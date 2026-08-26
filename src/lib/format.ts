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
