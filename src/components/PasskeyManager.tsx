"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { deletePasskeyAction } from "@/app/actions";
import { ACTOR_NAME_MAX } from "@/lib/session";
import { inputCls, primaryBtnCls } from "./form";
import { passkeyErrorMessage, rpIdMismatch } from "./passkey-error";
import { InAppBrowserNotice } from "./InAppBrowserNotice";

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
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  /** PasskeyLogin.tsx의 같은 이름 함수와 같은 이유·같은 구현이다 — 공용 모듈로 뺄 만큼
   * 무겁지 않아 각자 두었지만, 고칠 때는 둘 다 고쳐야 한다. */
  async function hasAuthenticator(): Promise<boolean> {
    if (typeof window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
      return true;
    }
    try {
      return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return true;
    }
  }

  async function register() {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      return setProblem("이 브라우저에서는 안 돼요. Safari로 열어주세요.");
    }
    // 없는 기기에서 시도하면 응답 없이 매달려 "등록 중…" 버튼이 영원히 굳어버린다
    // (2026-09-18, 테스트 중 재현) — 시도 전에 먼저 확인한다.
    if (!(await hasAuthenticator())) {
      return setProblem("이 기기에는 Face ID가 없어요.");
    }
    setBusy(true);
    setNote(null);
    setProblem(null);
    try {
      const res = await fetch("/api/auth/passkey/register");
      if (!res.ok) {
        setProblem("서버 설정이 아직 없어요. 관리자에게 알려주세요.");
        return;
      }

      const options = await res.json();
      // 브라우저에 넘기기 전에 도메인부터 대조한다 — 여기서 걸리면 원인이 분명하다.
      const mismatch = rpIdMismatch(options);
      if (mismatch) {
        setProblem(mismatch);
        return;
      }

      const attestation = await startRegistration({ optionsJSON: options });

      const verified = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: attestation, label: name }),
      });
      if (!verified.ok) {
        setProblem(`등록이 안 됐어요 (${await verified.text()}).`);
        return;
      }
      const { label } = await verified.json();
      setNote(`${label} 등록했어요! 이제 얼굴만 보면 들어와져요.`);
      setName("");
      router.refresh();
    } catch (error) {
      setProblem(passkeyErrorMessage(error, "등록"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <InAppBrowserNotice />
      {passkeys.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-lg border border-line p-3">
          {passkeys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0">
                <b className="text-sm font-medium">{key.label ?? "기기"}</b>
                <span className="block text-ink-soft">
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
                className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-danger transition-colors hover:border-danger disabled:opacity-50"
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-soft">이 기기 이름</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={ACTOR_NAME_MAX}
          placeholder="예: 내 맥"
          className={inputCls}
        />
      </label>

      <button type="button" onClick={register} disabled={busy} className={primaryBtnCls}>
        {busy ? "등록 중…" : passkeys.length > 0 ? "🔐 이 폰도 등록하기" : "🔐 이 기기에 Face ID 등록"}
      </button>
      {passkeys.length > 0 && <p className="text-xs text-ink-faint">이미 등록한 폰이면 안 눌러도 돼요.</p>}

      {note && <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">{note}</p>}
      {problem && (
        <p className="whitespace-pre-line rounded-xl bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}
