"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 하단 탭 — docs/08 §3.2. 주 동작은 전부 엄지 영역에 둔다.
// 아이콘은 GrowthPilot과 같이 이모지다(§4.0.7). 활성 탭은 연한 초록 알약.

const TABS = [
  { href: "/", label: "홈", icon: "🏠" },
  { href: "/deals", label: "딜", icon: "🏷️" },
  { href: "/stats", label: "성과", icon: "📈" },
  { href: "/settings", label: "설정", icon: "⚙️" },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-md"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="mx-auto flex max-w-3xl px-2">
        {TABS.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] font-semibold transition-colors ${
                  active ? "text-accent" : "text-ink-faint"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-8 w-14 items-center justify-center rounded-xl text-[19px] leading-none transition-colors ${
                    active ? "bg-accent-soft" : ""
                  }`}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
