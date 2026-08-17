"use client";

import { TimelineView } from "@/components/timeline/timeline-view";
import { PageHeader } from "@/components/ui/page-header";
import { useGame } from "@/lib/store/hooks";

export default function TimelinePage() {
  const game = useGame();
  if (!game) return null;

  return (
    <main className="mx-auto max-w-md px-4 pb-6">
      <PageHeader title="时间线" subtitle="点任意一条都能改或删。" />
      <TimelineView />
    </main>
  );
}
