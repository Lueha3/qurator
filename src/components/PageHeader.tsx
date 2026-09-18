// 상단은 읽기 전용이다 — 이동·동작은 전부 하단 탭과 FAB이 맡는다 (docs/08 §3.5-2).
// GrowthPilot과 같은 머리: 굵은 제목 한 줄 + 그 화면이 무엇을 하는지 한 문장.

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header
      className="sticky top-0 z-20 bg-paper/90 backdrop-blur-md"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="mx-auto max-w-3xl px-4 pb-3 pt-5">
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm leading-relaxed text-ink-soft">{subtitle}</p>}
      </div>
    </header>
  );
}
