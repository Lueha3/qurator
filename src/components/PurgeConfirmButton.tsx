"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { purgeTestDataAction } from "@/app/actions";

// /purge-test-data 전용 확인 버튼 — 1회용 정리라 dedupe처럼 재사용 가능한 컴포넌트로
// 빼지 않는다. 페이지 자체가 미리보기이므로 여기서는 "정말 지울지" 확인만 한다.

export function PurgeConfirmButton({ productCount }: { productCount: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  if (done !== null) {
    return (
      <p className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent">
        ✅ 상품 {done}개와 딸린 데이터를 전부 지웠어요.
      </p>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-xl bg-danger px-4 py-3 text-base font-semibold text-accent-ink transition-opacity active:opacity-90"
      >
        🗑️ 위 상품 {productCount}개 전부 삭제
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-danger bg-danger/5 p-4">
      <p className="text-sm font-semibold text-danger">정말 지울까요? 되돌릴 수 없어요.</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-semibold text-ink-soft disabled:opacity-40"
        >
          취소
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await purgeTestDataAction();
              setDone(result.productCount);
              router.refresh();
            })
          }
          className="flex-1 rounded-xl bg-danger px-3 py-2.5 text-sm font-semibold text-accent-ink disabled:opacity-40"
        >
          {pending ? "지우는 중…" : "네, 지워요"}
        </button>
      </div>
    </div>
  );
}
