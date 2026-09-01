import { beforeEach, describe, expect, it, vi } from "vitest";

// 게이트웨이만 가로챈다 — DB·파서·스냅샷 기록은 진짜로 돌려 피기백 경로 전체를 검증한다.
const gatewayFetch = vi.fn();
vi.mock("../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

const { db } = await import("../db");
const { activeEventTag, recordSnapshot, recordParsedSnapshot } = await import("../price-snapshot");
const { runHealthCheck } = await import("../health-check");
const { parseProductPage } = await import("../product-parser");

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
}

async function seedProduct(goodsNo = "424242") {
  const creator = await db.creator.create({ data: { handle: "snapshot_test" } });
  const product = await db.product.create({
    data: {
      creatorId: creator.id,
      musinsaGoodsNo: goodsNo,
      canonicalUrl: `https://www.musinsa.com/products/${goodsNo}`,
      brandName: "쿠어",
      productName: "오버핏 맨투맨",
      listPrice: 89000,
    },
  });
  return { creator, product };
}

beforeEach(async () => {
  gatewayFetch.mockReset();
  await resetDb();
});

describe("recordSnapshot — 가격 없는 기록은 오염이다", () => {
  it("가격이 하나도 없으면 기록하지 않는다", async () => {
    const { product } = await seedProduct();
    const saved = await recordSnapshot({ productId: product.id, source: "MANUAL" });
    expect(saved.recorded).toBe(false);
    expect(await db.priceSnapshot.count()).toBe(0);
  });

  it("가격이 있으면 기록한다", async () => {
    const { product } = await seedProduct();
    const saved = await recordSnapshot({
      productId: product.id,
      salePrice: 39900,
      listPrice: 89000,
      source: "MANUAL",
      eventTag: "BF2025",
      note: "테스트",
    });
    expect(saved.recorded).toBe(true);
    const row = await db.priceSnapshot.findFirstOrThrow();
    expect(row.salePrice).toBe(39900);
    expect(row.listPrice).toBe(89000);
    expect(row.eventTag).toBe("BF2025");
    expect(row.source).toBe("MANUAL");
  });

  it("존재하지 않는 상품이어도 throw하지 않는다 (본 흐름 보호)", async () => {
    const saved = await recordSnapshot({
      productId: "no-such-product",
      salePrice: 1000,
      source: "USER_URL",
    });
    expect(saved.recorded).toBe(false);
  });
});

describe("이벤트 창 자동 스탬핑 (policy watch.event.*)", () => {
  async function setWindow() {
    await db.policy.createMany({
      data: [
        { key: "watch.event.tag", value: "BF2026" },
        { key: "watch.event.start", value: "2026-11-16T00:00:00+09:00" },
        { key: "watch.event.end", value: "2026-11-27T00:00:00+09:00" },
      ],
    });
  }

  it("창 안이면 태그, 밖이면 null", async () => {
    await setWindow();
    expect(await activeEventTag(new Date("2026-11-20T12:00:00+09:00"))).toBe("BF2026");
    expect(await activeEventTag(new Date("2026-10-01T00:00:00+09:00"))).toBeNull();
  });

  it("policy 미설정이면 항상 null (기본 동작)", async () => {
    expect(await activeEventTag(new Date("2026-11-20T12:00:00+09:00"))).toBeNull();
  });

  it("창 안의 자동 스냅샷에 태그가 찍히고, 명시한 태그는 자동 판정을 이긴다", async () => {
    await setWindow();
    const { product } = await seedProduct();
    const inWindow = new Date("2026-11-20T12:00:00+09:00");

    await recordSnapshot({
      productId: product.id,
      salePrice: 35000,
      source: "WATCH",
      capturedAt: inWindow,
    });
    // 수동 입력은 창과 무관하게 자기 태그를 유지해야 한다 (작년 기록을 올해 창 안에서 입력하는 경우)
    await recordSnapshot({
      productId: product.id,
      salePrice: 39900,
      source: "MANUAL",
      eventTag: "BF2025",
      capturedAt: inWindow,
    });

    const rows = await db.priceSnapshot.findMany({ orderBy: { salePrice: "asc" } });
    expect(rows.map((r) => r.eventTag)).toEqual(["BF2026", "BF2025"]);
  });
});

describe("recordParsedSnapshot — 파싱 실패는 조용히 건너뛴다", () => {
  it("파싱 결과에 가격이 없으면 기록하지 않는다", async () => {
    const { product } = await seedProduct();
    const parsed = parseProductPage("<html><body>차단 페이지</body></html>");
    const saved = await recordParsedSnapshot(product.id, parsed, "USER_URL");
    expect(saved.recorded).toBe(false);
    expect(await db.priceSnapshot.count()).toBe(0);
  });
});

describe("헬스체크 피기백 — 추가 요청 0건으로 이력이 쌓인다", () => {
  const PAGE = `<html><head><script type="application/ld+json">
  ${JSON.stringify({
    "@type": "Product",
    name: "오버핏 맨투맨",
    brand: { name: "쿠어" },
    offers: {
      "@type": "Offer",
      price: "39900",
      availability: "https://schema.org/InStock",
      priceSpecification: { priceType: "https://schema.org/ListPrice", price: "89000" },
    },
  })}
  </script></head><body>${"본문 ".repeat(2000)}</body></html>`;

  async function seedPublishedDeal(linkCount = 1) {
    const { creator, product } = await seedProduct();
    const deal = await db.deal.create({
      data: {
        productId: product.id,
        creatorId: creator.id,
        status: "PUBLISHED",
        approvalStage: "APPROVED",
      },
    });
    for (let i = 0; i < linkCount; i++) {
      await db.curatorLink.create({
        data: {
          dealId: deal.id,
          rawUrl: `https://www.musinsa.com/products/424242?utm_term=ULID${i}`,
          isDefault: i === 0,
          healthCheckAfter: new Date(Date.now() - 3_600_000), // 이미 도래
        },
      });
    }
    return { product, deal };
  }

  it("점검 1회가 HEALTH_CHECK 스냅샷 1건을 남긴다 (가격·정가 포함)", async () => {
    const { product } = await seedPublishedDeal();
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PAGE });

    const result = await runHealthCheck();
    expect(result.checked).toBe(1);

    const snapshots = await db.priceSnapshot.findMany({ where: { productId: product.id } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].source).toBe("HEALTH_CHECK");
    expect(snapshots[0].salePrice).toBe(39900);
    expect(snapshots[0].listPrice).toBe(89000);
  });

  it("같은 상품에 링크가 여러 개여도 사이클당 스냅샷은 1건이다", async () => {
    const { product } = await seedPublishedDeal(2);
    gatewayFetch.mockResolvedValue({ ok: true, status: 200, body: PAGE });

    const result = await runHealthCheck();
    expect(result.checked).toBe(2);
    expect(await db.priceSnapshot.count({ where: { productId: product.id } })).toBe(1);
  });

  it("fetch 실패(게이트웨이 ok:false)는 스냅샷을 남기지 않는다", async () => {
    await seedPublishedDeal();
    // 실제 게이트웨이는 4xx를 ok:false(HTTP_ERROR)로 돌려준다 — 그 경로를 그대로 재현한다.
    gatewayFetch.mockResolvedValue({ ok: false, outcome: "HTTP_ERROR", reason: "HTTP 404" });

    await runHealthCheck();
    expect(await db.priceSnapshot.count()).toBe(0);
  });
});
