import { CopyButton } from "./CopyButton";
import type { CardDTO } from "@/lib/api-types";

const CHANNEL_LABEL: Record<CardDTO["channel"], string> = {
  KAKAO_OPEN: "카톡 오픈채팅",
  THREADS: "스레드",
  INSTAGRAM_COMMENT: "인스타 고정댓글",
  NOTION: "노션",
};

const CHANNEL_LIMIT: Partial<Record<CardDTO["channel"], number>> = {
  THREADS: 480,
  INSTAGRAM_COMMENT: 2200,
};

export function DealCard({ card }: { card: CardDTO }) {
  const limit = CHANNEL_LIMIT[card.channel];

  return (
    <div className="flex flex-col rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-sm font-medium">{CHANNEL_LABEL[card.channel]}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">
            {card.charCount}
            {limit ? `/${limit}` : ""}자
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
              card.disclosureOk ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"
            }`}
          >
            {card.disclosureOk ? "고지 OK" : "고지 실패"}
          </span>
        </div>
      </div>
      <pre className="max-h-64 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-sans text-[13px] leading-relaxed">
        {card.bodyText}
      </pre>
      {(card.truncated || card.warnings.length > 0) && (
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-danger">
          {card.truncated && <div>글자수 초과로 자동 축약됨</div>}
          {card.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-line px-3 py-2">
        {card.aiGeneratedFields.includes("hookLine") ? (
          <span className="text-[11px] text-muted">AI 훅 초안</span>
        ) : (
          <span className="text-[11px] text-muted">&nbsp;</span>
        )}
        <CopyButton text={card.bodyText} cardId={card.id} />
      </div>
    </div>
  );
}
