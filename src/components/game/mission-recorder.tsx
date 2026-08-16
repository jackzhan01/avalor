"use client";

import { useState } from "react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { ChoiceRow, SegmentedControl } from "@/components/ui/controls";
import { WarningBanner } from "@/components/ui/feedback";
import { useGameStore } from "@/lib/store/game-store";
import { useGame, useTimeline } from "@/lib/store/hooks";
import { requiredFails } from "@/lib/rules/avalon";
import { seatList, seatLabel } from "@/lib/format/labels";
import type { MissionResult } from "@/lib/types/game";

const UNKNOWN = -1;

export function MissionRecorder({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const game = useGame();
  const timeline = useTimeline();
  const addEvent = useGameStore((s) => s.addEvent);
  const [result, setResult] = useState<MissionResult | null>(null);
  const [failCount, setFailCount] = useState<number>(UNKNOWN);

  if (!game || !timeline) return null;
  const proposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  if (!proposal) return null;

  const missionNumber = proposal.missionNumber;
  const needed = requiredFails(game.playerCount, Math.min(missionNumber, 5));
  const teamSize = proposal.event.teamPlayerIds.length;

  // Advisory only. The recorded result is authoritative — this never
  // auto-corrects `result` from `failCount`.
  const inconsistent =
    failCount !== UNKNOWN &&
    result !== null &&
    ((result === "fail" && failCount < needed) ||
      (result === "success" && failCount >= needed));

  function reset() {
    setResult(null);
    setFailCount(UNKNOWN);
  }

  async function save() {
    if (!result) return;
    await addEvent({
      type: "mission",
      proposalId: proposal!.event.id,
      teamPlayerIds: [...proposal!.event.teamPlayerIds],
      result,
      ...(failCount !== UNKNOWN ? { failCount } : {}),
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
      title={`第 ${missionNumber} 轮任务结果`}
      subtitle={`${seatLabel(game, proposal.event.leaderId)} 点的车：${seatList(game, proposal.event.teamPlayerIds)}`}
      footer={
        <Button size="lg" fullWidth disabled={!result} onClick={() => void save()}>
          记完，进入下一轮
        </Button>
      }
    >
      <div className="mb-5">
        <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
          结果
        </p>
        <SegmentedControl
          ariaLabel="任务结果"
          value={result}
          onChange={setResult}
          options={[
            { value: "success", label: "任务成功", icon: "✓", tone: "good" },
            { value: "fail", label: "任务失败", icon: "✕", tone: "evil" },
          ]}
        />
      </div>

      <div>
        <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
          几张坏票
        </p>
        <ChoiceRow
          ariaLabel="坏票数量"
          value={failCount}
          onChange={setFailCount}
          options={[
            ...Array.from({ length: teamSize + 1 }, (_, i) => ({
              value: i,
              label: String(i),
            })),
            { value: UNKNOWN, label: "不清楚" },
          ]}
        />
        {needed === 2 && (
          <p className="mt-2 text-[12px] text-fg-muted">
            {game.playerCount} 人局的第 4 轮，要 2 张坏票才算失败。
          </p>
        )}
      </div>

      {inconsistent && (
        <WarningBanner className="mt-4">
          这轮需要 {needed} 张坏票才算失败，跟你选的坏票数对不上。仍然按你记的结果保存。
        </WarningBanner>
      )}
    </BottomSheet>
  );
}
