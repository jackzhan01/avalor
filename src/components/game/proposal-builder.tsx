"use client";

import { useState } from "react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { PlayerGrid } from "@/components/ui/player-grid";
import { WarningBanner } from "@/components/ui/feedback";
import { useGameStore } from "@/lib/store/game-store";
import { useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { getTeamSizeWarning } from "@/lib/rules/avalon";
import { seatLabel } from "@/lib/format/labels";

/** 点车: pick the leader and who gets on the bus. */
export function ProposalBuilder({
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

  // Draft state lives here, not in the store: the store should only change at
  // the rate a human creates events, never per tap of a checkbox.
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [team, setTeam] = useState<string[]>([]);
  const [pickingLeader, setPickingLeader] = useState(false);

  if (!game || !timeline) return null;

  // Suggested leader is anchored on the last voted proposal, and is always
  // overridable — house rules and mis-taps both happen.
  const effectiveLeader = leaderId ?? timeline.currentLeaderId;
  const missionNumber = Math.min(timeline.missionNumber, 5);
  const warning = getTeamSizeWarning(
    game.playerCount,
    missionNumber,
    team.length,
  );

  function reset() {
    setLeaderId(null);
    setTeam([]);
    setPickingLeader(false);
  }

  function toggle(playerId: string) {
    setTeam((prev) =>
      prev.includes(playerId)
        ? prev.filter((id) => id !== playerId)
        : [...prev, playerId],
    );
  }

  async function save() {
    if (!effectiveLeader) return;
    await addEvent({
      type: "proposal",
      leaderId: effectiveLeader,
      teamPlayerIds: [...team].sort(
        (a, b) =>
          (game!.players.find((p) => p.id === a)?.seat ?? 0) -
          (game!.players.find((p) => p.id === b)?.seat ?? 0),
      ),
    });
    reset();
    onClose();
  }

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={`第 ${missionNumber} 轮 · 第 ${timeline.proposalNumber} 车`}
      subtitle={`这轮通常 ${warning.expected} 个人上车`}
      footer={
        <Button
          size="lg"
          fullWidth
          disabled={!effectiveLeader || team.length === 0}
          onClick={() => void save()}
        >
          {warning.severity === "warn"
            ? `仍然记录（${team.length} 人）`
            : `记下这辆车（${team.length} 人）`}
        </Button>
      }
    >
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            队长
          </span>
          <button
            onClick={() => setPickingLeader((v) => !v)}
            className="min-h-[32px] rounded-lg px-2 text-[13px] font-medium text-accent active:bg-surface-2"
          >
            {pickingLeader ? "收起" : "换个人"}
          </button>
        </div>

        {pickingLeader ? (
          <PlayerGrid
            players={players}
            mode="single"
            selectedIds={effectiveLeader ? [effectiveLeader] : []}
            onSelect={(id) => {
              setLeaderId(id);
              setPickingLeader(false);
            }}
          />
        ) : (
          <div className="rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-[15px]">
            {effectiveLeader ? seatLabel(game, effectiveLeader) : "未指定"}
            {timeline.leaderSource === "rotation" && !leaderId && (
              <span className="ml-2 text-[12px] text-fg-subtle">按座位顺推</span>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            谁上车
          </span>
          <span className="text-[13px] tabular-nums text-fg-muted">
            {team.length} / {warning.expected}
          </span>
        </div>
        <PlayerGrid
          players={players}
          mode="multi"
          selectedIds={team}
          leaderId={effectiveLeader}
          onSelect={toggle}
        />
      </div>

      {warning.severity === "warn" && team.length > 0 && (
        <WarningBanner className="mt-3">
          {warning.message}还是可以照记 —— 可能是你们的规则不一样。
        </WarningBanner>
      )}
    </BottomSheet>
  );
}
