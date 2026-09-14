export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

// font-size 16px 이상이어야 iOS Safari가 입력 시 자동 줌인하지 않는다.
export const inputCls =
  "w-full rounded-md border border-line bg-background px-2.5 py-2 text-[16px] sm:text-sm outline-none focus:border-honey";

export const primaryBtnCls =
  "w-full rounded-lg bg-honey px-4 py-3 text-base font-semibold text-white transition-opacity active:opacity-90 disabled:opacity-50";

export const secondaryBtnCls =
  "flex-1 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm font-medium transition-colors hover:border-honey disabled:opacity-50";
