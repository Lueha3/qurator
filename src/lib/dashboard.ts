// 대시보드가 읽는 "지금 사람 손이 필요한 것" 목록. 전부 DB만 읽는다 —
// 새로고침이 무신사 요청을 만들지 않는 것이 불변식이다.

import { db } from "./db";
import { formatKRW } from "./format";

import { correctionText } from "./correction";
export { correctionText };

export interface DeadLinkAlert {
  dealId: string;
  brand: string;
  productName: string;
  /** "89,000원" 같은 표시용 문자열. 가격을 모르면 null */
  priceLabel: string | null;
  health: "SOLDOUT" | "DEAD" | "COUPON_EXPIRED";
  /** 카톡 오픈채팅에 붙여넣을 정정 공지 — 카톡은 이미 나간 메시지를 수정할 수 없다 */
  correction: string;
  confirmedAt: Date | null;
}

/**
 * 발행된 딜 가운데 헬스체커가 죽음을 확정한 링크. 링크허브·노션은 자동으로 내려가지만
 * 카톡 오픈채팅은 사람이 정정문을 붙여넣어야 한다 — 그래서 대시보드 맨 위에 띄운다.
 */
export async function loadDeadLinkAlerts(): Promise<DeadLinkAlert[]> {
  const deals = await db.deal.findMany({
    where: {
      status: "PUBLISHED",
      curatorLinks: { some: { health: { in: ["SOLDOUT", "DEAD", "COUPON_EXPIRED"] } } },
    },
    include: {
      product: true,
      curatorLinks: {
        where: { health: { in: ["SOLDOUT", "DEAD", "COUPON_EXPIRED"] } },
        orderBy: { healthCheckedAt: "desc" },
        take: 1,
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  return deals.map((deal) => {
    const link = deal.curatorLinks[0];
    const price = deal.finalPrice ?? deal.salePrice ?? deal.product.listPrice;
    return {
      dealId: deal.id,
      brand: deal.product.brandName,
      productName: deal.product.productName,
      priceLabel: price > 0 ? formatKRW(price) : null,
      health: link.health as DeadLinkAlert["health"],
      correction: correctionText(deal.product.brandName, deal.product.productName),
      confirmedAt: link.healthCheckedAt,
    };
  });
}
