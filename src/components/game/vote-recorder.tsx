"use client";

import { useState } from "react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/lib/store/game-store";
import { useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { seatList, seatLabel } from "@/lib/format/labels";
import type { VoteChoice } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

const CHOICES: { value: VoteChoice; label: string; icon: string }[] = [
  { value: "approve", label: "上票", icon: "✓" },
  { value: "reject", label: "下票", icon: "✕" },
  { value: "unknown", label: "不清楚", icon: "?" },
];

/**
 * Records the full seat-level vote pattern.
 *
 * Storing only "6-4 通过" would throw away most of the information: a 6-4 pass
 * by one coalition and a 6-4 pass by another mean completely different things
 * (spec §21). So every seat is kept, and three states are distinguished:
 *
 *   上票 / 下票   — recorded
 *   不清楚        — recorded as unknown (they voted, you didn't catch it)
 *   untouched     — absent from the map entirely (never recorded)
 */
export function VoteRecorder({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const game = useGame();
  const timeline = useTimeline();
  const players = usePlayers();
  const addEvent = useGameStore((s) => s.addEvent);
  const [votes, setVotes] = useState<Record<string, VoteChoice>>({});

  if (!game || !timeline) return null;
  const proposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  if (!proposal) return null;

  const counts = { approve: 0, reject: 0, unknown: 0 };
  for (const player of players) {
    const choice = votes[player.id];
    if (choice) counts[choice] += 1;
  }
  const unrecorded = players.length - (counts.approve + counts.reject + counts.unknown);

  function setAll(choice: VoteChoice) {
    const next: Record<string, VoteChoice> = {};
    for (const player of players) next[player.id] = choice;
    setVotes(next);
  }

  async function save(finalResult: "passed" | "rejected") {
    await addEvent({
      type: "vote",
      proposalId: proposal!.event.id,
      votes,
      finalResult,
    });
    setVotes({});
    onClose();
  }

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        setVotes({});
        onClose();
      }}
      title={`第 ${proposal.missionNumber} 轮 · 第 ${proposal.proposalNumber} 车 投票`}
      subtitle={`${seatLabel(game, proposal.event.leaderId)} 点的车：${seatList(game, proposal.event.teamPlayerIds)}`}
      footer={
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-3 text-[13px] tabular-nums text-fg-muted">
            <span className="text-good">上 {counts.approve}</span>
            <span className="text-evil">下 {counts.reject}</span>
            {counts.unknown > 0 && <span>不清楚 {counts.unknown}</span>}
            {unrecorded > 0 && (
              <span className="text-fg-subtle">未记 {unrecorded}</span>
            )}
          </div>
          {/* The result is recorded explicitly, never inferred from the tally —
              partial data would produce a confidently wrong answer. */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="lg"
              className="bg-evil"
              onClick={() => void save("rejected")}
            >
              车被否
            </Button>
            <Button
              size="lg"
              className="bg-good"
              onClick={() => void save("passed")}
            >
              车过了
            </Button>
          </div>
        </div>
      }
    >
      <div className="mb-3 flex gap-2">
        <button
          onClick={() => setAll("approve")}
          className="min-h-[38px] flex-1 rounded-lg border border-border bg-surface-2 text-[13px] font-medium active:bg-surface-3"
        >
          先全标上票
        </button>
        <button
          onClick={() => setAll("reject")}
          className="min-h-[38px] flex-1 rounded-lg border border-border bg-surface-2 text-[13px] font-medium active:bg-surface-3"
        >
          先全标下票
        </button>
        <button
          onClick={() => setVotes({})}
          className="min-h-[38px] rounded-lg border border-border bg-surface-2 px-3 text-[13px] font-medium active:bg-surface-3"
        >
          清空
        </button>
      </div>

      <div className="space-y-1.5">
        {players.map((player) => {
          const onTeam = proposal.event.teamPlayerIds.includes(player.id);
          const choice = votes[player.id] ?? null;
          return (
            <div key={player.id} className="flex items-center gap-2">
              <div
                className={cn(
                  "w-[4.5rem] shrink-0 text-[15px]",
                  onTeam && "font-semibold text-accent",
                )}
              >
                {player.seat}号
                {onTeam && (
                  <span className="ml-1 text-[10px] font-normal">在车上</span>
                )}
              </div>
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                {CHOICES.map((option) => {
                  const selected = choice === option.value;
                  return (
                    <button
                      key={option.value}
                      aria-pressed={selected}
                      aria-label={`${player.seat}号 ${option.label}`}
                      onClick={() =>
                        setVotes((prev) => {
                          // Tapping the active choice clears it back to
                          // "never recorded", which is a real, distinct state.
                          const next = { ...prev };
                          if (prev[player.id] === option.value)
                            delete next[player.id];
                          else next[player.id] = option.value;
                          return next;
                        })
                      }
                      className={cn(
                        "flex min-h-[44px] items-center justify-center gap-1 rounded-lg border text-[13px] font-medium transition-colors",
                        selected
                          ? option.value === "approve"
                            ? "border-good bg-good text-white"
                            : option.value === "reject"
                              ? "border-evil bg-evil text-white"
                              : "border-border-strong bg-surface-3 text-fg"
                          : "border-border bg-surface-2 text-fg-muted active:bg-surface-3",
                      )}
                    >
                      <span aria-hidden>{option.icon}</span>
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-fg-subtle">
        没点到的人会记成「没记录」，跟明确标「不清楚」是两回事。记一半也没关系。
      </p>
    </BottomSheet>
  );
}
