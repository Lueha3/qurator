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
  if (!d.listPrice && !d.salePrice && !d.finalPrice) return "⚠️ 가격 미확인 — [정보 고치기] 필요";
  const effective = d.finalPrice ?? d.salePrice ?? d.listPrice;
  if (d.salePrice != null && d.listPrice > 0 && d.salePrice < d.listPrice) {
    const pct = d.discountRate != null ? ` (${d.discountRate}%)` : "";
    return `${formatKRW(d.listPrice)} → ${formatKRW(effective)}${pct}`;
  }
  return formatKRW(effective || d.listPrice);
}
