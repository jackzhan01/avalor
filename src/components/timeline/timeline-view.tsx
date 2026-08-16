"use client";

import { useMemo, useState } from "react";
import { RatingBadge } from "@/components/ui/rating-chips";
import { Card, EmptyState, WarningBanner } from "@/components/ui/feedback";
import { EventEditSheet } from "./event-edit-sheet";
import { useEvents, useGame, useOpinions, useTimeline } from "@/lib/store/hooks";
import { seatLabel, seatList } from "@/lib/format/labels";
import type { GameEvent } from "@/lib/types/events";
import type { DerivedTimeline, ProposalState } from "@/lib/types/derived";
import type { GameRecord } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

const STATUS_LABEL: Record<ProposalState["status"], string> = {
  draft: "改车前的版本",
  voting: "等投票",
  rejected: "车被否",
  passed: "车过了",
  mission_completed: "车过了",
};

export function TimelineView() {
  const game = useGame();
  const events = useEvents();
  const timeline = useTimeline();
  const opinions = useOpinions();
  const [editingId, setEditingId] = useState<string | null>(null);

  /** Previous rating for each opinion event, so changes read as "4 → 2". */
  const previousRating = useMemo(() => {
    const map = new Map<string, number>();
    if (!opinions) return map;
    for (const chain of opinions.history.values()) {
      for (let i = 1; i < chain.length; i++) {
        map.set(chain[i].id, chain[i - 1].rating);
      }
    }
    return map;
  }, [opinions]);

  if (!game || !timeline) return null;

  if (events.length === 0) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          title="还没有任何记录"
          hint="回到「对局」页，听到什么记什么。"
        />
      </div>
    );
  }

  // Group by the mission each event belongs to, per the fold's context map.
  const maxMission = Math.max(5, timeline.missionNumber);
  const groups: { missionNumber: number; events: GameEvent[] }[] = [];
  for (let n = 1; n <= maxMission; n++) {
    const inMission = events.filter(
      (e) => (timeline.eventContext.get(e.id)?.missionNumber ?? e.missionNumber) === n,
    );
    if (inMission.length > 0) groups.push({ missionNumber: n, events: inMission });
  }

  /* Votes and missions render nested inside their proposal card, so they are
     skipped when encountered at the top level. Orphans still show up, flagged. */
  const nestedIds = new Set<string>();
  for (const proposal of timeline.proposalsById.values()) {
    if (proposal.vote) nestedIds.add(proposal.vote.id);
    if (proposal.mission) nestedIds.add(proposal.mission.id);
  }

  return (
    <>
      <div className="space-y-6 px-4 pb-8 pt-4">
        {groups.map((group) => {
          const summary = timeline.missions[group.missionNumber - 1];
          return (
            <section key={group.missionNumber}>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h2 className="text-[15px] font-semibold">
                  第 {group.missionNumber} 轮
                </h2>
                {summary && (
                  <span className="text-[12px] text-fg-subtle">
                    {summary.expectedTeamSize} 人上车
                    {summary.requiredFails === 2 && " · 要 2 张坏票"}
                    {summary.result &&
                      (summary.result === "success" ? " · 成功" : " · 失败")}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {group.events.map((event) => {
                  if (nestedIds.has(event.id)) return null;

                  if (event.type === "proposal") {
                    const proposal = timeline.proposalsById.get(event.id);
                    if (!proposal) return null;
                    return (
                      <ProposalCard
                        key={event.id}
                        game={game}
                        proposal={proposal}
                        timeline={timeline}
                        onEdit={setEditingId}
                      />
                    );
                  }

                  return (
                    <EventRow
                      key={event.id}
                      game={game}
                      event={event}
                      previousRating={previousRating.get(event.id)}
                      onEdit={() => setEditingId(event.id)}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <EventEditSheet eventId={editingId} onClose={() => setEditingId(null)} />
    </>
  );
}

function ProposalCard({
  game,
  proposal,
  timeline,
  onEdit,
}: {
  game: GameRecord;
  proposal: ProposalState;
  timeline: DerivedTimeline;
  onEdit: (eventId: string) => void;
}) {
  const vote = proposal.vote;
  const mission = proposal.mission;
  const warnings = timeline.warnings.filter(
    (w) =>
      w.eventId === proposal.event.id ||
      (vote && w.eventId === vote.id) ||
      (mission && w.eventId === mission.id),
  );

  const voteBreakdown = vote
    ? (() => {
        const approve: string[] = [];
        const reject: string[] = [];
        const unknown: string[] = [];
        for (const player of game.players) {
          const choice = Object.prototype.hasOwnProperty.call(
            vote.votes,
            player.id,
          )
            ? vote.votes[player.id]
            : null;
          if (choice === "approve") approve.push(player.id);
          else if (choice === "reject") reject.push(player.id);
          else if (choice === "unknown") unknown.push(player.id);
        }
        return { approve, reject, unknown };
      })()
    : null;

  return (
    <Card
      className={cn(
        proposal.status === "draft" && "border-dashed opacity-70",
      )}
    >
      <button
        onClick={() => onEdit(proposal.event.id)}
        className="-m-1 block w-full rounded-lg p-1 text-left active:bg-surface-2"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px]">
            <span className="font-medium">
              {seatLabel(game, proposal.event.leaderId)}
            </span>{" "}
            点车 · 第 {proposal.proposalNumber} 车
          </span>
          <span
            className={cn(
              "shrink-0 text-[12px] font-medium",
              proposal.status === "rejected" && "text-evil",
              (proposal.status === "passed" ||
                proposal.status === "mission_completed") &&
                "text-good",
              proposal.status === "voting" && "text-accent",
              proposal.status === "draft" && "text-fg-subtle",
            )}
          >
            {STATUS_LABEL[proposal.status]}
          </span>
        </div>
        <p className="mt-1 text-[17px] font-semibold tabular-nums">
          {seatList(game, proposal.event.teamPlayerIds)}
        </p>
      </button>

      {voteBreakdown && vote && (
        <button
          onClick={() => onEdit(vote.id)}
          className="mt-2.5 block w-full rounded-lg border-t border-border pt-2.5 text-left active:bg-surface-2"
        >
          <div className="space-y-0.5 text-[13px] tabular-nums">
            <div className="flex gap-2">
              <span className="w-10 shrink-0 text-good">✓ 上票</span>
              <span className="min-w-0 flex-1">
                {voteBreakdown.approve.length > 0
                  ? seatList(game, voteBreakdown.approve)
                  : "—"}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-10 shrink-0 text-evil">✕ 下票</span>
              <span className="min-w-0 flex-1">
                {voteBreakdown.reject.length > 0
                  ? seatList(game, voteBreakdown.reject)
                  : "—"}
              </span>
            </div>
            {voteBreakdown.unknown.length > 0 && (
              <div className="flex gap-2 text-fg-subtle">
                <span className="w-10 shrink-0">? 不清楚</span>
                <span className="min-w-0 flex-1">
                  {seatList(game, voteBreakdown.unknown)}
                </span>
              </div>
            )}
          </div>
        </button>
      )}

      {mission && (
        <button
          onClick={() => onEdit(mission.id)}
          className="mt-2.5 flex w-full items-center gap-2 rounded-lg border-t border-border pt-2.5 text-left active:bg-surface-2"
        >
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[12px] font-semibold text-white",
              mission.result === "success" ? "bg-good" : "bg-evil",
            )}
          >
            {mission.result === "success" ? "任务成功" : "任务失败"}
          </span>
          <span className="text-[13px] text-fg-muted">
            {mission.failCount != null
              ? `${mission.failCount} 张坏票`
              : "坏票数没记"}
          </span>
        </button>
      )}

      {warnings.length > 0 && (
        <div className="mt-2 space-y-1">
          {warnings.map((warning, i) => (
            <WarningBanner key={i}>{warning.message}</WarningBanner>
          ))}
        </div>
      )}
    </Card>
  );
}

function EventRow({
  game,
  event,
  previousRating,
  onEdit,
}: {
  game: GameRecord;
  event: GameEvent;
  previousRating?: number;
  onEdit: () => void;
}) {
  if (event.type === "opinion") {
    return (
      <button
        onClick={onEdit}
        className="flex w-full items-center gap-2 rounded-lg bg-surface px-3 py-2 text-left text-[13px] active:bg-surface-2"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{seatLabel(game, event.speakerId)}</span>
          <span className="text-fg-subtle"> 对 </span>
          <span className="font-medium">{seatLabel(game, event.targetId)}</span>
        </span>
        {previousRating != null && (
          <>
            <RatingBadge
              rating={previousRating as 1 | 2 | 3 | 4 | 5}
              className="opacity-50"
            />
            <span aria-hidden className="text-fg-subtle">
              →
            </span>
          </>
        )}
        <RatingBadge rating={event.rating} />
      </button>
    );
  }

  if (event.type === "text") {
    return (
      <button
        onClick={onEdit}
        className="block w-full rounded-lg border-l-2 border-accent bg-surface px-3 py-2 text-left text-[13px] active:bg-surface-2"
      >
        {event.playerId && (
          <span className="font-medium">{seatLabel(game, event.playerId)}：</span>
        )}
        <span className="text-fg-muted">{event.text}</span>
      </button>
    );
  }

  // An orphaned vote or mission: its proposal was deleted or never existed.
  return (
    <button
      onClick={onEdit}
      className="block w-full rounded-lg bg-surface px-3 py-2 text-left text-[13px] text-fg-muted active:bg-surface-2"
    >
      {event.type === "vote"
        ? `一条对不上车的投票记录（${event.finalResult === "passed" ? "过" : "否"}）`
        : `一条对不上车的任务结果（${event.type === "mission" && event.result === "success" ? "成功" : "失败"}）`}
    </button>
  );
}
