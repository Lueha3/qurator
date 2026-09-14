// 가격 분석 — docs/05-price-watch.md §4.4.
//
// 핵심 원칙: **단일 시점 비교를 하지 않는다.**
// "정가 89,000 → 행사가 39,900 = 55% 할인"은 무신사가 표기하는 숫자일 뿐이고,
// 행사 직전에 정가를 올려두는 위장 인상이 있으면 거짓말이 된다. 그래서 헤드라인 수치는
// **행사 직전 창의 판매가 중앙값(기준가) 대비 실할인율**이다 ([02 §8.2] PRICE_DROP의
// 30일 중앙값 필터와 같은 사상). 표본이 부족하면 계산하지 않고 "수집 부족"으로 남긴다 —
// 표본 2개짜리 중앙값으로 "올해가 작년보다 쌉니다"라고 말하는 것이 최악이다.

import { db } from "./db";
import type { SnapshotSource } from "@prisma/client";
import { formatKRW } from "./format";

/** 기준가로 인정할 최소 표본 수. 미만이면 실할인율을 계산하지 않는다. */
export const MIN_BASELINE_SAMPLES = 3;

/** 기준가 창 길이(일). 행사 시작 직전 이 기간의 중앙값이 기준가다. */
export const BASELINE_WINDOW_DAYS = 45;

/**
 * 2025 무진장 겨울 블랙프라이데이 기간 (무신사 뉴스룸: 11/16 19:00 ~ 11/26 자정).
 * 수동 입력 스냅샷의 capturedAt을 이 기간의 중간으로 찍는 근거 —
 * capturedAt은 "그 가격이 참이었던 시점"이지 "입력한 시점"이 아니다.
 */
export const BF2025_OBSERVED_AT = new Date("2025-11-21T12:00:00+09:00");

export interface SnapshotLike {
  capturedAt: Date;
  listPrice: number | null;
  salePrice: number | null;
  couponPrice: number | null;
  source: SnapshotSource;
  eventTag: string | null;
}

/** 짝수 개면 가운데 두 값의 평균(원 단위 반올림). 표본이 없으면 null. */
export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 할인율(%). 기준가가 없거나 0 이하면 계산하지 않는다.
 * 가격이 올랐으면 음수를 그대로 돌려준다 — "할인이 아니었다"는 사실을 숨기지 않기 위해서다.
 */
export function discountRate(basePrice: number | null, price: number | null): number | null {
  if (basePrice === null || price === null || basePrice <= 0) return null;
  return Math.round((1 - price / basePrice) * 100);
}

export interface Baseline {
  /** 창 안 판매가의 중앙값 */
  price: number | null;
  sampleSize: number;
  /** MIN_BASELINE_SAMPLES 이상인가 — false면 실할인율을 표시하면 안 된다 */
  sufficient: boolean;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * 기준가를 구한다. windowEnd 직전 windowDays 구간의 판매가 중앙값.
 *
 * 수동 입력(MANUAL)은 표본에서 제외한다: 기억·스크린샷에 의존한 단일 값이고,
 * 애초에 과거 행사가로 입력되므로 "행사 직전 평상시 가격"이라는 기준가의 정의에 맞지 않는다.
 */
export function computeBaseline(
  snapshots: SnapshotLike[],
  windowEnd: Date,
  windowDays: number = BASELINE_WINDOW_DAYS
): Baseline {
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  const prices = snapshots
    .filter(
      (s) =>
        s.source !== "MANUAL" &&
        s.salePrice !== null &&
        s.capturedAt >= windowStart &&
        s.capturedAt < windowEnd
    )
    .map((s) => s.salePrice as number);

  return {
    price: median(prices),
    sampleSize: prices.length,
    sufficient: prices.length >= MIN_BASELINE_SAMPLES,
    windowStart,
    windowEnd,
  };
}

export interface EventSummary {
  eventTag: string;
  /** 행사 기간 중 도달한 최저 판매가 — "그때 실제로 살 수 있었던 가장 싼 값" */
  salePrice: number;
  /** 행사 기간 중 관측된 최저 쿠폰 적용가 (파서 확장 전에는 항상 null) */
  couponPrice: number | null;
  /** 행사 기간 중 관측된 정가(최댓값 — 파싱 글리치로 낮은 값이 섞여도 흔들리지 않게) */
  listPrice: number | null;
  firstCapturedAt: Date;
  lastCapturedAt: Date;
  snapshotCount: number;
  /** 전부 수동 입력인가 — UI에 "수동" 배지를 다는 근거 */
  manualOnly: boolean;
  /** 기준가 대비 실할인율. 표본 부족이면 null(= 표시 금지) */
  realDiscountRate: number | null;
  /** 정가 대비 할인율 — 무신사 표기와 대조용 참고값 */
  listDiscountRate: number | null;
  /** 쿠폰가까지 반영한 실할인율 */
  couponDiscountRate: number | null;
  baseline: Baseline;
}

function minOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return nums.length > 0 ? Math.min(...nums) : null;
}

function maxOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return nums.length > 0 ? Math.max(...nums) : null;
}

/**
 * eventTag가 붙은 스냅샷을 행사별로 묶어 요약한다.
 *
 * 각 행사의 기준가 창은 "그 행사의 첫 스냅샷 직전 45일"이다 — 행사 시작일을 따로
 * 저장하지 않아도 되고(과거 행사는 policy 설정이 남아있지 않다), 실제 관측에만 의존한다.
 */
export function summarizeEvents(snapshots: SnapshotLike[]): EventSummary[] {
  const byTag = new Map<string, SnapshotLike[]>();
  for (const s of snapshots) {
    if (!s.eventTag) continue;
    const list = byTag.get(s.eventTag);
    if (list) list.push(s);
    else byTag.set(s.eventTag, [s]);
  }

  const summaries: EventSummary[] = [];
  for (const [eventTag, rows] of byTag) {
    const salePrice = minOf(rows.map((r) => r.salePrice));
    // 판매가가 하나도 없는 행사는 비교의 대상이 될 수 없다.
    if (salePrice === null) continue;

    const sorted = [...rows].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    const firstCapturedAt = sorted[0].capturedAt;
    const couponPrice = minOf(rows.map((r) => r.couponPrice));
    const listPrice = maxOf(rows.map((r) => r.listPrice));
    const baseline = computeBaseline(snapshots, firstCapturedAt);
    const basePrice = baseline.sufficient ? baseline.price : null;

    summaries.push({
      eventTag,
      salePrice,
      couponPrice,
      listPrice,
      firstCapturedAt,
      lastCapturedAt: sorted[sorted.length - 1].capturedAt,
      snapshotCount: rows.length,
      manualOnly: rows.every((r) => r.source === "MANUAL"),
      realDiscountRate: discountRate(basePrice, salePrice),
      listDiscountRate: discountRate(listPrice, salePrice),
      couponDiscountRate: discountRate(basePrice, couponPrice),
      baseline,
    });
  }

  // 시간순 — "작년 → 올해"로 읽히게 한다.
  return summaries.sort((a, b) => a.firstCapturedAt.getTime() - b.firstCapturedAt.getTime());
}

export interface PriceAnalysis {
  /** 최신 자동 스냅샷. 수동 입력은 과거 시점 기록이므로 "현재가"가 될 수 없다. */
  current: SnapshotLike | null;
  /**
   * 가장 오래된 자동 스냅샷. BF 이벤트 태그가 없어도(=일반적인 "몇 달 전 vs 지금" 비교)
   * "첫 기록 vs 현재" 카드의 재료가 된다 — events가 비어 있을 때의 유일한 시계열 비교 수단.
   * current와 같은 스냅샷이면(표본 1건) null로 둔다 — 자기 자신과 비교하는 카드는 의미가 없다.
   */
  first: SnapshotLike | null;
  /**
   * 바로 직전 자동 스냅샷(current 다음으로 최신). "방금 다시 찍었더니 지난번과 얼마나
   * 달라졌나"의 재료다 — first(최초 기록)와는 다른 질문에 답한다: first는 "추적 시작 대비",
   * previous는 "바로 어제/직전 대비". 표본이 2건 미만이면 null.
   */
  previous: SnapshotLike | null;
  /** 지금 시점의 평상시 기준가 — "지금 가격이 싼 편인가"의 판단 근거 */
  currentBaseline: Baseline;
  events: EventSummary[];
  snapshotCount: number;
}

/** 스냅샷 배열 하나로 전체 분석을 만든다 (순수 함수 — DB 접근 없음) */
export function analyzeSnapshots(snapshots: SnapshotLike[], now: Date = new Date()): PriceAnalysis {
  const automatic = snapshots
    .filter((s) => s.source !== "MANUAL")
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  const oldest = automatic[automatic.length - 1] ?? null;

  return {
    current: automatic[0] ?? null,
    first: automatic.length >= 2 ? oldest : null,
    previous: automatic[1] ?? null,
    currentBaseline: computeBaseline(snapshots, now),
    events: summarizeEvents(snapshots),
    snapshotCount: snapshots.length,
  };
}

