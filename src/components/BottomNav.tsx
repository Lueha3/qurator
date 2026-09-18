"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartIcon, SlidersIcon, HomeIcon, ListIcon } from "./icons";

// 하단 탭 — docs/08 §3.2. 주 동작은 전부 엄지 영역에 둔다.

const TABS = [
  { href: "/", label: "홈", Icon: HomeIcon },
  { href: "/deals", label: "딜", Icon: ListIcon },
  { href: "/stats", label: "성과", Icon: ChartIcon },
  { href: "/settings", label: "설정", Icon: SlidersIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line/60 bg-panel/95 shadow-[0_-4px_16px_rgb(26_23_20/0.06)] backdrop-blur-md"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="mx-auto flex max-w-3xl">
        {TABS.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 py-2 text-[11px] transition-colors ${
                  active ? "font-semibold text-honey" : "text-muted"
                }`}
              >
                <tab.Icon className="h-[22px] w-[22px]" />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
