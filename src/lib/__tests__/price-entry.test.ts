import { beforeEach, describe, expect, it, vi } from "vitest";

// 수동 입력은 순수 DB 기록이다 — 게이트웨이가 한 번도 불리지 않는 것까지 검증한다.
const gatewayFetch = vi.fn();
vi.mock("../fetch-gateway", () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetch(...args),
  USER_AGENT: "HoneyFlowBot/1.0",
}));

const { db } = await import("../db");
const { recordManualBfPrice, parsePriceInput } = await import("../price-entry");
const { BF2025_OBSERVED_AT } = await import("../price-analysis");

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
}

async function seedProduct(listPrice = 89000) {
  const creator = await db.creator.create({ data: { handle: `price_entry_${Date.now()}` } });
  return db.product.create({
    data: {
      creatorId: creator.id,
      musinsaGoodsNo: "777001",
      canonicalUrl: "https://www.musinsa.com/products/777001",
      brandName: "쿠어",
      productName: "오버핏 맨투맨",
      listPrice,
    },
  });
}

beforeEach(async () => {
  gatewayFetch.mockReset();
  await resetDb();
});

describe("가격 입력 파싱", () => {
  it("쉼표·원 접미사·숫자 타입을 전부 원 단위 정수로", () => {
    expect(parsePriceInput("39,900원")).toBe(39900);
    expect(parsePriceInput("39900")).toBe(39900);
    expect(parsePriceInput(45000)).toBe(45000);
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("0")).toBeNull();
    expect(parsePriceInput(null)).toBeNull();
  });
});

describe("작년 BF 가격 수동 입력 (네트워크 요청 0건)", () => {
  it("등록된 상품에 MANUAL 스냅샷을 기록하고 할인율을 돌려준다", async () => {
    const product = await seedProduct();

    const result = await recordManualBfPrice({
      productId: product.id,
      salePrice: "39,900원",
      listPrice: "89000",
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate).toBe(55); // (1 - 39900/89000) ≈ 55%
    expect(result.couponPrice).toBeNull();

    const manual = await db.priceSnapshot.findFirstOrThrow({ where: { source: "MANUAL" } });
    expect(manual.productId).toBe(product.id);
    expect(manual.salePrice).toBe(39900);
    expect(manual.listPrice).toBe(89000);
    expect(manual.eventTag).toBe("BF2025");
    // 그 가격이 참이었던 시점으로 기록된다 — 입력 시각이 아니다
    expect(manual.capturedAt.getTime()).toBe(BF2025_OBSERVED_AT.getTime());
  });

  it("정가 생략 시 상품 정가를 쓰고, 정가가 미확인(0)이면 null로 남긴다", async () => {
    const product = await seedProduct();
    const withList = await recordManualBfPrice({ productId: product.id, salePrice: 45000 });
    expect(withList.ok && withList.listPrice).toBe(89000);

    const unknown = await seedProduct(0);
    await db.product.update({ where: { id: unknown.id }, data: { musinsaGoodsNo: "777002" } });
    const noList = await recordManualBfPrice({ productId: unknown.id, salePrice: 45000 });
    expect(noList.ok && noList.listPrice).toBeNull();
    expect(noList.ok && noList.rate).toBeNull();
  });

  it("쿠폰가도 함께 기록하고 쿠폰 할인율을 돌려준다", async () => {
    const product = await seedProduct();
    const result = await recordManualBfPrice({
      productId: product.id,
      salePrice: 39900,
      listPrice: 89000,
      couponPrice: 37900,
    });
    expect(result.ok && result.couponRate).toBe(57); // (1 - 37900/89000) ≈ 57%
    const manual = await db.priceSnapshot.findFirstOrThrow({ where: { source: "MANUAL" } });
    expect(manual.couponPrice).toBe(37900);
  });

  it("미등록 상품·잘못된 가격은 기록하지 않는다", async () => {
    expect((await recordManualBfPrice({ productId: "no-such-product", salePrice: 39900 })).ok).toBe(false);
    const product = await seedProduct();
    expect((await recordManualBfPrice({ productId: product.id, salePrice: "" })).ok).toBe(false);
    expect(await db.priceSnapshot.count()).toBe(0);
  });
});
