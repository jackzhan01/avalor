"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

/**
 * The three tabs are sibling routes under game/[gameId]/layout.tsx, so
 * switching between them does NOT re-read IndexedDB — the layout, and with it
 * the loaded event log, survives the client-side navigation.
 */
export function BottomNav({ gameId }: { gameId: string }) {
  const pathname = usePathname();
  const base = `/game/${gameId}`;

  const tabs = [
    { href: base, label: "牌桌", icon: "◉" },
    { href: `${base}/players`, label: "玩家", icon: "☰" },
    { href: `${base}/timeline`, label: "时间线", icon: "≡" },
  ];

  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-[color:var(--separator)] bg-[color:var(--bg-elevated)]/92 backdrop-blur-xl">
      <div className="mx-auto flex max-w-md">
        {tabs.map((tab) => {
          const active =
            tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-[49px] flex-1 flex-col items-center justify-center gap-0.5",
                active
                  ? "text-[color:var(--blue)]"
                  : "text-[color:var(--label-tertiary)]",
              )}
            >
              <span aria-hidden className="text-[15px] leading-none">
                {tab.icon}
              </span>
              <span className="text-[10px] font-medium leading-none">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
