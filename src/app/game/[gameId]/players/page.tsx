"use client";

import Link from "next/link";
import { OpinionMatrix } from "@/components/players/opinion-matrix";
import { SectionTitle } from "@/components/ui/feedback";
import {
  useEvents,
  useGame,
  useOpinions,
  usePlayers,
  useTimeline,
} from "@/lib/store/hooks";
import { getPlayerMissionParticipation } from "@/lib/selectors";
import { cn } from "@/lib/utils/cn";

export default function PlayersPage() {
  const game = useGame();
  const players = usePlayers();
  const opinions = useOpinions();
  const timeline = useTimeline();
  const events = useEvents();

  if (!game || !timeline || !opinions) return null;

  return (
    <main className="mx-auto max-w-md">
      <header className="pt-safe sticky top-0 z-30 border-b border-border bg-bg/95 px-4 pb-3 pt-3 backdrop-blur">
        <h1 className="text-lg font-semibold">玩家</h1>
        <p className="mt-0.5 text-[12px] text-fg-muted">
          点座位号看这个人的完整记录。
        </p>
      </header>

      <div className="px-4 pb-8 pt-4">
        <section className="mb-6">
          <SectionTitle>每个人</SectionTitle>
          <ul className="space-y-1.5">
            {players.map((player) => {
              const expressed = opinions.current.get(player.id)?.size ?? 0;
              const received = players.filter((other) =>
                opinions.current.get(other.id)?.has(player.id),
              ).length;
              const missions = getPlayerMissionParticipation(
                events,
                game,
                player.id,
              );
              const failed = missions.filter((m) => m.result === "fail").length;
              const isLeader = timeline.currentLeaderId === player.id;

              return (
                <li key={player.id}>
                  <Link
                    href={`/game/${game.id}/players/${player.id}`}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 active:bg-surface-2",
                      isLeader ? "border-accent" : "border-border",
                    )}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-[15px] font-semibold">
                      {player.seat}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[15px] font-medium">
                          {player.name ?? `${player.seat}号`}
                        </span>
                        {isLeader && (
                          <span className="shrink-0 rounded bg-accent-soft px-1.5 text-[11px] font-medium text-accent">
                            队长
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-fg-subtle">
                        表态 {expressed} · 被评 {received}
                        {missions.length > 0 &&
                          ` · 上过 ${missions.length} 轮车`}
                        {failed > 0 && ` · 其中 ${failed} 轮崩了`}
                      </p>
                    </div>
                    <span aria-hidden className="text-fg-subtle">
                      ›
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <SectionTitle>保踩总表</SectionTitle>
          <OpinionMatrix />
        </section>
      </div>
    </main>
  );
}
