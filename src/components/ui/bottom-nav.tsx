"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

/**
 * The three tabs are sibling routes under game/[gameId]/layout.tsx, so
 * switching between them does NOT re-read IndexedDB — the layout, and with it
 * the loaded event log, persists across the client-side navigation.
 */
export function BottomNav({ gameId }: { gameId: string }) {
  const pathname = usePathname();
  const base = `/game/${gameId}`;

  const tabs = [
    { href: base, label: "对局", icon: "◎" },
    { href: `${base}/players`, label: "玩家", icon: "☷" },
    { href: `${base}/timeline`, label: "时间线", icon: "≡" },
  ];

  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-md">
        {tabs.map((tab) => {
          const active =
            tab.href === base
              ? pathname === base
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5",
                active ? "text-accent" : "text-fg-subtle",
              )}
            >
              <span aria-hidden className="text-base leading-none">
                {tab.icon}
              </span>
              <span className="text-[11px] font-medium leading-none">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
