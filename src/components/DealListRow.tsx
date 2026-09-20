"use client";

import Link from "next/link";
import type { DealDTO } from "@/lib/api-types";
import { dealPriceParts } from "@/lib/deal-format";
import { STAGE_DOT, STAGE_LABEL } from "@/lib/deal-stage";
import { formatKRW } from "@/lib/format";
import { BrandMark } from "./BrandMark";

// 딜 한 줄 — 홈(최근 캡처)과 딜 탭이 같은 행을 쓴다 (docs/08 §4.0.6).
//
// 위계: 상품명이 주인공, 할인율이 감정, 브랜드·상태는 눈썹(작고 흐리게), 시각은 맨 뒤.
// 예전 행은 날짜가 오른쪽 위에서 가장 먼저 읽혔다 — 날짜는 이 줄에서 가장 안 중요한 정보다.
//
// 홈에서는 <Link>, 딜 탭에서는 시트를 여는 <button>이다. 마크업은 같다.

interface RowProps {
  deal: DealDTO;
  /** 오른쪽 아래 작은 글자 — "14:49" 또는 "1시간 전". 서버가 정한 문자열을 그대로 받는다 */
  trailing?: string;
  /** "지켜보는 중" 필터에서는 그 표시가 중복이라 숨긴다 */
  hideSavedTag?: boolean;
  href?: string;
  onOpen?: () => void;
  /** 선택 삭제 모드일 때만 켠다 — 브랜드 마크 앞에 체크박스를 그린다. 홈 화면은 쓰지 않는다 */
  selected?: boolean;
}

export function DealListRow({ deal, trailing, hideSavedTag, href, onOpen, selected }: RowProps) {
  const price = dealPriceParts(deal);
  const dot = STAGE_DOT[deal.approvalStage];
  const done = deal.approvalStage === "SKIPPED";

  const body = (
    <>
      {selected !== undefined && (
        <span
          aria-hidden
          className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${
            selected ? "border-accent bg-accent text-accent-ink" : "border-line-strong text-transparent"
          }`}
        >
          ✓
        </span>
      )}
      <BrandMark brand={deal.brand} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] leading-4 text-ink-soft">
          <span className="truncate">{deal.brand}</span>
          <span aria-hidden>·</span>
          <span className="flex shrink-0 items-center gap-1">
            {dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
            {STAGE_LABEL[deal.approvalStage]}
          </span>
          {deal.soldOut && <span className="shrink-0 text-danger">· 품절</span>}
          {deal.watchActive && !hideSavedTag && (
            <span className="shrink-0 text-accent">· 지켜보는 중</span>
          )}
        </div>

        <div className={`mt-0.5 truncate text-[15px] font-semibold leading-snug ${done ? "text-ink-soft" : ""}`}>
          {deal.productName}
        </div>

        <div className="mt-1 flex items-baseline gap-1.5 text-sm">
          {price.missing ? (
            <span className="text-xs font-medium text-danger">⚠️ 가격 오류 — 눌러서 고치기</span>
          ) : (
            <>
              <span className={`font-semibold ${done ? "text-ink-soft" : ""}`}>{formatKRW(price.effective!)}</span>
              {price.list != null && (
                <span className="text-xs text-ink-soft line-through">{formatKRW(price.list)}</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5 self-stretch">
        {price.discountRate != null && price.discountRate > 0 ? (
          <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-4 text-accent-ink">
            {price.discountRate}%
          </span>
        ) : (
          <span className="h-5" aria-hidden />
        )}
        {trailing && <span className="mt-auto text-[11px] tabular-nums text-ink-soft">{trailing}</span>}
      </div>
    </>
  );

  const cls = "flex w-full items-start gap-3 px-3.5 py-3 text-left";
  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onOpen} className={cls}>
      {body}
    </button>
  );
}
