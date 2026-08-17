"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ChoiceRow, SegmentedControl } from "@/components/ui/controls";
import { RatingChips } from "@/components/ui/rating-chips";
import { SeatPicker } from "@/components/ui/player-grid";
import { ListAction, ListGroup } from "@/components/ui/list";
import { InlineWarning } from "@/components/ui/feedback";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers } from "@/lib/store/hooks";
import { collectCascade } from "@/lib/events/mutate";
import { requiredFails } from "@/lib/rules/avalon";
import { EVENT_TYPE_LABELS, seatLabel } from "@/lib/format/labels";
import type {
  GameEvent,
  IntendedTeamEvent,
  MissionEvent,
  OpinionEvent,
  ProposalEvent,
  Rating,
  RoleClaimEvent,
  TextEvent,
  VoteEvent,
} from "@/lib/types/events";
import type { GameRecord, MissionResult, Player } from "@/lib/types/game";

const UNKNOWN = -1;

/**
 * Edit or delete any recorded event, dispatched by type.
 *
 * V1 edits history in place rather than appending a correction event: the user
 * is fixing their own transcription, not recording that the game changed.
 * `assignContext` keeps the derived round numbering honest either way.
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
  const deleteEvent = useGameStore((s) => s.deleteEvent);
  const [confirming, setConfirming] = useState(false);

  const event = eventId ? (events.find((e) => e.id === eventId) ?? null) : null;
  if (!game || !event) return null;

  const cascade = collectCascade(events, event.id);
  // Only structural deletions can drag other records with them.
  const needsConfirm =
    event.type === "proposal" ||
    event.type === "vote" ||
    event.type === "mission";

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={`改这条${EVENT_TYPE_LABELS[event.type]}`}
        subtitle={`第 ${event.missionNumber} 轮${event.proposalNumber ? ` · 第 ${event.proposalNumber} 车` : ""}`}
        layerKey={event.id}
      >
        <Editor
          event={event}
          game={game}
          players={players}
          onDone={onClose}
        />

        <div className="mt-6">
          <ListGroup>
            <ListAction
              label="删除这条记录"
              destructive
              onClick={() => {
                if (needsConfirm) setConfirming(true);
                else {
                  void deleteEvent(event.id);
                  onClose();
                }
              }}
            />
          </ListGroup>
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirming}
        title="确定删除？"
        message="后面的轮次和车号会跟着重新排。"
        detail={cascade?.description || undefined}
        confirmLabel="删除"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          void deleteEvent(event.id);
          setConfirming(false);
          onClose();
        }}
      />
    </>
  );
}

function Editor({
  event,
  game,
  players,
  onDone,
}: {
  event: GameEvent;
  game: GameRecord;
  players: Player[];
  onDone: () => void;
}) {
  switch (event.type) {
    case "opinion":
      return <OpinionEditor event={event} game={game} onDone={onDone} />;
    case "text":
      return <TextEditor event={event} onDone={onDone} />;
    case "vote":
      return <VoteEditor event={event} onDone={onDone} />;
    case "mission":
      return <MissionEditor event={event} game={game} onDone={onDone} />;
    case "proposal":
      return <ProposalEditor event={event} game={game} players={players} onDone={onDone} />;
    case "intended_team":
      return (
        <IntendedTeamEditor event={event} game={game} players={players} onDone={onDone} />
      );
    case "role_claim":
      return <RoleClaimEditor event={event} game={game} onDone={onDone} />;
    case "role_mark":
      // Private marks are managed from the table, not the timeline, and the
      // timeline filters them out — this branch exists only for exhaustiveness.
      return null;
  }
}

function useEdit() {
  return useGameStore((s) => s.editEvent);
}

function OpinionEditor({
  event,
  game,
  onDone,
}: {
  event: OpinionEvent;
  game: GameRecord;
  onDone: () => void;
}) {
  const editEvent = useEdit();
  return (
    <div>
      <p className="t-subhead mb-3 text-[color:var(--label-secondary)]">
        <span className="font-semibold text-[color:var(--label)]">
          {seatLabel(game, event.speakerId)}
        </span>{" "}
        怎么看{" "}
        <span className="font-semibold text-[color:var(--label)]">
          {seatLabel(game, event.targetId)}
        </span>
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
}

function TextEditor({ event, onDone }: { event: TextEvent; onDone: () => void }) {
  const editEvent = useEdit();
  const [text, setText] = useState(event.text);
  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="t-body w-full rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-3 outline-none"
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

function VoteEditor({ event, onDone }: { event: VoteEvent; onDone: () => void }) {
  const editEvent = useEdit();
  return (
    <div>
      <p className="t-subhead mb-3 text-[color:var(--label-secondary)]">
        这辆车最后过了没有？
      </p>
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
      <InlineWarning className="mt-3">
        改这个会影响后面所有轮次和车号的排列。
      </InlineWarning>
    </div>
  );
}

function MissionEditor({
  event,
  game,
  onDone,
}: {
  event: MissionEvent;
  game: GameRecord;
  onDone: () => void;
}) {
  const editEvent = useEdit();
  const [result, setResult] = useState<MissionResult>(event.result);
  const [failCount, setFailCount] = useState(event.failCount ?? UNKNOWN);
  const needed = requiredFails(game.playerCount, Math.min(event.missionNumber, 5));
  const teamSize = event.teamPlayerIds.length;
  const dirty =
    result !== event.result || failCount !== (event.failCount ?? UNKNOWN);

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        ariaLabel="任务结果"
        value={result}
        onChange={setResult}
        options={[
          { value: "success", label: "任务成功", tone: "good" },
          { value: "fail", label: "任务失败", tone: "evil" },
        ]}
      />
      <div>
        <p className="t-footnote mb-2 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
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
            ...(failCount === UNKNOWN ? { failCount: undefined } : { failCount }),
          });
          onDone();
        }}
      >
        保存修改
      </Button>
    </div>
  );
}

function sortBySeat(game: GameRecord, ids: string[]): string[] {
  return [...ids].sort(
    (a, b) =>
      (game.players.find((p) => p.id === a)?.seat ?? 0) -
      (game.players.find((p) => p.id === b)?.seat ?? 0),
  );
}

function ProposalEditor({
  event,
  game,
  players,
  onDone,
}: {
  event: ProposalEvent;
  game: GameRecord;
  players: Player[];
  onDone: () => void;
}) {
  const editEvent = useEdit();
  const [leaderId, setLeaderId] = useState(event.leaderId);
  const [team, setTeam] = useState<string[]>([...event.teamPlayerIds]);
  const dirty =
    leaderId !== event.leaderId ||
    team.length !== event.teamPlayerIds.length ||
    team.some((id) => !event.teamPlayerIds.includes(id));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="t-footnote mb-2 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
          车主
        </p>
        <SeatPicker
          players={players}
          mode="single"
          selectedIds={[leaderId]}
          onSelect={setLeaderId}
        />
      </div>
      <div>
        <p className="t-footnote mb-2 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
          谁上车（{team.length} 人）
        </p>
        <SeatPicker
          players={players}
          selectedIds={team}
          onSelect={(id) =>
            setTeam((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
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
            teamPlayerIds: sortBySeat(game, team),
          });
          onDone();
        }}
      >
        保存修改
      </Button>
    </div>
  );
}

function IntendedTeamEditor({
  event,
  game,
  players,
  onDone,
}: {
  event: IntendedTeamEvent;
  game: GameRecord;
  players: Player[];
  onDone: () => void;
}) {
  const editEvent = useEdit();
  const [team, setTeam] = useState<string[]>([...event.teamPlayerIds]);
  const dirty =
    team.length !== event.teamPlayerIds.length ||
    team.some((id) => !event.teamPlayerIds.includes(id));

  return (
    <div className="flex flex-col gap-4">
      <p className="t-subhead text-[color:var(--label-secondary)]">
        <span className="font-semibold text-[color:var(--label)]">
          {seatLabel(game, event.playerId)}
        </span>{" "}
        说他会带谁上车（{team.length} 人）
      </p>
      <SeatPicker
        players={players}
        selectedIds={team}
        onSelect={(id) =>
          setTeam((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
          )
        }
      />
      <Button
        fullWidth
        disabled={!dirty || team.length === 0}
        onClick={() => {
          void editEvent(event.id, { teamPlayerIds: sortBySeat(game, team) });
          onDone();
        }}
      >
        保存修改
      </Button>
    </div>
  );
}

function RoleClaimEditor({
  event,
  game,
  onDone,
}: {
  event: RoleClaimEvent;
  game: GameRecord;
  onDone: () => void;
}) {
  const editEvent = useEdit();
  return (
    <div>
      <p className="t-subhead mb-3 text-[color:var(--label-secondary)]">
        <span className="font-semibold text-[color:var(--label)]">
          {seatLabel(game, event.playerId)}
        </span>{" "}
        这一下是跳派还是收回？
      </p>
      <SegmentedControl
        value={event.claimed ? "yes" : "no"}
        onChange={(next) => {
          const claimed = next === "yes";
          if (claimed === event.claimed) return;
          void editEvent(event.id, { claimed });
          onDone();
        }}
        options={[
          { value: "yes", label: "跳派" },
          { value: "no", label: "收回跳派" },
        ]}
      />
    </div>
  );
}
