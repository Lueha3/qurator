// 링크허브 배지 — docs/08 §3.3 / §2.2 G5.
//
// 팔로워가 허브에서 보는 것은 지금까지 "브랜드 · 상품명 · 가격"뿐이었다. 우리는 가격 이력을
// 이미 갖고 있으므로, **지금 살 이유**를 한 단어로 붙일 수 있다.
//
// 규율:
//   - 스냅샷과 딜 필드만 쓴다. 배지를 그리려고 무신사에 요청하지 않는다(요청 0건 불변식).
//   - 하나만 붙인다. 셋을 다 붙이면 아무것도 강조하지 않는 것과 같다.
//   - **우리가 기록한 범위 안에서**만 "최저가"라고 말한다 — 허브 각주가 그렇게 밝힌다.

import { db } from "./db";
import type { SnapshotLike } from "./price-analysis";

export type HubBadgeKind = "coupon" | "lowest" | "drop";

export interface HubBadge {
  kind: HubBadgeKind;
  label: string;
}

/** "최저가"라고 말하려면 이만큼은 봤어야 한다 — 2건짜리 최저가는 그냥 "지난번보다 싸다"다. */
export const MIN_LOWEST_SAMPLES = 3;
/** 쿠폰 마감을 배지로 띄우는 잔여 일수. 한 달 남은 쿠폰은 급한 소식이 아니다. */
export const COUPON_URGENT_DAYS = 7;

const DAY = 86_400_000;

function automaticSalePrices(snapshots: SnapshotLike[]): { at: number; price: number }[] {
  // 수동 입력은 과거 행사가라 "지금 최저가인가"의 기준이 될 수 없다 (price-analysis와 같은 규율).
  return snapshots
    .filter((s) => s.source !== "MANUAL" && s.salePrice !== null)
    .map((s) => ({ at: s.capturedAt.getTime(), price: s.salePrice as number }))
    .sort((a, b) => b.at - a.at);
}

export function hubBadge({
  snapshots,
  couponExpiresAt,
  now = new Date(),
}: {
  snapshots: SnapshotLike[];
  couponExpiresAt: Date | null;
  now?: Date;
}): HubBadge | null {
  // ① 마감이 가장 급하다 — 오늘 지나면 못 받는 혜택이다.
  if (couponExpiresAt && couponExpiresAt > now) {
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const daysLeft = Math.ceil((couponExpiresAt.getTime() - endOfToday.getTime()) / DAY);
    if (daysLeft <= COUPON_URGENT_DAYS) {
      return { kind: "coupon", label: daysLeft <= 0 ? "오늘 마감" : `D-${daysLeft} 마감` };
    }
  }

  const prices = automaticSalePrices(snapshots);
  if (prices.length < 2) return null;
  const [current, previous] = prices;

  // ② 우리가 본 것 중 제일 싸다 — 표본이 충분할 때만 말한다.
  if (prices.length >= MIN_LOWEST_SAMPLES) {
    const others = prices.slice(1).map((p) => p.price);
    if (current.price < Math.min(...others)) return { kind: "lowest", label: "최저가" };
  }

  // ③ 지난번보다 내렸다.
  if (current.price < previous.price) return { kind: "drop", label: "가격 인하" };

  return null;
}

/**
 * 허브에 실릴 딜들의 배지를 한 번에 만든다.
 * 딜마다 스냅샷을 조회하면 N+1이 된다 — 상품 묶음으로 한 번에 읽고 JS에서 나눈다.
 */
export async function buildHubBadges(
  deals: { id: string; productId: string; couponExpiresAt: Date | null }[],
  now: Date = new Date()
): Promise<Map<string, HubBadge>> {
  const badges = new Map<string, HubBadge>();
  if (deals.length === 0) return badges;

  const rows = await db.priceSnapshot.findMany({
    where: { productId: { in: [...new Set(deals.map((d) => d.productId))] } },
    orderBy: { capturedAt: "asc" },
  });

  const byProduct = new Map<string, SnapshotLike[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId);
    if (list) list.push(row);
    else byProduct.set(row.productId, [row]);
  }

  for (const deal of deals) {
    const badge = hubBadge({
      snapshots: byProduct.get(deal.productId) ?? [],
      couponExpiresAt: deal.couponExpiresAt,
      now,
    });
    if (badge) badges.set(deal.id, badge);
  }
  return badges;
}
