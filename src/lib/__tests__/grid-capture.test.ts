import { beforeEach, describe, expect, it, vi } from "vitest";

// 좋아요 목록(그리드) 한 장 = 상품 여러 개 (docs/06 §4.6).
// 검증 대상: 딜을 만들지 않고 지켜보는 상품으로만 담는가, 다시 찍으면 가격이 갱신되고
// 싸진 것이 잡히는가, 그리고 사람이 고른 순간에만 딜이 생기는가.

vi.mock("../fetch-gateway", () => ({
  gatewayFetch: vi.fn(),
  USER_AGENT: "HoneyFlowBot/1.0",
}));
vi.mock("../ai-hook", () => ({ draftHookLine: vi.fn(async () => null) }));

const extractFromScreenshot = vi.fn();
vi.mock("../vision-extract", () => ({
  extractFromScreenshot: (...args: unknown[]) => extractFromScreenshot(...args),
}));

const { captureFromScreenshots, startDealFromProduct } = await import("../deal-flow");
const { cheaperWatchedProducts } = await import("../price-drop");
const { loadWatchedProducts } = await import("../watch-list");
const { db } = await import("../db");
type VisionExtractResult = import("../vision-extract").VisionExtractResult;
type VisionGridItem = import("../vision-extract").VisionGridItem;

const IMAGE = { data: "ZmFrZSBqcGVn", mediaType: "image/jpeg" };

function gridItem(over: Partial<VisionGridItem> = {}): VisionGridItem {
  return {
    brand: "쿠어",
    productName: "스탠다드 오버셔츠",
    salePrice: 53400,
    discountRateShown: 40,
    soldOut: false,
    ...over,
  };
}

function gridVision(items: VisionGridItem[]): VisionExtractResult {
  return {
    // 그리드는 상세 페이지가 아니므로 false로 온다 — 그래도 "상품 페이지를 찍어주세요"로
    // 떨어지면 안 된다는 것이 이 경로의 핵심이다.
    isProductPage: false,
    gridItems: items,
    brand: null,
    productName: null,
    styleCode: null,
    listPrice: null,
    salePrice: null,
    couponPrice: null,
    discountRateShown: null,
    soldOut: null,
    confidence: "high",
    notes: null,
  };
}

async function captureGrid(items: VisionGridItem[]) {
  extractFromScreenshot.mockResolvedValueOnce(gridVision(items));
  const result = await captureFromScreenshots([IMAGE]);
  if (result.kind !== "grid") throw new Error(`grid 아님: ${result.kind}`);
  return result;
}

beforeEach(async () => {
  extractFromScreenshot.mockReset();
  await db.auditLog.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.contentCard.deleteMany();
  await db.shortLink.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.product.deleteMany();
});

describe("좋아요 목록 한 장 담기", () => {
  it("상품 여러 개를 담고 딜은 하나도 만들지 않는다", async () => {
    const result = await captureGrid([
      gridItem({ brand: "쿠어", productName: "스탠다드 오버셔츠", salePrice: 53400 }),
      gridItem({ brand: "인사일런스", productName: "울 블렌드 코트", salePrice: 181300 }),
      gridItem({ brand: "토피", productName: "케이블 니트 가디건", salePrice: 71400 }),
    ]);

    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(await db.product.count()).toBe(3);
    expect(await db.priceSnapshot.count()).toBe(3);
    // 목록 한 장이 딜 24장이 되면 "오늘 할 일"이 무너진다 — 그래서 딜은 0이다.
    expect(await db.deal.count()).toBe(0);
    expect(await db.watchItem.count({ where: { active: true } })).toBe(3);
  });

  it("이름도 가격도 못 읽은 칸은 건너뛴다 — 빈 상품을 만들지 않는다", async () => {
    await captureGrid([
      gridItem(),
      gridItem({ brand: null, productName: null, salePrice: 12000 }),
      gridItem({ brand: "토피", productName: "니트", salePrice: null }),
    ]);

    // Vision 파서가 버리지 못한 칸도 적재 단계에서 기록할 사실이 없으면 스냅샷이 안 남는다.
    const products = await db.product.findMany();
    expect(products.every((p) => p.brandName !== "(브랜드 미입력)")).toBe(true);
    expect(await db.priceSnapshot.count()).toBe(1);
  });

  it("같은 목록을 다시 찍으면 상품이 늘지 않고 가격만 쌓인다", async () => {
    await captureGrid([gridItem({ salePrice: 53400 })]);
    const second = await captureGrid([gridItem({ salePrice: 48000 })]);

    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(await db.product.count()).toBe(1);
    expect(await db.priceSnapshot.count()).toBe(2);
  });

  it("지난번보다 싸진 상품을 세어 돌려준다", async () => {
    await captureGrid([
      gridItem({ productName: "오버셔츠", salePrice: 53400 }),
      gridItem({ productName: "코트", salePrice: 181300 }),
    ]);
    const second = await captureGrid([
      gridItem({ productName: "오버셔츠", salePrice: 43400 }), // 내림
      gridItem({ productName: "코트", salePrice: 181300 }), // 그대로
    ]);

    expect(second.cheaper).toBe(1);
  });
});

