// 링크 헬스체커 — docs/02-architecture.md §10.3.
//
// 해결하는 문제: 품절·쿠폰 만료된 링크가 옛 게시물과 노션에 남아 신뢰를 갉아먹는 것.
// 사람이 수동으로는 절대 못 하는 일이고, 현표의 병목 (c)다.
//
// 계정 안전 규칙 (docs/03 §5.4·§4.3):
//   1. **커미션 파라미터 없는 정규 상품 URL만 조회한다.** 큐레이터 링크(ULID 포함)를 우리가
//      방문하면 현표 자신의 클릭이 실적으로 찍힌다 — Fetch Gateway가 하드 abort하지만,
//      애초에 여기서 정규 URL을 만들어 넘긴다.
//   2. 조회 집합이 '현표가 링크를 발행한 상품 목록'과 1:1로 일치하면 UA를 익명화해도 계정이 특정된다.
//      → 최근 클릭이 발생한 링크 중심 + 발행 시각과 첫 체크 사이 랜덤 오프셋(1~6h).
//   3. **의심스러우면 유지한다.** 파서가 깨졌을 때 정상 링크를 죽이는 오탐이,
//      죽은 링크를 하루 더 두는 미탐보다 훨씬 비싸다(신뢰 훼손).

import { db } from "./db";
import { gatewayFetch } from "./fetch-gateway";
import { parseProductPage } from "./product-parser";
import { audit } from "./audit";
import type { CuratorLink, LinkHealth } from "@prisma/client";

/** 발행 직후 몇 시간 뒤부터 체크를 시작할지 — 발행 시각과의 동기화 지문을 없앤다 */
const FIRST_CHECK_OFFSET_MIN_MS = 1 * 3_600_000;
const FIRST_CHECK_OFFSET_MAX_MS = 6 * 3_600_000;

/** 한 번의 실행에서 점검할 최대 링크 수. 게이트웨이 예산을 한꺼번에 태우지 않도록. */
const MAX_PER_RUN = 20;

/** 연속 몇 번 품절로 보여야 확정할지 — 일시 품절(플랩)로 살아있는 링크를 죽이지 않는다 */
const SOLDOUT_CONFIRM_STREAK = 3;

export function firstCheckAt(from: Date = new Date()): Date {
  const offset =
    FIRST_CHECK_OFFSET_MIN_MS +
    Math.random() * (FIRST_CHECK_OFFSET_MAX_MS - FIRST_CHECK_OFFSET_MIN_MS);
  return new Date(from.getTime() + offset);
}

/**
 * 점검 주기 티어 (docs/02 §10.3).
 * 발행 직후가 트래픽 대부분이 발생하는 구간이라 촘촘히 보고, 오래된 딜은 뜸하게 본다.
 */
export function nextCheckInterval(publishedAt: Date, now: Date = new Date()): number | null {
  const ageMs = now.getTime() - publishedAt.getTime();
  const day = 24 * 3_600_000;
  if (ageMs < 3 * day) return 6 * 3_600_000;
  if (ageMs < 14 * day) return 12 * 3_600_000;
  if (ageMs < 30 * day) return day;
  return null; // 30일 이후 점검 종료
}

export type HealthVerdict =
  | { kind: "ok"; detail: string }
  | { kind: "soldout"; detail: string }
  | { kind: "gone"; detail: string } // 상품 자체가 사라짐 (404/410)
  | { kind: "frozen"; reason: string }; // 판정 불가 — 상태를 바꾸지 않는다

/**
 * 판매 가능 여부를 판정한다.
 *
 * **HTML 전문을 문자열로 훑지 않는다.** 상품 페이지에는 추천상품·연관상품 JSON이 함께 실리고,
 * 무신사처럼 옵션이 많은 상품은 사이즈별 offer가 배열로 온다. 전문에서 "outofstock"을 찾으면
 * 사이즈 하나 품절인 잘 팔리는 상품이 품절로 확정되고, 허브에서 사라지고, 과거 게시물의 링크가
 * 전부 안내 페이지로 착지하고, 현표는 판매 중인 상품을 품절이라고 공지하게 된다.
 * 그래서 **최상위 Product의 구조화된 offers만** 본다.
 *
 * 판정 불가는 전부 frozen이다 — 무신사 리뉴얼로 파서가 깨졌을 때 살아있는 링크를 전부
 * 죽여버리는 것이 이 시스템 최악의 시나리오다.
 */
export function judgeAvailability(status: number, html: string): HealthVerdict {
  // 상품 자체가 사라진 것은 가장 확실한 죽음 신호다.
  if (status === 404 || status === 410) {
    return { kind: "gone", detail: `상품 페이지가 사라졌습니다 (HTTP ${status})` };
  }
  if (status >= 400) {
    return { kind: "frozen", reason: `HTTP ${status} — 판정하지 않습니다` };
  }

  const parsed = parseProductPage(html);
  if (parsed.fieldCount === 0) {
    return { kind: "frozen", reason: "상품 구조를 읽지 못했습니다 (파서 점검 필요)" };
  }

  const { total, inStock, hasAvailabilityInfo } = parsed.offers;
  if (total === 0 || !hasAvailabilityInfo) {
    // AggregateOffer만 있거나 availability 표기가 없는 경우 — 알 수 없으므로 건드리지 않는다.
    return { kind: "frozen", reason: "재고 표기가 없어 판정할 수 없습니다" };
  }
  if (inStock > 0) {
    return { kind: "ok", detail: `${total}개 옵션 중 ${inStock}개 재고 있음` };
  }
  return { kind: "soldout", detail: `${total}개 옵션 전부 품절` };
}

