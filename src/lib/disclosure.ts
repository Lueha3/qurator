// 공정위 고지 표준 — docs/03-account-safety.md §10 정본 문구를 그대로 상수화한다.
// 이 파일은 렌더러(주입, 1차 방어)와 API 검증 게이트(verifyDisclosure, 2차 방어)가
// "같은 문자열"을 공유하도록 하는 단일 정본이다. 절대 변형하지 않는다 — off 옵션은 없다.

import type { Channel } from "@prisma/client";

export const DISCLOSURE: Record<Channel, string> = {
  KAKAO_OPEN: "(광고) 아래 링크로 구매 시 수수료를 받습니다",
  THREADS: "[광고] 큐레이터 링크 — 구매 시 수수료를 받습니다",
  INSTAGRAM_COMMENT: "[광고] 아래 링크로 구매 시 수수료를 받습니다",
  NOTION: "(광고) 아래 링크로 구매 시 수수료를 받습니다",
};

/**
 * 2차 방어(검증 게이트): bodyText가 실제로 정확한 고지 문구로 "시작"하는지 독립적으로 재확인한다.
 * 렌더러가 무엇을 했든 상관없이, 이 함수가 false를 반환하면 발행·복사 API는 422로 거부해야 한다.
 * (docs/03 §10의 "3중 방어" 중 2단계 — 렌더러 주입과 이 검증은 서로 다른 코드 경로다.)
 */
export function verifyDisclosure(channel: Channel, bodyText: string): boolean {
  return bodyText.startsWith(DISCLOSURE[channel]);
}
