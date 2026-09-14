import Link from "next/link";

const NAV = [
  { href: "/", label: "딜" },
  { href: "/watch", label: "가격 추적" },
] as const;

export function AppHeader({ current }: { current: "/" | "/watch" }) {
  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <h1 className="text-base font-semibold">qurator</h1>
        <nav className="flex items-center gap-1 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-1.5 ${
                current === item.href ? "bg-honey-soft font-medium text-honey" : "text-muted hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          ))}
          {/* 링크허브는 공개 페이지라 프리페치로 열리지 않게 순수 <a>로 둔다 */}
          <a href="/hub" target="_blank" rel="noopener" className="rounded-md px-3 py-1.5 text-muted hover:text-foreground">
            링크허브 ↗
          </a>
        </nav>
      </div>
    </header>
  );
}
