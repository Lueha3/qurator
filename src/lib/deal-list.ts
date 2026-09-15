// 딜 목록을 DTO로 읽어오는 공통 경로. 홈·딜 탭이 같은 함수를 쓴다.
// DB만 읽는다 — 페이지뷰가 무신사 요청을 만들지 않는 것이 불변식이다(docs/05 §1.1).

import { db } from "./db";
import { DEAL_INCLUDE, toDealDTO } from "./deal-dto";
import { buildPriceAnalyses } from "./price-analysis";
import type { DealDTO } from "./api-types";

/**
 * 딜 탭은 클라이언트에서 필터·검색을 한다(1인 사용자의 딜 수는 수백 건 규모라 서버 페이지네이션이
 * 필요 없다). 그 대신 상한을 둔다 — 넘어가면 오래된 것부터 잘리고, 그건 보관 필터의 몫이다.
 */
export const DEAL_PAGE_SIZE = 300;

export async function loadDeals(
  now: Date = new Date(),
  take: number = DEAL_PAGE_SIZE
): Promise<DealDTO[]> {
  const deals = await db.deal.findMany({
    include: DEAL_INCLUDE,
    orderBy: { createdAt: "desc" },
    take,
  });
  // 가격 이력은 상품 단위다 — 딜마다 쿼리하지 않고 한 번에 읽어 묶는다 (docs/05 §4.6).
  const analyses = await buildPriceAnalyses([...new Set(deals.map((d) => d.productId))], now);
  return deals.map((deal) => toDealDTO(deal, analyses.get(deal.productId), now));
}
