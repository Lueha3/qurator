// 지켜보는 상품 목록 — docs/06 §4.6.
//
// 딜 목록(deal-list.ts)과 **다른 축**이다. 딜은 "올릴지 판단하는 카드"이고, 이쪽은 "값을 지켜보는
// 상품"이다. 좋아요 목록을 통째로 담으면 딜 없이 상품만 300개가 생기므로, 딜 목록으로는 그 300개가
// 화면에 아예 보이지 않는다 — 이 함수가 그 목록을 만든다.
//
// 딜이 이미 있는 상품은 그 딜로 이어준다(dealId). 없으면 [올릴게요]를 누르는 순간 만들어진다.
//
// DB만 읽는다. 이 계산이 무신사 요청을 만들지 않는 것이 불변식이다.

import { db } from "./db";
import { buildPriceAnalyses } from "./price-analysis";

export interface WatchedProductDTO {
  productId: string;
  /**
   * 상품이 등록된 순서(DB 시퀀스). 그리드를 왼쪽 위→오른쪽, 줄 단위로 읽은 순서와 같다
   * (2026-09-20, 사용자 요청) — 목록이 어떤 기준으로 정렬돼도 이 번호로 원래 화면 위치를
   * 되짚을 수 있다.
   */
  registrationNo: number;
  brandName: string;
  productName: string;
  /** 마지막으로 기록된 가격. 한 번도 못 읽었으면 null */
  price: number | null;
  /** 지난번 기록 가격 — 이번에 내렸을 때만 채워진다(오른 경우는 배지를 띄우지 않는다) */
  priceBefore: number | null;
  /** 내린 폭(%) — priceBefore가 있을 때만 */
  dropRate: number | null;
  /** 지금까지 기록한 횟수 */
  recordCount: number;
  /**
   * 화면에 찍힌 할인율(%) — 최신 기록 기준. dropRate(지난 기록 대비 내림폭)와는 다른 값이다:
   * 이건 무신사가 그 순간 표시한 정가 대비 할인율을 그대로 옮긴 것뿐이다.
   */
  discountRateShown: number | null;
  /** 이 상품으로 이미 만든 딜. 있으면 그 카드로 바로 간다 */
  dealId: string | null;
  /** 마지막 기록 시각 */
  lastRecordedAt: string | null;
}

/**
 * 지켜보는 상품 전부. **기본 정렬은 등록순**(registrationNo 오름차순) — 그리드를 찍은
 * 순서 그대로 목록에 나온다. "싸진 것부터" 정렬은 화면(DealBrowser)에서 사람이 토글로
 * 켠다 — 이미 모든 필드(dropRate 등)가 여기 담겨 있어 다시 조회할 필요가 없다.
 *
 * 딜 연결은 **끝나지 않은 딜**만 본다 — 이미 올렸거나 안 올리기로 한 딜로 보내면, 같은 상품을
 * 다시 판단하려는 사람을 끝난 카드에 떨어뜨리게 된다. 그 경우는 딜 없는 것과 같이 취급해
 * [올릴게요]가 새 판단을 시작하게 한다.
 */
export async function loadWatchedProducts(now: Date = new Date()): Promise<WatchedProductDTO[]> {
  const watches = await db.watchItem.findMany({
    where: { active: true, expiresAt: { gt: now } },
    include: { product: true },
  });
  if (watches.length === 0) return [];

  const productIds = watches.map((w) => w.productId);
  const [analyses, openDeals] = await Promise.all([
    buildPriceAnalyses(productIds, now),
    db.deal.findMany({
      where: {
        productId: { in: productIds },
        approvalStage: { in: ["CANDIDATE", "AWAITING_LINK", "READY_TO_PUBLISH"] },
      },
      select: { id: true, productId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const dealByProduct = new Map<string, string>();
  for (const deal of openDeals) {
    if (!dealByProduct.has(deal.productId)) dealByProduct.set(deal.productId, deal.id);
  }

  const rows = watches.map((watch): WatchedProductDTO => {
    const analysis = analyses.get(watch.productId);
    const price = analysis?.current?.salePrice ?? null;
    const before = analysis?.previous?.salePrice ?? null;
    const dropped = price !== null && before !== null && price < before;

    return {
      productId: watch.productId,
      registrationNo: watch.product.registrationNo,
      brandName: watch.product.brandName,
      productName: watch.product.productName,
      price,
      priceBefore: dropped ? before : null,
      dropRate: dropped ? Math.round(((before - price) / before) * 100) : null,
      recordCount: analysis?.snapshotCount ?? 0,
      discountRateShown: analysis?.current?.discountRateShown ?? null,
      dealId: dealByProduct.get(watch.productId) ?? null,
      lastRecordedAt: analysis?.current?.capturedAt.toISOString() ?? null,
    };
  });

  return rows.sort((a, b) => a.registrationNo - b.registrationNo);
}
