// 상단은 읽기 전용이다 — 이동·동작은 전부 하단 탭과 FAB이 맡는다 (docs/08 §3.5-2).
// V3: 선을 없앴다. 배경이 카드보다 어두워져 헤더가 따로 경계를 그을 필요가 없다.

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header
      className="sticky top-0 z-20 bg-background/85 backdrop-blur-md"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="mx-auto max-w-3xl px-4 pb-2 pt-4">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
    </header>
  );
}
