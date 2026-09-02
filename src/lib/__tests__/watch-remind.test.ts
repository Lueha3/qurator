import { beforeEach, describe, expect, it, vi } from "vitest";

// 텔레그램만 가로채고 대상 선정·중복 억제는 진짜 DB로 검증한다.
// 이 모듈의 값어치는 "언제 조르지 않는가"에 있다 — 매일 같은 목록을 다시 보내는 알림은
// 몇 번 무시되는 순간 전부 무시되고, 그러면 기준가 수집이 통째로 멈춘다.

const sent: Array<{ chatId: string | number; text: string }> = [];

vi.mock("../telegram/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram/client")>();
  return {
    ...actual,
    sendMessage: vi.fn(async (opts: { chatId: string | number; text: string }) => {
      sent.push(opts);
      return { message_id: sent.length };
    }),
  };
});

const { db } = await import("../db");
const { addWatch } = await import("../watch");
const { dueForReminder, buildReminderMessages, sendWatchReminder } = await import("../watch-remind");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "777001";

async function resetDb() {
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.deal.deleteMany();
  await db.productVariant.deleteMany();
  await db.product.deleteMany();
  await db.creator.deleteMany();
  await db.policy.deleteMany();
  await db.auditLog.deleteMany();
}

async function seedProducts(count: number) {
  const creator = await db.creator.create({ data: { handle: `remind_test_${Date.now()}` } });
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push(
      await db.product.create({
        data: {
          creatorId: creator.id,
          musinsaGoodsNo: `8${String(i).padStart(5, "0")}`,
          canonicalUrl: `https://www.musinsa.com/products/8${String(i).padStart(5, "0")}`,
          brandName: "쿠어",
          productName: `상품 ${i}`,
          listPrice: 89000,
        },
      })
    );
  }
  return products;
}

async function snapshot(productId: string, capturedAt: Date) {
  await db.priceSnapshot.create({
    data: { productId, capturedAt, salePrice: 45000, source: "USER_URL" },
  });
}

beforeEach(async () => {
  sent.length = 0;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "777001";
  await resetDb();
});

describe("리마인더 대상 — 이미 기록된 상품은 다시 조르지 않는다", () => {
  it("스냅샷이 한 번도 없으면 대상이다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);

    const items = await dueForReminder();
    expect(items).toHaveLength(1);
    expect(items[0].lastSnapshotAt).toBeNull();
  });

  it("재조회 간격(기본 20h) 안에 기록이 있으면 제외된다 — 오늘 이미 던진 상품", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await snapshot(product.id, new Date(Date.now() - 2 * HOUR));

    expect(await dueForReminder()).toHaveLength(0);
  });

  it("간격을 넘긴 기록만 있으면 다시 대상이 된다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await snapshot(product.id, new Date(Date.now() - 2 * DAY));

    const items = await dueForReminder();
    expect(items).toHaveLength(1);
    expect(items[0].lastSnapshotAt).not.toBeNull();
  });

  it("해제·만료된 워치는 대상이 아니다", async () => {
    const [a, b] = await seedProducts(2);
    await addWatch(a.id);
    await addWatch(b.id);
    await db.watchItem.update({ where: { productId: a.id }, data: { active: false } });
    await db.watchItem.update({
      where: { productId: b.id },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });

    expect(await dueForReminder()).toHaveLength(0);
  });
});

describe("리마인더 본문", () => {
  it("상품 링크와 개수를 담고, 텔레그램 한도를 넘지 않는다", async () => {
    const products = await seedProducts(3);
    for (const p of products) await addWatch(p.id);

    const messages = buildReminderMessages(await dueForReminder(), null);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("3개");
    expect(messages[0]).toContain("https://www.musinsa.com/products/800000");
    expect(messages[0].length).toBeLessThan(4096);
  });

  it("상품이 많으면 여러 통으로 나눈다 — 잘린 목록은 뒤쪽을 영영 놓친다", async () => {
    const products = await seedProducts(25);
    for (const p of products) await addWatch(p.id);

    const messages = buildReminderMessages(await dueForReminder(), null);

    expect(messages.length).toBeGreaterThan(1);
    for (const text of messages) expect(text.length).toBeLessThan(4096);
    // 마지막 상품까지 어느 통엔가는 들어 있다
    expect(messages.join("\n")).toContain("상품 24");
  });

  it("행사 창이 열려 있으면 하루 2회임을 알린다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);

    const [text] = buildReminderMessages(await dueForReminder(), "BF2026");
    expect(text).toContain("BF2026");
  });
});

describe("전송 — 같은 주기에 두 번 조르지 않는다", () => {
  it("보내면 감사 로그를 남기고, 같은 주기의 두 번째 호출은 건너뛴다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);

    const first = await sendWatchReminder();
    expect(first.sent).toBe(1);
    expect(first.items).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("777001");

    const second = await sendWatchReminder();
    expect(second.skipped).toBe("ALREADY_SENT");
    expect(sent).toHaveLength(1);
  });

  it("대상이 없으면 아무것도 보내지 않는다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await snapshot(product.id, new Date());

    expect((await sendWatchReminder()).skipped).toBe("NO_ITEMS");
    expect(sent).toHaveLength(0);
  });

  it("채널 화이트리스트가 비어 있으면 보내지 않는다 (fail closed)", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = "";

    expect((await sendWatchReminder()).skipped).toBe("NO_CHANNEL");
    expect(sent).toHaveLength(0);
  });

  it("전송이 전부 실패하면 기록을 남기지 않아 다음 사이클에 다시 시도한다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);

    const client = await import("../telegram/client");
    vi.mocked(client.sendMessage).mockRejectedValueOnce(new Error("텔레그램 500"));

    const result = await sendWatchReminder();
    expect(result.sent).toBe(0);
    expect(await db.auditLog.count({ where: { action: "watch.reminded" } })).toBe(0);

    // 다음 호출이 ALREADY_SENT로 막히지 않는다
    expect((await sendWatchReminder()).sent).toBe(1);
  });
});
