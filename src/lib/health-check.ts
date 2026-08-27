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
  | { kind: "ok" }
  | { kind: "soldout" }
  | { kind: "frozen"; reason: string }; // 판정 불가 — 상태를 바꾸지 않는다

/**
 * 상품 페이지에서 판매 가능 여부를 판정한다.
 * 파싱이 안 되면 'frozen'을 반환해 **상태를 그대로 둔다** — 무신사 리뉴얼로 파서가 깨졌을 때
 * 살아있는 링크를 전부 죽여버리는 것이 최악의 시나리오이기 때문이다.
 */
export function judgeAvailability(html: string): HealthVerdict {
  const parsed = parseProductPage(html);
  if (parsed.fieldCount === 0) {
    return { kind: "frozen", reason: "상품 구조를 읽지 못했습니다 (파서 점검 필요)" };
  }

  const lowered = html.toLowerCase();
  // schema.org availability가 가장 신뢰할 만한 신호다.
  if (lowered.includes("schema.org/outofstock") || lowered.includes('"outofstock"')) {
    return { kind: "soldout" };
  }
  if (lowered.includes("schema.org/instock") || lowered.includes('"instock"')) {
    return { kind: "ok" };
  }
  // 가격은 읽혔는데 재고 표기가 없으면 판단하지 않는다.
  return { kind: "frozen", reason: "재고 표기를 찾지 못했습니다" };
}

interface CheckResult {
  checked: number;
  died: string[]; // 새로 죽은 것으로 확정된 dealId
  frozen: number;
}

/**
 * 점검 대상을 고른다.
 * 발행 상품 전체가 아니라 (a) 첫 체크 시각이 지났고 (b) 주기가 도래한 것 중,
 * 최근 클릭이 있었던 링크를 우선한다 — 조회 집합과 발행 목록의 일치도를 희석하는 효과도 있다.
 */
async function selectTargets(now: Date) {
  const candidates = await db.curatorLink.findMany({
    where: {
      health: { in: ["OK", "UNCHECKED", "SOLDOUT"] },
      deal: { status: "PUBLISHED" },
      OR: [{ healthCheckAfter: null }, { healthCheckAfter: { lte: now } }],
    },
    include: {
      deal: { include: { product: true, posts: { orderBy: { publishedAt: "desc" }, take: 1 } } },
      shortLinks: {
        include: { clicks: { where: { ts: { gte: new Date(now.getTime() - 24 * 3_600_000) } } } },
      },
    },
    take: 200,
  });

  const due = candidates.filter((link) => {
    const publishedAt = link.deal.posts[0]?.publishedAt ?? link.deal.updatedAt;
    const interval = nextCheckInterval(publishedAt, now);
    if (interval === null) return false; // 30일 경과 — 점검 종료
    if (!link.healthCheckedAt) return true;
    return now.getTime() - link.healthCheckedAt.getTime() >= interval;
  });

  // 최근 클릭이 있는 것 우선 — 실제로 사람이 쓰고 있는 링크가 먼저 정확해야 한다.
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
    await db.curatorLink.update({
      where: { id: link.id },
      data: { health: "OK", healthCheckedAt: now, soldoutStreak: 0 },
    });
    // 재입고 — 죽었던 숏링크를 되살린다
    if (link.health === "SOLDOUT") {
      await db.shortLink.updateMany({
        where: { curatorLinkId: link.id },
        data: { state: "ACTIVE" },
      });
      await audit({ actor: "SYSTEM", action: "health.restocked", approvalRef: link.dealId });
    }
    return { died: false };
  }

  // soldout — 연속 관측이 쌓여야 확정한다(일시 품절로 링크를 죽이지 않기 위해)
  const streak = link.soldoutStreak + 1;
  const confirmed = streak >= SOLDOUT_CONFIRM_STREAK;

  await db.curatorLink.update({
    where: { id: link.id },
    data: {
      soldoutStreak: streak,
      healthCheckedAt: now,
      ...(confirmed ? { health: "SOLDOUT" as LinkHealth } : {}),
    },
  });

  if (!confirmed) return { died: false };

  // 확정 → 숏링크를 DEAD로. 과거 게시물의 링크까지 한 번에 구제된다
  // (게시물을 소급 수정하지 않고 착지점만 바꾼다).
  await db.shortLink.updateMany({
    where: { curatorLinkId: link.id },
    data: { state: "DEAD" },
  });
  await audit({
    actor: "SYSTEM",
    action: "health.soldout_confirmed",
    approvalRef: link.dealId,
    detail: `${link.deal.product.brandName} ${link.deal.product.productName} — ${streak}회 연속 품절 관측`,
  });
  return { died: true };
}

/**
 * 한 사이클을 돈다. 크론/워커가 주기적으로 호출한다.
 * 게이트웨이가 예산·페이싱·차단감지를 담당하므로 여기서는 대상 선정과 판정만 한다.
 */
export async function runHealthCheck(now: Date = new Date()): Promise<CheckResult> {
  const targets = await selectTargets(now);
  const result: CheckResult = { checked: 0, died: [], frozen: 0 };

  for (const link of targets) {
    // 커미션 파라미터가 없는 정규 상품 URL만 조회한다 — 큐레이터 링크는 절대 방문하지 않는다.
    const url = link.deal.product.canonicalUrl;

    const fetched = await gatewayFetch({ url, trigger: "HEALTH_CHECK" });
    if (!fetched.ok) {
      // 차단·예산 소진 등 — 더 두드리지 않고 이번 사이클을 끝낸다.
      // "실패했으니 다시 시도"가 차단을 심화시키는 전형적인 경로다.
      break;
    }
    result.checked++;

    const verdict = judgeAvailability(fetched.body);
    if (verdict.kind === "frozen") result.frozen++;

    const { died } = await applyVerdict(link, verdict, now);
    if (died) result.died.push(link.dealId);
  }

  return result;
}
