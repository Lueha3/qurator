"use client";

import { emptyCls, inputCls, segmentCls, segmentItemCls } from "./form";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { unwatchAction } from "@/app/actions";
import type { DealDTO } from "@/lib/api-types";
import { kstDayKey, kstDayLabel, kstTime } from "@/lib/format";
import { DealListRow } from "./DealListRow";
import { DealStageCard } from "./DealStageCard";
import { DealForm } from "./DealForm";

// 딜 탭 — docs/08 §3.3.
//
// 왜 목록과 카드를 분리했나: 카드(DealStageCard)는 딜 1건의 모든 것을 보여주도록 만들어져 있어서
// 30건이 쌓이면 스크롤로 찾을 수 없다. 그래서 **찾기는 행에서, 하기는 시트에서** 한다.
// 카드 자체는 한 글자도 바뀌지 않았다 — 놓이는 자리만 바뀌었다(docs/06 §3.0 버튼 규칙 유지).
//
// V3 (docs/08 §4.0.6): 줄마다 날짜를 찍는 대신 날짜로 묶는다. 같은 날 찍은 것이 한 카드 안에
// 모이니 "오늘 뭘 올렸지"가 한눈에 보이고, 줄에는 시각만 남아 상품명이 주인공이 된다.

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
  { key: "candidate", label: "결정 전" },
  { key: "awaiting", label: "링크 필요" },
  { key: "ready", label: "문구 준비됨" },
  { key: "saved", label: "지켜보는 중" },
  { key: "approved", label: "올림" },
  { key: "skipped", label: "보관" },
  { key: "archived", label: "지난 딜" },
];

const EMPTY_TEXT: Record<DealFilter, string> = {
  all: "아직 딜이 없어요. 오른쪽 아래 [📷 올리기]로 시작해보세요.",
  candidate: "결정할 딜이 없어요. 스크린샷을 올리면 여기에 쌓여요.",
  awaiting: "링크가 필요한 딜이 없어요.",
  ready: "카톡 문구를 받을 딜이 없어요.",
  saved: "지켜보는 상품이 없어요. 딜을 열고 [📈 가격만 지켜보기]를 눌러보세요.",
  approved: "최근 30일 안에 올린 딜이 없어요.",
  skipped: "보관한 딜이 없어요.",
  archived: `올린 지 ${ARCHIVE_AFTER_DAYS}일이 지난 딜은 아직 없어요.`,
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

interface DayGroup {
  key: string;
  label: string;
  deals: DealDTO[];
}

/** 목록은 이미 최신순이므로 순서를 지키며 같은 날짜끼리 묶기만 한다 */
function groupByDay(deals: DealDTO[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const deal of deals) {
    const date = new Date(deal.createdAt);
    const key = kstDayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.deals.push(deal);
    else groups.push({ key, label: kstDayLabel(date, now), deals: [deal] });
  }
  return groups;
}

export function DealBrowser({
  deals,
  curatorShopUrl,
  initialFilter,
  initialDealId,
  nowIso,
}: {
  deals: DealDTO[];
  curatorShopUrl: string | null;
  initialFilter: DealFilter;
  initialDealId: string | null;
  /**
   * 서버가 정한 기준 시각. 클라이언트가 Date.now()를 따로 부르면 "오늘/어제" 경계와 보관 판정이
   * 서버 렌더와 달라져 하이드레이션이 깨질 수 있다 — 같은 순간을 그대로 넘겨받는다.
   */
  nowIso: string;
}) {
  const [filter, setFilter] = useState<DealFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialDealId);
  const [manualOpen, setManualOpen] = useState(false);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const manualRef = useRef<HTMLDialogElement>(null);

  const nowDate = useMemo(() => new Date(nowIso), [nowIso]);
  const now = nowDate.getTime();

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

  const groups = useMemo(() => groupByDay(visible, nowDate), [visible, nowDate]);

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

  const showRelease = filter === "saved";

  return (
    <div className="flex flex-col gap-4">
      {/* 필터: GrowthPilot의 세그먼트 스위치 — 흰 상자 안 연한 초록 알약 */}
      <div className="-mx-4 overflow-x-auto px-4 no-scrollbar">
        <div className={`w-max ${segmentCls}`}>
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => selectFilter(f.key)}
                aria-pressed={active}
                className={segmentItemCls(active)}
              >
                {f.label}
                {counts[f.key] > 0 && (
                  <span className={`ml-1 tabular-nums ${active ? "opacity-70" : "opacity-60"}`}>{counts[f.key]}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="브랜드나 상품명으로 찾기"
          aria-label="딜 검색"
          className={inputCls}
        />
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          className="shrink-0 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm font-semibold text-ink-soft"
        >
          ✏️ 직접 만들기
        </button>
      </div>

      {visible.length === 0 ? (
        <p className={emptyCls}>
          {query.trim() ? `“${query.trim()}”에 맞는 딜이 없어요.` : EMPTY_TEXT[filter]}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-2">
            <h3 className="px-1 text-[13px] font-medium text-ink-soft">{group.label}</h3>
            <ul className="card divide-y divide-line">
              {group.deals.map((deal) => (
                <DealRow
                  key={deal.id}
                  deal={deal}
                  time={kstTime(new Date(deal.createdAt))}
                  showRelease={showRelease}
                  onOpen={() => openSheet(deal.id)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <dialog ref={sheetRef} className="sheet" onClose={closeSheet} onClick={(e) => {
        // backdrop(=dialog 자신) 클릭으로 닫는다. 내용 영역 클릭은 여기까지 올라오지 않는다.
        if (e.target === sheetRef.current) closeSheet();
      }}>
        <div className="max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-paper p-4 sm:rounded-3xl">
          <div className="mb-3 flex items-center justify-between">
            <span className="h-1 w-10 rounded-full bg-line-strong/50 sm:hidden" aria-hidden />
            <button
              type="button"
              onClick={closeSheet}
              className="ml-auto rounded-lg bg-surface px-3 py-1.5 text-sm text-ink-soft border border-line"
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
        <div className="max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-paper p-4 sm:rounded-3xl">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">✏️ 직접 만들기</h2>
            <button
              type="button"
              onClick={() => setManualOpen(false)}
              className="rounded-lg bg-surface px-3 py-1.5 text-sm text-ink-soft border border-line"
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
  time,
  showRelease,
  onOpen,
}: {
  deal: DealDTO;
  time: string;
  showRelease: boolean;
  onOpen: () => void;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <li>
      <DealListRow deal={deal} trailing={time} hideSavedTag={showRelease} onOpen={onOpen} />
      {showRelease && (
        <div className="flex items-center justify-between gap-3 px-3.5 pb-3 pl-[66px] text-xs text-ink-soft">
          <span>
            {deal.priceHistory?.currentCapturedLabel
              ? `마지막 기록 ${deal.priceHistory.currentCapturedLabel}`
              : "아직 기록 없음"}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(async () => void (await unwatchAction(deal.productId)))}
            className="shrink-0 font-medium hover:text-danger disabled:opacity-50"
          >
            그만 지켜보기
          </button>
        </div>
      )}
    </li>
  );
}