describe("싸진 상품", () => {
  it("내린 상품만, 많이 내린 순으로 나온다", async () => {
    await captureGrid([
      gridItem({ productName: "오버셔츠", salePrice: 100000 }),
      gridItem({ productName: "코트", salePrice: 100000 }),
      gridItem({ productName: "니트", salePrice: 100000 }),
    ]);
    await captureGrid([
      gridItem({ productName: "오버셔츠", salePrice: 90000 }), // 10% 내림
      gridItem({ productName: "코트", salePrice: 50000 }), // 50% 내림
      gridItem({ productName: "니트", salePrice: 120000 }), // 오름 — 나오면 안 된다
    ]);

    const drops = await cheaperWatchedProducts();
    expect(drops.map((d) => d.productName)).toEqual(["코트", "오버셔츠"]);
    expect(drops[0].rate).toBe(50);
    expect(drops[0].from).toBe(100000);
    expect(drops[0].to).toBe(50000);
  });

  it("기록이 한 번뿐이면 비교하지 않는다 — 방금 담은 300개가 전부 뜨면 의미가 없다", async () => {
    await captureGrid([gridItem()]);
    expect(await cheaperWatchedProducts()).toEqual([]);
  });

  it("한 번에 80% 넘게 내린 값은 의심 표시가 붙고 맨 위 자리를 내준다 — OCR 자릿수 오독일 수 있다 (2026-09-21)", async () => {
    await captureGrid([
      gridItem({ productName: "오버셔츠", salePrice: 53400 }),
      gridItem({ productName: "코트", salePrice: 100000 }),
    ]);
    await captureGrid([
      gridItem({ productName: "오버셔츠", salePrice: 48000 }), // 정상 하락(10%)
      gridItem({ productName: "코트", salePrice: 9000 }), // 자릿수 오독처럼 보이는 91% 하락
    ]);

    const drops = await cheaperWatchedProducts();
    // 의심스러운 쪽(코트, 91%)이 하락률로는 훨씬 크지만 맨 위로 오지 않는다.
    expect(drops.map((d) => d.productName)).toEqual(["오버셔츠", "코트"]);
    expect(drops[0].suspicious).toBe(false);
    expect(drops[1].suspicious).toBe(true);
  });
});

