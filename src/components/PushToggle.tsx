"use client";

import { useEffect, useState } from "react";
import { pushSubscribeAction, pushTestAction, pushUnsubscribeAction } from "@/app/actions";
import { primaryBtnCls, secondaryBtnCls } from "./form";

// 아침 알림 스위치 — docs/08 §4.0.5 (V2-G).
//
// "켜져 있는가"의 진짜 답은 서버가 아니라 **이 기기의 브라우저**가 갖고 있다. 폰에서 알림을
// 끄거나 홈 화면 아이콘을 지우면 서버의 구독 행은 그대로 남아 있어도 알림은 오지 않는다.
// 그래서 상태는 항상 navigator에서 다시 읽는다.
//
// 아이폰은 **홈 화면에 추가한 뒤에만** 웹 푸시가 동작한다(Safari 탭에서는 API 자체가 없다).
// 그 경우 "지원 안 함"이라고만 하면 사람은 고칠 방법을 모른다 — 무엇을 해야 하는지 적는다.

type State =
  | "loading"
  | "unsupported" // 브라우저가 웹 푸시를 아예 모른다
  | "needs-install" // 아이폰 Safari 탭 — 홈 화면에 추가하면 된다
  | "no-keys" // 서버에 VAPID 키가 없다
  | "denied" // 사람이 알림을 거부해 둔 상태 — 브라우저 설정에서만 되돌린다
  | "off"
  | "on";

export function PushToggle({ publicKey }: { publicKey: string | null }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    detect(publicKey).then(
      (next) => alive && setState(next),
      () => alive && setState("unsupported")
    );
    return () => {
      alive = false;
    };
  }, [publicKey]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    setNote(null);
    try {
      // 권한 요청은 반드시 사람이 버튼을 누른 흐름 안에서 — 그렇지 않으면 브라우저가 무시한다.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }

      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // 조용한 푸시는 쓰지 않는다. 브라우저도 이것만 허용한다
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const ok = await pushSubscribeAction(sub.toJSON());
      if (!ok) {
        await sub.unsubscribe();
        setNote("저장하지 못했어요. 다시 눌러주세요.");
        setState("off");
        return;
      }
      setState("on");
      setNote("켰어요! 할 일 있는 날 아침 8시에 와요.");
    } catch {
      setNote("켜지 못했어요. 다시 눌러주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await pushUnsubscribeAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("off");
      setNote("껐어요.");
    } catch {
      setNote("끄지 못했어요. 다시 눌러주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    try {
      const run = await pushTestAction();
      setNote(
        run.status === "sent"
          ? "보냈어요! 폰 알림을 확인해주세요."
          : run.status === "no-subscription"
            ? "켜진 기기가 없어요. 먼저 켜주세요."
            : "서버 설정이 없어요. 관리자에게 알려주세요."
      );
    } catch {
      setNote("보내지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <p className="text-xs text-ink-soft">확인 중…</p>;

  if (state === "no-keys")
    return (
      <p className="text-xs text-ink-soft">
        서버에 알림 설정이 없어요. 관리자에게 알려주세요.
      </p>
    );

  if (state === "needs-install")
    return (
      <p className="text-xs text-ink-soft">
        아이폰은 홈 화면에 추가해야 알림을 켤 수 있어요. 홈 화면 아이콘으로 열어주세요.
      </p>
    );

  if (state === "unsupported")
    return <p className="text-xs text-ink-soft">이 브라우저에서는 알림을 켤 수 없어요.</p>;

  if (state === "denied")
    return (
      <p className="text-xs text-danger">
        알림이 꺼져 있어요. 아이폰 설정에서 허용해주세요.
      </p>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {state === "on" ? (
          <>
            <button type="button" disabled={busy} onClick={disable} className={secondaryBtnCls}>
              끄기
            </button>
            <button type="button" disabled={busy} onClick={test} className={`${primaryBtnCls} flex-1`}>
              {busy ? "보내는 중…" : "지금 보내보기"}
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={enable} className={`${primaryBtnCls} flex-1`}>
            {busy ? "켜는 중…" : "🔔 아침 알림 켜기"}
          </button>
        )}
      </div>
      {note && <p className="text-xs text-ink-soft">{note}</p>}
    </div>
  );
}

/**
 * 이 기기에서 지금 알림이 어떤 상태인지. 서버가 아니라 **브라우저에게 묻는다** —
 * 폰에서 알림을 껐거나 홈 화면 아이콘을 지우면 서버의 구독 행은 남아도 알림은 오지 않는다.
 */
async function detect(publicKey: string | null): Promise<State> {
  if (!publicKey) return "no-keys";

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  if (!supported) {
    // 아이폰에서 홈 화면 앱이 아니면 PushManager가 없다 — 지원 불가가 아니라 설치 전이다.
    const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    return iOS && !standalone ? "needs-install" : "unsupported";
  }

  if (Notification.permission === "denied") return "denied";

  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? "on" : "off";
}

/** VAPID 공개키는 base64url 문자열로 오고, 브라우저는 바이트 배열을 요구한다. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
