// 정책 시트 — docs/02-architecture.md §13의 코드 측 정본.
//
// 원칙 (docs/02 §13): "여기 없는 수치를 코드에 하드코딩하지 않는다."
// 그리고 docs/03 §4.2의 이중화: DB 설정 + 코드 하드캡. 둘 중 **더 보수적인 값**이 이긴다.
// 즉 DB를 조작해도 하드캡보다 느슨해질 수 없다 — 설정 실수나 오염이 계정을 위험에 빠뜨리지 못하게.

import { db } from "./db";

/** 코드 하드캡. DB 값이 이보다 느슨하면 무시된다. */
export const HARD_CAP = {
  /** 무신사로 나가는 전역 일일 요청 상한 (헬스체크 포함) */
  fetchDailyMax: 600,
  /** 요청 간 최소 간격(ms). 실제 간격 = 이 값 + 지터 */
  fetchMinIntervalMs: 5_000,
  /** 지터 상한(ms) */
  fetchJitterMaxMs: 5_000,
  /** 시간당 상한 */
  fetchHourlyMax: 60,
  /** 단일 응답 최대 바이트 — 초과 시 중단 */
  fetchMaxBytes: 3_000_000,
  /** 단일 요청 타임아웃(ms) */
  fetchTimeoutMs: 12_000,
  /** 리다이렉트 최대 추적 횟수 (각 홉마다 가드 전체 재실행) */
  fetchMaxRedirects: 3,

  // ── BF 가격 워치 (docs/05-price-watch.md §3.2) ──
  /** 동시 추적 상품 상한. [02 §13]의 추적 상한 200개의 15% — "현표가 직접 고른 소수"를 수치로 강제 */
  watchItemsMax: 30,
  /** 한 사이클 최대 조회 수 */
  watchPerRunMax: 30,
  /** 같은 상품 재조회 최소 간격(ms). 하루 1회 — 일 1회 크론이 지터로 밀려도 놓치지 않게 20h */
  watchMinIntervalMs: 20 * 3_600_000,
  /** 행사 창(BF) 기간의 재조회 최소 간격(ms). 하루 2회 */
  watchEventIntervalMs: 10 * 3_600_000,
} as const;

export type PolicyKey = keyof typeof HARD_CAP | "killSwitch" | "shortlinkMode" | "crawlessMode";

/** DB 오버라이드를 읽되, 하드캡보다 느슨해지지 않도록 조인다. */
async function readNumeric(key: keyof typeof HARD_CAP): Promise<number> {
  const cap = HARD_CAP[key];
  try {
    const row = await db.policy.findUnique({ where: { key } });
    if (!row) return cap;
    const parsed = Number(row.value);
    if (!Number.isFinite(parsed) || parsed < 0) return cap;
    // 상한류(Max)는 작을수록 보수적, 간격류(Interval)는 클수록 보수적.
    const conservativeIsSmaller = key.endsWith("Max") || key.endsWith("MaxBytes") || key.endsWith("Redirects");
    return conservativeIsSmaller ? Math.min(parsed, cap) : Math.max(parsed, cap);
  } catch {
    // DB를 못 읽으면 가장 보수적인 값으로 — 정책 조회 실패가 가드 해제로 이어지면 안 된다.
    return cap;
  }
}

export async function getLimits() {
  const [dailyMax, hourlyMax, minIntervalMs, jitterMaxMs, maxBytes, timeoutMs, maxRedirects] =
    await Promise.all([
      readNumeric("fetchDailyMax"),
      readNumeric("fetchHourlyMax"),
      readNumeric("fetchMinIntervalMs"),
      readNumeric("fetchJitterMaxMs"),
      readNumeric("fetchMaxBytes"),
      readNumeric("fetchTimeoutMs"),
      readNumeric("fetchMaxRedirects"),
    ]);
  return { dailyMax, hourlyMax, minIntervalMs, jitterMaxMs, maxBytes, timeoutMs, maxRedirects };
}

/** BF 워치 규율 (docs/05 §3.2). 하드캡 이중화는 위와 동일 — DB로 느슨하게 만들 수 없다. */
export async function getWatchLimits() {
  const [itemsMax, perRunMax, minIntervalMs, eventIntervalMs] = await Promise.all([
    readNumeric("watchItemsMax"),
    readNumeric("watchPerRunMax"),
    readNumeric("watchMinIntervalMs"),
    readNumeric("watchEventIntervalMs"),
  ]);
  return { itemsMax, perRunMax, minIntervalMs, eventIntervalMs };
}

/**
 * 글로벌 킬 스위치 (docs/03 §6.2). 켜져 있으면 모든 아웃바운드 요청이 즉시 거부된다.
 * 조회 실패 시 false(=정상 동작)를 반환한다: DB 장애로 전체 기능이 멈추는 것보다,
 * 이미 승인 게이트 뒤에 있는 요청이 진행되는 편이 낫다. 킬 스위치는 사람이 명시적으로 켜는 것이다.
 */
export async function isKillSwitchOn(): Promise<boolean> {
  try {
    const row = await db.policy.findUnique({ where: { key: "killSwitch" } });
    return row?.value === "on";
  } catch {
    return false;
  }
}

export async function setKillSwitch(on: boolean, note?: string) {
  await db.policy.upsert({
    where: { key: "killSwitch" },
    update: { value: on ? "on" : "off", note },
    create: { key: "killSwitch", value: on ? "on" : "off", note },
  });
}

/**
 * 크롤리스 모드 (docs/05 §3.4). 켜져 있으면 워치 러너는 무신사에 요청을 **한 건도** 보내지 않고,
 * 사람에게 보내는 리마인더(src/lib/watch-remind.ts)가 그 자리를 대신한다.
 *
 * 기본값이 `on`인 것이 이 스위치의 핵심이다. docs/05 §9.1에서 무신사 robots.txt가
 * 와일드카드 그룹(`User-agent: *` → `Disallow: /`)으로 우리 UA(HoneyFlowBot)를 전 경로 차단함이
 * 실측 확정됐다. 게이트(§3.3)를 통과했다는 기록 없이 러너가 도는 일을 코드가 막는다 —
 * 끄는 것은 사람의 명시적 행위여야 한다.
 *
 * killSwitch와 기본값 방향이 반대인 이유: 저쪽은 "평시 정상"이 기본이고, 이쪽은
 * **실측으로 차단이 확정된 상태**가 기본이다. DB를 못 읽으면 켜진 것으로 본다(요청을 보내지 않는다).
 */
export async function isCrawlessMode(): Promise<boolean> {
  try {
    const row = await db.policy.findUnique({ where: { key: "crawlessMode" } });
    return row?.value !== "off";
  } catch {
    return true;
  }
}

/** 크롤리스 해제는 §3.3 게이트 실측을 §9에 기록한 뒤에만 한다. note에 그 근거를 남긴다. */
export async function setCrawlessMode(on: boolean, note?: string) {
  await db.policy.upsert({
    where: { key: "crawlessMode" },
    update: { value: on ? "on" : "off", note },
    create: { key: "crawlessMode", value: on ? "on" : "off", note },
  });
}
