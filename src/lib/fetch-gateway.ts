// Fetch Gateway — 무신사로 나가는 **모든** 아웃바운드 HTTP의 단일 관문.
// docs/02-architecture.md §8.1 + docs/03-account-safety.md §4.
//
// 이 모듈의 존재 이유: 워커가 늘어나도 전역 레이트리밋·차단감지·킬스위치가 한 곳에서 깨지지 않게 하는 것.
// 애플리케이션 코드는 절대 fetch()를 직접 호출하지 않는다 (eslint 규칙으로 강제 — eslint.config.mjs).
//
// 구조적 보증 (코드 리뷰가 아니라 타입/구현이 강제하는 것):
//   1. 호출부는 헤더를 넘길 수 없다. 헤더는 이 파일이 만든다 → Cookie/Authorization이 실릴 경로 자체가 없다.
//   2. 쿠키 저장소가 없다. 응답의 Set-Cookie는 읽지도, 보관하지도, 되돌려 보내지도 않는다.
//   3. 커미션 파라미터가 붙은 URL은 assertFetchable이 하드 abort한다 (자기 클릭 어뷰징 사고 차단).
//   4. 리다이렉트는 자동 추적하지 않는다. 홉마다 가드 전체를 다시 통과해야 한다.

import { lookup } from "node:dns/promises";
import { db } from "./db";
import { getLimits, isKillSwitchOn } from "./policy";
import { assertFetchable, isBlockedAddress } from "./url-guard";
import { decideByOutcome, parseRobots, type RobotsFetchOutcome } from "./robots";
import type { FetchOutcome, FetchTrigger } from "@prisma/client";

/**
 * 정직한 봇 식별 (docs/03 §4.1 식별자 위생).
 * 브라우저로 위장하지 않는다 — 위장은 "보호조치 우회"로 해석될 여지를 만들고,
 * 여기어때 판례가 그어준 안전선 밖으로 나가는 일이다.
 * 연락처에는 현표 계정과 연결되는 어떤 식별자도 넣지 않는다(jenflox/현표/개인 이메일 금지).
 */
export const USER_AGENT = "HoneyFlowBot/1.0 (+https://honeyflow.tools/bot)";

export type GatewayResult =
  | { ok: true; status: number; body: string; finalUrl: string }
  | { ok: false; outcome: FetchOutcome; reason: string };

interface GatewayRequest {
  /** 이미 정규화된 URL. 커미션 파라미터가 남아 있으면 하드 abort된다. */
  url: string;
  trigger: FetchTrigger;
}

// ── 로깅 ────────────────────────────────────────────────────────────────
// 본문은 절대 저장하지 않는다 (docs/03 §11).

async function log(
  entry: {
    url: string;
    trigger: FetchTrigger;
    outcome: FetchOutcome;
    responseCode?: number;
    durationMs?: number;
    bytes?: number;
    detail?: string;
  }
) {
  let host = "unknown";
  try {
    host = new URL(entry.url).hostname;
  } catch {
    /* 파싱 불가 URL도 기록은 남긴다 */
  }
  try {
    await db.fetchLog.create({ data: { ...entry, host } });
  } catch {
    // 로깅 실패가 요청 처리를 막지는 않는다. 다만 조용히 삼키지 않도록 콘솔에는 남긴다.
    console.error("[gateway] fetch_log 기록 실패", entry.url, entry.outcome);
  }
}

function reject(
  url: string,
  trigger: FetchTrigger,
  outcome: FetchOutcome,
  reason: string
): Promise<GatewayResult> {
  return log({ url, trigger, outcome, detail: reason }).then(() => ({
    ok: false as const,
    outcome,
    reason,
  }));
}

// ── 서킷브레이커 ─────────────────────────────────────────────────────────
// docs/03 §6.2·6.3: 자동 정지, 수동 재개 비대칭.
// "오탐의 비용(발행 지연)은 미탐의 비용(계정 정지)보다 압도적으로 싸다."

