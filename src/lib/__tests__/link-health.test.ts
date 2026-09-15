import { beforeEach, describe, expect, it } from "vitest";

// 사람이 표시하는 품절. 이 경로가 지키는 약속은 팔로워에게 한 것이다 —
// "품절된 상품은 목록에서 내려갑니다". 그래서 표시했을 때 **허브 쿼리에서 실제로 빠지는지**와
// **이미 나간 링크가 커미션 URL로 가지 않는지**를 본다.

const { db } = await import("../db");
const { markSoldOut, restoreDeal } = await import("../link-health");

async function resetDb() {
  await db.clickEvent.deleteMany();
  await db.hubVisit.deleteMany();
  await db.shortLink.deleteMany();
  await db.post.deleteMany();
  await db.contentCard.deleteMany();
  await db.curatorLink.deleteMany();
  await db.deal.deleteMany();
  await db.priceSnapshot.deleteMany();
  await db.watchItem.deleteMany();
  await db.product.deleteMany();
  await db.creator.deleteMany();
  await db.auditLog.deleteMany();
}

/** 발행까지 끝난 딜 — 허브에 실릴 조건(살아있는 링크 + hub 숏링크)을 갖춘 상태 */
async function publishedDeal() {
  const creator = await db.creator.create({ data: { handle: `soldout_${Date.now()}` } });
  const product = await db.product.create({
    data: {
      creatorId: creator.id,
      musinsaGoodsNo: "700001",
      canonicalUrl: "https://www.musinsa.com/products/700001",
      brandName: "쿠어",
      productName: "오버셔츠",
      listPrice: 89000,
    },
  });
  const deal = await db.deal.create({
    data: { productId: product.id, creatorId: creator.id, status: "PUBLISHED", approvalStage: "APPROVED" },
  });
  const link = await db.curatorLink.create({
    data: { dealId: deal.id, rawUrl: "https://www.musinsa.com/products/700001?utm_term=x" },
  });
  // 지면 두 곳에 나갔다고 본다 — 허브와 카톡
  for (const surface of ["hub", "kakao_open"]) {
    await db.shortLink.create({
      data: {
        code: `c${surface}${Math.random().toString(36).slice(2, 6)}`,
        dealId: deal.id,
        curatorLinkId: link.id,
        surface,
        targetUrl: link.rawUrl,
      },
    });
  }
  return { deal, link };
}

/** 링크허브가 실제로 쓰는 조건 그대로 (src/app/hub/page.tsx) */
function hubVisible(now: Date) {
  return db.deal.count({
    where: {
      status: "PUBLISHED",
      curatorLinks: { some: { health: { in: ["OK", "UNCHECKED"] } } },
      shortLinks: { some: { state: "ACTIVE", surface: "hub" } },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("사람이 표시하는 품절", () => {
  it("표시하면 허브 목록에서 빠진다", async () => {
    const { deal } = await publishedDeal();
    expect(await hubVisible(new Date())).toBe(1);

    const result = await markSoldOut(deal.id);
    expect(result.ok).toBe(true);
    expect(await hubVisible(new Date())).toBe(0);
  });

  it("이미 나간 링크는 전부 DEAD가 된다 — 카톡에 남은 링크까지 한 번에 구제된다", async () => {
    const { deal } = await publishedDeal();
    await markSoldOut(deal.id);

    const links = await db.shortLink.findMany({ where: { dealId: deal.id } });
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.state === "DEAD")).toBe(true);
  });

  it("되돌리면 다시 올라오고 숏링크도 살아난다", async () => {
    const { deal } = await publishedDeal();
    await markSoldOut(deal.id);

    const result = await restoreDeal(deal.id);
    expect(result.ok).toBe(true);
    expect(await hubVisible(new Date())).toBe(1);
    const links = await db.shortLink.findMany({ where: { dealId: deal.id } });
    expect(links.every((l) => l.state === "ACTIVE")).toBe(true);
  });

  it("되돌린 링크는 OK가 아니라 UNCHECKED다 — 살아있다고 확인한 적이 없다", async () => {
    const { deal, link } = await publishedDeal();
    await markSoldOut(deal.id);
    await restoreDeal(deal.id);

    const after = await db.curatorLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(after.health).toBe("UNCHECKED");
    expect(after.soldoutStreak).toBe(0);
  });

  it("링크가 없는 딜은 표시할 수 없다", async () => {
    const creator = await db.creator.create({ data: { handle: `nolink_${Date.now()}` } });
    const product = await db.product.create({
      data: {
        creatorId: creator.id,
        canonicalUrl: "https://www.musinsa.com/products/700002",
        brandName: "쿠어",
        productName: "링크 없는 딜",
        listPrice: 10000,
      },
    });
    const deal = await db.deal.create({ data: { productId: product.id, creatorId: creator.id } });

    const result = await markSoldOut(deal.id);
    expect(result).toEqual({ ok: false, reason: "붙어 있는 큐레이터 링크가 없습니다." });
  });

  it("사람이 한 일로 감사 로그에 남는다 — 제재 소명의 증적이다", async () => {
    const { deal } = await publishedDeal();
    await markSoldOut(deal.id);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "health.soldout_marked" } });
    expect(log.actor).toBe("HUMAN");
    expect(log.approvalRef).toBe(deal.id);
  });
});