/**
 * 방금 캡처와 바로 직전 캡처를 비교해 "가격이 어떻게 바뀌었나"의 전 과정을 보여준다 —
 * 후보 카드용 (docs/06 §3.1). PriceStrip의 "첫 기록 vs 현재"와는
 * 다른 질문 — 여기는 "바로 전 vs 지금"만 본다. 최대 3줄:
 *   ① 판매가 자체가 어떻게 바뀌었나 (항상)
 *   ② 정가 대비 실할인율이 어떻게 바뀌었나 (정가를 읽었을 때만)
 *   ③ 쿠폰 적용 시 최종가 (화면에 쿠폰가가 보였을 때만)
 *
 * previous가 없으면(첫 기록이라 비교 대상이 없음) null — 아무것도 보여주지 않는 것 자체가
 * "비교할 게 없다"는 정직한 신호다. 마찬가지로 정가·쿠폰가는 실제로 읽힌 경우에만 줄을 더한다
 * — 없는 숫자를 지어내지 않는다 (docs/06 §3의 "확신의 정도가 숫자와 함께 보여야 한다" 원칙).
 */
export function buildPriceChangeNote(analysis: PriceAnalysis | undefined): string | null {
  if (!analysis) return null;
  const { current, previous } = analysis;
  if (!current || !previous) return null;
  if (current.salePrice === null || previous.salePrice === null) return null;

  const lines: string[] = [];

  // ① 판매가 헤드라인
  const prevSale = formatKRW(previous.salePrice);
  const nowSale = formatKRW(current.salePrice);
  if (current.salePrice === previous.salePrice) {
    lines.push(`➡️ 지난번과 같은 판매가예요 (${nowSale})`);
  } else {
    const rate = discountRate(previous.salePrice, current.salePrice);
    lines.push(
      rate === null || rate === 0
        ? `${prevSale} → ${nowSale}`
        : rate > 0
          ? `📉 지난번 ${prevSale} → 지금 ${nowSale} (${rate}% 하락)`
          : `📈 지난번 ${prevSale} → 지금 ${nowSale} (${Math.abs(rate)}% 상승)`
    );
  }

  // ② 정가 대비 실할인율 — 정가가 그 사이 달라졌거나 이번에 못 읽었으면 "전후 비교"를
  // 지어내지 않고 지금 값만 보여준다. 같은 정가를 기준으로 삼을 수 있을 때만 화살표로 잇는다.
  const listPrice = current.listPrice;
  if (listPrice !== null && listPrice > 0) {
    const nowRate = discountRate(listPrice, current.salePrice);
    if (nowRate !== null) {
      const prevRate =
        previous.listPrice === listPrice && previous.salePrice !== null
          ? discountRate(listPrice, previous.salePrice)
          : null;
      lines.push(
        prevRate !== null
          ? `정가 ${formatKRW(listPrice)} 기준 할인율 ${prevRate}% → ${nowRate}%`
          : `정가 ${formatKRW(listPrice)} 기준 할인율 ${nowRate}%`
      );
    }
  }

  // ③ 쿠폰 적용가 — 로그인 상태 화면값이라 등급할인이 섞여 있을 수 있다(docs/06 §4.1).
  // 그대로 보여주되 어떤 쿠폰인지는 단정하지 않는다.
  if (current.couponPrice !== null && current.couponPrice > 0) {
    const couponRate =
      listPrice !== null && listPrice > 0 ? discountRate(listPrice, current.couponPrice) : null;
    const couponLabel = couponRate !== null ? ` (${couponRate}% 할인)` : "";
    if (previous.couponPrice !== null && previous.couponPrice !== current.couponPrice) {
      lines.push(
        `쿠폰 적용 시 지난번 ${formatKRW(previous.couponPrice)} → 지금 ${formatKRW(current.couponPrice)}${couponLabel}`
      );
    } else {
      lines.push(`쿠폰 적용 시 ${formatKRW(current.couponPrice)}${couponLabel}`);
    }
  }

  return lines.join("\n");
}

/**
 * 여러 상품의 분석을 한 번의 쿼리로 만든다.
 * 워크스페이스가 딜 30건을 그리면서 상품마다 쿼리를 날리면 N+1이 된다 — 한 번에 읽고 JS에서 묶는다.
 */
export async function buildPriceAnalyses(
  productIds: string[],
  now: Date = new Date()
): Promise<Map<string, PriceAnalysis>> {
  const result = new Map<string, PriceAnalysis>();
  if (productIds.length === 0) return result;

  const rows = await db.priceSnapshot.findMany({
    where: { productId: { in: productIds } },
    orderBy: { capturedAt: "asc" },
  });

  const byProduct = new Map<string, SnapshotLike[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId);
    if (list) list.push(row);
    else byProduct.set(row.productId, [row]);
  }

  for (const productId of productIds) {
    result.set(productId, analyzeSnapshots(byProduct.get(productId) ?? [], now));
  }
  return result;
}
