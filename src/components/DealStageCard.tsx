"use client";

import { useState, useTransition } from "react";
import {
  approveAction,
  attachLinkAction,
  interestAction,
  markSoldOutAction,
  replaceHookAction,
  restoreDealAction,
  skipAction,
  watchAction,
} from "@/app/actions";
import type { DealDTO } from "@/lib/api-types";
import { formatShortDateTime } from "@/lib/format";
import { dealPriceLine } from "@/lib/deal-format";
import { CopyPane } from "./CopyPane";
import { DealCard } from "./DealCard";
import { DealEditForm } from "./DealEditForm";
import { PriceStrip } from "./PriceStrip";
import { inputCls, primaryBtnCls, secondaryBtnCls } from "./form";
import { STAGE_DOT, STAGE_LABEL } from "@/lib/deal-stage";
import { BrandMark } from "./BrandMark";

// 딜 시트 — docs/02 §6 "카드 1장의 상태 전이". 결정 전 → 링크 필요 → 문구 준비됨 → 올림/보관이
// 한 자리에서 일어난다. 배치 규칙은 docs/06 §3.0 그대로: 주 동작이 한 줄을 독점하고, "올리지 않는" 것들은 아래 줄.
// 문구는 2026-09-18 GrowthPilot 톤으로 다시 썼다(docs/08 §4.0.7) — 해요체, 한 문장에 한 뜻, 개발 용어 없음.

const CURATOR_CENTER = "https://www.musinsa.com/curator";

