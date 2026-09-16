"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dedupeApplyAction, dedupePreviewAction } from "@/app/actions";
import type { DedupePlan } from "@/lib/dedupe";
import { primaryBtnCls, secondaryBtnCls } from "./form";

// 중복 카드 정리 — 무엇을 닫을지 **먼저 보여주고** 사람이 누른 뒤에만 바꾼다.
// 남의 데이터를 한 번에 여러 건 건드리는 동작이라, 미리보기 없는 버튼을 두지 않는다.

export function DedupeCard() {
  const router = useRouter();
  const [plan, setPlan] = useState<DedupePlan | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(work: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await work();
      } catch {
        setError("서버 오류가 났습니다. 다시 시도해주세요.");
      }
    });
  }

  if (done !== null) {
    return (
      <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">
        ✅ {done}장을 기록 완료로 옮겼습니다. 딜 탭의 “기록 완료” 필터에 그대로 있습니다.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {plan === null ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(async () => setPlan(await dedupePreviewAction()))}
          className={secondaryBtnCls}
        >
          {pending ? "확인 중…" : "중복 카드 확인"}
        </button>
      ) : plan.closeCount === 0 && plan.manualCount === 0 ? (
        <p className="text-sm text-muted">정리할 중복이 없습니다.</p>
      ) : (
        <>
          <p className="text-sm">
            상품 <b>{plan.groups.length}개</b>에서 <b>{plan.closeCount}장</b>을 닫습니다.
            {plan.manualCount > 0 && (
              <span className="text-muted">
                {" "}
                링크가 붙은 {plan.manualCount}장은 그대로 둡니다.
              </span>
            )}
          </p>

          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-lg border border-line p-3">
            {plan.groups.map((group) => (
              <li key={group.keep.dealId} className="text-xs">
                <div className="truncate font-medium">{group.productLabel}</div>
                <div className="text-muted">
                  남김: {group.keep.stageLabel} ({group.keep.when})
                </div>
                {group.close.map((card) => (
                  <div key={card.dealId} className="text-muted">
                    닫음: {card.stageLabel} ({card.when})
                  </div>
                ))}
                {group.manual.map((card) => (
                  <div key={card.dealId} className="text-honey">
                    그대로 둠: {card.stageLabel} ({card.when}) — 링크 {card.links}개
                  </div>
                ))}
              </li>
            ))}
          </ul>

          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => setPlan(null)} className={secondaryBtnCls}>
              취소
            </button>
            <button
              type="button"
              disabled={pending || plan.closeCount === 0}
              onClick={() =>
                run(async () => {
                  const result = await dedupeApplyAction();
                  setDone(result.closed);
                  setPlan(null);
                  router.refresh();
                })
              }
              className={`${primaryBtnCls} flex-1`}
            >
              {pending ? "정리 중…" : `${plan.closeCount}장 정리하기`}
            </button>
          </div>
        </>
      )}

      {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