async function checkCircuit(host: string): Promise<{ open: true; reason: string } | { open: false }> {
  const state = await db.circuitState.findUnique({ where: { host } });
  if (!state) return { open: false };
  if (state.state === "BLOCKED") {
    return {
      open: true,
      reason: `${host} 수집이 차단 상태입니다(사유: ${state.reason ?? "미기록"}). 자동 재개되지 않으며 사람이 해제해야 합니다.`,
    };
  }
  if (state.pausedUntil && state.pausedUntil > new Date()) {
    return {
      open: true,
      reason: `${host} 백오프 중입니다 (${state.pausedUntil.toISOString()}까지).`,
    };
  }
  return { open: false };
}

const BACKOFF_LADDER_MS = [30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];

async function recordFailure(host: string, reason: string, hardBlock: boolean) {
  const existing = await db.circuitState.findUnique({ where: { host } });
  const failures = (existing?.consecutiveFailures ?? 0) + 1;

  if (hardBlock) {
    // 캡차·차단 페이지 감지 → 자동 재개 없음. 뚫지 않고 멈춘다 (Never List 7번).
    await db.circuitState.upsert({
      where: { host },
      update: { state: "BLOCKED", reason, pausedUntil: null, consecutiveFailures: failures },
      create: { host, state: "BLOCKED", reason, consecutiveFailures: failures },
    });
    return;
  }

  const step = BACKOFF_LADDER_MS[Math.min(failures - 1, BACKOFF_LADDER_MS.length - 1)];
  const jitter = step * 0.2 * (Math.random() * 2 - 1); // ±20%
  const pausedUntil = new Date(Date.now() + step + jitter);
  await db.circuitState.upsert({
    where: { host },
    update: { state: "DEGRADED", reason, pausedUntil, consecutiveFailures: failures },
    create: { host, state: "DEGRADED", reason, pausedUntil, consecutiveFailures: failures },
  });
}

async function recordSuccess(host: string) {
  const existing = await db.circuitState.findUnique({ where: { host } });
  if (!existing || existing.state === "BLOCKED") return; // BLOCKED는 성공 한 번으로 풀리지 않는다
  if (existing.consecutiveFailures === 0 && existing.state === "HEALTHY") return;
  await db.circuitState.update({
    where: { host },
    data: { state: "HEALTHY", pausedUntil: null, reason: null, consecutiveFailures: 0 },
  });
}

/** 사람이 명시적으로 서킷을 해제한다 (docs/03 §6.3 복구 런북 ③). */
export async function resumeHost(host: string) {
  await db.circuitState.upsert({
    where: { host },
    update: { state: "HEALTHY", pausedUntil: null, reason: null, consecutiveFailures: 0 },
    create: { host, state: "HEALTHY" },
  });
}

// ── 예산·페이싱 ──────────────────────────────────────────────────────────

