"use client";

import { use } from "react";
import Link from "next/link";
import { RatingBadge } from "@/components/ui/rating-chips";
import { Card, EmptyState, SectionTitle } from "@/components/ui/feedback";
import { useEvents, useGame, usePlayers } from "@/lib/store/hooks";
import {
  getOpinionHistory,
  getPlayerMissionParticipation,
  getPlayerNotes,
  getPlayerOpinions,
  getPlayerProposalHistory,
  getPlayerVoteHistory,
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
  if (!player) {
    return (
      <div className="px-4 py-10">
        <EmptyState title="找不到这个玩家" />
      </div>
    );
  }

  const { expressed, received } = getPlayerOpinions(events, playerId);
  const proposals = getPlayerProposalHistory(events, game, playerId);
  const voteHistory = getPlayerVoteHistory(events, game, playerId);
  const missions = getPlayerMissionParticipation(events, game, playerId);
  const notes = getPlayerNotes(events, playerId);

  const changed = expressed.filter((edge) => edge.cell.revisionCount > 1);

  return (
    <main className="mx-auto max-w-md">
      <header className="pt-safe sticky top-0 z-30 border-b border-border bg-bg/95 px-4 pb-3 pt-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Link
            href={`/game/${gameId}/players`}
            aria-label="返回玩家列表"
            className="-ml-2 flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted active:bg-surface-2"
          >
            <span aria-hidden>←</span>
          </Link>
          <h1 className="text-lg font-semibold">{playerLabel(game, playerId)}</h1>
        </div>
      </header>

      <div className="space-y-6 px-4 pb-10 pt-4">
        <section>
          <SectionTitle>他怎么看别人（当前）</SectionTitle>
          {expressed.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">还没表过态。</p>
          ) : (
            <Card className="space-y-1.5">
              {players
                .filter((p) => p.id !== playerId)
                .map((target) => {
                  const edge = expressed.find((e) => e.targetId === target.id);
                  return (
                    <div
                      key={target.id}
                      className="flex items-center gap-2 text-[14px]"
                    >
                      <span className="w-14 shrink-0 text-fg-muted">
                        {seatLabel(game, target.id)}
                      </span>
                      <RatingBadge rating={edge?.cell.rating ?? null} />
                      {edge && edge.cell.revisionCount > 1 && (
                        <span className="text-[11px] text-fg-subtle">
                          改过 {edge.cell.revisionCount - 1} 次
                        </span>
                      )}
                    </div>
                  );
                })}
            </Card>
          )}
        </section>

        {changed.length > 0 && (
          <section>
            <SectionTitle>他改过口的</SectionTitle>
            <Card className="space-y-2">
              {changed.map((edge) => {
                const chain = getOpinionHistory(events, playerId, edge.targetId);
                return (
                  <div key={edge.targetId} className="text-[13px]">
                    <span className="text-fg-muted">
                      对 {seatLabel(game, edge.targetId)}：
                    </span>
                    <span className="ml-1 inline-flex items-center gap-1 align-middle">
                      {chain.map((event, i) => (
                        <span key={event.id} className="inline-flex items-center gap-1">
                          {i > 0 && (
                            <span aria-hidden className="text-fg-subtle">
                              →
                            </span>
                          )}
                          <RatingBadge rating={event.rating} />
                          <span className="text-[10px] text-fg-subtle">
                            第{event.missionNumber}轮
                          </span>
                        </span>
                      ))}
                    </span>
                  </div>
                );
              })}
            </Card>
          </section>
        )}

        <section>
          <SectionTitle>别人怎么看他</SectionTitle>
          {received.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">还没人评过他。</p>
          ) : (
            <Card className="space-y-1.5">
              {received.map((edge) => (
                <div
                  key={edge.speakerId}
                  className="flex items-center gap-2 text-[14px]"
                >
                  <span className="w-14 shrink-0 text-fg-muted">
                    {seatLabel(game, edge.speakerId)}
                  </span>
                  <RatingBadge rating={edge.cell.rating} />
                  {/* Mutual high/low ratings are worth eyeballing, so show the
                      reverse direction inline rather than making the user hunt. */}
                  {(() => {
                    const back = expressed.find(
                      (e) => e.targetId === edge.speakerId,
                    );
                    return back ? (
                      <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
                        <span aria-hidden>↔</span>
                        <RatingBadge rating={back.cell.rating} />
                      </span>
                    ) : null;
                  })()}
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <SectionTitle>他点过的车</SectionTitle>
          {proposals.asLeader.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">还没当过队长。</p>
          ) : (
            <Card className="space-y-1.5">
              {proposals.asLeader.map((record) => (
                <div
                  key={record.proposalEventId}
                  className="flex items-baseline gap-2 text-[13px]"
                >
                  <span className="w-16 shrink-0 text-fg-subtle">
                    第{record.missionNumber}轮·{record.proposalNumber}车
                  </span>
                  <span className="min-w-0 flex-1 tabular-nums">
                    {seatList(game, record.teamPlayerIds)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[12px]",
                      record.status === "rejected" ? "text-evil" : "text-good",
                    )}
                  >
                    {record.status === "rejected"
                      ? "否"
                      : record.status === "voting"
                        ? "等票"
                        : record.status === "draft"
                          ? "改过"
                          : "过"}
                  </span>
                </div>
              ))}
              <p className="pt-1 text-[12px] text-fg-subtle">
                当队长 {proposals.timesLed} 次 · 过 {proposals.asLeaderOutcome.passed} 否{" "}
                {proposals.asLeaderOutcome.rejected}
              </p>
            </Card>
          )}
        </section>

        <section>
          <SectionTitle>他的票</SectionTitle>
          {voteHistory.records.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">还没有投票记录。</p>
          ) : (
            <Card className="space-y-1.5">
              {voteHistory.records.map((record) => (
                <div
                  key={record.voteEventId}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <span className="w-16 shrink-0 text-fg-subtle">
                    第{record.missionNumber}轮·{record.proposalNumber}车
                  </span>
                  <span
                    className={cn(
                      "w-14 shrink-0 font-medium",
                      record.vote === "approve" && "text-good",
                      record.vote === "reject" && "text-evil",
                      (record.vote === "unknown" || record.vote === null) &&
                        "text-fg-subtle",
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
                  {record.wasOnTeam && (
                    <span className="shrink-0 text-[11px] text-accent">在车上</span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
                    车{record.finalResult === "passed" ? "过" : "否"}
                  </span>
                </div>
              ))}
              <p className="pt-1 text-[12px] text-fg-subtle">
                上票 {voteHistory.tally.approve} · 下票 {voteHistory.tally.reject}
                {voteHistory.tally.unknown > 0 &&
                  ` · 不清楚 ${voteHistory.tally.unknown}`}
                {voteHistory.tally.unrecorded > 0 &&
                  ` · 没记 ${voteHistory.tally.unrecorded}`}
              </p>
            </Card>
          )}
        </section>

        <section>
          <SectionTitle>他上过的车</SectionTitle>
          {missions.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">还没上过车。</p>
          ) : (
            <Card className="space-y-1.5">
              {missions.map((mission) => (
                <div
                  key={mission.missionNumber}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <span className="w-14 shrink-0 text-fg-subtle">
                    第{mission.missionNumber}轮
                  </span>
                  <span
                    className={cn(
                      "font-medium",
                      mission.result === "success" ? "text-good" : "text-evil",
                    )}
                  >
                    {mission.result === "success" ? "成功" : "失败"}
                  </span>
                  {mission.failCount != null && (
                    <span className="text-fg-subtle">
                      {mission.failCount} 张坏票
                    </span>
                  )}
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <SectionTitle>关于他的备注</SectionTitle>
          {notes.length === 0 ? (
            <p className="text-[13px] text-fg-subtle">还没有备注。</p>
          ) : (
            <Card className="space-y-2">
              {notes.map((note) => (
                <div key={note.id} className="text-[13px]">
                  <span className="text-[11px] text-fg-subtle">
                    第{note.missionNumber}轮 ·{" "}
                  </span>
                  {note.text}
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}
