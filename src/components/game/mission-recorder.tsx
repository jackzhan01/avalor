"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list";
import { useGameStore } from "@/lib/store/game-store";
import { useGame, useTimeline } from "@/lib/store/hooks";
import { requiredFails } from "@/lib/rules/avalon";
import { seatLabel, seatList } from "@/lib/format/labels";
import type { MissionResult } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

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
  const [failCount, setFailCount] = useState(UNKNOWN);

  if (!game || !timeline || !open) return null;
  const proposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  if (!proposal) return null;

  const missionNumber = proposal.missionNumber;
  const needed = requiredFails(game.playerCount, Math.min(missionNumber, 5));
  const teamSize = proposal.event.teamPlayerIds.length;

  function reset() {
    setResult(null);
    setFailCount(UNKNOWN);
  }

  return (
    <Sheet
      open
      onClose={() => {
        reset();
        onClose();
      }}
      title={`第 ${missionNumber} 轮结果`}
      subtitle={`${seatLabel(game, proposal.event.leaderId)} 点的车：${seatList(game, proposal.event.teamPlayerIds)}`}
      layerKey="mission"
      trailing={<span className="w-16" />}
      footer={
        <Button
          size="lg"
          fullWidth
          disabled={!result}
          onClick={() => {
            void addEvent({
              type: "mission",
              proposalId: proposal!.event.id,
              teamPlayerIds: [...proposal!.event.teamPlayerIds],
              result: result!,
              ...(failCount !== UNKNOWN ? { failCount } : {}),
            });
            reset();
            onClose();
          }}
        >
          记完，进入下一轮
        </Button>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-2">
        {(
          [
            { value: "success", label: "任务成功", color: "var(--green)" },
            { value: "fail", label: "任务失败", color: "var(--red)" },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            onClick={() => {
              setResult(option.value);
              // The result already implies the fail count in the common case:
              // a success at one required fail can only be 0, and a failure is
              // at least the required number. Pre-fill it rather than letting
              // the user enter something the rules contradict and then warning.
              setFailCount(option.value === "success" ? 0 : needed);
            }}
            aria-pressed={result === option.value}
            className={cn(
              "t-body min-h-[54px] rounded-[12px] font-semibold active:opacity-80",
              result === option.value
                ? "text-white"
                : "bg-[color:var(--fill)] text-[color:var(--label)]",
            )}
            style={
              result === option.value ? { backgroundColor: option.color } : undefined
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      <ListGroup
        header="几张坏票"
        footer={
          needed === 2
            ? `${game.playerCount} 人局第 4 轮，要 2 张坏票才算失败 —— 所以成功也可能有 1 张。`
            : result === "success"
              ? "任务成功就是 0 张。要是你们规则不一样，也能照改。"
              : "不确定就选「不清楚」，不影响记录。"
        }
      >
        <div className="flex flex-wrap gap-1.5 p-3">
          {[...Array.from({ length: teamSize + 1 }, (_, i) => i), UNKNOWN].map(
            (count) => (
              <button
                key={count}
                onClick={() => setFailCount(count)}
                aria-pressed={failCount === count}
                className={cn(
                  "t-body min-h-[44px] min-w-[52px] rounded-[10px] px-3 font-medium active:opacity-70",
                  failCount === count
                    ? "bg-[color:var(--blue)] text-white"
                    : "bg-[color:var(--fill)] text-[color:var(--label)]",
                )}
              >
                {count === UNKNOWN ? "不清楚" : count}
              </button>
            ),
          )}
        </div>
      </ListGroup>

      {failCount !== UNKNOWN &&
        result !== null &&
        ((result === "fail" && failCount < needed) ||
          (result === "success" && failCount >= needed)) && (
          <p className="t-footnote mt-3 rounded-[10px] bg-[color:var(--fill)] px-3 py-2 text-[color:var(--orange)]">
            这轮要 {needed} 张坏票才算失败，跟你选的对不上。仍然按你记的结果保存。
          </p>
        )}
    </Sheet>
  );
}
