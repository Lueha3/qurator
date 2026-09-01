// 순수 포맷 헬퍼 — 렌더러가 사람이 읽는 문자열을 조립할 때만 사용한다.
// 여기에는 어떤 정책 판단도 없다(가격/할인율 계산은 호출부의 DealFacts가 이미 확정한 값을 그대로 표기).

export function formatKRW(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

const KST_ENDS_AT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const KST_SHORT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23", // hour12 기반 AM/PM 로케일 문자열은 서버/클라이언트 ICU 데이터가 달라
  // "오전"↔"AM"처럼 다르게 렌더될 수 있어 하이드레이션 불일치를 일으킨다. 24시간제로 고정해 회피.
});

/** 딜 생성 시각 등 짧은 타임스탬프 표시용. 서버(SSR)와 클라이언트가 항상 같은 문자열을 낸다. */
export function formatShortDateTime(date: Date): string {
  return KST_SHORT.format(date);
}

/**
 * "3시간 전" 같은 상대 시각. now를 인자로 받는 순수 함수인 이유:
 * 클라이언트가 Date.now()로 다시 계산하면 서버 렌더 결과와 달라져 하이드레이션이 깨진다.
 * 서버에서 한 번 계산해 문자열로 넘기고, 클라이언트는 그 문자열을 그대로 그린다.
 */
export function formatRelativeFromNow(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "방금";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

export function formatEndsAt(endsAt: Date): string {
  // 예: "8/28(금) 23:59"
  const parts = KST_ENDS_AT.formatToParts(endsAt);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const month = get("month");
  const day = get("day");
  const weekday = get("weekday");
  const hour = get("hour");
  const minute = get("minute");
  return `${month}/${day}(${weekday}) ${hour}:${minute}`;
}
