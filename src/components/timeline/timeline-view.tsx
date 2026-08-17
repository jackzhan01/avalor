"use client";

import { useMemo, useState } from "react";
import { RatingBadge } from "@/components/ui/rating-chips";
import { EmptyState, InlineWarning } from "@/components/ui/feedback";
import { EventEditSheet } from "./event-edit-sheet";
import { useEvents, useGame, useOpinions, useTimeline } from "@/lib/store/hooks";
import { seatLabel, seatList } from "@/lib/format/labels";
import { isPrivateEvent, type GameEvent } from "@/lib/types/events";
import type { DerivedTimeline, ProposalState } from "@/lib/types/derived";
import type { GameRecord } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

const STATUS_LABEL: Record<ProposalState["status"], string> = {
  draft: "改车前",
  voting: "等投票",
  rejected: "被否",
  passed: "过了",
  mission_completed: "过了",
};

/**
 * Every recorded thing, in order, grouped by round.
 *
 * Each row is tappable and says so — editing history is a first-class action
 * here, not something buried behind a long-press nobody discovers.
 */
export function TimelineView() {
  const game = useGame();
  const events = useEvents();
  const timeline = useTimeline();
  const opinions = useOpinions();
  const [editingId, setEditingId] = useState<string | null>(null);

  /** Previous rating per opinion event, so a change reads as "4 → 2". */
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
      <EmptyState title="还没有任何记录" hint="回到牌桌，听到什么记什么。" />
    );
  }

  const maxMission = Math.max(5, timeline.missionNumber);
  const groups: { missionNumber: number; events: GameEvent[] }[] = [];
  for (let n = 1; n <= maxMission; n++) {
    const inMission = events.filter(
      (e) =>
        // The private layer is deliberately absent here: the timeline is the
        // record of the game, and it should be safe to hand to someone or
        // glance at with people around. Marks live on the table instead.
        !isPrivateEvent(e) &&
        (timeline.eventContext.get(e.id)?.missionNumber ?? e.missionNumber) === n,
    );
    if (inMission.length > 0) groups.push({ missionNumber: n, events: inMission });
  }

  // Votes and missions render inside their proposal card, so they are skipped
  // at the top level. Orphans still surface, flagged.
  const nested = new Set<string>();
  for (const proposal of timeline.proposalsById.values()) {
    if (proposal.vote) nested.add(proposal.vote.id);
    if (proposal.mission) nested.add(proposal.mission.id);
  }

  return (
    <>
      <div className="flex flex-col gap-7 pb-8">
        {groups.map((group) => {
          const summary = timeline.missions[group.missionNumber - 1];
          return (
            <section key={group.missionNumber}>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
                <h2 className="t-headline">第 {group.missionNumber} 轮</h2>
                {summary && (
                  <span className="t-caption text-[color:var(--label-tertiary)]">
                    {summary.expectedTeamSize} 人上车
                    {summary.requiredFails === 2 && " · 要 2 张坏票"}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {group.events.map((event) => {
                  if (nested.has(event.id)) return null;
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
                    <StatementRow
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

  const split = vote
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
    <div
      className={cn(
        "overflow-hidden rounded-[10px] bg-[color:var(--bg-elevated)]",
        proposal.status === "draft" && "opacity-60",
      )}
    >
      <button
        onClick={() => onEdit(proposal.event.id)}
        className="list-row w-full px-3.5 py-2.5 text-left active:bg-[color:var(--fill)]"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="t-subhead">
            <span className="font-semibold">
              {seatLabel(game, proposal.event.leaderId)}
            </span>{" "}
            点车 · 第 {proposal.proposalNumber} 车
          </span>
          <span
            className={cn(
              "t-caption shrink-0 font-semibold",
              proposal.status === "rejected" && "text-[color:var(--red)]",
              (proposal.status === "passed" ||
                proposal.status === "mission_completed") &&
                "text-[color:var(--green)]",
              proposal.status === "voting" && "text-[color:var(--blue)]",
              proposal.status === "draft" && "text-[color:var(--label-tertiary)]",
            )}
          >
            {STATUS_LABEL[proposal.status]}
          </span>
        </div>
        <p className="mt-1 text-[19px] font-semibold tabular-nums">
          {seatList(game, proposal.event.teamPlayerIds)}
        </p>
      </button>

      {split && vote && (
        <button
          onClick={() => onEdit(vote.id)}
          className="list-row w-full px-3.5 py-2.5 text-left active:bg-[color:var(--fill)]"
        >
          <div className="t-footnote flex flex-col gap-0.5 tabular-nums">
            <div className="flex gap-2">
              <span className="w-11 shrink-0 font-semibold text-[color:var(--green)]">
                ✓ 上票
              </span>
              <span className="min-w-0 flex-1">
                {split.approve.length > 0 ? seatList(game, split.approve) : "—"}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-11 shrink-0 font-semibold text-[color:var(--red)]">
                ✕ 下票
              </span>
              <span className="min-w-0 flex-1">
                {split.reject.length > 0 ? seatList(game, split.reject) : "—"}
              </span>
            </div>
            {split.unknown.length > 0 && (
              <div className="flex gap-2 text-[color:var(--label-tertiary)]">
                <span className="w-11 shrink-0">? 不清楚</span>
                <span className="min-w-0 flex-1">
                  {seatList(game, split.unknown)}
                </span>
              </div>
            )}
          </div>
        </button>
      )}

      {mission && (
        <button
          onClick={() => onEdit(mission.id)}
          className="list-row flex w-full items-center gap-2 px-3.5 py-2.5 text-left active:bg-[color:var(--fill)]"
        >
          <span
            className="t-caption rounded-[6px] px-1.5 py-0.5 font-semibold text-white"
            style={{
              backgroundColor:
                mission.result === "success" ? "var(--green)" : "var(--red)",
            }}
          >
            {mission.result === "success" ? "任务成功" : "任务失败"}
          </span>
          <span className="t-footnote text-[color:var(--label-secondary)]">
            {mission.failCount != null
              ? `${mission.failCount} 张坏票`
              : "坏票数没记"}
          </span>
        </button>
      )}

      {warnings.length > 0 && (
        <div className="flex flex-col gap-1 p-2">
          {warnings.map((warning, i) => (
            <InlineWarning key={i}>{warning.message}</InlineWarning>
          ))}
        </div>
      )}
    </div>
  );
}

function StatementRow({
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
  const shell =
    "flex w-full items-center gap-2 rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-2.5 text-left active:bg-[color:var(--fill)]";

  if (event.type === "opinion") {
    return (
      <button onClick={onEdit} className={shell}>
        <span className="t-footnote min-w-0 flex-1 truncate">
          <span className="font-semibold">{seatLabel(game, event.speakerId)}</span>
          <span className="text-[color:var(--label-tertiary)]"> 说 </span>
          <span className="font-semibold">{seatLabel(game, event.targetId)}</span>
        </span>
        {previousRating != null && (
          <>
            <RatingBadge rating={previousRating as 1 | 2 | 3 | 4 | 5} muted />
            <span aria-hidden className="text-[color:var(--label-tertiary)]">
              →
            </span>
          </>
        )}
        <RatingBadge rating={event.rating} />
      </button>
    );
  }

  if (event.type === "intended_team") {
    return (
      <button onClick={onEdit} className={shell}>
        <span className="t-footnote min-w-0 flex-1">
          <span className="font-semibold">{seatLabel(game, event.playerId)}</span>
          <span className="text-[color:var(--label-tertiary)]"> 想带 </span>
          <span className="font-semibold tabular-nums">
            {seatList(game, event.teamPlayerIds)}
          </span>
        </span>
        <span className="t-caption shrink-0 rounded-[6px] bg-[color:var(--fill)] px-1.5 py-0.5 text-[color:var(--label-secondary)]">
          意向
        </span>
      </button>
    );
  }

  if (event.type === "role_claim") {
    return (
      <button onClick={onEdit} className={shell}>
        <span className="t-footnote min-w-0 flex-1">
          <span className="font-semibold">{seatLabel(game, event.playerId)}</span>
          <span className="text-[color:var(--label-tertiary)]">
            {event.claimed ? " 跳派" : " 收回跳派"}
          </span>
        </span>
        <span
          className="t-caption shrink-0 rounded-[6px] px-1.5 py-0.5 font-semibold text-white"
          style={{
            backgroundColor: event.claimed ? "var(--blue)" : "var(--gray)",
          }}
        >
          {event.claimed ? "派" : "撤"}
        </span>
      </button>
    );
  }

  if (event.type === "text") {
    return (
      <button
        onClick={onEdit}
        className={cn(shell, "border-l-[3px] border-[color:var(--blue)]")}
      >
        <span className="t-footnote min-w-0 flex-1">
          {event.playerId && (
            <span className="font-semibold">
              {seatLabel(game, event.playerId)}：
            </span>
          )}
          <span className="text-[color:var(--label-secondary)]">{event.text}</span>
        </span>
      </button>
    );
  }

  // An orphaned vote or mission whose proposal is gone.
  return (
    <button onClick={onEdit} className={shell}>
      <span className="t-footnote min-w-0 flex-1 text-[color:var(--label-secondary)]">
        {event.type === "vote"
          ? `一条对不上车的投票（${event.finalResult === "passed" ? "过" : "否"}）`
          : "一条对不上车的任务结果"}
      </span>
    </button>
  );
}
