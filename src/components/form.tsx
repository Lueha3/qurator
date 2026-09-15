export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

// 공통 클래스 — 같은 것은 같게 보이도록 한곳에서 정한다 (docs/08 §3.5.1).
// 모서리: 카드 16px(rounded-2xl) · 컨트롤 12px(rounded-lg) · 칩과 FAB은 원형.
// 테두리: 면을 나누는 선은 --line(옅게), **누를 수 있는 것**은 --line-strong(대비 3:1 이상).

/** 입력칸. font-size 16px 이상이어야 iOS Safari가 입력 시 자동 줌인하지 않는다. */
export const inputCls =
  "w-full rounded-lg border border-line-strong bg-panel px-3 py-2.5 text-[16px] outline-none transition-colors focus:border-honey sm:text-sm";

export const primaryBtnCls =
  "w-full rounded-lg bg-honey px-4 py-3 text-base font-semibold text-accent-ink transition-opacity active:opacity-90 disabled:opacity-50";

export const secondaryBtnCls =
  "flex-1 rounded-lg border border-line-strong bg-panel px-3 py-2.5 text-sm font-medium transition-colors hover:border-honey disabled:opacity-50";
