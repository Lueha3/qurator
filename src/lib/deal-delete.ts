// 딜 선택 삭제 — 딜 탭 체크박스 다중 선택에서 쓴다 (2026-09-20).
//
// dedupe.ts(중복을 '안 올림'으로 옮기기)·purge-screenshot-data.ts(스크린샷 출처 전체 삭제)와
// 다르다: 이건 **사람이 화면에서 직접 고른** 딜만, **실제로** 지운다. 인코딩이 깨져 상품명을
// 읽을 수 없는 경우처럼 앞의 두 도구로는 못 잡는 것들을 지우기 위한 것이다.
//
// 딜만 지우고 Product는 남기는 게 기본이다 — 같은 상품에 다른 딜이 남아 있으면 그 딜이 가격
// 기록(Product.priceSnapshots)을 계속 쓴다. **활성 워치(지켜보는 중)가 있는 상품도 남긴다** —
// "가격만 지켜보기"는 사람이 따로 누른 명시적 의사라 딜 하나 지운다고 같이 꺼지면 안 된다.
// 둘 다 해당 없을 때만(남은 딜 0 · 활성 워치 없음) Product까지 함께 지운다 — 안 그러면
// 아무 딜에서도 안 보이는 유령 상품·가격기록이 DB에 쌓인다.

import { db } from "./db";
import { audit } from "./audit";

export interface DeleteDealsResult {
  dealCount: number;
  /** 함께 지워진 상품(이번 삭제로 남은 딜도 활성 워치도 없어진 것들) */
  orphanedProductCount: number;
}

export async function deleteDeals(dealIds: string[]): Promise<DeleteDealsResult> {
  const ids = [...new Set(dealIds)].filter(Boolean);
  if (ids.length === 0) return { dealCount: 0, orphanedProductCount: 0 };

  const deals = await db.deal.findMany({
    where: { id: { in: ids } },
    select: { id: true, productId: true },
  });
  if (deals.length === 0) return { dealCount: 0, orphanedProductCount: 0 };

  const realIds = deals.map((d) => d.id);
  const productIds = [...new Set(deals.map((d) => d.productId))];

  const shortLinks = await db.shortLink.findMany({
    where: { dealId: { in: realIds } },
    select: { id: true },
  });
  const shortLinkIds = shortLinks.map((s) => s.id);

  await db.$transaction([
    db.clickEvent.deleteMany({ where: { shortLinkId: { in: shortLinkIds } } }),
    db.shortLink.deleteMany({ where: { dealId: { in: realIds } } }),
    db.post.deleteMany({ where: { dealId: { in: realIds } } }),
    db.contentCard.deleteMany({ where: { dealId: { in: realIds } } }),
    db.curatorLink.deleteMany({ where: { dealId: { in: realIds } } }),
    db.deal.deleteMany({ where: { id: { in: realIds } } }),
  ]);

  // 이번 삭제 뒤 다시 센다 — 그 사이 값이 바뀌었을 수 있어 트랜잭션 전 값을 믿지 않는다.
  const [remainingDeals, activeWatches] = await Promise.all([
    db.deal.findMany({ where: { productId: { in: productIds } }, select: { productId: true } }),
    db.watchItem.findMany({
      where: { productId: { in: productIds }, active: true },
      select: { productId: true },
    }),
  ]);
  const stillHasDeal = new Set(remainingDeals.map((d) => d.productId));
  const stillWatched = new Set(activeWatches.map((w) => w.productId));
  const orphanedProductIds = productIds.filter((id) => !stillHasDeal.has(id) && !stillWatched.has(id));

  if (orphanedProductIds.length > 0) {
    await db.$transaction([
      db.priceSnapshot.deleteMany({ where: { productId: { in: orphanedProductIds } } }),
      db.watchItem.deleteMany({ where: { productId: { in: orphanedProductIds } } }),
      db.productVariant.deleteMany({ where: { productId: { in: orphanedProductIds } } }),
      db.product.deleteMany({ where: { id: { in: orphanedProductIds } } }),
    ]);
  }

  await audit({
    actor: "HUMAN",
    action: "deal.deleted",
    detail:
      `딜 ${realIds.length}개 선택 삭제` +
      (orphanedProductIds.length > 0 ? ` · 상품 ${orphanedProductIds.length}개 함께 삭제` : ""),
  });

  return { dealCount: realIds.length, orphanedProductCount: orphanedProductIds.length };
}
