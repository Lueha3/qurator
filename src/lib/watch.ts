// BF 가격 워치 — docs/05-price-watch.md §3.2·§4.3.
//
// 이 파일은 이 시스템에서 **유일하게 사람 없이 무신사에 요청을 보내는 코드**다.
// 그래서 규율이 기능보다 먼저다:
//
//   1. 조회 대상은 현표가 명시적으로 등록한 상품뿐이다. 발굴·카탈로그 순회는 하지 않는다.
//   2. 상한(기본 30개)·빈도(하루 1회, 행사 기간 2회)는 정책 시트가 정본이고 하드캡으로 이중화된다.
//   3. 순회 순서를 매번 섞는다 — 고정 순서는 그 자체로 스케줄러 지문이다.
//   4. 등록 즉시 조회하지 않는다(1~6h 랜덤 오프셋) — "관심을 표한 순간"과 요청 시각을 떼어놓는다.
//   5. 차단·예산 소진 신호를 받으면 그 사이클을 즉시 끝낸다. 자동으로 뚫지 않는다.
//   6. **VPS 전용이다.** 현표의 기기·IP에서 돌리면 docs/03 §4.1 물리 격리가 깨진다.

import { db } from "./db";
import { gatewayFetch } from "./fetch-gateway";
import { parseProductPage } from "./product-parser";
import { recordParsedSnapshot, activeEventTag } from "./price-snapshot";
import { getWatchLimits } from "./policy";
import { audit } from "./audit";

/** 워치 등록 기본 유효기간(일). 목적이 끝난 상품에 트래픽이 잔존하지 않게 한다. */
export const WATCH_DEFAULT_DAYS = 90;

const FIRST_CHECK_OFFSET_MIN_MS = 1 * 3_600_000;
const FIRST_CHECK_OFFSET_MAX_MS = 6 * 3_600_000;

/** 등록 시각과 첫 조회 시각을 떼어놓는다 (docs/03 §4.3 동기화 신호 제거) */
export function firstWatchCheckAt(from: Date = new Date()): Date {
  const offset =
    FIRST_CHECK_OFFSET_MIN_MS +
    Math.random() * (FIRST_CHECK_OFFSET_MAX_MS - FIRST_CHECK_OFFSET_MIN_MS);
  return new Date(from.getTime() + offset);
}

export type AddWatchResult =
  | { ok: true; alreadyActive: boolean; expiresAt: Date; activeCount: number }
  | { ok: false; reason: string; activeCount: number };

/**
 * 워치에 상품을 등록한다. 상한을 넘으면 거부한다 —
 * "조금 더 담아도 되겠지"가 반복되면 소수 추적이라는 전제 자체가 무너진다.
 */
export async function addWatch(
  productId: string,
  now: Date = new Date()
): Promise<AddWatchResult> {
  const limits = await getWatchLimits();
  const existing = await db.watchItem.findUnique({ where: { productId } });
  const activeCount = await countActiveWatches(now);

  // 이미 활성인 항목의 갱신은 상한과 무관하다(총량이 늘지 않는다).
  const isActiveNow = !!existing && existing.active && existing.expiresAt > now;
  if (!isActiveNow && activeCount >= limits.itemsMax) {
    return {
      ok: false,
      reason: `추적 상한 ${limits.itemsMax}개를 이미 채웠습니다. 먼저 하나를 해제해주세요.`,
      activeCount,
    };
  }

  const expiresAt = new Date(now.getTime() + WATCH_DEFAULT_DAYS * 86_400_000);
  await db.watchItem.upsert({
    where: { productId },
    // 재등록은 기간만 연장한다. checkAfter를 다시 밀면 재등록을 반복해 조회를 영영 미룰 수 있다.
    update: { active: true, expiresAt },
    create: { productId, expiresAt, checkAfter: firstWatchCheckAt(now) },
  });

  await audit({
    actor: "HUMAN",
    action: "watch.added",
    approvalRef: productId,
    detail: `BF 워치 등록 (만료 ${expiresAt.toISOString().slice(0, 10)})`,
  });

  return {
    ok: true,
    alreadyActive: isActiveNow,
    expiresAt,
    activeCount: isActiveNow ? activeCount : activeCount + 1,
  };
}

/** 워치를 해제한다. 행 자체는 남겨 이력을 보존하고 active만 내린다. */
export async function removeWatch(productId: string): Promise<boolean> {
  const existing = await db.watchItem.findUnique({ where: { productId } });
  if (!existing || !existing.active) return false;
  await db.watchItem.update({ where: { productId }, data: { active: false } });
  await audit({ actor: "HUMAN", action: "watch.removed", approvalRef: productId });
  return true;
}

export async function countActiveWatches(now: Date = new Date()): Promise<number> {
  return db.watchItem.count({ where: { active: true, expiresAt: { gt: now } } });
}