export function DealStageCard({ deal, curatorShopUrl }: { deal: DealDTO; curatorShopUrl: string | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [hookText, setHookText] = useState("");

  function run(work: () => Promise<void>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await work();
      } catch {
        setError("잠깐 문제가 생겼어요. 다시 눌러주세요.");
      }
    });
  }

  const kakao = deal.cards.find((c) => c.channel === "KAKAO_OPEN");
  const others = deal.cards.filter((c) => c.channel !== "KAKAO_OPEN");
  const canProceed = deal.parseSource !== "none";

  return (
    <article className="card p-4">
      <header className="mb-3 flex items-start gap-3">
        <BrandMark brand={deal.brand} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] leading-4 text-ink-soft">
            <span className="truncate">{deal.brand}</span>
            <span aria-hidden>·</span>
            <span className="flex shrink-0 items-center gap-1">
              {STAGE_DOT[deal.approvalStage] && (
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STAGE_DOT[deal.approvalStage]}`} />
              )}
              {STAGE_LABEL[deal.approvalStage]}
            </span>
            <time className="ml-auto shrink-0 tabular-nums">{formatShortDateTime(new Date(deal.createdAt))}</time>
          </div>
          <h3 className="mt-0.5 text-[17px] font-semibold leading-snug tracking-tight">
            {deal.productName}
            {deal.styleCode ? <span className="whitespace-nowrap text-sm font-normal text-ink-soft"> · {deal.styleCode}</span> : null}
          </h3>
          <p className="mt-0.5 text-sm">
            {dealPriceLine(deal)}
            {deal.couponDesc ? <span className="text-ink-soft"> · 쿠폰 {deal.couponDesc}</span> : null}
          </p>
        </div>
      </header>

      {deal.priceHistory && <PriceStrip history={deal.priceHistory} />}

      {deal.approvalStage === "CANDIDATE" && (
        <div className="flex flex-col gap-3">
          {deal.priceChangeNote && (
            <pre className="whitespace-pre-wrap rounded-xl bg-accent-soft px-3 py-2 font-sans text-sm text-accent">
              {deal.priceChangeNote}
            </pre>
          )}
          {deal.parseSource === "none" && (
            <p className="text-sm text-danger">⚠️ 상품 정보를 못 읽었어요. [✏️ 정보 고치기]로 채워주세요.</p>
          )}
          {deal.parseSource === "opengraph" && (
            <p className="text-sm text-ink-soft">일부만 읽었어요. 올리기 전에 한 번 확인해주세요.</p>
          )}
          {canProceed && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => interestAction(deal.id))}
              className={primaryBtnCls}
            >
              ✅ 올릴게요
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || deal.watchActive}
              onClick={() =>
                run(async () => {
                  const r = await watchAction(deal.productId);
                  setNotice(
                    r.ok
                      ? r.alreadyActive
                        ? "이미 지켜보고 있어요."
                        : `📈 지켜보기 시작! 같은 상품을 다시 찍어 올리면 그때마다 가격 변화가 기록돼요. (지켜보는 중 ${r.activeCount}개)`
                      : `⚠️ ${r.reason}`
                  );
                })
              }
              className={secondaryBtnCls}
            >
              {deal.watchActive ? "📈 지켜보는 중" : "📈 가격만 지켜보기"}
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => skipAction(deal.id))} className={secondaryBtnCls}>
              📁 보관
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "AWAITING_LINK" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            🔗 <b>내 링크를 붙여넣어 주세요.</b>{" "}
            <span className="text-ink-soft">큐레이터센터에서 이 상품의 링크를 만들어 그대로 붙여넣으면 카톡 문구가 완성돼요.</span>
          </p>
          <a
            href={curatorShopUrl ?? CURATOR_CENTER}
            target="_blank"
            rel="noopener noreferrer"
            className={`${secondaryBtnCls} text-center`}
          >
            큐레이터센터 열기 ↗
          </a>
          <textarea
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            rows={3}
            placeholder="https://www.musinsa.com/products/…?utm_source=curator&utm_term=…"
            className={`${inputCls} resize-none`}
          />
          <button
            type="button"
            disabled={pending || !linkText.trim()}
            onClick={() =>
              run(async () => {
                const r = await attachLinkAction(deal.id, linkText);
                if (!r.ok) {
                  setError(`${r.reason} 다시 붙여넣어 주세요.`);
                  return;
                }
                setWarnings(r.warnings);
                setLinkText("");
              })
            }
            className={primaryBtnCls}
          >
            {pending ? "문구 만드는 중…" : "🔗 링크 붙이기"}
          </button>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => skipAction(deal.id))} className={secondaryBtnCls}>
              📁 보관
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "READY_TO_PUBLISH" && (
        <div className="flex flex-col gap-3">
          {warnings.length > 0 && (
            <ul className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {warnings.map((w) => (
                <li key={w}>⚠️ {w}</li>
              ))}
            </ul>
          )}
          {deal.hookLine ? (
            <p className="text-sm">
              💬 <b>{deal.hookLine}</b>
              {deal.hookSource === "ai" && <span className="ml-1 text-[11px] text-ink-soft">AI 초안</span>}
            </p>
          ) : (
            <p className="text-sm text-ink-soft">첫 줄 문구가 없어요. 아래에 넣을 수 있어요.</p>
          )}
          <div className="flex gap-2">
            <input
              value={hookText}
              onChange={(e) => setHookText(e.target.value)}
              placeholder="첫 줄 문구 (한 줄)"
              className={inputCls}
            />
            <button
              type="button"
              disabled={pending || !hookText.trim()}
              onClick={() =>
                run(async () => {
                  const r = await replaceHookAction(deal.id, hookText);
                  if (!r.ok) setError(r.reason);
                  else setHookText("");
                })
              }
              className={`${secondaryBtnCls} flex-none`}
            >
              바꾸기
            </button>
          </div>

          <p className="text-xs text-ink-soft">🔗 링크 {deal.linkCount}개</p>

          {kakao && (
            <div className="rounded-xl border border-line">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-ink-soft">
                <span>카톡에 이렇게 나가요</span>
                <span>
                  {kakao.charCount}자 ·{" "}
                  <span className={kakao.disclosureOk ? "text-accent" : "text-danger"}>
                    {kakao.disclosureOk ? "광고 표시 OK" : "광고 표시 빠짐"}
                  </span>
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words p-3 font-sans text-[13px] leading-relaxed">{kakao.bodyText}</pre>
            </div>
          )}

          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = await approveAction(deal.id);
                if (!r.ok) {
                  setError(
                    r.reason === "DISCLOSURE_FAILED"
                      ? "⛔️ 광고 표시가 빠진 문구는 올릴 수 없어요."
                      : "링크를 먼저 붙여주세요."
                  );
                }
              })
            }
            className={primaryBtnCls}
          >
            🚀 카톡 문구 받기
          </button>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => skipAction(deal.id))} className={secondaryBtnCls}>
              📁 보관
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "APPROVED" && (
        <div className="flex flex-col gap-3">
          {deal.soldOut ? (
            <p className="text-sm text-ink-soft">
              🚫 <b className="text-ink">품절로 표시했어요.</b> 팔로워 페이지에서 내렸고, 이미 보낸 링크는 안내 페이지로 가요.
            </p>
          ) : (
            <p className="text-sm">✅ <b>올렸어요!</b> 아래 문구를 복사해 카톡에 붙여넣으세요.</p>
          )}
          {kakao && <CopyPane text={kakao.bodyText} cardId={kakao.id} />}
          {others.length > 0 && (
            <details className="rounded-xl border border-line">
              <summary className="cursor-pointer px-3 py-2 text-sm text-ink-soft">
                다른 채널 문구 (스레드 · 인스타 고정댓글 · 노션)
              </summary>
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                {others.map((card) => (
                  <DealCard key={card.id} card={card} />
                ))}
              </div>
            </details>
          )}

          {/*
            품절은 사람이 표시한다 — 헬스체커는 무신사 요청이 필요해 robots에 막혀 있다(docs/05 §9.1).
            누르는 순간 허브에서 내려가고, 이미 나간 카톡·노션 링크는 안내 페이지로 착지한다.
          */}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = deal.soldOut
                    ? await restoreDealAction(deal.id)
                    : await markSoldOutAction(deal.id);
                  if (!r.ok) setError(r.reason);
                  else if (!deal.soldOut) setNotice("팔로워 페이지에서 내렸어요. 홈에서 품절 안내를 복사해 카톡에 올려주세요.");
                })
              }
              className={secondaryBtnCls}
            >
              {deal.soldOut ? "↩️ 품절 취소" : "🚫 품절됐어요"}
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "SKIPPED" && (
        <p className="text-sm text-ink-soft">📁 보관 중이에요. 가격만 기록해뒀어요.</p>
      )}

      {deal.approvalStage !== "APPROVED" && deal.approvalStage !== "SKIPPED" && (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setEditing((v) => !v)} className={secondaryBtnCls}>
            ✏️ 정보 고치기
          </button>
        </div>
      )}

      {editing && <DealEditForm deal={deal} onClose={() => setEditing(false)} />}

      {deal.approvalStage !== "APPROVED" && deal.approvalStage !== "SKIPPED" && (
        <details className="mt-3 rounded-xl bg-paper text-xs leading-relaxed text-ink-soft">
          <summary className="cursor-pointer px-3 py-2 font-medium">버튼이 뭐예요?</summary>
          <div className="flex flex-col gap-1.5 px-3 pb-3">
            <p><b className="text-ink">✅ 올릴게요</b> — 카톡에 올릴 준비를 시작해요. 링크를 붙이면 카톡 문구가 만들어져요. 바로 올라가지는 않아요.</p>
            <p><b className="text-ink">📈 가격만 지켜보기</b> — 지금은 안 올리지만 가격은 계속 보고 싶을 때. 같은 상품을 다시 찍어 올리면 “그때 얼마 → 지금 얼마”가 자동으로 비교돼요.</p>
            <p><b className="text-ink">📁 보관</b> — 이 딜을 접어요. 지우는 게 아니에요. 가격은 이미 기록됐고, 올리지만 않는 거예요.</p>
            <p><b className="text-ink">✏️ 정보 고치기</b> — 브랜드·상품명·가격을 잘못 읽었을 때 바로잡아요.</p>
            <p>💡 스크린샷을 올리는 것만으로 가격은 항상 기록돼요. 버튼은 “이 다음에 뭘 할지”를 고르는 거예요.</p>
          </div>
        </details>
      )}

      {notice && <p className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm text-accent">{notice}</p>}
      {error && <p className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
    </article>
  );
}