async function checkBudget(host: string): Promise<{ blocked: true; reason: string } | { blocked: false; waitMs: number }> {
  const limits = await getLimits();
  const now = Date.now();

  // 예산과 페이싱은 "실제로 네트워크로 나간 요청"을 기준으로 센다.
  // 성공(OK)만 세면 404·타임아웃이 상한을 전혀 소모하지 않아, 실패가 반복될수록 우리가 상대 서버를
  // 더 세게 두드리게 된다. 반대로 가드에서 막혀 나가지도 않은 BLOCKED_*는 세면 안 된다.
  const NETWORK_TOUCHED = {
    notIn: [
      "BLOCKED_POLICY",
      "BLOCKED_ROBOTS",
      "BLOCKED_BUDGET",
      "BLOCKED_CIRCUIT",
    ] as FetchOutcome[],
  };

  const [dayCount, hourCount, last] = await Promise.all([
    db.fetchLog.count({
      where: { outcome: NETWORK_TOUCHED, ts: { gte: new Date(now - 24 * 3_600_000) } },
    }),
    db.fetchLog.count({
      where: { outcome: NETWORK_TOUCHED, host, ts: { gte: new Date(now - 3_600_000) } },
    }),
    db.fetchLog.findFirst({
      where: { host, outcome: NETWORK_TOUCHED },
      orderBy: { ts: "desc" },
      select: { ts: true },
    }),
  ]);

  if (dayCount >= limits.dailyMax) {
    return { blocked: true, reason: `일일 요청 상한(${limits.dailyMax}건)에 도달했습니다.` };
  }
  if (hourCount >= limits.hourlyMax) {
    return { blocked: true, reason: `시간당 요청 상한(${limits.hourlyMax}건)에 도달했습니다.` };
  }

  // 최소 간격 + 지터. 사람 속도를 흉내내는 것이 아니라 상대 서버에 부담을 주지 않기 위한 것.
  const jitter = Math.random() * limits.jitterMaxMs;
  const target = limits.minIntervalMs + jitter;
  const elapsed = last ? now - last.ts.getTime() : Number.POSITIVE_INFINITY;
  const waitMs = Math.max(0, Math.ceil(target - elapsed));
  return { blocked: false, waitMs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── robots.txt ──────────────────────────────────────────────────────────

interface RobotsCacheEntry {
  outcome: RobotsFetchOutcome;
  fetchedAt: number;
}
const robotsCache = new Map<string, RobotsCacheEntry>();
/** RFC 9309: 캐시는 24시간을 넘기지 않는다(SHOULD NOT). "한 번 받아서 영구 캐시"는 금지. */
const ROBOTS_TTL_MS = 24 * 3_600_000;
/** RFC 9309 §2.5: 파서는 최소 500KiB를 처리해야 한다. 그 이상은 잘라도 된다. */
const ROBOTS_MAX_BYTES = 512_000;

async function getRobots(host: string): Promise<RobotsFetchOutcome> {
  const cached = robotsCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached.outcome;

  const started = Date.now();
  const result = await rawFetch(`https://${host}/robots.txt`, "ROBOTS", ROBOTS_MAX_BYTES, 8_000);
  const durationMs = Date.now() - started;

  // robots.txt 조회도 실제로 네트워크로 나간 요청이다 — 예산·감사 대상이므로 기록한다.
  await log({
    url: `https://${host}/robots.txt`,
    trigger: "ROBOTS",
    outcome: result.ok ? "OK" : result.outcome,
    responseCode: result.ok ? result.status : undefined,
    durationMs,
    bytes: result.ok ? result.body.length : undefined,
  });

  // RFC 9309 §2.3.1의 결과 분류. 이 분기를 틀리면 정확히 반대로 동작한다:
  //   2xx → 파싱 / 4xx → 규칙 없음(허용) / 5xx·네트워크 실패 → 전면 금지
  //
  // 단, 4xx 중 403·429는 "규칙이 없다"가 아니라 "차단당하고 있다"는 신호다. 이 둘을 absent로
  // 분류하면 무신사가 우리를 막기 시작하는 바로 그 순간에 robots 가드가 반대로 풀린다 —
  // "차단당하면 뚫지 않고 멈춘다"(docs/03 §9 Never List 7번)의 정반대 동작이다.
  let outcome: RobotsFetchOutcome;
  if (!result.ok) {
    outcome = { kind: "unavailable" };
  } else if (looksLikeBotChallenge(result.status, result.body)) {
    // robots.txt 자리에서 챌린지가 오면 이미 차단이 시작된 것이다. 서킷을 열고 더 두드리지 않는다.
    await recordFailure(host, `robots.txt 조회에서 봇 차단 감지 (HTTP ${result.status})`, true);
    outcome = { kind: "unavailable" };
  } else if (result.status >= 200 && result.status < 300) {
    outcome = { kind: "parsed", rules: parseRobots(result.body) };
  } else if (result.status >= 400 && result.status < 500) {
    outcome = { kind: "absent" };
  } else {
    outcome = { kind: "unavailable" };
  }

  robotsCache.set(host, { outcome, fetchedAt: Date.now() });
  return outcome;
}

/** 테스트·운영 편의를 위한 캐시 초기화 */
export function clearRobotsCache() {
  robotsCache.clear();
}

// ── 실제 네트워크 호출 ───────────────────────────────────────────────────

/**
 * 가드를 통과한 뒤의 순수 HTTP 수행부. 헤더는 여기서만 만들어지며, 호출부가 주입할 수 없다.
 * 리다이렉트는 따라가지 않는다(manual) — 추적 여부는 상위 gatewayFetch가 가드를 재실행해 결정한다.
 */
async function rawFetch(
  url: string,
  trigger: FetchTrigger,
  maxBytes: number,
  timeoutMs: number
): Promise<{ ok: true; status: number; body: string; location: string | null } | { ok: false; outcome: FetchOutcome; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual", // 자동 추적 금지 — 홉마다 가드를 다시 통과시킨다
      signal: controller.signal,
      // 헤더는 고정. Cookie/Authorization이 실릴 자리가 구조적으로 없다.
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      // 응답의 Set-Cookie는 읽지 않고, 어떤 쿠키 저장소에도 보관하지 않는다.
      cache: "no-store",
    });

    const location = response.headers.get("location");

    // Content-Length 선검사 — 거대 응답을 받기 전에 끊는다.
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      return {
        ok: false,
        outcome: "BLOCKED_POLICY",
        reason: `응답이 너무 큽니다 (${declared} bytes > ${maxBytes}).`,
      };
    }

    // 스트림을 읽으며 실제 바이트를 세어 상한을 넘기면 중단한다(Content-Length가 거짓일 수 있으므로).
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: true, status: response.status, body: "", location };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          outcome: "BLOCKED_POLICY",
          reason: `응답이 상한(${maxBytes} bytes)을 초과했습니다.`,
        };
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return {
      ok: true,
      status: response.status,
      body: new TextDecoder("utf-8").decode(merged),
      location,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      outcome: aborted ? "TIMEOUT" : "NETWORK_ERROR",
      reason: aborted ? `${timeoutMs}ms 안에 응답이 오지 않았습니다.` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 봇 차단 감지 (docs/03 §6.1). 200 응답이라도 상품 페이지가 아니라 챌린지 페이지일 수 있다.
 * 감지되면 서킷을 BLOCKED로 열고 자동 재개하지 않는다.
 */
export function looksLikeBotChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 429) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes("captcha") ||
    head.includes("cf-browser-verification") ||
    head.includes("just a moment") ||
    head.includes("_incapsula_") ||
    head.includes("access denied") ||
    head.includes("unusual traffic")
  );
}

