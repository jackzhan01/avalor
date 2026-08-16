"use client";

import Link from "next/link";
import type { DerivedTimeline } from "@/lib/types/derived";
import type { GameRecord } from "@/lib/types/game";
import { seatLabel } from "@/lib/format/labels";
import { cn } from "@/lib/utils/cn";

/** ✓ / ✕ / — per mission, so the whole game state reads at a glance. */
function MissionStrip({ timeline }: { timeline: DerivedTimeline }) {
  return (
    <div className="flex items-center gap-1.5">
      {timeline.missions.map((mission) => {
        const done = mission.result !== null;
        const success = mission.result === "success";
        return (
          <div
            key={mission.missionNumber}
            title={`第 ${mission.missionNumber} 轮 · ${mission.expectedTeamSize} 人上车${mission.requiredFails === 2 ? " · 需要 2 张坏票" : ""}`}
            className={cn(
              "flex h-7 flex-1 items-center justify-center rounded-md border text-[13px] font-semibold",
              done
                ? success
                  ? "border-good bg-good text-white"
                  : "border-evil bg-evil text-white"
                : mission.status === "in_progress"
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface-2 text-fg-subtle",
            )}
          >
            {done ? (success ? "✓" : "✕") : mission.expectedTeamSize}
          </div>
        );
      })}
    </div>
  );
}

export function GameHeader({
  game,
  timeline,
}: {
  game: GameRecord;
  timeline: DerivedTimeline;
}) {
  const leader = timeline.currentLeaderId
    ? seatLabel(game, timeline.currentLeaderId)
    : "—";

  return (
    <header className="pt-safe sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto max-w-md px-4 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">
              第 {Math.min(timeline.missionNumber, 5)} 轮
            </span>
            <span className="text-sm text-fg-muted">
              第 {timeline.proposalNumber} 车
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-good">
              好 {timeline.successCount}
            </span>
            <span className="text-fg-subtle">—</span>
            <span className="font-medium text-evil">
              坏 {timeline.failCount}
            </span>
            <Link
              href={`/game/${game.id}/settings`}
              aria-label="对局设置"
              className="ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-fg-subtle active:bg-surface-2"
            >
              <span aria-hidden>⋯</span>
            </Link>
          </div>
        </div>

        <div className="mt-2.5">
          <MissionStrip timeline={timeline} />
        </div>

        <div className="mt-2 flex items-center gap-3 text-[12px] text-fg-muted">
          <span>
            队长 <span className="font-medium text-fg">{leader}</span>
          </span>
          {timeline.rejectionStreak > 0 && (
            <span className="text-warn">
              已连挂 {timeline.rejectionStreak} 次
            </span>
          )}
          {timeline.isComplete && (
            <span className="font-medium text-accent">对局已结束</span>
          )}
        </div>
      </div>
    </header>
  );
}
