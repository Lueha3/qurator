"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInviteAction, revokeInviteAction } from "@/app/actions";
import { inputCls, primaryBtnCls, secondaryBtnCls } from "./form";

export interface InviteView {
  id: string;
  note: string | null;
  expiresAt: string;
}

// 1회용 등록 초대 — docs/03 §7.2.
//
// 코드는 **발급 순간에만** 화면에 뜬다. 목록에서는 다시 보여주지 않는다 — 다시 볼 수 있으면
// 그 목록 화면이 곧 열쇠 보관함이 되고, 30분·1회용으로 좁혀둔 의미가 사라진다.

export function InviteCard({ invites }: { invites: InviteView[] }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      {invites.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-lg border border-line p-3">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0">
                <b className="text-sm font-medium">{invite.note ?? "이름 없음"}</b>
                <span className="block text-muted">
                  {formatExpiry(invite.expiresAt)}까지 · 아직 사용 안 함
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await revokeInviteAction(invite.id);
                    router.refresh();
                  })
                }
                className="shrink-0 rounded-lg border border-line-strong px-2.5 py-1.5 text-danger transition-colors hover:border-danger disabled:opacity-50"
              >
                취소
              </button>
            </li>
          ))}
        </ul>
      )}

      {fresh ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            이 링크를 보내주세요. <b>30분 뒤 만료</b>되고 <b>한 번만</b> 쓸 수 있습니다. 이 화면을
            벗어나면 다시 볼 수 없습니다.
          </p>
          <code className="block break-all rounded-lg border border-line bg-background p-3 font-mono text-xs">
            {fresh}
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFresh(null)}
              className={secondaryBtnCls}
            >
              닫기
            </button>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh);
                setCopied(true);
              }}
              className={`${primaryBtnCls} flex-1`}
            >
              {copied ? "복사됨 ✓" : "링크 복사"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">누구에게 보내나요</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={24}
              placeholder="예: 현표"
              className={inputCls}
            />
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const invite = await createInviteAction(note);
                setFresh(invite.url);
                setCopied(false);
                setNote("");
                router.refresh();
              })
            }
            className={primaryBtnCls}
          >
            {pending ? "만드는 중…" : "등록 링크 만들기"}
          </button>
        </div>
      )}
    </div>
  );
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}
