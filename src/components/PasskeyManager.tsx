"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { deletePasskeyAction } from "@/app/actions";
import { primaryBtnCls } from "./form";

export interface PasskeyView {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

// Face ID 등록 — docs/03 §7.1. 등록은 **이미 로그인한 상태에서만** 된다(이 화면이 게이트 뒤다).
//
// 마지막 하나를 지우는 것을 막지 않는다. `?k=` 주소가 비상구로 늘 살아 있어서
// 패스키를 전부 지워도 앱에서 잠기지 않기 때문이다 — 그 사실을 화면에도 적는다.

export function PasskeyManager({ passkeys }: { passkeys: PasskeyView[] }) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  async function register() {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      return setNote("이 브라우저는 패스키를 지원하지 않습니다.");
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/auth/passkey/register");
      if (!res.ok) {
        setNote("서버 설정(PUBLIC_BASE_URL)이 없어 등록할 수 없습니다.");
        return;
      }
      const attestation = await startRegistration({ optionsJSON: await res.json() });

      const verified = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attestation),
      });
      if (!verified.ok) {
        setNote("등록하지 못했습니다. 다시 시도해주세요.");
        return;
      }
      const { label } = await verified.json();
      setNote(`${label} 등록 완료. 이제 주소만 치고 얼굴만 보면 열립니다.`);
      router.refresh();
    } catch {
      // 사람이 Face ID를 취소한 경우도 여기로 온다 — 실패라고 겁주지 않는다.
      setNote(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {passkeys.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-lg border border-line p-3">
          {passkeys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0">
                <b className="text-sm font-medium">{key.label ?? "기기"}</b>
                <span className="block text-muted">
                  {key.lastUsedAt
                    ? `마지막 사용 ${formatDay(key.lastUsedAt)}`
                    : `등록 ${formatDay(key.createdAt)} · 아직 사용 안 함`}
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await deletePasskeyAction(key.id);
                    router.refresh();
                  })
                }
                className="shrink-0 rounded-lg border border-line-strong px-2.5 py-1.5 text-danger transition-colors hover:border-danger disabled:opacity-50"
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" onClick={register} disabled={busy} className={primaryBtnCls}>
        {busy ? "등록 중…" : passkeys.length > 0 ? "이 기기도 등록하기" : "이 기기에 Face ID 등록"}
      </button>

      {note && <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
    </div>
  );
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}
