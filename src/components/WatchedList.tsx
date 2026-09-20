"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startDealAction, unwatchAction } from "@/app/actions";
import type { WatchedProductDTO } from "@/lib/watch-list";
import { formatKRW } from "@/lib/format";
import { BrandMark } from "./BrandMark";
import { emptyCls } from "./form";

// 지켜보는 상품 목록 — docs/06 §4.6.
//
// 딜 목록(DealListRow)과 다른 것을 보여준다. 여기 있는 상품은 대개 딜이 없다 — 좋아요 목록을
// 통째로 담은 것이라 "아직 올릴지 정하지 않은 상품"이기 때문이다. 그래서 행의 주인공은 단계가
// 아니라 **가격이 내렸는가**이고, 주 동작은 "딜 시작하기" 하나다.
//
// 딜이 이미 있는 상품은 그 카드로 바로 간다 — 같은 상품의 판단이 두 장으로 갈라지지 않게.

export function WatchedList({
  items,
  selectMode,
  selected,
  onToggleSelect,
}: {
  items: WatchedProductDTO[];
  /** 체크박스 선택 모드 — DealBrowser의 "☑️ 선택" 토글을 공유한다 (2026-09-20) */
  selectMode?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (productId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className={emptyCls}>
        지켜보는 상품이 없어요.
        <br />
        무신사 좋아요 목록을 찍어 올리면 한 번에 담을 수 있어요.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <ul className="card divide-y divide-line">
        {items.map((item) => (
          <WatchedRow
            key={item.productId}
            item={item}
            onError={setError}
            selectMode={selectMode}
            selected={selected?.has(item.productId)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function WatchedRow({
  item,
  onError,
  selectMode,
  selected,
  onToggleSelect,
}: {
  item: WatchedProductDTO;
  onError: (message: string | null) => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (productId: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function open() {
    if (selectMode) {
      onToggleSelect?.(item.productId);
      return;
    }
    onError(null);
    startTransition(async () => {
      try {
        const result = await startDealAction(item.productId);
        if (!result.ok) {
          onError(result.reason);
          return;
        }
        router.push(`/deals?d=${result.dealId}`);
        router.refresh();
      } catch {
        onError("딜을 열지 못했어요. 다시 눌러주세요.");
      }
    });
  }

  // 목록이 300줄이 될 수 있으므로 "그만 지켜보기"에 한 줄을 더 내주지 않는다 — 행 오른쪽
  // 아래의 빈 자리에 겹쳐 놓고, 그 자리만 본문 탭에서 떼어낸다(pr-20으로 겹침 방지).
  // 선택 모드에서는 숨긴다 — 탭 전체가 선택 토글이라 겹친 버튼이 오조작을 부른다.
  return (
    <li className="relative">
      <button
        type="button"
        onClick={open}
        disabled={pending}
        className="flex w-full items-start gap-3 px-3.5 py-3 pb-3.5 text-left disabled:opacity-50"
      >
        {selectMode && (
          <span
            aria-hidden
            className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${
              selected ? "border-accent bg-accent text-accent-ink" : "border-line-strong text-transparent"
            }`}
          >
            ✓
          </span>
        )}
        <BrandMark brand={item.brandName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] leading-4 text-ink-soft">
            {/* 등록순번 — 정렬을 무엇으로 바꿔도 이 번호로 원래 화면 위치를 되짚을 수 있다 */}
            <span className="shrink-0 tabular-nums text-ink-faint">#{item.registrationNo}</span>
            <span className="truncate">{item.brandName}</span>
            {item.dealId && <span className="shrink-0 text-accent">· 딜 있음</span>}
          </div>

          <div className="mt-0.5 truncate text-[15px] font-semibold leading-snug">
            {item.productName}
          </div>

          <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 pr-20 text-sm">
            {item.price === null ? (
              <span className="text-xs text-ink-soft">아직 가격 기록 없음</span>
            ) : (
              <>
                {item.priceBefore !== null && (
                  <span className="whitespace-nowrap text-xs text-ink-soft line-through">
                    {formatKRW(item.priceBefore)}
                  </span>
                )}
                <span className="whitespace-nowrap font-semibold">{formatKRW(item.price)}</span>
                <span className="text-[11px] text-ink-faint">· {item.recordCount}번 기록</span>
              </>
            )}
          </div>
        </div>

        {/* 배지와 화살표는 위쪽에 모은다 — 행 오른쪽 아래는 "그만 지켜보기"가 쓴다.
            화면 할인율(맨 앞, DealListRow와 같은 맨 배지)과 dropRate(📉, 지난 기록 대비 내림)는
            다른 값이라 나란히 둬도 헷갈리지 않게 이모지로 구분한다. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {item.discountRateShown !== null && item.discountRateShown > 0 && (
            <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-4 text-accent-ink">
              {item.discountRateShown}%
            </span>
          )}
          {item.dropRate !== null && (
            <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold leading-4 text-accent-ink">
              📉 {item.dropRate}%
            </span>
          )}
          <span aria-hidden className="text-ink-faint">
            ›
          </span>
        </div>
      </button>

      {!selectMode && (
        <div className="absolute bottom-2.5 right-3.5">
          <ReleaseButton productId={item.productId} onError={onError} />
        </div>
      )}
    </li>
  );
}

function ReleaseButton({
  productId,
  onError,
}: {
  productId: string;
  onError: (message: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        onError(null);
        startTransition(async () => {
          try {
            await unwatchAction(productId);
          } catch {
            onError("그만두지 못했어요. 다시 눌러주세요.");
          }
        });
      }}
      className="text-xs font-medium text-ink-faint transition-colors hover:text-danger disabled:opacity-50"
    >
      그만 지켜보기
    </button>
  );
}
