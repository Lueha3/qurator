export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      {hint && <span className="-mt-1 text-xs text-ink-soft">{hint}</span>}
      {children}
    </label>
  );
}

// 공통 클래스 — 같은 것은 같게 보이도록 한곳에서 정한다 (docs/08 §3.5.1 → §4.0.7 GrowthPilot 규격).
// 모서리: 카드 16px(rounded-2xl) · 컨트롤 12px(rounded-xl) · 칩은 원형.
// 테두리: 면·입력칸 모두 --line 한 가지. 누르면 --accent로 바뀐다(포커스·호버).

/** 입력칸. font-size 16px 이상이어야 iOS Safari가 입력 시 자동 줌인하지 않는다. */
export const inputCls =
  "w-full rounded-xl border border-line bg-paper px-4 py-3 text-[16px] outline-none transition-colors placeholder:text-ink-faint focus:border-accent sm:text-sm";

/** 주 버튼 — 짙은 초록 바탕. 한 화면에 하나만 */
export const primaryBtnCls =
  "w-full rounded-xl bg-accent px-4 py-3 text-base font-semibold text-accent-ink transition-opacity active:opacity-90 disabled:opacity-40";

/** 보조 버튼 — 선만 있는 흰 버튼 */
export const secondaryBtnCls =
  "flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-40";

/** 위험 버튼 — 지우기·빼기 */
export const dangerBtnCls =
  "rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-semibold text-danger transition-colors hover:border-danger disabled:opacity-40";

/** 세그먼트(칩 줄) 바깥 상자와 안쪽 칩 — GrowthPilot의 쇼츠/롱폼 스위치와 같은 모양 */
export const segmentCls = "flex gap-1 rounded-xl border border-line bg-surface p-1 text-sm font-semibold";
export const segmentItemCls = (active: boolean) =>
  `shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 transition-colors ${active ? "bg-accent-soft text-accent" : "text-ink-faint hover:text-ink"}`;

/** 빈 상태 — 점선 상자 */
export const emptyCls = "rounded-2xl border-2 border-dashed border-line px-6 py-10 text-center text-sm leading-relaxed text-ink-faint";

/** 주의 카드 — 앰버. "지금 알아야 할 것"에만 쓴다 */
export const noticeCls = "rounded-xl border border-amber bg-amber-soft px-4 py-3 text-sm leading-relaxed text-amber-ink";
