"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { unwatchAction } from "@/app/actions";
import type { DealDTO } from "@/lib/api-types";
import { dealPriceLine } from "@/lib/deal-format";
import { formatShortDateTime } from "@/lib/format";
import { DealStageCard } from "./DealStageCard";
import { DealForm } from "./DealForm";

// 딜 탭 — docs/08 §3.3.
//
// 왜 목록과 카드를 분리했나: 카드(DealStageCard)는 딜 1건의 모든 것을 보여주도록 만들어져 있어서
// 30건이 쌓이면 스크롤로 찾을 수 없다. 그래서 **찾기는 행에서, 하기는 시트에서** 한다.
// 카드 자체는 한 글자도 바뀌지 않았다 — 놓이는 자리만 바뀌었다(docs/06 §3.0 버튼 규칙 유지).

const ARCHIVE_AFTER_DAYS = 30;

export type DealFilter =
  | "all"
  | "candidate"
  | "awaiting"
  | "ready"
  | "saved"
  | "approved"
  | "skipped"
  | "archived";

const FILTERS: { key: DealFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "candidate", label: "후보" },
  { key: "awaiting", label: "링크 대기" },
  { key: "ready", label: "승인 대기" },
  { key: "saved", label: "저장함" },
  { key: "approved", label: "승인 완료" },
  { key: "skipped", label: "기록 완료" },
  { key: "archived", label: "보관" },
];

const EMPTY_TEXT: Record<DealFilter, string> = {
  all: "아직 딜이 없습니다. 오른쪽 아래 [📷 올리기]로 시작하세요.",
  candidate: "후보가 없습니다. 스크린샷을 올리면 여기에 쌓입니다.",
  awaiting: "큐레이터 링크를 기다리는 딜이 없습니다.",
  ready: "승인을 기다리는 딜이 없습니다.",
  saved: "저장함이 비어 있습니다. 딜 카드의 [📈 가격만 지켜보기]로 담아두세요.",
  approved: "최근 30일 안에 승인한 딜이 없습니다.",
  skipped: "기록만 하고 넘긴 딜이 없습니다.",
  archived: `승인한 지 ${ARCHIVE_AFTER_DAYS}일이 지난 딜이 아직 없습니다.`,
};

const STAGE_CHIP: Record<DealDTO["approvalStage"], string> = {
  CANDIDATE: "후보",
  AWAITING_LINK: "링크 대기",
  READY_TO_PUBLISH: "승인 대기",
  APPROVED: "승인 완료",
  SKIPPED: "기록 완료",
};

/** 승인한 지 오래된 딜은 기본 목록에서 빠진다 — 삭제가 아니라 보관이다(허브 노출과는 무관). */
function isArchived(deal: DealDTO, now: number): boolean {
  if (deal.approvalStage !== "APPROVED") return false;
  return now - new Date(deal.createdAt).getTime() > ARCHIVE_AFTER_DAYS * 86_400_000;
}

function matches(deal: DealDTO, filter: DealFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return !isArchived(deal, now);
    case "candidate":
      return deal.approvalStage === "CANDIDATE";
    case "awaiting":
      return deal.approvalStage === "AWAITING_LINK";
    case "ready":
      return deal.approvalStage === "READY_TO_PUBLISH";
    case "saved":
      return deal.watchActive;
    case "approved":
      return deal.approvalStage === "APPROVED" && !isArchived(deal, now);
    case "skipped":
      return deal.approvalStage === "SKIPPED";
    case "archived":
      return isArchived(deal, now);
  }
}

