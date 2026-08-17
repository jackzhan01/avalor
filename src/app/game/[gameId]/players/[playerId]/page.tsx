"use client";

import { use } from "react";
import Link from "next/link";
import { RatingBadge } from "@/components/ui/rating-chips";
import { ListGroup, ListRow } from "@/components/ui/list";
import { EmptyState } from "@/components/ui/feedback";
import { useEvents, useGame, usePlayers } from "@/lib/store/hooks";
import {
  getIntendedTeamHistory,
  getOpinionHistory,
  getPlayerMissionParticipation,
  getPlayerNotes,
  getPlayerOpinions,
  getPlayerProposalHistory,
  getPlayerVoteHistory,
  getRoleClaim,
  getRoleClaimHistory,
} from "@/lib/selectors";
import { playerLabel, seatLabel, seatList } from "@/lib/format/labels";
import { cn } from "@/lib/utils/cn";

export default function PlayerDetailPage({
  params,
}: {
  params: Promise<{ gameId: string; playerId: string }>;
}) {
  const { gameId, playerId } = use(params);
  const game = useGame();
  const events = useEvents();
  const players = usePlayers();

  if (!game) return null;
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return <EmptyState title="找不到这个玩家" />;

  const { expressed, received } = getPlayerOpinions(events, playerId);
  const intended = getIntendedTeamHistory(events, playerId);
  const claim = getRoleClaim(events, playerId);
  const claimHistory = getRoleClaimHistory(events, playerId);
  const proposals = getPlayerProposalHistory(events, game, playerId);
  const votes = getPlayerVoteHistory(events, game, playerId);
  const missions = getPlayerMissionParticipation(events, game, playerId);
  const notes = getPlayerNotes(events, playerId);
  const changed = expressed.filter((e) => e.cell.revisionCount > 1);

  return (
    <main className="mx-auto max-w-md px-4 pb-6">
      <header className="pt-safe pb-4 pt-3">
        <Link
          href={`/game/${gameId}/players`}
          className="t-body -ml-2 mb-1 inline-flex min-h-[36px] items-center px-2 text-[color:var(--blue)]"
        >
          <span aria-hidden className="mr-0.5 text-[20px] leading-none">‹</span>
          玩家
        </Link>
        <h1 className="t-large-title">{playerLabel(game, playerId)}</h1>
      </header>

      <div className="flex flex-col gap-7">
        {/* 跳派 first: it is a single binary fact and the most compressed
            signal on the page. */}
        <ListGroup header="跳派">
          <ListRow
            label={
              claim === null
                ? "没说过"
                : claim.claimed
                  ? "跳了派"
                  : "跳过又收回了"
            }
            detail={
              claim && claim.revisionCount > 1
                ? `第 ${claimHistory.map((c) => c.missionNumber).join("、")} 轮各变过一次`
                : claim
                  ? `第 ${claim.missionNumber} 轮`
                  : undefined
            }
            value={
              claim?.claimed ? (
                <span className="t-caption rounded-[5px] bg-[color:var(--blue)] px-1.5 font-semibold text-white">
                  派
                </span>
              ) : undefined
            }
          />
        </ListGroup>

        <ListGroup
          header="他想带谁上车"
          footer="这是他嘴上说的，跟他真点的车分开记。"
        >
          {intended.length === 0 ? (
            <ListRow label="还没说过" />
          ) : (
            intended.map((event) => (
              <ListRow
                key={event.id}
                label={
                  <span className="tabular-nums">
                    {seatList(game, event.teamPlayerIds)}
                  </span>
                }
                detail={`第 ${event.missionNumber} 轮`}
                value={
                  event.id === intended[intended.length - 1].id ? "最新" : undefined
                }
              />
            ))
          )}
        </ListGroup>

        <ListGroup header="他真点的车">
          {proposals.asLeader.length === 0 ? (
            <ListRow label="还没当过队长" />
          ) : (
            <>
              {proposals.asLeader.map((record) => (
                <ListRow
                  key={record.proposalEventId}
                  label={
                    <span className="tabular-nums">
                      {seatList(game, record.teamPlayerIds)}
                    </span>
                  }
                  detail={`第 ${record.missionNumber} 轮 · 第 ${record.proposalNumber} 车`}
                  value={
                    <span
                      className={
                        record.status === "rejected"
                          ? "text-[color:var(--red)]"
                          : "text-[color:var(--green)]"
                      }
                    >
                      {record.status === "rejected"
                        ? "否"
                        : record.status === "voting"
                          ? "等票"
                          : record.status === "draft"
                            ? "改过"
                            : "过"}
                    </span>
                  }
                />
              ))}
              <ListRow
                label={`当队长 ${proposals.timesLed} 次`}
                value={`过 ${proposals.asLeaderOutcome.passed} · 否 ${proposals.asLeaderOutcome.rejected}`}
              />
            </>
          )}
        </ListGroup>

        <ListGroup header="他怎么看别人">
          {players
            .filter((p) => p.id !== playerId)
            .map((target) => {
              const edge = expressed.find((e) => e.targetId === target.id);
              return (
                <ListRow
                  key={target.id}
                  label={seatLabel(game, target.id)}
                  detail={
                    edge && edge.cell.revisionCount > 1
                      ? `改过 ${edge.cell.revisionCount - 1} 次`
                      : undefined
                  }
                  value={<RatingBadge rating={edge?.cell.rating ?? null} />}
                />
              );
            })}
        </ListGroup>

        {changed.length > 0 && (
          <ListGroup header="他改过口的">
            {changed.map((edge) => {
              const chain = getOpinionHistory(events, playerId, edge.targetId);
              return (
                <ListRow
                  key={edge.targetId}
                  label={`对 ${seatLabel(game, edge.targetId)}`}
                  value={
                    <span className="flex items-center gap-1">
                      {chain.map((event, i) => (
                        <span key={event.id} className="flex items-center gap-1">
                          {i > 0 && (
                            <span
                              aria-hidden
                              className="text-[color:var(--label-tertiary)]"
                            >
                              →
                            </span>
                          )}
                          <RatingBadge rating={event.rating} muted={i < chain.length - 1} />
                        </span>
                      ))}
                    </span>
                  }
                />
              );
            })}
          </ListGroup>
        )}

        <ListGroup header="别人怎么看他">
          {received.length === 0 ? (
            <ListRow label="还没人评过他" />
          ) : (
            received.map((edge) => {
              const back = expressed.find((e) => e.targetId === edge.speakerId);
              return (
                <ListRow
                  key={edge.speakerId}
                  label={seatLabel(game, edge.speakerId)}
                  value={
                    <span className="flex items-center gap-1.5">
                      <RatingBadge rating={edge.cell.rating} />
                      {back && (
                        <>
                          <span
                            aria-hidden
                            className="text-[11px] text-[color:var(--label-tertiary)]"
                          >
                            ↔
                          </span>
                          <RatingBadge rating={back.cell.rating} />
                        </>
                      )}
                    </span>
                  }
                />
              );
            })
          )}
        </ListGroup>

        <ListGroup
          header="他的票"
          footer={
            votes.records.length > 0
              ? `上票 ${votes.tally.approve} · 下票 ${votes.tally.reject}${votes.tally.unknown > 0 ? ` · 不清楚 ${votes.tally.unknown}` : ""}${votes.tally.unrecorded > 0 ? ` · 没记 ${votes.tally.unrecorded}` : ""}`
              : undefined
          }
        >
          {votes.records.length === 0 ? (
            <ListRow label="还没有投票记录" />
          ) : (
            votes.records.map((record) => (
              <ListRow
                key={record.voteEventId}
                label={`第 ${record.missionNumber} 轮 · 第 ${record.proposalNumber} 车`}
                detail={record.wasOnTeam ? "他在车上" : undefined}
                value={
                  <span
                    className={cn(
                      "font-medium",
                      record.vote === "approve" && "text-[color:var(--green)]",
                      record.vote === "reject" && "text-[color:var(--red)]",
                      (record.vote === "unknown" || record.vote === null) &&
                        "text-[color:var(--label-tertiary)]",
                    )}
                  >
                    {record.vote === "approve"
                      ? "✓ 上票"
                      : record.vote === "reject"
                        ? "✕ 下票"
                        : record.vote === "unknown"
                          ? "? 不清楚"
                          : "— 没记"}
                  </span>
                }
              />
            ))
          )}
        </ListGroup>

        <ListGroup header="他上过的车">
          {missions.length === 0 ? (
            <ListRow label="还没上过车" />
          ) : (
            missions.map((mission) => (
              <ListRow
                key={mission.missionNumber}
                label={`第 ${mission.missionNumber} 轮`}
                detail={
                  mission.failCount != null
                    ? `${mission.failCount} 张坏票`
                    : "坏票数没记"
                }
                value={
                  <span
                    className={
                      mission.result === "success"
                        ? "text-[color:var(--green)]"
                        : "text-[color:var(--red)]"
                    }
                  >
                    {mission.result === "success" ? "成功" : "失败"}
                  </span>
                }
              />
            ))
          )}
        </ListGroup>

        <ListGroup header="关于他的备注">
          {notes.length === 0 ? (
            <ListRow label="还没有备注" />
          ) : (
            notes.map((note) => (
              <ListRow
                key={note.id}
                label={note.text}
                detail={`第 ${note.missionNumber} 轮`}
              />
            ))
          )}
        </ListGroup>
      </div>
    </main>
  );
}
