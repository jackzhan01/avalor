"use client";

import { ListGroup, ListRow } from "@/components/ui/list";
import { OpinionMatrix } from "@/components/players/opinion-matrix";
import {
  useEvents,
  useGame,
  useOpinions,
  usePlayers,
  useTimeline,
} from "@/lib/store/hooks";
import {
  getClaimants,
  getIntendedTeam,
  getPlayerMissionParticipation,
} from "@/lib/selectors";
import { playerLabel } from "@/lib/format/labels";

export default function PlayersPage() {
  const game = useGame();
  const players = usePlayers();
  const opinions = useOpinions();
  const timeline = useTimeline();
  const events = useEvents();

  if (!game || !timeline || !opinions) return null;
  const claimants = new Set(getClaimants(events));

  return (
    <main className="mx-auto max-w-md px-4 pb-6">
      <header className="pt-safe pb-4 pt-3">
        <h1 className="t-large-title">玩家</h1>
      </header>

      <div className="flex flex-col gap-7">
        <ListGroup>
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
            const intended = getIntendedTeam(events, player.id);

            const bits = [`表态 ${expressed}`, `被评 ${received}`];
            if (intended) bits.push("有意向车");
            if (missions.length > 0) {
              bits.push(
                failed > 0
                  ? `上过 ${missions.length} 轮车（${failed} 轮崩）`
                  : `上过 ${missions.length} 轮车`,
              );
            }

            return (
              <ListRow
                key={player.id}
                href={`/game/${game.id}/players/${player.id}`}
                leading={
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--fill)] text-[15px] font-semibold">
                    {player.seat}
                  </span>
                }
                label={
                  <span className="flex items-center gap-1.5">
                    {player.name ?? playerLabel(game, player.id)}
                    {timeline.currentLeaderId === player.id && (
                      <span className="t-caption rounded-[5px] bg-[color:var(--fill)] px-1.5 font-medium text-[color:var(--blue)]">
                        队长
                      </span>
                    )}
                    {claimants.has(player.id) && (
                      <span className="t-caption rounded-[5px] bg-[color:var(--blue)] px-1.5 font-medium text-white">
                        跳派
                      </span>
                    )}
                  </span>
                }
                detail={bits.join(" · ")}
                accessory="chevron"
                inset={60}
              />
            );
          })}
        </ListGroup>

        <section>
          <h2 className="t-footnote mb-2 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
            保踩总表
          </h2>
          <OpinionMatrix />
        </section>
      </div>
    </main>
  );
}
