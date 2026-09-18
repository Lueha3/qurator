import { formatKRW } from "@/lib/format";
import type { PriceEventDTO, PriceHistoryDTO } from "@/lib/api-types";

// BF 가격 비교 스트립 — docs/05-price-watch.md §4.6.
//
// 표시 원칙: **없는 데이터를 있는 것처럼 그리지 않는다.**
// 기준가 표본이 부족하면 할인율 대신 "기준가 수집 중 (2/3)"을 보여주고,
// 수동 입력값에는 반드시 배지를 단다. 사람이 이 숫자를 보고 "작년보다 싸다"고 방송하기 때문에,
// 확신의 정도가 숫자와 함께 보여야 한다.

function Cell({
  label,
  children,
  tone = "normal",
}: {
  label: string;
  children: React.ReactNode;
  tone?: "normal" | "muted";
}) {
  return (
    <div className="flex-1 rounded-xl bg-paper px-3 py-2">
      <div className="text-[11px] text-ink-soft">{label}</div>
      <div className={`mt-0.5 text-sm ${tone === "muted" ? "text-ink-soft" : "font-medium"}`}>
        {children}
      </div>
    </div>
  );
}

function EventCell({ event }: { event: PriceEventDTO }) {
  const label = event.manualOnly ? `${event.eventTag} (직접 입력)` : event.eventTag;

  // 쿠폰가 라인은 두 분기(실할인 있음/없음) 모두에서 조건이 같아 한 번만 만든다 —
  // "작년 vs 올해"를 나란히 볼 때 쿠폰가 유무로 줄 수가 흔들리면 비교가 깨진다.
  const couponLine = event.couponPrice !== null && (
    <div className="text-xs font-normal text-ink-soft">
      쿠폰가 {formatKRW(event.couponPrice)}
      {event.couponDiscountRate !== null && ` · 평소보다 ${event.couponDiscountRate}% 싸요`}
    </div>
  );

  // 실할인율이 헤드라인이다. 표본이 부족하면 %를 띄우지 않는다 — 위장 인상을 못 거른 숫자이므로.
  if (event.realDiscountRate !== null) {
    return (
      <Cell label={label}>
        <span className="text-xs font-normal text-ink-soft">평소보다 </span>{event.realDiscountRate}%<span className="ml-1 text-xs font-normal text-ink-soft">싸요</span>
        <div className="text-xs font-normal text-ink-soft">{formatKRW(event.salePrice)}</div>
        {couponLine}
      </Cell>
    );
  }

  return (
    <Cell label={label}>
      {formatKRW(event.salePrice)}
      {event.listDiscountRate !== null && (
        <span className="ml-1.5 text-xs text-ink-soft">정가에서 {event.listDiscountRate}%</span>
      )}
      {/*
        기준가 진행률은 "앞으로 모이면 실할인율이 나온다"는 뜻이다.
        수동 입력 행사(시스템 이전의 과거)는 표본이 영영 오지 않으므로 진행률을 띄우면 거짓말이 된다.
      */}
      <div className="text-xs font-normal text-ink-soft">
        {event.manualOnly
          ? "기록 시작 전 행사라 비교는 없어요"
          : `평소 가격 모으는 중 ${event.baselineSampleSize}/3`}
      </div>
      {couponLine}
    </Cell>
  );
}

/**
 * BF 이벤트 태그가 하나도 없을 때("몇 달 전 vs 지금" 같은 일반 기간 비교, 행사 기간 무관)
 * 보여줄 카드. events가 비어 있어도 자동 스냅샷이 2건 이상이면 가장 오래된 것과 최신을 비교한다 —
 * 6개월 뒤 다시 찍은 스크린샷처럼, BF 창 밖에서 쌓인 기록도 "첫 기록 vs 현재"로는 항상 보인다.
 */
function FirstRecordCell({ history }: { history: PriceHistoryDTO }) {
  if (history.firstSalePrice === null) {
    return (
      <Cell label="행사 기록" tone="muted">
        아직 없어요
        <div className="text-xs font-normal text-ink-soft">
          가격 {history.snapshotCount}번 기록했어요
        </div>
      </Cell>
    );
  }

  const rate = history.firstChangeRate;
  return (
    <Cell label="첫 기록">
      {formatKRW(history.firstSalePrice)}
      {rate !== null && rate !== 0 && (
        <span className="ml-1.5 text-xs text-ink-soft">
          {rate > 0 ? `지금이 ${rate}% 더 싸요` : `지금이 ${Math.abs(rate)}% 더 비싸요`}
        </span>
      )}
      <div className="text-xs font-normal text-ink-soft">
        {history.firstCapturedLabel} 기록
        {history.firstCouponPrice !== null && ` · 쿠폰가 ${formatKRW(history.firstCouponPrice)}`}
      </div>
    </Cell>
  );
}

export function PriceStrip({ history }: { history: PriceHistoryDTO }) {
  // 최근 두 행사만 — "작년 vs 올해"가 한눈에 들어오는 것이 목적이다.
  const events = history.events.slice(-2);
  // 비교할 것이 하나도 없으면(첫 기록뿐) 스트립을 그리지 않는다 — 빈 셀 두 개가 자리만 차지한다.
  if (events.length === 0 && history.firstSalePrice === null) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {events.length === 0 ? (
        <FirstRecordCell history={history} />
      ) : (
        events.map((e) => <EventCell key={e.eventTag} event={e} />)
      )}

      <Cell label="지금 가격" tone={history.currentSalePrice === null ? "muted" : "normal"}>
        {history.currentSalePrice === null ? (
          "아직 기록 없음"
        ) : (
          <>
            {formatKRW(history.currentCouponPrice ?? history.currentSalePrice)}
            {history.currentCouponPrice !== null && (
              <span className="ml-1.5 text-xs text-ink-soft">쿠폰가</span>
            )}
            <div className="text-xs font-normal text-ink-soft">
              {history.currentCapturedLabel} 기록 · 지금까지 {history.snapshotCount}번
            </div>
          </>
        )}
      </Cell>
    </div>
  );
}