export async function listActiveWatches(now: Date = new Date()) {
  return db.watchItem.findMany({
    where: { active: true, expiresAt: { gt: now } },
    include: { product: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * 만료된 워치를 내린다. 러너가 매 사이클 먼저 호출한다 —
 * 만료 처리를 사람 손에 맡기면 목적이 끝난 상품을 몇 달씩 계속 두드리게 된다.
 */
export async function expireWatches(now: Date = new Date()): Promise<number> {
  const { count } = await db.watchItem.updateMany({
    where: { active: true, expiresAt: { lte: now } },
    data: { active: false },
  });
  if (count > 0) {
    await audit({ actor: "SYSTEM", action: "watch.expired", detail: `${count}건 자동 해제` });
  }
  return count;
}

/** 사이클을 즉시 끝내야 하는 신호 — 헬스체커와 같은 목록을 쓴다(같은 규율이어야 한다). */
const STOP_CYCLE_OUTCOMES = new Set([
  "BLOCKED_CIRCUIT",
  "BLOCKED_BUDGET",
  "BLOCKED_POLICY",
  "BLOCKED_ROBOTS",
  "BOT_CHALLENGE",
]);

export interface WatchCycleResult {
  /** 실제로 조회한 상품 수 */
  checked: number;
  /** 스냅샷이 기록된 수 (파싱 실패는 제외된다) */
  recorded: number;
  /** 조회는 됐지만 가격을 못 읽은 수 — 누적되면 파서 점검 신호다 */
  parseFailed: number;
  expired: number;
  /** 이번 사이클에 적용된 재조회 간격의 근거 (행사 창이면 태그) */
  eventTag: string | null;
  /** 조기 종료 사유. 조용히 멈추지 않기 위해 반드시 위로 올린다 */
  stoppedEarly: string | null;
}

/** Fisher-Yates. 매 사이클 순회 순서를 섞어 고정 순서 지문을 없앤다. */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 워치 한 사이클. VPS의 크론/systemd 타이머가 하루 1회 호출한다.
 *
 * 게이트웨이가 예산·페이싱·robots·차단감지를 담당하므로 여기서는 대상 선정과 기록만 한다.
 * 헬스체크와 **다른 시간대**에 돌려야 한다 — 호스트당 시간당 60건 캡을 공유하기 때문에
 * 같은 시각에 겹치면 둘 중 하나가 BLOCKED_BUDGET으로 조기 종료된다(안전하지만 커버리지 손실).
 */
export async function runWatchCycle(now: Date = new Date()): Promise<WatchCycleResult> {
  const result: WatchCycleResult = {
    checked: 0,
    recorded: 0,
    parseFailed: 0,
    expired: 0,
    eventTag: null,
    stoppedEarly: null,
  };

  result.expired = await expireWatches(now);

  const limits = await getWatchLimits();
  const eventTag = await activeEventTag(now);
  result.eventTag = eventTag;
  // 행사 기간에만 하루 2회. 평시에 빈도를 올리지 않는 것이 이 설계의 핵심 절제다.
  const interval = eventTag ? limits.eventIntervalMs : limits.minIntervalMs;
  const dueBefore = new Date(now.getTime() - interval);

  const due = await db.watchItem.findMany({
    where: {
      active: true,
      expiresAt: { gt: now },
      checkAfter: { lte: now },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: dueBefore } }],
    },
    include: { product: true },
    // 가장 오래 방치된 것부터 — 상한에 걸려 잘리더라도 어떤 상품도 굶지 않게 한다.
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
    take: limits.perRunMax,
  });

  for (const item of shuffle(due)) {
    // 커미션 파라미터가 없는 정규 상품 URL만 — 큐레이터 링크는 절대 방문하지 않는다.
    const fetched = await gatewayFetch({ url: item.product.canonicalUrl, trigger: "WATCH" });

    if (!fetched.ok) {
      if (STOP_CYCLE_OUTCOMES.has(fetched.outcome)) {
        result.stoppedEarly = `${fetched.outcome}: ${fetched.reason}`;
        await audit({
          actor: "SYSTEM",
          action: "watch.stopped",
          detail: result.stoppedEarly,
        });
        break;
      }
      // 개별 실패(타임아웃·네트워크)는 이 상품만 건너뛴다. 단 lastCheckedAt은 갱신해야
      // 다음 사이클에 같은 상품이 다시 맨 앞에 뽑혀 뒤가 굶는 일이 없다.
      await db.watchItem.update({ where: { id: item.id }, data: { lastCheckedAt: now } });
      continue;
    }

    result.checked++;
    await db.watchItem.update({ where: { id: item.id }, data: { lastCheckedAt: now } });

    const parsed = parseProductPage(fetched.body);
    const saved = await recordParsedSnapshot(item.productId, parsed, "WATCH");
    if (saved.recorded) result.recorded++;
    else result.parseFailed++;
  }

  return result;
}
