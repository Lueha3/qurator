/**
 * 카톡에 붙여넣을 품절 안내 — 팔로워가 읽는 글이라 renderer 본문과 같은 취급이다(고지 원칙 그대로).
 * 홈(dashboard.ts)과 딜 시트(품절 표시 직후)가 같은 문장을 쓴다.
 */
export function correctionText(brand: string, productName: string): string {
  return `[품절 안내] ${brand} ${productName} 은(는) 품절되었습니다. 링크를 눌러도 구매할 수 없어요. 새 아이템으로 다시 찾아뵙겠습니다!`;
}
