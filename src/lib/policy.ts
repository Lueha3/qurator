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
} as const;

export type PolicyKey = keyof typeof HARD_CAP | "killSwitch" | "shortlinkMode";

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
