import { beforeEach, describe, expect, it } from "vitest";

// 대상 선정을 진짜 DB로 검증한다.
// 이 모듈의 값어치는 "언제 조르지 않는가"에 있다 — 매일 같은 목록을 다시 보여주는 알림은
// 몇 번 무시되는 순간 전부 무시되고, 그러면 기준가 수집이 통째로 멈춘다.

const { db } = await import("../db");
const { addWatch } = await import("../watch");
const { dueForReminder } = await import("../watch-remind");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function resetDb() {
  await db.clickEvent.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.productVariant.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
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
    data: { productId, capturedAt, salePrice: 45000, source: "SCREENSHOT" },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("리마인더 대상 — 이미 기록된 상품은 다시 조르지 않는다", () => {
  it("스냅샷이 한 번도 없으면 대상이다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);

    const items = await dueForReminder();
    expect(items).toHaveLength(1);
    expect(items[0].lastSnapshotAt).toBeNull();
    expect(items[0].brandName).toBe("쿠어");
  });

  it("재조회 간격(기본 20h) 안에 기록이 있으면 제외된다 — 오늘 이미 올린 상품", async () => {
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

  it("여러 상품이면 등록 순서대로 전부 나온다 — 잘린 목록은 뒤쪽을 영영 놓친다", async () => {
    const products = await seedProducts(25);
    for (const p of products) await addWatch(p.id);

    const items = await dueForReminder();
    expect(items).toHaveLength(25);
    expect(items.at(-1)?.productName).toBe("상품 24");
  });
});
