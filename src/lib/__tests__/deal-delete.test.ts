import { beforeEach, describe, expect, it } from "vitest";
import { deleteDeals, deleteWatchedProducts } from "../deal-delete";
import { db } from "../db";
import { getDefaultCreator } from "../creator";

// 체크박스 다중 선택 삭제 — docs 06 §4.6 연계. 두 함수의 핵심 안전장치를 검증한다:
//   deleteDeals: 딜을 지워도 다른 딜·활성 워치가 남아 있으면 Product는 건드리지 않는다
//   deleteWatchedProducts: 발행된(APPROVED) 딜이 있는 상품은 통째로 건너뛴다

beforeEach(async () => {
  await db.auditLog.deleteMany();
  await db.clickEvent.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.deal.deleteMany();
  await db.product.deleteMany();
});

async function makeProduct(overrides: Partial<{ brandName: string; productName: string }> = {}) {
  const creator = await getDefaultCreator();
  return db.product.create({
    data: {
      creatorId: creator.id,
      canonicalUrl: `https://www.musinsa.com/products/${Math.floor(Math.random() * 1e9)}`,
      brandName: overrides.brandName ?? "테스트브랜드",
      productName: overrides.productName ?? "테스트상품",
      listPrice: 50000,
    },
  });
}

async function makeDeal(productId: string, approvalStage: "CANDIDATE" | "APPROVED" | "SKIPPED" = "CANDIDATE") {
  const creator = await getDefaultCreator();
  return db.deal.create({
    data: { productId, creatorId: creator.id, approvalStage, salePrice: 40000 },
  });
}

describe("deleteDeals — 딜 탭 체크박스 삭제", () => {
  it("선택한 딜만 지운다 — 상품·다른 딜은 그대로 둔다", async () => {
    const product = await makeProduct();
    const keep = await makeDeal(product.id, "CANDIDATE");
    const remove = await makeDeal(product.id, "SKIPPED");

    const result = await deleteDeals([remove.id]);

    expect(result.dealCount).toBe(1);
    expect(result.orphanedProductCount).toBe(0); // keep 딜이 남아 있어 상품은 안 지워진다
    expect(await db.deal.findUnique({ where: { id: remove.id } })).toBeNull();
    expect(await db.deal.findUnique({ where: { id: keep.id } })).not.toBeNull();
    expect(await db.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it("마지막 딜을 지우면서 활성 워치도 없으면 상품까지 함께 지운다", async () => {
    const product = await makeProduct();
    const deal = await makeDeal(product.id, "SKIPPED");

    const result = await deleteDeals([deal.id]);

    expect(result.orphanedProductCount).toBe(1);
    expect(await db.product.findUnique({ where: { id: product.id } })).toBeNull();
  });

  it("딜을 지워도 활성 워치가 있으면 상품은 남긴다 — '가격만 지켜보기'는 별개 의사다", async () => {
    const product = await makeProduct();
    const deal = await makeDeal(product.id, "SKIPPED");
    await db.watchItem.create({
      data: { productId: product.id, expiresAt: new Date(Date.now() + 1_000_000), checkAfter: new Date() },
    });

    await deleteDeals([deal.id]);

    expect(await db.product.findUnique({ where: { id: product.id } })).not.toBeNull();
    expect(await db.watchItem.findUnique({ where: { productId: product.id } })).not.toBeNull();
  });
});

describe("deleteWatchedProducts — 지켜보는 중 탭 체크박스 삭제", () => {
  it("딜 없는 상품을 지운다 — 그리드 캡처로만 쌓인 대부분의 경우", async () => {
    const product = await makeProduct({ brandName: "우신 스포츠" });
    await db.watchItem.create({
      data: { productId: product.id, expiresAt: new Date(Date.now() + 1_000_000), checkAfter: new Date() },
    });

    const result = await deleteWatchedProducts([product.id]);

    expect(result).toEqual({ productCount: 1, blockedCount: 0 });
    expect(await db.product.findUnique({ where: { id: product.id } })).toBeNull();
    expect(await db.watchItem.findUnique({ where: { productId: product.id } })).toBeNull();
  });

  // 이 테스트가 이 기능의 핵심 안전장치다 — 실패하면 팔로워가 쓰고 있는 링크가 지워질 수 있다.
  it("발행된(APPROVED) 딜이 있으면 상품을 통째로 건너뛴다", async () => {
    const product = await makeProduct();
    await makeDeal(product.id, "APPROVED");

    const result = await deleteWatchedProducts([product.id]);

    expect(result).toEqual({ productCount: 0, blockedCount: 1 });
    expect(await db.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it("발행 전 딜(CANDIDATE·SKIPPED)은 상품과 함께 지운다", async () => {
    const product = await makeProduct();
    await makeDeal(product.id, "CANDIDATE");
    await makeDeal(product.id, "SKIPPED");

    const result = await deleteWatchedProducts([product.id]);

    expect(result).toEqual({ productCount: 1, blockedCount: 0 });
    expect(await db.deal.count({ where: { productId: product.id } })).toBe(0);
  });

  it("여러 개 선택 중 일부만 발행됐으면 그것만 건너뛰고 나머지는 지운다", async () => {
    const blocked = await makeProduct({ brandName: "발행됨" });
    await makeDeal(blocked.id, "APPROVED");
    const removable = await makeProduct({ brandName: "안 발행됨" });
    await db.watchItem.create({
      data: { productId: removable.id, expiresAt: new Date(Date.now() + 1_000_000), checkAfter: new Date() },
    });

    const result = await deleteWatchedProducts([blocked.id, removable.id]);

    expect(result).toEqual({ productCount: 1, blockedCount: 1 });
    expect(await db.product.findUnique({ where: { id: blocked.id } })).not.toBeNull();
    expect(await db.product.findUnique({ where: { id: removable.id } })).toBeNull();
  });
});