// ── 관문 ────────────────────────────────────────────────────────────────

export async function gatewayFetch(req: GatewayRequest): Promise<GatewayResult> {
  const { trigger } = req;

  if (await isKillSwitchOn()) {
    return reject(req.url, trigger, "BLOCKED_POLICY", "글로벌 킬 스위치가 켜져 있습니다.");
  }

  const limits = await getLimits();
  let currentUrl = req.url;

  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    // ① 하드 가드 — 홉마다 다시 실행한다. 리다이렉트로 가드를 우회할 수 없다.
    const guard = assertFetchable(currentUrl);
    if (!guard.ok) {
      return reject(currentUrl, trigger, "BLOCKED_POLICY", guard.error.reason);
    }
    const target = guard.value;
    const host = target.hostname;

    // ② 서킷
    const circuit = await checkCircuit(host);
    if (circuit.open) {
      return reject(currentUrl, trigger, "BLOCKED_CIRCUIT", circuit.reason);
    }

    // ③ robots.txt
    // robots.txt 자체 조회만 판정에서 제외한다(무한 재귀 방지). 이 예외가 백도어가 되지 않도록
    // "trigger가 ROBOTS이면서 경로가 /robots.txt인 경우"로 좁힌다 — 호출부가 ROBOTS 트리거를
    // 붙여 임의 경로의 robots 준수를 건너뛸 수 없다.
    const isRobotsItself = trigger === "ROBOTS" && target.pathname === "/robots.txt";
    if (!isRobotsItself) {
      const outcome = await getRobots(host);
      // 쿼리스트링까지 넘겨야 `Disallow: /*?` 계열 규칙이 적용된다 (RFC 9309).
      const pathWithQuery = `${target.pathname}${target.search}`;
      if (!decideByOutcome(outcome, USER_AGENT, pathWithQuery)) {
        const why =
          outcome.kind === "unavailable"
            ? "robots.txt를 가져올 수 없어 접근을 보류했습니다 (RFC 9309: 조회 실패는 전면 금지)."
            : `robots.txt가 이 경로를 허용하지 않습니다: ${pathWithQuery}`;
        return reject(currentUrl, trigger, "BLOCKED_ROBOTS", why);
      }
    }

    // ④ SSRF 2차 방어 — 호스트 화이트리스트를 통과했어도 DNS가 사설망을 가리키면 중단.
    try {
      const addresses = await lookup(host, { all: true });
      const bad = addresses.find((a) => isBlockedAddress(a.address));
      if (bad) {
        return reject(
          currentUrl,
          trigger,
          "BLOCKED_POLICY",
          `호스트가 비공개 주소로 해석됩니다 (${bad.address}).`
        );
      }
    } catch (err) {
      return reject(currentUrl, trigger, "NETWORK_ERROR", `DNS 조회 실패: ${String(err)}`);
    }

    // ⑤ 예산·페이싱
    const budget = await checkBudget(host);
    if (budget.blocked) {
      return reject(currentUrl, trigger, "BLOCKED_BUDGET", budget.reason);
    }
    if (budget.waitMs > 0) await sleep(budget.waitMs);

    // ⑥ 호출
    const started = Date.now();
    const result = await rawFetch(currentUrl, trigger, limits.maxBytes, limits.timeoutMs);
    const durationMs = Date.now() - started;

    if (!result.ok) {
      await log({ url: currentUrl, trigger, outcome: result.outcome, durationMs, detail: result.reason });
      if (result.outcome === "TIMEOUT" || result.outcome === "NETWORK_ERROR") {
        await recordFailure(host, result.reason, false);
      }
      return { ok: false, outcome: result.outcome, reason: result.reason };
    }

    // ⑦ 리다이렉트: 자동으로 따라가지 않고 루프 상단으로 보내 가드를 다시 통과시킨다.
    if (result.status >= 300 && result.status < 400 && result.location) {
      await log({
        url: currentUrl,
        trigger,
        outcome: "OK",
        responseCode: result.status,
        durationMs,
        detail: `redirect → ${result.location}`,
      });
      currentUrl = new URL(result.location, currentUrl).toString();
      continue;
    }

    // ⑧ 차단 페이지 감지
    if (looksLikeBotChallenge(result.status, result.body)) {
      await log({
        url: currentUrl,
        trigger,
        outcome: "BOT_CHALLENGE",
        responseCode: result.status,
        durationMs,
        detail: "캡차/차단 페이지로 판정",
      });
      await recordFailure(host, `봇 차단 감지 (HTTP ${result.status})`, true);
      return {
        ok: false,
        outcome: "BOT_CHALLENGE",
        reason:
          "무신사가 자동 요청을 차단하고 있습니다. 수집을 중단했습니다 — 상품 정보를 직접 입력해 주세요.",
      };
    }

    if (result.status >= 400) {
      await log({
        url: currentUrl,
        trigger,
        outcome: "HTTP_ERROR",
        responseCode: result.status,
        durationMs,
        bytes: result.body.length,
      });
      await recordFailure(host, `HTTP ${result.status}`, false);
      return { ok: false, outcome: "HTTP_ERROR", reason: `HTTP ${result.status}` };
    }

    await log({
      url: currentUrl,
      trigger,
      outcome: "OK",
      responseCode: result.status,
      durationMs,
      bytes: result.body.length,
    });
    await recordSuccess(host);
    return { ok: true, status: result.status, body: result.body, finalUrl: currentUrl };
  }

  return reject(currentUrl, trigger, "BLOCKED_POLICY", "리다이렉트가 너무 많습니다.");
}
