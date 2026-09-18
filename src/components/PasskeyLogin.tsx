"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ACTOR_NAME_MAX } from "@/lib/session";
import { inputCls, primaryBtnCls } from "./form";
import { passkeyErrorMessage, rpIdMismatch } from "./passkey-error";
import { InAppBrowserNotice } from "./InAppBrowserNotice";

// 로그인 화면 — docs/03 §7.1·§7.2.
//
// 이 화면은 게이트 앞(공개)이라 보이는 것이 버튼 하나뿐이어야 한다. 등록된 패스키가 있는지조차
// 눌러보기 전에는 말하지 않고, 실패 이유도 뭉뚱그린다.
//
// `?invite=<코드>`가 붙어 있으면 **등록 화면**이 된다 — 실사용자(현표)가 마스터 토큰 없이
// 자기 폰을 등록하는 길이다.

type State = "idle" | "working" | "unsupported" | "no-authenticator" | "none" | "failed" | "bad-invite";

/** 로그인 뒤 돌아갈 곳. 같은 출처의 경로만 — 외부 주소·프로토콜 상대 주소는 홈으로 */
function safeNext(next?: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/";
  return next;
}

export function PasskeyLogin({ invite, next }: { invite?: string; next?: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function supported(): boolean {
    return typeof window !== "undefined" && !!window.PublicKeyCredential;
  }

  /**
   * Face ID/Touch ID 같은 "이 기기 안" 인증 수단이 실제로 있는가. 이걸 건너뛰고 바로
   * 시도하면, 없는 기기에서는 브라우저가 응답 없이 매달려 "확인 중…" 버튼이 영원히
   * 굳어버린다(2026-09-18, 테스트 중 재현 — 실기기 Face ID는 반드시 승인·취소로 끝나지만,
   * 인증기 자체가 없으면 그 결론이 오지 않는다). 이 API가 없는 구형 브라우저는 과잉 차단하지
   * 않고 그냥 시도한다.
   */
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

  async function login() {
    if (!supported()) return setState("unsupported");
    if (!(await hasAuthenticator())) return setState("no-authenticator");
    setState("working");
    setProblem(null);
    try {
      const res = await fetch("/api/auth/passkey/login");
      if (res.status === 404) return setState("none");
      if (!res.ok) return setState("failed");

      const options = await res.json();
      const mismatch = rpIdMismatch(options);
      if (mismatch) {
        setProblem(mismatch);
        return setState("idle");
      }

      const assertion = await startAuthentication({ optionsJSON: options });
      const verified = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assertion),
      });
      if (!verified.ok) return setState("failed");

      enter();
    } catch (error) {
      // 실패를 삼키지 않는다 — 아무 일도 안 일어나는 화면이 가장 나쁘다.
      setProblem(passkeyErrorMessage(error, "로그인"));
      setState("idle");
    }
  }

  async function registerWithInvite() {
    if (!invite) return;
    if (!supported()) return setState("unsupported");
    if (!(await hasAuthenticator())) return setState("no-authenticator");
    setState("working");
    setProblem(null);
    try {
      const res = await fetch(`/api/auth/passkey/invite?code=${encodeURIComponent(invite)}`);
      if (res.status === 403) return setState("bad-invite");
      if (!res.ok) return setState("failed");

      const options = await res.json();
      const mismatch = rpIdMismatch(options);
      if (mismatch) {
        setProblem(mismatch);
        return setState("idle");
      }

      const credential = await startRegistration({ optionsJSON: options });
      const verified = await fetch("/api/auth/passkey/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: invite, credential, label: name }),
      });
      if (verified.status === 403) return setState("bad-invite");
      if (!verified.ok) return setState("failed");

      enter();
    } catch (error) {
      setProblem(passkeyErrorMessage(error, "등록"));
      setState("idle");
    }
  }

  function enter() {
    router.replace(safeNext(next));
    router.refresh();
  }

  if (invite) {
    return (
      <div className="flex flex-col gap-3">
        <InAppBrowserNotice />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-soft">이 폰 이름 (비워도 돼요)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={ACTOR_NAME_MAX}
            placeholder="예: 현표 아이폰"
            className={inputCls}
          />
        </label>
        <button
          type="button"
          onClick={registerWithInvite}
          disabled={state === "working"}
          className={primaryBtnCls}
        >
          {state === "working" ? "등록 중…" : "🔐 Face ID로 등록하기"}
        </button>
        <Note state={state} invite />
        <Problem text={problem} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <InAppBrowserNotice />
      <button type="button" onClick={login} disabled={state === "working"} className={primaryBtnCls}>
        {state === "working" ? "확인 중…" : "🔓 Face ID로 열기"}
      </button>
      <Note state={state} />
      <Problem text={problem} />
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="whitespace-pre-line rounded-xl bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger">{text}</p>
  );
}

function Note({ state, invite }: { state: State; invite?: boolean }) {
  if (state === "none")
    return (
      <p className="text-xs text-ink-soft">
        아직 등록된 폰이 없어요. 관리자에게 <b>등록 링크</b>를 받아 그 링크로 열어주세요.
      </p>
    );
  if (state === "unsupported")
    return <p className="text-xs text-ink-soft">이 브라우저에서는 Face ID를 쓸 수 없어요. Safari로 열어주세요.</p>;
  if (state === "no-authenticator")
    return (
      <p className="text-xs text-ink-soft">
        이 기기에는 Face ID가 없어서 쓸 수 없어요. 아이폰에서 열어주세요.
      </p>
    );
  if (state === "bad-invite")
    return (
      <p className="text-xs text-danger">
        이 등록 링크는 만료되었거나 이미 사용됐어요. 관리자에게 새 링크를 받아주세요.
      </p>
    );
  if (state === "failed")
    return (
      <p className="text-xs text-danger">
        {invite ? "등록이 안 됐어요." : "열리지 않았어요."} 다시 눌러주세요.
      </p>
    );
  return null;
}
