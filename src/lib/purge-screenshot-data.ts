// 스크린샷 테스트 데이터 전량 삭제 — 2026-09-20, 사용자 결정.
//
// Vision 캡처를 붙이고 크레딧 문제를 고치는 동안 쌓인 상품·딜·가격기록은 전부 테스트로
// 만들어진 것이다("지금까지 사진을 올리면서 만들어진 모든 데이터"). 출시 전 한 번 걷어내고
// 깨끗한 상태에서 시작하기 위한 **1회용** 정리다 — dedupe.ts와 달리 상태를 바꾸는 게 아니라
// 실제로 지운다.
//
// 대상 판정: `Product.source === "SCREENSHOT"` (docs/06 스크린샷 캡처로 만들어진 상품에만 붙는
// 마킹, schema.prisma CaptureSource 참고). 그 상품에 매달린 것(딜·가격기록·워치·링크·발행이력)을
// 전부 함께 지운다 — Product가 사라지면 FK가 남을 수 없기 때문이다.
//
// 건드리지 않는 것: Creator(계정 자체) · Passkey류(로그인) · PushSubscription · Policy ·
// AuditLog(append-only, 삭제 경로를 만들지 않는다는 §11 규칙) · FetchLog · HubVisit · CircuitState.
//
// 순서가 중요하다 — 자식부터 지워야 FK 위반이 안 난다:
// ClickEvent → ShortLink → Post → ContentCard → CuratorLink → Deal → PriceSnapshot →
// WatchItem → ProductVariant → Product.

import { db } from "./db";
import { audit } from "./audit";

export interface PurgePlan {
  productCount: number;
  dealCount: number;
  priceSnapshotCount: number;
  watchItemCount: number;
  curatorLinkCount: number;
  contentCardCount: number;
  postCount: number;
  shortLinkCount: number;
  clickEventCount: number;
  /** 화면·CLI에 그대로 찍을 상품 목록 — 뭐가 지워지는지 사람이 눈으로 확인할 수 있게 */
  products: { brandName: string; productName: string; dealCount: number }[];
}

async function targetProductIds(): Promise<string[]> {
  const products = await db.product.findMany({
    where: { source: "SCREENSHOT" },
    select: { id: true },
  });
  return products.map((p) => p.id);
}

/** 계획만 계산한다 — **아무것도 바꾸지 않는다.** */
export async function planPurge(): Promise<PurgePlan> {
  const productIds = await targetProductIds();
  if (productIds.length === 0) {
    return {
      productCount: 0,
      dealCount: 0,
      priceSnapshotCount: 0,
      watchItemCount: 0,
      curatorLinkCount: 0,
      contentCardCount: 0,
      postCount: 0,
      shortLinkCount: 0,
      clickEventCount: 0,
      products: [],
    };
  }

  const [products, deals, priceSnapshotCount, watchItemCount] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds } },
      select: {
        brandName: true,
        productName: true,
        _count: { select: { deals: true } },
      },
    }),
    db.deal.findMany({
      where: { productId: { in: productIds } },
      select: { id: true },
    }),
    db.priceSnapshot.count({ where: { productId: { in: productIds } } }),
    db.watchItem.count({ where: { productId: { in: productIds } } }),
  ]);

  const dealIds = deals.map((d) => d.id);
  const [curatorLinkCount, contentCardCount, postCount, shortLinks] = await Promise.all([
    db.curatorLink.count({ where: { dealId: { in: dealIds } } }),
    db.contentCard.count({ where: { dealId: { in: dealIds } } }),
    db.post.count({ where: { dealId: { in: dealIds } } }),
    db.shortLink.findMany({ where: { dealId: { in: dealIds } }, select: { id: true } }),
  ]);

  const clickEventCount = shortLinks.length
    ? await db.clickEvent.count({ where: { shortLinkId: { in: shortLinks.map((s) => s.id) } } })
    : 0;

  return {
    productCount: products.length,
    dealCount: dealIds.length,
    priceSnapshotCount,
    watchItemCount,
    curatorLinkCount,
    contentCardCount,
    postCount,
    shortLinkCount: shortLinks.length,
    clickEventCount,
    products: products.map((p) => ({
      brandName: p.brandName,
      productName: p.productName,
      dealCount: p._count.deals,
    })),
  };
}

/**
 * 계획을 실제로 적용한다. 계획은 여기서 **다시 계산한다** — 호출 사이에 새 캡처가 들어왔을 수
 * 있고, 그 새 상품까지 지우는 게 맞다(여전히 SCREENSHOT 소스라면).
 */
export async function applyPurge(): Promise<PurgePlan> {
  const plan = await planPurge();
  if (plan.productCount === 0) return plan;

  const productIds = await targetProductIds();
  const deals = await db.deal.findMany({
    where: { productId: { in: productIds } },
    select: { id: true },
  });
  const dealIds = deals.map((d) => d.id);
  const shortLinks = await db.shortLink.findMany({
    where: { dealId: { in: dealIds } },
    select: { id: true },
  });
  const shortLinkIds = shortLinks.map((s) => s.id);

  // 하나의 트랜잭션으로 — 중간에 끊기면 절반만 지워진 고아 행이 남는다.
  await db.$transaction([
    db.clickEvent.deleteMany({ where: { shortLinkId: { in: shortLinkIds } } }),
    db.shortLink.deleteMany({ where: { dealId: { in: dealIds } } }),
    db.post.deleteMany({ where: { dealId: { in: dealIds } } }),
    db.contentCard.deleteMany({ where: { dealId: { in: dealIds } } }),
    db.curatorLink.deleteMany({ where: { dealId: { in: dealIds } } }),
    db.deal.deleteMany({ where: { id: { in: dealIds } } }),
    db.priceSnapshot.deleteMany({ where: { productId: { in: productIds } } }),
    db.watchItem.deleteMany({ where: { productId: { in: productIds } } }),
    db.productVariant.deleteMany({ where: { productId: { in: productIds } } }),
    db.product.deleteMany({ where: { id: { in: productIds } } }),
  ]);

  // 삭제 자체는 audit_log에 남긴다(§11 — 삭제 경로가 없는 건 audit_log 테이블이지, 이 동작을
  // 기록하지 말라는 뜻이 아니다). approvalRef는 FK가 아니므로 지워진 딜 id를 그대로 남겨도 안전하다.
  await audit({
    actor: "HUMAN",
    action: "data.purged_screenshot_test_data",
    detail: `테스트 데이터 전량 삭제 — 상품 ${plan.productCount}개 · 딜 ${plan.dealCount}개 · 가격기록 ${plan.priceSnapshotCount}건`,
  });

  return plan;
}
