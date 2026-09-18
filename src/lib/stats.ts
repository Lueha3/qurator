// 성과 집계 — docs/08 §3.3 성과 탭.
//
// 쌓이던 데이터를 처음으로 보여주는 곳이다: 숏링크 클릭(ClickEvent)·발행 이력(Post)은
// 이미 기록되고 있었는데 읽는 화면이 없었다.
//
// 규율 두 가지:
//   1. DB만 읽는다. 성과 화면을 여는 것이 무신사 요청을 만들지 않는다.
//   2. 봇 클릭·봇 방문은 집계에서 뺀다. 자기 실적처럼 보이는 숫자가 판단을 망친다.

import type { PostStatus } from "@prisma/client";
import { db } from "./db";

/** 발행으로 세는 상태 — PENDING·FAILED는 "나갔다"가 아니다 */
const SENT_STATUS: PostStatus[] = ["SENT", "CONFIRMED"];

export type StatsPeriod = 7 | 30;

/** 카톡 오픈채팅 일일 게시 권고 상한 (docs/02 §7.5 — 전송은 사람이, 페이스는 도구가 본다) */
export const KAKAO_DAILY_LIMIT = 5;

export interface StatDelta {
  value: number;
  /** 직전 같은 길이의 기간 값. 비교 대상이 없으면 0 */
  prev: number;
}

export interface StatBar {
  label: string;
  value: number;
}

export interface TopDeal {
  dealId: string;
  brand: string;
  productName: string;
  clicks: number;
}

export interface StatsSummary {
  days: StatsPeriod;
  clicks: StatDelta;
  posts: StatDelta;
  hubVisits: StatDelta;
  /** 지면(surface)별 클릭 — 많은 순 */
  bySurface: StatBar[];
  topDeals: TopDeal[];
  /** 허브 지면 숏링크 클릭 수 */
  hubClicks: number;
  /** 허브 방문 대비 클릭 비율(%). 방문이 0이면 null — 0%로 그리면 거짓말이 된다 */
  hubCtr: number | null;
  /** 오늘 카톡 오픈채팅에 복사해 나간 카드 수 */
  kakaoToday: number;
}

const SURFACE_LABEL: Record<string, string> = {
  hub: "팔로워 페이지",
  kakao_open: "카톡 오픈채팅",
  threads: "스레드",
  instagram_comment: "인스타 고정댓글",
  notion: "노션",
};

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function loadStats(days: StatsPeriod, now: Date = new Date()): Promise<StatsSummary> {
  const windowMs = days * 86_400_000;
  const since = new Date(now.getTime() - windowMs);
  const prevSince = new Date(now.getTime() - windowMs * 2);

  const humanClicks = { uaClass: "human" };
  const sent = { status: { in: SENT_STATUS } };

  const [grouped, clicksPrev, posts, postsPrev, hubVisits, hubVisitsPrev, kakaoToday] =
    await Promise.all([
      // 지면·딜별로 나누려면 shortLinkId 단위로 묶어야 한다. 클릭 행 전체를 끌어오지 않는다.
      db.clickEvent.groupBy({
        by: ["shortLinkId"],
        where: { ts: { gte: since }, ...humanClicks },
        _count: { _all: true },
      }),
      db.clickEvent.count({ where: { ts: { gte: prevSince, lt: since }, ...humanClicks } }),
      db.post.count({ where: { publishedAt: { gte: since }, ...sent } }),
      db.post.count({ where: { publishedAt: { gte: prevSince, lt: since }, ...sent } }),
      db.hubVisit.count({ where: { ts: { gte: since }, ...humanClicks } }),
      db.hubVisit.count({ where: { ts: { gte: prevSince, lt: since }, ...humanClicks } }),
      db.post.count({
        where: { channel: "KAKAO_OPEN", publishedAt: { gte: startOfDay(now) }, ...sent },
      }),
    ]);

  const clicks = grouped.reduce((sum, row) => sum + row._count._all, 0);

  const links = grouped.length
    ? await db.shortLink.findMany({
        where: { id: { in: grouped.map((g) => g.shortLinkId) } },
        select: {
          id: true,
          surface: true,
          dealId: true,
          deal: { select: { product: { select: { brandName: true, productName: true } } } },
        },
      })
    : [];
  const linkById = new Map(links.map((l) => [l.id, l]));

  const surfaceTotals = new Map<string, number>();
  const dealTotals = new Map<string, TopDeal>();
  for (const row of grouped) {
    const link = linkById.get(row.shortLinkId);
    if (!link) continue; // 숏링크가 지워졌으면 집계에서 빠진다
    const n = row._count._all;

    surfaceTotals.set(link.surface, (surfaceTotals.get(link.surface) ?? 0) + n);

    const deal = dealTotals.get(link.dealId);
    if (deal) deal.clicks += n;
    else
      dealTotals.set(link.dealId, {
        dealId: link.dealId,
        brand: link.deal.product.brandName,
        productName: link.deal.product.productName,
        clicks: n,
      });
  }

  const bySurface = [...surfaceTotals.entries()]
    .map(([surface, value]) => ({ label: SURFACE_LABEL[surface] ?? surface, value }))
    .sort((a, b) => b.value - a.value);

  const topDeals = [...dealTotals.values()].sort((a, b) => b.clicks - a.clicks).slice(0, 5);

  const hubClicks = surfaceTotals.get("hub") ?? 0;

  return {
    days,
    clicks: { value: clicks, prev: clicksPrev },
    posts: { value: posts, prev: postsPrev },
    hubVisits: { value: hubVisits, prev: hubVisitsPrev },
    bySurface,
    topDeals,
    hubClicks,
    hubCtr: hubVisits > 0 ? Math.round((hubClicks / hubVisits) * 100) : null,
    kakaoToday,
  };
}