interface CheckResult {
  checked: number;
  died: string[]; // 새로 죽은 것으로 확정된 dealId
  frozen: number;
  /** 사이클이 조기 종료됐다면 그 사유. 조용히 멈추지 않기 위해 반드시 위로 올린다. */
  stoppedEarly: string | null;
}

/**
 * 이 결과를 받으면 더 두드리면 안 된다 — 사이클을 즉시 끝낸다.
 * 반대로 개별 링크의 문제(404, 타임아웃 등)는 그 링크만 건너뛰고 계속 진행해야 한다.
 * 예전 구현은 모든 실패에 break를 걸어, 삭제된 상품 하나가 헬스체커 전체를 영구히 멈췄다.
 */
const STOP_CYCLE_OUTCOMES = new Set([
  "BLOCKED_CIRCUIT",
  "BLOCKED_BUDGET",
  "BLOCKED_POLICY",
  "BLOCKED_ROBOTS",
  "BOT_CHALLENGE",
]);

/**
 * 점검 대상을 고른다.
 * 발행 상품 전체가 아니라 (a) 첫 체크 시각이 지났고 (b) 주기가 도래한 것 중,
 * 최근 클릭이 있었던 링크를 우선한다 — 조회 집합과 발행 목록의 일치도를 희석하는 효과도 있다.
 */
async function selectTargets(now: Date) {
  // 가장 짧은 티어(6시간)를 SQL 하한으로 내려 "아직 주기가 안 된 것"을 DB에서 걸러낸다.
  // 전부 가져와 JS에서 자르면, 30일 지난 링크가 수백 건 쌓였을 때 후보창을 그것들이 채워
  // 새 링크가 영영 점검되지 않는 기아(starvation)가 생긴다.
  const minInterval = 6 * 3_600_000;
  const dueBefore = new Date(now.getTime() - minInterval);
  // 30일 넘은 딜은 애초에 대상이 아니다 — 무한히 무신사를 두드리지 않기 위해.
  const oldestPublish = new Date(now.getTime() - 30 * 24 * 3_600_000);

  const candidates = await db.curatorLink.findMany({
    where: {
      health: { in: ["OK", "UNCHECKED", "SOLDOUT"] },
      deal: { status: "PUBLISHED", updatedAt: { gte: oldestPublish } },
      OR: [{ healthCheckAfter: null }, { healthCheckAfter: { lte: now } }],
      AND: [{ OR: [{ healthCheckedAt: null }, { healthCheckedAt: { lte: dueBefore } }] }],
    },
    include: {
      deal: { include: { product: true, posts: { orderBy: { publishedAt: "desc" }, take: 1 } } },
      shortLinks: {
        include: {
          clicks: { where: { ts: { gte: new Date(now.getTime() - 24 * 3_600_000) } } },
        },
      },
    },
    // 가장 오래 방치된 것부터 결정적으로 — 어떤 링크도 굶지 않게 한다(null 우선).
    orderBy: [{ healthCheckedAt: { sort: "asc", nulls: "first" } }],
    take: MAX_PER_RUN * 3,
  });

  // 티어별 정확한 주기는 여기서 확인한다(SQL은 가장 짧은 티어까지만 걸렀다).
  const due = candidates.filter((link) => {
    const publishedAt = link.deal.posts[0]?.publishedAt ?? link.deal.updatedAt;
    const interval = nextCheckInterval(publishedAt, now);
    if (interval === null) return false; // 30일 경과 — 점검 종료
    if (!link.healthCheckedAt) return true;
    return now.getTime() - link.healthCheckedAt.getTime() >= interval;
  });

  // 최근 클릭이 있는 것 우선 — 실제로 사람이 쓰고 있는 링크가 먼저 정확해야 한다.
  // (동점이면 위의 healthCheckedAt 오름차순이 유지되어 오래된 것이 먼저 간다.)
  due.sort((a, b) => {
    const ca = a.shortLinks.reduce((n, s) => n + s.clicks.length, 0);
    const cb = b.shortLinks.reduce((n, s) => n + s.clicks.length, 0);
    return cb - ca;
  });

  return due.slice(0, MAX_PER_RUN);
}

