import { beforeEach, describe, expect, it, vi } from "vitest";

// 게이트웨이만 가로챈다 — 대상 선정·간격·상한·기록은 진짜 DB로 검증한다.
// 이 사이클은 사람 없이 무신사에 요청을 보내는 유일한 코드라, 규율이 실제로 지켜지는지가 검증의 전부다.
const gatewayFetch = vi.fn();
vi.mock("../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

const { db } = await import("../db");
const { addWatch, removeWatch, runWatchCycle, expireWatches, countActiveWatches } = await import(
  "../watch"
);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PAGE = `<html><head><script type="application/ld+json">
${JSON.stringify({
  "@type": "Product",
  name: "오버셔츠",
  brand: { name: "쿠어" },
  offers: { "@type": "Offer", price: "45000", availability: "https://schema.org/InStock" },
})}
</script></head><body>${"본문 ".repeat(2000)}</body></html>`;

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
  const creator = await db.creator.create({ data: { handle: `watch_test_${Date.now()}` } });
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push(
      await db.product.create({
        data: {
          creatorId: creator.id,
          musinsaGoodsNo: `9${String(i).padStart(5, "0")}`,
          canonicalUrl: `https://www.musinsa.com/products/9${String(i).padStart(5, "0")}`,
          brandName: "쿠어",
          productName: `상품 ${i}`,
          listPrice: 89000,
        },
      })
    );
  }
  return products;
}

/** 등록 직후엔 checkAfter(1~6h 뒤)가 걸려 있어 조회되지 않는다 — 테스트에서는 그 시각을 과거로 당긴다 */
async function makeDue(productId: string, lastCheckedAt: Date | null = null) {
  await db.watchItem.update({
    where: { productId },
    data: { checkAfter: new Date(Date.now() - HOUR), lastCheckedAt },
  });
}

beforeEach(async () => {
  gatewayFetch.mockReset();
  await resetDb();
});

describe("워치 등록 — 상한이 실제로 막는다", () => {
  it("등록하면 활성 1건이 되고 만료가 90일 뒤로 잡힌다", async () => {
    const [product] = await seedProducts(1);
    const now = new Date();
    const result = await addWatch(product.id, now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activeCount).toBe(1);
    const days = Math.round((result.expiresAt.getTime() - now.getTime()) / DAY);
    expect(days).toBe(90);
  });

  it("첫 조회 시각은 등록 직후가 아니다 (동기화 지문 제거)", async () => {
    const [product] = await seedProducts(1);
    const now = new Date();
    await addWatch(product.id, now);

    const item = await db.watchItem.findUniqueOrThrow({ where: { productId: product.id } });
    const offsetHours = (item.checkAfter.getTime() - now.getTime()) / HOUR;
    expect(offsetHours).toBeGreaterThanOrEqual(1);
    expect(offsetHours).toBeLessThanOrEqual(6);
  });

  it("상한(30개)을 넘으면 새 등록을 거부한다", async () => {
    const products = await seedProducts(31);
    for (const p of products.slice(0, 30)) {
      expect((await addWatch(p.id)).ok).toBe(true);
    }
    const overflow = await addWatch(products[30].id);
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.reason).toContain("상한");
    expect(await countActiveWatches()).toBe(30);
  });

  it("이미 활성인 상품의 재등록은 상한과 무관하게 기간만 연장한다", async () => {
    const products = await seedProducts(30);
    for (const p of products) await addWatch(p.id);

    const again = await addWatch(products[0].id);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyActive).toBe(true);
    expect(await countActiveWatches()).toBe(30);
  });

  it("해제하면 활성에서 빠지고 자리가 난다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    expect(await removeWatch(product.id)).toBe(true);
    expect(await countActiveWatches()).toBe(0);
    // 이미 해제된 것을 또 해제하면 false
    expect(await removeWatch(product.id)).toBe(false);
  });

  it("만료된 워치는 자동으로 해제된다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await db.watchItem.update({
      where: { productId: product.id },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });

    expect(await expireWatches()).toBe(1);
    expect(await countActiveWatches()).toBe(0);
  });
});

