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
    <div className="flex-1 rounded-lg border border-line px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`mt-0.5 text-sm ${tone === "muted" ? "text-muted" : "font-medium"}`}>
        {children}
      </div>
    </div>
  );
}

function EventCell({ event }: { event: PriceEventDTO }) {
  const label = event.manualOnly ? `${event.eventTag} (수동)` : event.eventTag;

  // 실할인율이 헤드라인이다. 표본이 부족하면 %를 띄우지 않는다 — 위장 인상을 못 거른 숫자이므로.
  if (event.realDiscountRate !== null) {
    return (
      <Cell label={label}>
        {event.realDiscountRate}%<span className="ml-1.5 text-xs text-muted">실할인</span>
        <div className="text-xs font-normal text-muted">{formatKRW(event.salePrice)}</div>
      </Cell>
    );
  }

  return (
    <Cell label={label}>
      {formatKRW(event.salePrice)}
      {event.listDiscountRate !== null && (
        <span className="ml-1.5 text-xs text-muted">정가 대비 {event.listDiscountRate}%</span>
      )}
      {/*
        기준가 진행률은 "앞으로 모이면 실할인율이 나온다"는 뜻이다.
        수동 입력 행사(시스템 이전의 과거)는 표본이 영영 오지 않으므로 진행률을 띄우면 거짓말이 된다.
      */}
      <div className="text-xs font-normal text-muted">
        {event.manualOnly
          ? "기록 이전 행사 — 실할인율 없음"
          : `기준가 수집 ${event.baselineSampleSize}/3`}
      </div>
    </Cell>
  );
}

export function PriceStrip({ history }: { history: PriceHistoryDTO }) {
  // 최근 두 행사만 — "작년 vs 올해"가 한눈에 들어오는 것이 목적이다.
  const events = history.events.slice(-2);

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {events.length === 0 ? (
        <Cell label="행사 기록" tone="muted">
          아직 없음
          <div className="text-xs font-normal text-muted">
            스냅샷 {history.snapshotCount}건 수집 중
          </div>
        </Cell>
      ) : (
        events.map((e) => <EventCell key={e.eventTag} event={e} />)
      )}

      <Cell label="현재가" tone={history.currentSalePrice === null ? "muted" : "normal"}>
        {history.currentSalePrice === null ? (
          "아직 스냅샷 없음"
        ) : (
          <>
            {formatKRW(history.currentCouponPrice ?? history.currentSalePrice)}
            {history.currentCouponPrice !== null && (
              <span className="ml-1.5 text-xs text-muted">쿠폰가</span>
            )}
            <div className="text-xs font-normal text-muted">
              {history.currentCapturedLabel} 기준 · 스냅샷 {history.snapshotCount}건
            </div>
          </>
        )}
      </Cell>
    </div>
  );
}
