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

describe("matchOrCreateProduct — recentLinkedDeal", () => {
  it("같은 대화·10분 이내에 goodsNo가 있는 딜의 상품을 그대로 매칭한다", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, { musinsaGoodsNo: "123456" });
    const chatId = "chat-1";
    await db.deal.create({
      data: {
        productId: product.id,
        creatorId: creator.id,
        telegramChatId: chatId,
      },
    });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      chatId,
      brand: null,
      productName: null,
      styleCode: null,
    });

    expect(result.matchedBy).toBe("recentLinkedDeal");
    expect(result.product.id).toBe(product.id);
  });

  it("10분보다 오래된 딜은 매칭하지 않는다(styleCode/nameMatch도 없으면 신규 생성)", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, { musinsaGoodsNo: "999999" });
    const chatId = "chat-2";
    const deal = await db.deal.create({
      data: {
        productId: product.id,
        creatorId: creator.id,
        telegramChatId: chatId,
      },
    });
    await db.deal.update({
      where: { id: deal.id },
      data: { createdAt: new Date(Date.now() - 11 * 60_000) },
    });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      chatId,
      brand: "다른브랜드",
      productName: "전혀 다른 상품",
      styleCode: null,
    });

    expect(result.matchedBy).toBe("created");
  });

  it("goodsNo가 없는(=아직 링크 안 붙은) 딜은 매칭 대상이 아니다", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, { musinsaGoodsNo: null });
    const chatId = "chat-3";
    await db.deal.create({
      data: { productId: product.id, creatorId: creator.id, telegramChatId: chatId },
    });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      chatId,
      brand: "쿠어",
      productName: "스탠다드 오버셔츠",
      styleCode: null,
    });

    // goodsNo 없는 딜은 1)에서 걸리지 않지만, (brand, productName) 정규화가 같은 상품 1건과
    // 일치하므로 3) nameMatch로 떨어진다 — recentLinkedDeal이 아니라는 것만 확인한다.
    expect(result.matchedBy).toBe("nameMatch");
    expect(result.product.id).toBe(product.id);
  });
});

describe("matchOrCreateProduct — styleCode", () => {
  it("creator 범위에서 styleCode가 정확히 일치하면 그 상품을 매칭한다", async () => {
    const creator = await seedCreator();
    const product = await seedProduct(creator.id, { styleCode: "ABC-123" });

    const result = await matchOrCreateProduct({
      creatorId: creator.id,
      chatId: "chat-4",
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
      chatId: "chat-5",
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
      chatId: "chat-6",
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
      chatId: "chat-7",
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
      chatId: "chat-8",
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
      chatId: "chat-9",
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
      chatId: "chat-10",
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
