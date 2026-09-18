import { formatKRW } from "./format";
import type { DealDTO } from "./api-types";

/**
 * 딜 한 건의 가격 줄. 목록(행)과 카드(시트)가 같은 문자열을 쓴다 —
 * 같은 딜이 두 자리에서 다르게 보이면 어느 쪽이 맞는지 알 수 없다.
 *
 * 가격을 못 읽었을 때 0원을 찍으면 그대로 광고 고지와 함께 오픈채팅에 나갈 수 있으므로,
 * 사실 필드가 비었다는 것을 사람이 반드시 보게 한다.
 */
export function dealPriceLine(d: DealDTO): string {
  if (!d.listPrice && !d.salePrice && !d.finalPrice) return "⚠️ 가격을 못 읽었어요 — 아래 ‘정보 고치기’로 채워주세요";
  const effective = d.finalPrice ?? d.salePrice ?? d.listPrice;
  if (d.salePrice != null && d.listPrice > 0 && d.salePrice < d.listPrice) {
    const pct = d.discountRate != null ? ` (${d.discountRate}%)` : "";
    return `${formatKRW(d.listPrice)} → ${formatKRW(effective)}${pct}`;
  }
  return formatKRW(effective || d.listPrice);
}

export interface PriceParts {
  /** 실제로 내는 가격. 못 읽었으면 null */
  effective: number | null;
  /** 취소선으로 보여줄 정가. 할인이 아니면 null */
  list: number | null;
  /** 배지로 보여줄 할인율. **스크린샷에서 읽은 값만** 쓴다 — 두 가격으로 역산하지 않는다.
   * 역산한 숫자가 카톡에 나간 카드 문구와 다르면 어느 쪽이 맞는지 알 수 없다. */
  discountRate: number | null;
  missing: boolean;
}

/**
 * 목록 행이 가격을 세 조각(현재가·정가·할인율)으로 나눠 그리기 위한 것.
 * 판단 규칙은 dealPriceLine과 정확히 같다 — 같은 딜이 줄과 시트에서 다른 값을 보이면 안 된다.
 */
export function dealPriceParts(d: DealDTO): PriceParts {
  if (!d.listPrice && !d.salePrice && !d.finalPrice) {
    return { effective: null, list: null, discountRate: null, missing: true };
  }
  const effective = d.finalPrice ?? d.salePrice ?? d.listPrice;
  const discounted = d.salePrice != null && d.listPrice > 0 && d.salePrice < d.listPrice;
  return {
    effective: effective || d.listPrice,
    list: discounted ? d.listPrice : null,
    discountRate: discounted ? d.discountRate : null,
    missing: false,
  };
}
