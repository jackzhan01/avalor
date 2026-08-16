"use client";

import { useEffect, useState } from "react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ChoiceRow, SegmentedControl } from "@/components/ui/controls";
import { RatingChips } from "@/components/ui/rating-chips";
import { PlayerGrid } from "@/components/ui/player-grid";
import { WarningBanner } from "@/components/ui/feedback";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers } from "@/lib/store/hooks";
import { collectCascade } from "@/lib/events/mutate";
import { requiredFails } from "@/lib/rules/avalon";
import { EVENT_TYPE_LABELS, seatLabel } from "@/lib/format/labels";
import type { GameEvent, Rating } from "@/lib/types/events";
import type { MissionResult } from "@/lib/types/game";

const UNKNOWN = -1;

/**
 * Edit or delete any event, dispatched by type.
 *
 * V1 edits the historical event in place rather than appending a correction
 * event. Strict event sourcing would prefer the latter, but for a notebook the
 * user is correcting their own transcription, not recording that the game
 * changed — and `assignContext` keeps derived numbering honest either way.
 */
export function EventEditSheet({
  eventId,
  onClose,
}: {
  eventId: string | null;
  onClose: () => void;
}) {
  const game = useGame();
  const events = useEvents();
  const players = usePlayers();
  const editEvent = useGameStore((s) => s.editEvent);
  const deleteEvent = useGameStore((s) => s.deleteEvent);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const event = eventId ? events.find((e) => e.id === eventId) ?? null : null;

  if (!game || !event) return null;

  const cascade = collectCascade(events, event.id);
  const needsConfirm =
    event.type === "proposal" ||
    event.type === "vote" ||
    event.type === "mission";

  function requestDelete() {
    if (needsConfirm) setConfirmingDelete(true);
    else {
      void deleteEvent(event!.id);
      onClose();
    }
  }

  return (
    <>
      <BottomSheet
        open
        onClose={onClose}
        title={`修改${EVENT_TYPE_LABELS[event.type]}记录`}
        subtitle={`第 ${event.missionNumber} 轮${event.proposalNumber ? ` · 第 ${event.proposalNumber} 车` : ""}`}
        footer={
          <Button variant="danger" fullWidth onClick={requestDelete}>
            删除这条记录
          </Button>
        }
      >
        <EventEditor event={event} onDone={onClose} />
      </BottomSheet>

      <ConfirmDialog
        open={confirmingDelete}
        title="确定删除？"
        message="删掉之后，后面的轮次和车号会跟着重新排。"
        detail={cascade?.description || undefined}
        confirmLabel="删除"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          void deleteEvent(event.id);
          setConfirmingDelete(false);
          onClose();
        }}
      />
    </>
  );

  function EventEditor({
    event,
    onDone,
  }: {
    event: GameEvent;
    onDone: () => void;
  }) {
    switch (event.type) {
      case "opinion":
        return (
          <div>
            <p className="mb-3 text-[15px]">
              {seatLabel(game!, event.speakerId)} 对{" "}
              {seatLabel(game!, event.targetId)} 的态度
            </p>
            <RatingChips
              value={event.rating}
              onChange={(rating: Rating) => {
                if (rating === event.rating) return;
                void editEvent(event.id, { rating });
                onDone();
              }}
            />
          </div>
        );

      case "text":
        return <TextEditor event={event} onDone={onDone} />;

      case "vote":
        return (
          <div>
            <p className="mb-3 text-[15px]">这辆车最后过了没有？</p>
            <SegmentedControl
              value={event.finalResult}
              onChange={(finalResult) => {
                if (finalResult === event.finalResult) return;
                void editEvent(event.id, { finalResult });
                onDone();
              }}
              options={[
                { value: "passed", label: "车过了", tone: "good" },
                { value: "rejected", label: "车被否", tone: "evil" },
              ]}
            />
            <WarningBanner className="mt-3">
              改这个会影响后面所有轮次和车号的排列。
            </WarningBanner>
          </div>
        );

      case "mission":
        return <MissionEditor event={event} onDone={onDone} />;

      case "proposal":
        return <ProposalEditor event={event} onDone={onDone} />;
    }
  }

  function TextEditor({
    event,
    onDone,
  }: {
    event: Extract<GameEvent, { type: "text" }>;
    onDone: () => void;
  }) {
    const [text, setText] = useState(event.text);
    useEffect(() => setText(event.text), [event.text]);
    return (
      <div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-[15px] outline-none focus:border-accent"
        />
        <Button
          className="mt-3"
          fullWidth
          disabled={text.trim() === event.text || text.trim().length === 0}
          onClick={() => {
            void editEvent(event.id, { text: text.trim() });
            onDone();
          }}
        >
          保存修改
        </Button>
      </div>
    );
  }

  function MissionEditor({
    event,
    onDone,
  }: {
    event: Extract<GameEvent, { type: "mission" }>;
    onDone: () => void;
  }) {
    const [result, setResult] = useState<MissionResult>(event.result);
    const [failCount, setFailCount] = useState<number>(
      event.failCount ?? UNKNOWN,
    );
    const needed = requiredFails(
      game!.playerCount,
      Math.min(event.missionNumber, 5),
    );
    const teamSize = event.teamPlayerIds.length;
    const dirty =
      result !== event.result ||
      failCount !== (event.failCount ?? UNKNOWN);

    return (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            结果
          </p>
          <SegmentedControl
            value={result}
            onChange={setResult}
            options={[
              { value: "success", label: "任务成功", tone: "good" },
              { value: "fail", label: "任务失败", tone: "evil" },
            ]}
          />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            几张坏票{needed === 2 && "（这轮要 2 张才算失败）"}
          </p>
          <ChoiceRow
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
        </div>
        <Button
          fullWidth
          disabled={!dirty}
          onClick={() => {
            void editEvent(event.id, {
              result,
              ...(failCount === UNKNOWN
                ? { failCount: undefined }
                : { failCount }),
            });
            onDone();
          }}
        >
          保存修改
        </Button>
      </div>
    );
  }

  function ProposalEditor({
    event,
    onDone,
  }: {
    event: Extract<GameEvent, { type: "proposal" }>;
    onDone: () => void;
  }) {
    const [leaderId, setLeaderId] = useState(event.leaderId);
    const [team, setTeam] = useState<string[]>([...event.teamPlayerIds]);
    const dirty =
      leaderId !== event.leaderId ||
      team.length !== event.teamPlayerIds.length ||
      team.some((id) => !event.teamPlayerIds.includes(id));

    return (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            队长
          </p>
          <PlayerGrid
            players={players}
            mode="single"
            selectedIds={[leaderId]}
            onSelect={setLeaderId}
          />
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            谁上车（{team.length} 人）
          </p>
          <PlayerGrid
            players={players}
            mode="multi"
            selectedIds={team}
            onSelect={(id) =>
              setTeam((prev) =>
                prev.includes(id)
                  ? prev.filter((x) => x !== id)
                  : [...prev, id],
              )
            }
          />
        </div>
        <Button
          fullWidth
          disabled={!dirty || team.length === 0}
          onClick={() => {
            void editEvent(event.id, {
              leaderId,
              teamPlayerIds: [...team].sort(
                (a, b) =>
                  (game!.players.find((p) => p.id === a)?.seat ?? 0) -
                  (game!.players.find((p) => p.id === b)?.seat ?? 0),
              ),
            });
            onDone();
          }}
        >
          保存修改
        </Button>
      </div>
    );
  }
}