export function DealBrowser({
  deals,
  curatorShopUrl,
  initialFilter,
  initialDealId,
}: {
  deals: DealDTO[];
  curatorShopUrl: string | null;
  initialFilter: DealFilter;
  initialDealId: string | null;
}) {
  const [filter, setFilter] = useState<DealFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialDealId);
  const [manualOpen, setManualOpen] = useState(false);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const manualRef = useRef<HTMLDialogElement>(null);

  // 상대 시각·보관 판정의 기준 시각. 렌더마다 Date.now()를 부르면 하이드레이션이 흔들린다.
  const [now] = useState(() => Date.now());

  const counts = useMemo(() => {
    const map = {} as Record<DealFilter, number>;
    for (const f of FILTERS) map[f.key] = deals.filter((d) => matches(d, f.key, now)).length;
    return map;
  }, [deals, now]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deals.filter((deal) => {
      if (!matches(deal, filter, now)) return false;
      if (!q) return true;
      return `${deal.brand} ${deal.productName} ${deal.styleCode ?? ""}`.toLowerCase().includes(q);
    });
  }, [deals, filter, query, now]);

  const openDeal = openId ? (deals.find((d) => d.id === openId) ?? null) : null;

  // <dialog>는 showModal()로 열어야 포커스 트랩·Esc·backdrop이 동작한다.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    if (openDeal && !el.open) el.showModal();
    if (!openDeal && el.open) el.close();
  }, [openDeal]);

  useEffect(() => {
    const el = manualRef.current;
    if (!el) return;
    if (manualOpen && !el.open) el.showModal();
    if (!manualOpen && el.open) el.close();
  }, [manualOpen]);

  /** 주소창을 현재 상태에 맞춘다. 새로고침해도 보던 필터·카드가 그대로 열리도록 — 서버 왕복은 없다. */
  function syncUrl(nextFilter: DealFilter, nextDealId: string | null) {
    const params = new URLSearchParams();
    if (nextFilter !== "all") params.set("f", nextFilter);
    if (nextDealId) params.set("d", nextDealId);
    const qs = params.toString();
    window.history.replaceState({}, "", qs ? `/deals?${qs}` : "/deals");
  }

  function selectFilter(next: DealFilter) {
    setFilter(next);
    syncUrl(next, openId);
  }

  function openSheet(dealId: string) {
    setOpenId(dealId);
    syncUrl(filter, dealId);
  }

  function closeSheet() {
    setOpenId(null);
    syncUrl(filter, null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-4 overflow-x-auto px-4 no-scrollbar">
        <div className="flex w-max gap-1.5">
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => selectFilter(f.key)}
                aria-pressed={active}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-honey bg-honey-soft font-medium text-honey"
                    : "border-line bg-panel text-muted"
                }`}
              >
                {f.label}
                {counts[f.key] > 0 && <span className="ml-1 text-xs opacity-70">{counts[f.key]}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="브랜드 · 상품명 검색"
          aria-label="딜 검색"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-[16px] outline-none focus:border-honey sm:text-sm"
        />
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          className="shrink-0 rounded-lg border border-line bg-panel px-3 py-2 text-sm font-medium text-muted hover:border-honey"
        >
          ✏️ 직접 입력
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
          {query.trim() ? `“${query.trim()}”와 맞는 딜이 없습니다.` : EMPTY_TEXT[filter]}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((deal) => (
            <DealRow
              key={deal.id}
              deal={deal}
              showRelease={filter === "saved"}
              onOpen={() => openSheet(deal.id)}
            />
          ))}
        </ul>
      )}

      <dialog ref={sheetRef} className="sheet" onClose={closeSheet} onClick={(e) => {
        // backdrop(=dialog 자신) 클릭으로 닫는다. 내용 영역 클릭은 여기까지 올라오지 않는다.
        if (e.target === sheetRef.current) closeSheet();
      }}>
        <div className="max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-background p-4 sm:rounded-2xl sm:border">
          <div className="mb-3 flex items-center justify-between">
            <span className="h-1 w-10 rounded-full bg-line sm:hidden" aria-hidden />
            <button
              type="button"
              onClick={closeSheet}
              className="ml-auto rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-muted"
            >
              닫기
            </button>
          </div>
          {openDeal && <DealStageCard deal={openDeal} curatorShopUrl={curatorShopUrl} />}
        </div>
      </dialog>

      <dialog ref={manualRef} className="sheet" onClose={() => setManualOpen(false)} onClick={(e) => {
        if (e.target === manualRef.current) setManualOpen(false);
      }}>
        <div className="max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-background p-4 sm:rounded-2xl sm:border">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">✏️ 직접 입력으로 카드 만들기</h2>
            <button
              type="button"
              onClick={() => setManualOpen(false)}
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-muted"
            >
              닫기
            </button>
          </div>
          <DealForm onCreated={() => setManualOpen(false)} />
        </div>
      </dialog>
    </div>
  );
}

function DealRow({
  deal,
  showRelease,
  onOpen,
}: {
  deal: DealDTO;
  showRelease: boolean;
  onOpen: () => void;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <li className="rounded-xl border border-line bg-panel">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-3.5 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted">
              {STAGE_CHIP[deal.approvalStage]}
            </span>
            {deal.parseSource === "none" && <span className="text-[11px] text-danger">정보 없음</span>}
            {deal.watchActive && !showRelease && <span aria-label="저장함" className="text-[11px]">📈</span>}
          </div>
          <div className="truncate text-sm font-medium">
            {deal.brand} · {deal.productName}
          </div>
          <div className="truncate text-sm text-muted">{dealPriceLine(deal)}</div>
          {showRelease && (
            <div className="mt-0.5 text-xs text-muted">
              {deal.priceHistory?.currentCapturedLabel
                ? `마지막 기록 ${deal.priceHistory.currentCapturedLabel}`
                : "아직 기록 없음"}
            </div>
          )}
        </div>
        <time className="shrink-0 font-mono text-[11px] text-muted">
          {formatShortDateTime(new Date(deal.createdAt))}
        </time>
      </button>

      {showRelease && (
        <div className="border-t border-line px-3.5 py-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(async () => void (await unwatchAction(deal.productId)))}
            className="text-xs font-medium text-muted hover:text-danger disabled:opacity-50"
          >
            🚫 저장함에서 빼기
          </button>
        </div>
      )}
    </li>
  );
}
