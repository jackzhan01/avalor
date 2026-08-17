"use client";

import { TimelineView } from "@/components/timeline/timeline-view";
import { useGame } from "@/lib/store/hooks";

export default function TimelinePage() {
  const game = useGame();
  if (!game) return null;

  return (
    <main className="mx-auto max-w-md px-4 pb-6">
      <header className="pt-safe pb-4 pt-3">
        <h1 className="t-large-title">时间线</h1>
        <p className="t-footnote mt-1 text-[color:var(--label-secondary)]">
          点任意一条都能改或删。
        </p>
      </header>
      <TimelineView />
    </main>
  );
}
