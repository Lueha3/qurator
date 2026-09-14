import { beforeEach, describe, expect, it } from "vitest";

const { db } = await import("../db");
const { matchOrCreateProduct } = await import("../product-match");

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

async function seedCreator() {
  return db.creator.create({ data: { handle: `product_match_test_${Date.now()}` } });
}

async function seedProduct(
  creatorId: string,
  overrides: Partial<{
    musinsaGoodsNo: string | null;
    brandName: string;
    productName: string;
    styleCode: string | null;
  }> = {}
) {
  return db.product.create({
    data: {
      creatorId,
      musinsaGoodsNo: overrides.musinsaGoodsNo ?? null,
      canonicalUrl: `https://www.musinsa.com/products/${Math.floor(Math.random() * 1_000_000)}`,
      brandName: overrides.brandName ?? "쿠어",
      productName: overrides.productName ?? "스탠다드 오버셔츠",
      styleCode: overrides.styleCode ?? null,
      listPrice: 89000,
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("matchOrCreateProduct — 최근 딜은 근거가 아니다", () => {
  it("goodsNo가 있는 딜이 방금 생겼어도 이름이 다르면 그 상품에 붙이지 않는다", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, { musinsaGoodsNo: "123456" });
    await db.deal.create({ data: { productId: product.id, creatorId: creator.id } });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: "다른브랜드",
      productName: "전혀 다른 상품",
      styleCode: null,
    });

    expect(result.matchedBy).toBe("created");
    expect(result.product.id).not.toBe(product.id);
  });
});

describe("matchOrCreateProduct — styleCode", () => {
  it("creator 범위에서 styleCode가 정확히 일치하면 그 상품을 매칭한다", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, { styleCode: "ABC-123" });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: null,
      productName: null,
      styleCode: "ABC-123",
    });

    expect(result.matchedBy).toBe("styleCode");
    expect(result.product.id).toBe(product.id);
  });

  it("다른 creator의 동일 styleCode는 매칭하지 않는다", async () => {
    const creatorA = await seedCreator();
    const creatorB = await seedCreator();
    await seedProduct(creatorA.id, { styleCode: "SHARED-1" });

    const result = await matchOrCreateProduct({
      creatorId: creatorB.id,
      brand: null,
      productName: null,
      styleCode: "SHARED-1",
    });

    expect(result.matchedBy).toBe("created");
  });
});

describe("matchOrCreateProduct — nameMatch", () => {
  it("정규화된 (brand, productName)이 정확히 1개와 일치하면 매칭한다", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, {
      brandName: "쿠어",
      productName: "스탠다드 오버셔츠",
    });

    // 공백·대소문자·구두점이 달라도 정규화 후 같으면 매칭돼야 한다.
    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: " 쿠어 ",
      productName: "스탠다드-오버셔츠",
      styleCode: null,
    });

    expect(result.matchedBy).toBe("nameMatch");
    expect(result.product.id).toBe(product.id);
  });

  it("후보가 2개로 겹치면(모호) 매칭하지 않고 신규를 생성한다", async () => {
    const creator = await seedCreator();
    await seedProduct(creator.id, { brandName: "쿠어", productName: "스탠다드 오버셔츠" });
    await seedProduct(creator.id, { brandName: "쿠어", productName: "스탠다드 오버셔츠" });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: "쿠어",
      productName: "스탠다드 오버셔츠",
      styleCode: null,
    });

    expect(result.matchedBy).toBe("created");
    expect(await db.product.count({ where: { creatorId: creator.id } })).toBe(3);
  });
});

describe("matchOrCreateProduct — created", () => {
  it("아무 것도 매칭되지 않으면 SCREENSHOT 출처의 새 Product를 만든다", async () => {
    const creator = await seedCreator();

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: "신규브랜드",
      productName: "신규 상품",
      styleCode: "NEW-001",
    });

    expect(result.matchedBy).toBe("created");
    expect(result.product.source).toBe("SCREENSHOT");
    expect(result.product.musinsaGoodsNo).toBeNull();
    expect(result.product.brandName).toBe("신규브랜드");
    expect(result.product.productName).toBe("신규 상품");
    expect(result.product.styleCode).toBe("NEW-001");
    expect(result.product.listPrice).toBe(0);
  });

  it("brand/productName이 null이면 handler.ts와 동일한 placeholder를 쓴다", async () => {
    const creator = await seedCreator();

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: null,
      productName: null,
      styleCode: null,
    });

    expect(result.matchedBy).toBe("created");
    expect(result.product.brandName).toBe("(브랜드 미입력)");
    expect(result.product.productName).toBe("(상품명 미입력)");
  });

  it("canonicalUrl은 실제 무신사 URL과 절대 혼동될 수 없는 sentinel 형식이다", async () => {
    const creator = await seedCreator();

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      brand: null,
      productName: null,
      styleCode: null,
    });

    expect(result.product.canonicalUrl).toMatch(
      /^screenshot-pending:[0-9a-f-]{36}$/
    );
    expect(result.product.canonicalUrl).not.toContain("musinsa.com");
  });
});
