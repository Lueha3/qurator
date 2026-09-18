"use client";

import { useState, useTransition } from "react";
import { unwatchAction } from "@/app/actions";
import { secondaryBtnCls } from "./form";

export interface WatchRow {
  productId: string;
  brand: string;
  productName: string;
  /** "3시간 전" — 서버에서 확정한 문자열 */
  lastSnapshotLabel: string | null;
}

export function WatchList({ rows }: { rows: WatchRow[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-ink-soft">
        지켜보는 상품이 없어요. 딜을 열고 [📈 가격만 지켜보기]를 눌러보세요.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.productId} className="card flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {row.brand} · {row.productName}
            </div>
            <div className="text-xs text-ink-soft">
              {row.lastSnapshotLabel ? `마지막 기록 ${row.lastSnapshotLabel}` : "아직 기록 없음"}
            </div>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                try {
                  await unwatchAction(row.productId);
                } catch {
                  setError("그만두지 못했어요. 다시 눌러주세요.");
                }
              });
            }}
            className={`${secondaryBtnCls} flex-none`}
          >
            그만 지켜보기
          </button>
        </li>
      ))}
      {error && <li className="text-sm text-danger">{error}</li>}
    </ul>
  );
}
