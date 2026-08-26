"use client";

import { useState } from "react";

export function CopyButton({ text, cardId }: { text: string; cardId: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 클립보드 API가 막힌 환경(비-HTTPS 등) — 그래도 UX가 끊기지 않게 조용히 무시.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    // 발행 이력 기록은 사용자 체감 속도에 영향 없게 fire-and-forget.
    fetch(`/api/cards/${cardId}/copy`, { method: "POST" }).catch(() => {});
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        copied
          ? "bg-ok/15 text-ok"
          : "bg-honey text-white hover:opacity-90"
      }`}
    >
      {copied ? "복사됨" : "복사"}
    </button>
  );
}