async function applyVerdict(
  link: CuratorLink & { deal: { id: string; product: { productName: string; brandName: string } } },
  verdict: HealthVerdict,
  now: Date
): Promise<{ died: boolean }> {
  if (verdict.kind === "frozen") {
    // 상태는 건드리지 않고 점검 시각만 갱신한다. 파서가 깨진 것이면 알림으로 사람이 안다.
    await db.curatorLink.update({
      where: { id: link.id },
      data: { healthCheckedAt: now },
    });
    await audit({
      actor: "SYSTEM",
      action: "health.frozen",
      approvalRef: link.dealId,
      detail: verdict.reason,
    });
    return { died: false };
  }

  if (verdict.kind === "ok") {
    const wasDead = link.health === "SOLDOUT";
    // 상태 갱신과 숏링크 전환은 한 트랜잭션으로 — 중간에 죽으면
    // health=OK인데 숏링크는 DEAD인 어긋난 상태가 남고, 되돌릴 경로가 없다.
    await db.$transaction([
      db.curatorLink.update({
        where: { id: link.id },
        data: { health: "OK", healthCheckedAt: now, soldoutStreak: 0 },
      }),
      db.shortLink.updateMany({ where: { curatorLinkId: link.id }, data: { state: "ACTIVE" } }),
    ]);
    if (wasDead) {
      await audit({
        actor: "SYSTEM",
        action: "health.restocked",
        approvalRef: link.dealId,
        detail: verdict.detail,
      });
    }
    return { died: false };
  }

  // 이미 확정된 죽음은 다시 확정하지 않는다.
  // (중복 확정하면 매 사이클 died:true가 되어 같은 상품의 품절 알림이 30일 내내 반복된다.)
  if (link.health === "SOLDOUT") {
    await db.curatorLink.update({ where: { id: link.id }, data: { healthCheckedAt: now } });
    return { died: false };
  }

  const isGone = verdict.kind === "gone";
  // 상품 페이지가 사라진 것(404)은 되돌아올 여지가 거의 없어 더 빨리 확정한다.
  const threshold = isGone ? 2 : SOLDOUT_CONFIRM_STREAK;
  const streak = link.soldoutStreak + 1;
  const confirmed = streak >= threshold;

  if (!confirmed) {
    await db.curatorLink.update({
      where: { id: link.id },
      data: { soldoutStreak: streak, healthCheckedAt: now },
    });
    return { died: false };
  }

  // 확정 → 숏링크를 DEAD로. 과거 게시물의 링크까지 한 번에 구제된다
  // (게시물을 소급 수정하지 않고 착지점만 바꾼다).
  await db.$transaction([
    db.curatorLink.update({
      where: { id: link.id },
      data: {
        soldoutStreak: streak,
        healthCheckedAt: now,
        health: (isGone ? "DEAD" : "SOLDOUT") as LinkHealth,
      },
    }),
    db.shortLink.updateMany({ where: { curatorLinkId: link.id }, data: { state: "DEAD" } }),
  ]);

  await audit({
    actor: "SYSTEM",
    action: isGone ? "health.gone_confirmed" : "health.soldout_confirmed",
    approvalRef: link.dealId,
    detail: `${link.deal.product.brandName} ${link.deal.product.productName} — ${streak}회 연속 관측 · ${
      verdict.kind === "gone" || verdict.kind === "soldout" ? verdict.detail : ""
    }`,
  });
  return { died: true };
}

/**
 * 한 사이클을 돈다. 크론/워커가 주기적으로 호출한다.
 * 게이트웨이가 예산·페이싱·차단감지를 담당하므로 여기서는 대상 선정과 판정만 한다.
 */
export async function runHealthCheck(now: Date = new Date()): Promise<CheckResult> {
  const targets = await selectTargets(now);
  const result: CheckResult = { checked: 0, died: [], frozen: 0, stoppedEarly: null };

  for (const link of targets) {
    // 커미션 파라미터가 없는 정규 상품 URL만 조회한다 — 큐레이터 링크는 절대 방문하지 않는다.
    const url = link.deal.product.canonicalUrl;

    const fetched = await gatewayFetch({ url, trigger: "HEALTH_CHECK" });

    if (!fetched.ok) {
      if (STOP_CYCLE_OUTCOMES.has(fetched.outcome)) {
        // 차단·예산 소진 — 더 두드리지 않고 끝낸다.
        // "실패했으니 다시 시도"가 차단을 심화시키는 전형적인 경로다.
        result.stoppedEarly = `${fetched.outcome}: ${fetched.reason}`;
        break;
      }
      // 개별 링크 문제(타임아웃·네트워크 오류)는 이 링크만 건너뛰고 계속한다.
      // 단 healthCheckedAt은 갱신해야 한다 — 안 그러면 같은 링크가 매 사이클 맨 앞에
      // 다시 뽑혀 뒤의 링크들이 영영 점검되지 않는다(head-of-line blocking).
      result.frozen++;
      await db.curatorLink.update({ where: { id: link.id }, data: { healthCheckedAt: now } });
      await audit({
        actor: "SYSTEM",
        action: "health.fetch_failed",
        approvalRef: link.dealId,
        detail: `${fetched.outcome}: ${fetched.reason}`,
      });
      continue;
    }

    result.checked++;

    const verdict = judgeAvailability(fetched.status, fetched.body);
    if (verdict.kind === "frozen") result.frozen++;

    const { died } = await applyVerdict(link, verdict, now);
    if (died) result.died.push(link.dealId);
  }

  return result;
}
