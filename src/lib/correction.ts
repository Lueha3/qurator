/**
 * 카톡에 붙여넣을 안내문 — **팔로워가 읽는 글**이라 renderer 본문과 같은 취급이다(고지 원칙 그대로).
 * 홈(dashboard.ts)과 딜 시트(품절 표시 직후)가 같은 문장을 쓴다.
 *
 * 사유별로 나눈다 (2026-09-18, 사용자 결정 — docs/08 §4.0.7). 예전에는 셋 다 "품절되었습니다"로
 * 나갔는데, 쿠폰만 끝난 상품에 "품절"이라고 공지하면 **팔로워에게 틀린 말을 하는 것**이고
 * 그 상품은 아직 팔리고 있으므로 살 기회를 뺏는 것이기도 하다.
 *
 * 세 사유 모두 "링크를 눌러도 소용없다"는 점은 같아서, 그 한 줄은 공통으로 둔다.
 */
export type DeadReason = "SOLDOUT" | "DEAD" | "COUPON_EXPIRED";

export function correctionText(
  brand: string,
  productName: string,
  reason: DeadReason = "SOLDOUT"
): string {
  const item = `${brand} ${productName}`;
  switch (reason) {
    case "COUPON_EXPIRED":
      // 상품은 살아 있고 쿠폰만 끝났다 — "품절"이라고 하면 거짓이다.
      return `[쿠폰 종료 안내] ${item} 쿠폰이 끝났습니다. 상품은 그대로 있지만 알려드린 가격으로는 살 수 없어요. 다음에 더 좋은 가격으로 찾아뵙겠습니다!`;
    case "DEAD":
      // 상품 페이지 자체가 사라졌다 — 품절인지 내려간 것인지 우리는 모른다. 아는 것만 말한다.
      return `[판매 종료 안내] ${item} 상품 페이지가 내려갔습니다. 링크를 눌러도 열리지 않아요. 새 아이템으로 다시 찾아뵙겠습니다!`;
    default:
      return `[품절 안내] ${item} 은(는) 품절되었습니다. 링크를 눌러도 구매할 수 없어요. 새 아이템으로 다시 찾아뵙겠습니다!`;
  }
}
