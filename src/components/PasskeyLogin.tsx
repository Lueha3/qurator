"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { primaryBtnCls } from "./form";

// Face ID 로그인 버튼 — docs/03 §7.1.
//
// 이 화면은 게이트 앞(공개)이라, 여기서 보이는 것은 버튼 하나뿐이어야 한다.
// 등록된 패스키가 있는지조차 눌러보기 전에는 말하지 않는다.

type State = "idle" | "working" | "unsupported" | "none" | "failed";

export function PasskeyLogin() {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  async function login() {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      return setState("unsupported");
    }
    setState("working");
    try {
      const res = await fetch("/api/auth/passkey/login");
      if (res.status === 404) return setState("none"); // 아직 등록된 패스키가 없다
      if (!res.ok) return setState("failed");

      const assertion = await startAuthentication({ optionsJSON: await res.json() });

      const verified = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assertion),
      });
      if (!verified.ok) return setState("failed");

      // 쿠키가 심어졌다. refresh를 함께 불러 로그인 전에 캐시된 화면이 남지 않게 한다.
      router.replace("/");
      router.refresh();
    } catch {
      // 사람이 Face ID를 취소한 경우도 여기로 온다 — 실패라고 겁주지 않는다.
      setState("idle");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={login} disabled={state === "working"} className={primaryBtnCls}>
        {state === "working" ? "확인 중…" : "🔓 Face ID로 열기"}
      </button>

      {state === "none" && (
        <p className="text-xs text-muted">
          이 앱에 등록된 패스키가 없습니다. <code className="font-mono">?k=</code> 주소로 한 번 들어간 뒤
          설정 탭에서 <b>Face ID 등록</b>을 먼저 해주세요.
        </p>
      )}
      {state === "unsupported" && (
        <p className="text-xs text-muted">이 브라우저는 패스키를 지원하지 않습니다.</p>
      )}
      {state === "failed" && (
        <p className="text-xs text-danger">
          로그인하지 못했습니다. 다시 시도하거나 <code className="font-mono">?k=</code> 주소로 열어주세요.
        </p>
      )}
    </div>
  );
}
