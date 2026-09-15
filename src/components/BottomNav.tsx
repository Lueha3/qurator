"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 하단 탭 — docs/08 §3.2. 주 동작은 전부 엄지 영역에 둔다.
// 성과 탭은 V2-B에서 추가된다(빈 탭을 미리 만들지 않는다 — "없는 것을 그리지 않는다").

const TABS = [
  { href: "/", label: "홈", icon: "◎" },
  { href: "/deals", label: "딜", icon: "▤" },
  { href: "/settings", label: "설정", icon: "⚙" },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 backdrop-blur"
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
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors ${
                  active ? "text-honey" : "text-muted"
                }`}
              >
                <span aria-hidden className="text-base leading-none">
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
