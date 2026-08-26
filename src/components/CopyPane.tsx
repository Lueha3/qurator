"use client";

import { useRef, useState } from "react";
import { recordCopy } from "@/app/copy/[cardId]/actions";

type CopyState = "idle" | "copied" | "manual";

/**
 * textarea 높이 추정. 단순히 \n 개수만 세면 좁은 폰 화면에서 줄바꿈된 만큼 잘려서,
 * 자동 복사가 실패했을 때의 폴백("길게 눌러 직접 복사")이 반쪽이 된다.
 * 한 줄이 화면 폭에서 대략 몇 글자인지를 반영해 넉넉히 잡는다.
 */
function estimateRows(text: string): number {
  const CHARS_PER_VISUAL_LINE = 18; // 390px 폭 · 16px 한글 기준 보수적 추정
  const visualLines = text
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_VISUAL_LINE)), 0);
  return Math.min(40, visualLines + 1);
}

/**
 * 복사 웹뷰의 클라이언트 부분.
 *
 * iOS Safari 함정: 클릭 핸들러 안에서 await를 한 번이라도 거치면 user activation이 소실되어
 * writeText()가 NotAllowedError로 거부된다. 그래서 **텍스트는 서버에서 이미 렌더되어 props로
 * 들어와 있고, 핸들러는 완전히 동기적으로 시작한다** (fetch-on-click을 하지 않으면 이 문제 자체가 없다).
 *
 * 폴백 3단:
 *   ① navigator.clipboard.writeText — HTTPS/localhost + 제스처 필요
 *   ② textarea + execCommand('copy') — Secure Context 불필요, 인앱 WebView에서 유일하게 되는 경우가 많다
 *   ③ 전문을 선택된 상태로 노출 + "길게 눌러 복사" 안내 — 100% 탈출 경로
 * 실패를 조용히 삼키지 않는 것이 핵심이다.
 */
export function CopyPane({ text, token }: { text: string; token: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  function markCopied() {
    setState("copied");
    // 발행 이력 기록은 체감 속도에 영향 없게 fire-and-forget.
    void recordCopy(token).catch(() => {});
  }

  function legacyCopy(): boolean {
    const area = areaRef.current;
    if (!area) return false;
    try {
      area.focus();
      area.setSelectionRange(0, 999999); // iOS는 select()만으로는 선택이 안 잡히는 경우가 있다
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }

  function handleCopy() {
    // 인앱 브라우저(카카오톡/인스타 등)는 clipboard API가 막힌 경우가 많아 폴백을 먼저 시도한다.
    const ua = navigator.userAgent;
    const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|Line\//i.test(ua);

    if (inApp && legacyCopy()) {
      markCopied();
      return;
    }

    // await를 쓰지 않는다 — 동기 호출로 시작해야 iOS에서 user activation이 유지된다.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => markCopied(),
        () => (legacyCopy() ? markCopied() : setState("manual"))
      );
      return;
    }
    if (legacyCopy()) markCopied();
    else setState("manual");
  }

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={handleCopy}
        className={`w-full rounded-lg px-4 py-3.5 text-base font-semibold transition-colors ${
          state === "copied" ? "bg-ok text-white" : "bg-honey text-white active:opacity-90"
        }`}
      >
        {state === "copied" ? "✓ 복사됨 — 카톡에 붙여넣으세요" : "📋 카톡용 문구 복사"}
      </button>

      {state === "manual" && (
        <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          자동 복사가 막혀 있습니다. 아래 글을 길게 눌러 전체 선택 후 복사해 주세요.
        </p>
      )}

      {/* 폴백용 textarea. 화면 밖으로 숨기지 않고 실제 내용으로 쓴다 —
          복사가 실패해도 사용자가 여기서 직접 선택해 복사할 수 있어야 하기 때문.
          font-size는 16px 이상이어야 iOS가 자동 줌인하지 않는다. */}
      <textarea
        ref={areaRef}
        readOnly
        value={text}
        rows={estimateRows(text)}
        className="w-full resize-none rounded-lg border border-line bg-panel p-3 text-[16px] leading-relaxed"
      />
    </div>
  );
}
