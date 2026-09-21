// 지켜보는 상품 중 가격이 내려간 것 — docs/06 §4.6.
//
// 좋아요 목록을 통째로 담는 이유가 여기 있다. 300개를 담아두는 목적은 지금 올릴 것을 고르는 게
// 아니라 **가격이 내려가는 순간을 잡는 것**이고, 목록을 다시 찍을 때마다 300개 가격이 한 번에
// 갱신되므로 그 비교가 공짜로 생긴다.
//
// 판단 기준은 "지난번 기록보다 싼가" 하나다. "평소 가격보다 싼가"(기준가 대비 실할인)가 더 좋은
// 질문이지만 그건 표본 3건이 필요하고(price-analysis MIN_BASELINE_SAMPLES), 막 담은 목록은 전부
// 1건이다. 표본이 쌓이면 딜 시트가 그 판단을 이어서 한다 — 여기서는 사람을 부르기만 하면 된다.
//
// DB만 읽는다. 이 계산이 무신사 요청을 만들지 않는 것이 불변식이다.

import { db } from "./db";
import { buildPriceAnalyses } from "./price-analysis";

/**
 * 한 번에 이 이상 내렸으면 실제 세일보다 OCR 자릿수 오독일 가능성이 크다고 본다(2026-09-21,
 * 실사용 오독 재현 — 자릿수 하나가 빠지면 하락률이 ~90%로 보인다). 완전히 숨기지는 않는다 —
 * 무신사 블랙아웃 세일처럼 실제로 80%를 넘는 경우가 드물게 있어서다. 다만 "많이 내린 순"
 * 정렬에서 맨 위 자리는 내주지 않는다: 확인 안 된 값이 "가장 좋은 딜"로 보이면 안 된다.
 */
const SUSPICIOUS_DROP_RATE = 80;

export interface PriceDropItem {
  productId: string;
  brandName: string;
  productName: string;
  /** 지난번 기록 가격 */
  from: number;
  /** 이번에 읽힌 가격 */
  to: number;
  /** 내린 폭(%) — 반올림 */
  rate: number;
  /** 한 번에 너무 많이 내려 OCR 오독 가능성이 있다 — 목록에서 빼지는 않고 표시만 한다 */
  suspicious: boolean;
}

/**
 * 지켜보는 상품 가운데 **가장 최근 기록이 그 직전 기록보다 싼** 것들. 많이 내린 순.
 *
 * 수동 입력(MANUAL) 스냅샷은 과거 행사가라 "지금 싸졌다"의 근거가 될 수 없다 —
 * price-analysis가 이미 자동 스냅샷만으로 current/previous를 고르므로 여기서 또 거르지 않는다.
 */
export async function cheaperWatchedProducts(now: Date = new Date()): Promise<PriceDropItem[]> {
  const watches = await db.watchItem.findMany({
    where: { active: true, expiresAt: { gt: now } },
    include: { product: true },
  });
  if (watches.length === 0) return [];

  const analyses = await buildPriceAnalyses(watches.map((w) => w.productId));

  const drops: PriceDropItem[] = [];
  for (const watch of watches) {
    const analysis = analyses.get(watch.productId);
    const to = analysis?.current?.salePrice ?? null;
    const from = analysis?.previous?.salePrice ?? null;
    if (to === null || from === null || to >= from) continue;

    const rate = Math.round(((from - to) / from) * 100);
    drops.push({
      productId: watch.productId,
      brandName: watch.product.brandName,
      productName: watch.product.productName,
      from,
      to,
      rate,
      suspicious: rate >= SUSPICIOUS_DROP_RATE,
    });
  }

  // 의심스러운 값은 뒤로 — 확인되지 않은 오독이 "가장 많이 내렸다"는 자리를 차지하지 않는다.
  return drops.sort((a, b) => {
    if (a.suspicious !== b.suspicious) return a.suspicious ? 1 : -1;
    return b.rate - a.rate;
  });
}
