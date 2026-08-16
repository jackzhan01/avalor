"use client";

import { TimelineView } from "@/components/timeline/timeline-view";
import { useGame, useTimeline } from "@/lib/store/hooks";

export default function TimelinePage() {
  const game = useGame();
  const timeline = useTimeline();
  if (!game || !timeline) return null;

  return (
    <main className="mx-auto max-w-md">
      <header className="pt-safe sticky top-0 z-30 border-b border-border bg-bg/95 px-4 pb-3 pt-3 backdrop-blur">
        <h1 className="text-lg font-semibold">时间线</h1>
        <p className="mt-0.5 text-[12px] text-fg-muted">
          按轮次分组，点任意一条可以改或删。
        </p>
      </header>
      <TimelineView />
    </main>
  );
}
