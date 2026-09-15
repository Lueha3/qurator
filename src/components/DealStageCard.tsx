"use client";

import { useState, useTransition } from "react";
import {
  approveAction,
  attachLinkAction,
  interestAction,
  replaceHookAction,
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

// 승인 카드 — docs/02 §6 "카드 1장의 상태 전이". 후보 → 링크 대기 → 발행 승인 → 승인/기록 완료가
// 한 자리에서 일어난다. 버튼 문구·배치 규칙은 docs/06 §3.0 그대로다:
//   주 동작(발행)은 한 줄을 독점하고, 나머지는 "올리지 않는다"는 점에서 같은 급이라 아래 줄에 묶는다.

const STAGE_LABEL: Record<DealDTO["approvalStage"], string> = {
  CANDIDATE: "후보",
  AWAITING_LINK: "링크 대기",
  READY_TO_PUBLISH: "승인 대기",
  APPROVED: "승인 완료",
  SKIPPED: "기록 완료",
};

const CURATOR_CENTER = "https://www.musinsa.com/curator";

export function DealStageCard({ deal, curatorShopUrl }: { deal: DealDTO; curatorShopUrl: string | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [hookText, setHookText] = useState("");

  function run(work: () => Promise<void>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await work();
      } catch {
        setError("서버 오류가 났습니다. 다시 시도해주세요.");
      }
    });
  }

  const kakao = deal.cards.find((c) => c.channel === "KAKAO_OPEN");
  const others = deal.cards.filter((c) => c.channel !== "KAKAO_OPEN");
  const canProceed = deal.parseSource !== "none";

  return (
    <article className="rounded-2xl border border-line bg-panel p-4">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <span className="mb-1 inline-block rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
            {STAGE_LABEL[deal.approvalStage]}
          </span>
          <h3 className="text-base font-semibold">
            {deal.brand} · {deal.productName}
            {deal.styleCode ? (
              <span className="whitespace-nowrap text-muted"> · {deal.styleCode}</span>
            ) : null}
          </h3>
          <p className="text-sm">
            {dealPriceLine(deal)}
            {deal.couponDesc ? <span className="text-muted"> · 쿠폰 {deal.couponDesc}</span> : null}
          </p>
        </div>
        <time className="shrink-0 font-mono text-[11px] text-muted">
          {formatShortDateTime(new Date(deal.createdAt))}
        </time>
      </header>

      {deal.priceHistory && <PriceStrip history={deal.priceHistory} />}

      {deal.approvalStage === "CANDIDATE" && (
        <div className="flex flex-col gap-3">
          {deal.priceChangeNote && (
            <pre className="whitespace-pre-wrap rounded-md bg-honey-soft px-3 py-2 font-sans text-sm text-honey">
              {deal.priceChangeNote}
            </pre>
          )}
          {deal.parseSource === "none" && (
            <p className="text-sm text-danger">⚠️ 상품 정보를 읽지 못했습니다. [✏️ 정보 고치기]로 채워주세요.</p>
          )}
          {deal.parseSource === "opengraph" && (
            <p className="text-sm text-muted">일부 정보만 읽었습니다 — 승인 전 확인해주세요.</p>
          )}
          {canProceed && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => interestAction(deal.id))}
              className={primaryBtnCls}
            >
              ✅ 이 상품 올릴게요
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
                        ? "이미 지켜보는 중입니다."
                        : `📈 가격 추적 시작 — 같은 상품을 다시 찍어 올리면 그때마다 변화가 기록됩니다. (지켜보는 중 ${r.activeCount}개)`
                      : `⚠️ ${r.reason}`
                  );
                })
              }
              className={secondaryBtnCls}
            >
              {deal.watchActive ? "📈 지켜보는 중" : "📈 가격만 지켜보기"}
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => skipAction(deal.id))} className={secondaryBtnCls}>
              ✔️ 기록 완료
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "AWAITING_LINK" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            📎 <b>큐레이터 링크를 붙여넣어 주세요.</b>{" "}
            <span className="text-muted">큐레이터센터에서 링크를 만든 뒤 그대로 붙여넣으면 카드가 완성됩니다.</span>
          </p>
          <a
            href={curatorShopUrl ?? CURATOR_CENTER}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-line px-3 py-2.5 text-center text-sm font-medium hover:border-honey"
          >
            🔗 큐레이터센터 열기
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
            {pending ? "카드 만드는 중…" : "링크 붙여넣기 → 카드 만들기"}
          </button>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => skipAction(deal.id))} className={secondaryBtnCls}>
              ✔️ 기록 완료
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "READY_TO_PUBLISH" && (
        <div className="flex flex-col gap-3">
          {warnings.length > 0 && (
            <ul className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {warnings.map((w) => (
                <li key={w}>⚠️ {w}</li>
              ))}
            </ul>
          )}
          {deal.hookLine ? (
            <p className="text-sm">
              💬 <b>{deal.hookLine}</b>
              {deal.hookSource === "ai" && <span className="ml-1 text-[11px] text-muted">AI 초안</span>}
            </p>
          ) : (
            <p className="text-sm text-muted">훅 문구 없음 — 아래에서 넣을 수 있습니다.</p>
          )}
          <div className="flex gap-2">
            <input
              value={hookText}
              onChange={(e) => setHookText(e.target.value)}
              placeholder="새 훅 문구 (한 줄)"
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
              className="shrink-0 rounded-lg border border-line px-3 text-sm font-medium hover:border-honey disabled:opacity-50"
            >
              ✏️ 훅 교체
            </button>
          </div>

          <p className="text-xs text-muted">🔗 링크 {deal.linkCount}개</p>

          {kakao && (
            <div className="rounded-lg border border-line">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
                <span>카톡 오픈채팅 미리보기 — 보이는 그대로 나갑니다</span>
                <span>
                  {kakao.charCount}자 ·{" "}
                  <span className={kakao.disclosureOk ? "text-ok" : "text-danger"}>
                    {kakao.disclosureOk ? "고지 OK" : "고지 실패"}
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
                      ? "⛔️ 고지문 검증에 실패한 카드는 발행할 수 없습니다."
                      : "카드가 없습니다 — 링크를 먼저 붙여넣어주세요."
                  );
                }
              })
            }
            className={primaryBtnCls}
          >
            🚀 승인 — 카톡 문구 받기
          </button>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => skipAction(deal.id))} className={secondaryBtnCls}>
              ✔️ 기록 완료
            </button>
          </div>
        </div>
      )}

      {deal.approvalStage === "APPROVED" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">✅ <b>승인 완료</b> — 아래 문구를 카톡에 붙여넣으세요.</p>
          {kakao && <CopyPane text={kakao.bodyText} cardId={kakao.id} />}
          {others.length > 0 && (
            <details className="rounded-lg border border-line">
              <summary className="cursor-pointer px-3 py-2 text-sm text-muted">
                다른 채널 문구 (스레드 · 인스타 고정댓글 · 노션)
              </summary>
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                {others.map((card) => (
                  <DealCard key={card.id} card={card} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {deal.approvalStage === "SKIPPED" && (
        <p className="text-sm text-muted">✔️ 기록 완료 — 가격은 저장했고, 발행은 하지 않았습니다.</p>
      )}

      {deal.approvalStage !== "APPROVED" && deal.approvalStage !== "SKIPPED" && (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setEditing((v) => !v)} className={secondaryBtnCls}>
            ✏️ 정보 고치기
          </button>
          <button type="button" onClick={() => setShowGuide((v) => !v)} className={secondaryBtnCls}>
            ❓ 버튼 설명
          </button>
        </div>
      )}

      {editing && <DealEditForm deal={deal} onClose={() => setEditing(false)} />}

      {showGuide && (
        <div className="mt-3 rounded-lg bg-background p-3 text-xs leading-relaxed text-muted">
          <p className="mb-1"><b className="text-foreground">✅ 이 상품 올릴게요</b> — 발행 준비를 시작합니다. 큐레이터센터에서 링크를 만들어 붙여넣으면 카톡 문구가 완성됩니다. <i>바로 발행되지 않습니다 — 마지막에 승인 단계가 있습니다.</i></p>
          <p className="mb-1"><b className="text-foreground">📈 가격만 지켜보기</b> — 지금 올리진 않지만 가격 변화를 계속 보고 싶을 때. 나중에 같은 상품을 다시 찍어 올리면 “그때 얼마 → 지금 얼마”가 자동으로 비교됩니다.</p>
          <p className="mb-1"><b className="text-foreground">✔️ 기록 완료</b> — 이 카드를 닫습니다. <i>삭제가 아닙니다</i> — 스크린샷을 올린 순간 가격은 이미 저장됐으니, 발행만 하지 않고 끝내는 것입니다.</p>
          <p className="mb-1"><b className="text-foreground">✏️ 정보 고치기</b> — 브랜드·상품명·가격을 잘못 읽었을 때 바로잡습니다.</p>
          <p>💡 <b className="text-foreground">스크린샷을 올리는 것만으로 가격은 항상 기록됩니다.</b> 버튼은 “이 다음에 무엇을 할지”를 고르는 것입니다.</p>
        </div>
      )}

      {notice && <p className="mt-3 rounded-md bg-honey-soft px-3 py-2 text-sm text-honey">{notice}</p>}
      {error && <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
    </article>
  );
}