describe("지켜보는 상품 목록", () => {
  it("딜 없이도 목록에 보인다 — 안 보이면 담은 의미가 없다", async () => {
    await captureGrid([gridItem({ brand: "쿠어", productName: "오버셔츠", salePrice: 53400 })]);

    const rows = await loadWatchedProducts();
    expect(rows).toHaveLength(1);
    expect(rows[0].brandName).toBe("쿠어");
    expect(rows[0].price).toBe(53400);
    expect(rows[0].dealId).toBeNull();
    expect(rows[0].recordCount).toBe(1);
  });

  // 회귀 테스트 — 실사용자 제보(2026-09-20): 화면에 할인율이 찍혀 있었는데 목록에 안 나왔다.
  // 원인은 PriceSnapshot에 저장할 컬럼 자체가 없어 vision이 읽어온 값이 그 자리에서 버려진 것.
  it("화면에 찍힌 할인율이 스냅샷에 저장돼 목록에 나온다", async () => {
    await captureGrid([
      gridItem({ brand: "쿠어", productName: "오버셔츠", salePrice: 53400, discountRateShown: 40 }),
    ]);

    const snapshot = await db.priceSnapshot.findFirstOrThrow();
    expect(snapshot.discountRateShown).toBe(40);

    const rows = await loadWatchedProducts();
    expect(rows[0].discountRateShown).toBe(40);
  });

  it("할인율이 안 찍혀 있었으면 null로 남는다 — 0%를 지어내지 않는다", async () => {
    await captureGrid([gridItem({ discountRateShown: null })]);

    const rows = await loadWatchedProducts();
    expect(rows[0].discountRateShown).toBeNull();
  });

  it("내린 상품의 dropRate를 정확히 계산한다 — 정렬은 등록순 담당이 아니다", async () => {
    await captureGrid([
      gridItem({ productName: "그대로", salePrice: 50000 }),
      gridItem({ productName: "내림", salePrice: 50000 }),
    ]);
    await captureGrid([
      gridItem({ productName: "그대로", salePrice: 50000 }),
      gridItem({ productName: "내림", salePrice: 40000 }),
    ]);

    const rows = await loadWatchedProducts();
    const dropped = rows.find((r) => r.productName === "내림");
    const unchanged = rows.find((r) => r.productName === "그대로");
    expect(dropped?.dropRate).toBe(20);
    expect(unchanged?.dropRate).toBeNull();
  });

  // 회귀 테스트(2026-09-20, 사용자 요청): "싸진 것 먼저"였던 기본 정렬을 등록순으로 바꿨다 —
  // "싸진 순"은 이제 화면(DealBrowser)에서 토글로 고르는 선택지다.
  it("기본 정렬은 등록순이다 — 가격이 아무리 많이 내려도 순서가 안 바뀐다", async () => {
    await captureGrid([
      gridItem({ productName: "먼저", salePrice: 50000 }),
      gridItem({ productName: "나중", salePrice: 50000 }),
    ]);
    await captureGrid([gridItem({ productName: "나중", salePrice: 10000 })]); // 80% 내림

    const rows = await loadWatchedProducts();
    expect(rows.map((r) => r.productName)).toEqual(["먼저", "나중"]);
    expect(rows[0].registrationNo).toBeLessThan(rows[1].registrationNo);
  });
});

describe("지켜보는 상품에서 딜 시작", () => {
  it("고른 순간에만 딜이 생긴다", async () => {
    await captureGrid([gridItem({ salePrice: 53400 })]);
    const product = await db.product.findFirstOrThrow();
    expect(await db.deal.count()).toBe(0);

    const result = await startDealFromProduct(product.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(false);

    const deal = await db.deal.findUniqueOrThrow({ where: { id: result.dealId } });
    expect(deal.approvalStage).toBe("CANDIDATE");
    // 마지막으로 읽은 가격이 카드에 실린다 — 사람이 다시 찍지 않아도 판단할 재료가 있어야 한다.
    expect(deal.salePrice).toBe(53400);
    expect(await db.auditLog.count({ where: { action: "deal.started_from_watch" } })).toBe(1);
  });

  it("이미 열린 딜이 있으면 새로 만들지 않고 그것을 준다 — 판단이 두 장으로 갈라지면 안 된다", async () => {
    await captureGrid([gridItem()]);
    const product = await db.product.findFirstOrThrow();

    const first = await startDealFromProduct(product.id);
    const second = await startDealFromProduct(product.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.dealId).toBe(first.dealId);
    expect(second.reused).toBe(true);
    expect(await db.deal.count()).toBe(1);
  });
});
