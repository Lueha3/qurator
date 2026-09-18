"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ACTOR_NAME_MAX } from "@/lib/session";
import { inputCls, primaryBtnCls } from "./form";
import { passkeyErrorMessage, rpIdMismatch } from "./passkey-error";

// 로그인 화면 — docs/03 §7.1·§7.2.
//
// 이 화면은 게이트 앞(공개)이라 보이는 것이 버튼 하나뿐이어야 한다. 등록된 패스키가 있는지조차
// 눌러보기 전에는 말하지 않고, 실패 이유도 뭉뚱그린다.
//
// `?invite=<코드>`가 붙어 있으면 **등록 화면**이 된다 — 실사용자(현표)가 마스터 토큰 없이
// 자기 폰을 등록하는 길이다.

type State = "idle" | "working" | "unsupported" | "none" | "failed" | "bad-invite";

export function PasskeyLogin({ invite }: { invite?: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function supported(): boolean {
    return typeof window !== "undefined" && !!window.PublicKeyCredential;
  }

  async function login() {
    if (!supported()) return setState("unsupported");
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
    router.replace("/");
    router.refresh();
  }

  if (invite) {
    return (
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">이 기기 이름 (기록에 남습니다)</span>
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
          {state === "working" ? "등록 중…" : "🔐 이 기기에 Face ID 등록"}
        </button>
        <Note state={state} invite />
        <Problem text={problem} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
    <p className="rounded-md bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger">{text}</p>
  );
}

function Note({ state, invite }: { state: State; invite?: boolean }) {
  if (state === "none")
    return (
      <p className="text-xs text-muted">
        이 앱에 등록된 패스키가 없습니다. 앱을 관리하는 분께 <b>등록 초대 링크</b>를 요청해주세요.
      </p>
    );
  if (state === "unsupported")
    return <p className="text-xs text-muted">이 브라우저는 패스키를 지원하지 않습니다.</p>;
  if (state === "bad-invite")
    return (
      <p className="text-xs text-danger">
        이 초대 링크는 만료되었거나 이미 사용되었습니다. 새 링크를 요청해주세요.
      </p>
    );
  if (state === "failed")
    return (
      <p className="text-xs text-danger">
        {invite ? "등록하지" : "로그인하지"} 못했습니다. 다시 시도해주세요.
      </p>
    );
  return null;
}