describe("워치 사이클 — 빈도 규율", () => {
  it("조회하고 WATCH 스냅샷을 남긴다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await makeDue(product.id);
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PAGE });

    const result = await runWatchCycle();
    expect(result.checked).toBe(1);
    expect(result.recorded).toBe(1);

    const snap = await db.priceSnapshot.findFirstOrThrow();
    expect(snap.source).toBe("WATCH");
    expect(snap.salePrice).toBe(45000);
    // 정규 상품 URL만 조회한다 — 커미션 파라미터가 붙은 링크는 절대 방문하지 않는다
    expect(gatewayFetch).toHaveBeenCalledWith({
      url: product.canonicalUrl,
      trigger: "WATCH",
    });
  });

  it("등록 직후(checkAfter 이전)에는 조회하지 않는다", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id); // checkAfter = 1~6h 뒤
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PAGE });

    const result = await runWatchCycle();
    expect(result.checked).toBe(0);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("평시에는 하루 1회를 넘지 않는다 (10시간 전 조회분은 대상 아님)", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await makeDue(product.id, new Date(Date.now() - 10 * HOUR));
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PAGE });

    expect((await runWatchCycle()).checked).toBe(0);
  });

  it("행사 창(policy watch.event.*)에서는 10시간 간격으로 조회한다", async () => {
    const now = new Date();
    await db.policy.createMany({
      data: [
        { key: "watch.event.tag", value: "BF2026" },
        { key: "watch.event.start", value: new Date(now.getTime() - DAY).toISOString() },
        { key: "watch.event.end", value: new Date(now.getTime() + DAY).toISOString() },
      ],
    });
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await makeDue(product.id, new Date(now.getTime() - 11 * HOUR));
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PAGE });

    const result = await runWatchCycle();
    expect(result.eventTag).toBe("BF2026");
    expect(result.checked).toBe(1);
    // 행사 창 안의 스냅샷에는 태그가 자동으로 찍힌다
    const snap = await db.priceSnapshot.findFirstOrThrow();
    expect(snap.eventTag).toBe("BF2026");
  });
});

describe("워치 사이클 — 차단 신호를 만나면 뚫지 않고 멈춘다", () => {
  it("BOT_CHALLENGE를 만나면 그 사이클을 즉시 끝낸다", async () => {
    const products = await seedProducts(3);
    for (const p of products) {
      await addWatch(p.id);
      await makeDue(p.id);
    }
    gatewayFetch.mockResolvedValue({
      ok: false,
      outcome: "BOT_CHALLENGE",
      reason: "차단 페이지 감지",
    });

    const result = await runWatchCycle();
    expect(result.stoppedEarly).toContain("BOT_CHALLENGE");
    expect(gatewayFetch).toHaveBeenCalledTimes(1); // 나머지 2건을 더 두드리지 않는다
    expect(result.checked).toBe(0);
  });

  it("BLOCKED_BUDGET(예산 소진)도 사이클을 끝낸다", async () => {
    const products = await seedProducts(2);
    for (const p of products) {
      await addWatch(p.id);
      await makeDue(p.id);
    }
    gatewayFetch.mockResolvedValue({
      ok: false,
      outcome: "BLOCKED_BUDGET",
      reason: "일일 상한 소진",
    });

    expect((await runWatchCycle()).stoppedEarly).toContain("BLOCKED_BUDGET");
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
  });

  it("개별 실패(타임아웃)는 그 상품만 건너뛰고 계속한다", async () => {
    const products = await seedProducts(2);
    for (const p of products) {
      await addWatch(p.id);
      await makeDue(p.id);
    }
    gatewayFetch
      .mockResolvedValueOnce({ ok: false, outcome: "TIMEOUT", reason: "느림" })
      .mockResolvedValueOnce({ ok: true, status: 200, body: PAGE });

    const result = await runWatchCycle();
    expect(result.stoppedEarly).toBeNull();
    expect(gatewayFetch).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(1);
  });

  it("실패한 상품도 lastCheckedAt이 갱신된다 (매 사이클 재시도로 굶기지 않기)", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await makeDue(product.id);
    gatewayFetch.mockResolvedValue({ ok: false, outcome: "NETWORK_ERROR", reason: "끊김" });

    await runWatchCycle();
    const item = await db.watchItem.findUniqueOrThrow({ where: { productId: product.id } });
    expect(item.lastCheckedAt).not.toBeNull();
  });

  it("파싱 실패는 스냅샷 없이 카운트만 올린다 (파서 점검 신호)", async () => {
    const [product] = await seedProducts(1);
    await addWatch(product.id);
    await makeDue(product.id);
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: "<html>차단</html>" });

    const result = await runWatchCycle();
    expect(result.checked).toBe(1);
    expect(result.parseFailed).toBe(1);
    expect(await db.priceSnapshot.count()).toBe(0);
  });
});
