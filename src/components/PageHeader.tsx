// 상단은 읽기 전용이다 — 이동·동작은 전부 하단 탭과 FAB이 맡는다 (docs/08 §3.5-2).

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header
      className="sticky top-0 z-20 border-b border-line bg-background/90 backdrop-blur"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="mx-auto max-w-3xl px-4 py-3">
        <h1 className="text-base font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
    </header>
  );
}
