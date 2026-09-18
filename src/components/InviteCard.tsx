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
                <span className="block text-ink-soft">
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
          <p className="text-xs text-ink-soft">
            이 링크를 보내주세요. <b>30분 뒤 만료</b>되고 <b>한 번만</b> 쓸 수 있습니다. 이 화면을
            벗어나면 다시 볼 수 없습니다.
          </p>
          <code className="block break-all rounded-lg border border-line bg-paper p-3 font-mono text-xs">
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
            <span className="text-xs font-medium text-ink-soft">누구에게 보내나요</span>
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

/**
 * 24시간제로 고정한다(hour12: false). `hour: "numeric"`(12시간제)를 썼을 때 서버(Node)는
 * 오전/오후를 "AM"/"PM"으로 내놓는데 브라우저는 "오전"/"오후"로 내놓아서 — 같은 로캘·같은
 * 시각인데 서버가 그린 HTML과 클라이언트가 그린 문자열이 달라 **하이드레이션이 깨졌다**
 * (2026-09-18, 실사용 중 발견 — 설정 탭이 React #418로 통째로 다시 그려지면서 방금 만든
 * 초대 링크가 화면에서 사라지는 사고로 나타났다). 24시간제는 오전/오후 표기 자체가 없어
 * 이 발산이 생기지 않는다(Node·Chromium 둘 다 "05:00").
 */
function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}
