"use client";

import { useState } from "react";
import Link from "next/link";
import { RoundTable, RATING_VAR } from "@/components/table/round-table";
import { RoundButton } from "@/components/ui/page-header";
import {
  ConfirmRow,
  Dock,
  DockHeader,
  PrimaryRow,
  RatingRow,
  VoteRow,
} from "@/components/game/mode-bar";
import { PlayerMenuSheet } from "@/components/game/player-menu-sheet";
import { MissionRecorder } from "@/components/game/mission-recorder";
import { TextNoteComposer } from "@/components/game/text-note-composer";
import { LeaderPickerSheet } from "@/components/game/leader-picker-sheet";
import { RoleSetupSheet } from "@/components/game/role-setup-sheet";
import { Scratchpad } from "@/components/game/scratchpad";
import { AiSheet } from "@/components/game/ai-sheet";
import { hasEnoughToAnalyze } from "@/lib/ai/client";
import type { AiTask } from "@/lib/ai/types";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import {
  deriveLady,
  getAllRoleMarks,
  getClaimants,
  getCurrentOpinion,
} from "@/lib/selectors";
import { getTeamSizeWarning, visionFor, type Vision } from "@/lib/rules/avalon";
import { markColor, markShort, seatLabel, seatList } from "@/lib/format/labels";
import type { Rating } from "@/lib/types/events";
import type { RoleType, VoteChoice } from "@/lib/types/game";
import type { SeatVisual } from "@/components/table/round-table";

type Mode =
  | { kind: "idle" }
  | { kind: "opinionTarget"; speakerId: string }
  | { kind: "opinionRate"; speakerId: string; targetId: string }
  | { kind: "intended"; playerId: string; team: string[] }
  | {
      kind: "proposal";
      leaderId: string;
      team: string[];
      /** Set only by an explicit tap, for tables running a house rule. */
      allowMismatch?: boolean;
    }
  | { kind: "vote"; proposalId: string; votes: Record<string, VoteChoice> }
  | { kind: "vision"; role: RoleType; vision: Vision; picked: string[] }
  | { kind: "ladyAssign" }
  | { kind: "ladyCheck"; targetId: string | null }
  /** Only reachable when the user held the token: what they actually saw. */
  | { kind: "ladyReveal"; targetId: string };

const VOTE_CYCLE: (VoteChoice | null)[] = ["approve", "reject", "unknown", null];

const VOTE_BADGE: Record<VoteChoice, { text: string; color: string }> = {
  approve: { text: "✓", color: "var(--green)" },
  reject: { text: "✕", color: "var(--red)" },
  unknown: { text: "?", color: "var(--gray)" },
};

export default function GamePage() {
  const game = useGame();
  const events = useEvents();
  const players = usePlayers();
  const timeline = useTimeline();
  const addEvent = useGameStore((s) => s.addEvent);
  const deleteEvent = useGameStore((s) => s.deleteEvent);

  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  /**
   * Bumped when the AI writes a speech outline into the scratchpad. The
   * scratchpad seeds its text once on mount and never syncs back from the
   * store — that is what keeps typing from racing the debounced write — so a
   * write from outside has to remount it to become visible.
   */
  const [scratchpadVersion, setScratchpadVersion] = useState(0);
  const [menuPlayerId, setMenuPlayerId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"mission" | "note" | "leader" | null>(null);
  const [notePlayerId, setNotePlayerId] = useState<string | null>(null);
  /*
   * Vision and guesses are separate layers because they are separate kinds of
   * information: one is what the game told you, the other is what you decided.
   * Both start hidden on every load and every navigation back here, and
   * neither is persisted, so they cannot be left switched on for someone to
   * read over your shoulder.
   */
  const [visionVisible, setVisionVisible] = useState(false);
  const [guessVisible, setGuessVisible] = useState(false);
  /** Set only when the user actively defers the role prompt. */
  const [roleDeferred, setRoleDeferred] = useState(false);
  /**
   * Opening it by hand is a separate switch from the automatic prompt. They
   * used to share one, so once anything had been recorded — assigning the
   * 女神 alone was enough — the banner's own tap could not reopen it.
   */
  const [rolePromptForced, setRolePromptForced] = useState(false);

  if (!game || !timeline) return null;

  /*
   * Ask for the role the moment a fresh game opens. Unanswered, it costs the
   * vision, the win rate, and the one label that makes the finished record
   * worth keeping — so it is asked before anything else, not left to be
   * discovered in a menu.
   *
   * Once anything has been recorded the prompt stops appearing on its own and
   * the banner takes over, so it can never stand between the user and a game
   * already in progress.
   */
  const roleMissing = !game.viewerRole;
  const askRoleNow =
    roleMissing && ((events.length === 0 && !roleDeferred) || rolePromptForced);

  const claimants = new Set(getClaimants(events));
  const marks = getAllRoleMarks(events);
  const activeProposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  const missionNumber = Math.min(timeline.missionNumber, 5);
  const currentLeaderId = timeline.currentLeaderId;
  const lady = deriveLady(events, game);
  const ladyIsMine = lady.holderId === game.viewerPlayerId;
  const assassinationDue =
    timeline.successCount >= 3 && game.status !== "completed";

  function seatVisual(playerId: string): SeatVisual {
    const state = marks.get(playerId);
    const layerShown =
      state && (state.certainty === "known" ? visionVisible : guessVisible);
    const privateMark =
      state && layerShown
        ? {
            text: markShort(state.mark),
            color: markColor(state.mark),
            certain: state.certainty === "known",
          }
        : null;

    switch (mode.kind) {
      case "opinionTarget":
      case "opinionRate": {
        if (playerId === mode.speakerId) {
          return { ring: "speaker", disabled: mode.kind === "opinionRate" };
        }
        const cell = getCurrentOpinion(events, mode.speakerId, playerId);
        return {
          selected: mode.kind === "opinionRate" && playerId === mode.targetId,
          mark: privateMark,
          badge: cell
            ? {
                text: String(cell.rating),
                color: RATING_VAR[cell.rating],
                title: `已记 ${cell.rating}`,
              }
            : null,
        };
      }
      case "intended":
        return {
          selected: mode.team.includes(playerId),
          ring: playerId === mode.playerId ? "speaker" : null,
          mark: privateMark,
        };
      case "proposal":
        return {
          selected: mode.team.includes(playerId),
          mark: privateMark,
          badgeLeft:
            playerId === mode.leaderId
              ? { text: "车", color: "var(--yellow)", title: "这辆车的车主" }
              : null,
        };
      case "vote": {
        const choice = mode.votes[playerId];
        return {
          selected: activeProposal?.event.teamPlayerIds.includes(playerId),
          mark: privateMark,
          badge: choice ? VOTE_BADGE[choice] : null,
        };
      }
      case "vision":
        return {
          selected: mode.picked.includes(playerId),
          disabled: playerId === game!.viewerPlayerId,
          dimmed: playerId === game!.viewerPlayerId,
        };
      case "ladyAssign":
        return { selected: playerId === lady.holderId };
      case "ladyCheck":
      case "ladyReveal": {
        // Anyone who has already held the token is out of reach — that is the
        // rule that makes the token walk across the table instead of ping-pong.
        const reachable = lady.examinable.includes(playerId);
        return {
          selected: playerId === (mode.kind === "ladyCheck" ? mode.targetId : mode.targetId),
          disabled: !reachable,
          dimmed: !reachable,
          badgeBottom:
            playerId === lady.holderId
              ? { text: "女", color: "var(--blue)", title: "拿着湖中女神" }
              : null,
        };
      }
      default:
        return {
          selected: activeProposal?.event.teamPlayerIds.includes(playerId),
          mark: privateMark,
          badgeLeft:
            currentLeaderId === playerId
              ? { text: "车", color: "var(--yellow)", title: "当前车主" }
              : null,
          badge: claimants.has(playerId)
            ? { text: "派", color: "var(--blue)", title: "跳了派" }
            : null,
          badgeBottom:
            lady.holderId === playerId
              ? { text: "女", color: "var(--blue)", title: "拿着湖中女神" }
              : null,
        };
    }
  }

  function onSeat(playerId: string) {
    switch (mode.kind) {
      case "idle":
        setMenuPlayerId(playerId);
        break;
      case "opinionTarget":
        if (playerId === mode.speakerId) return;
        setMode({ ...mode, kind: "opinionRate", targetId: playerId });
        break;
      case "opinionRate":
        if (playerId === mode.speakerId) return;
        setMode({
          kind: "opinionRate",
          speakerId: mode.speakerId,
          targetId: playerId,
        });
        break;
      case "intended":
      case "proposal": {
        const team = mode.team.includes(playerId)
          ? mode.team.filter((id) => id !== playerId)
          : [...mode.team, playerId];
        setMode({ ...mode, team });
        break;
      }
      case "vision": {
        if (playerId === game!.viewerPlayerId) return;
        const picked = mode.picked.includes(playerId)
          ? mode.picked.filter((id) => id !== playerId)
          : [...mode.picked, playerId];
        setMode({ ...mode, picked });
        break;
      }
      case "ladyAssign":
        void addEvent({ type: "lady_assign", holderId: playerId });
        setMode({ kind: "idle" });
        break;
      case "ladyCheck":
        if (!lady.examinable.includes(playerId)) return;
        setMode({ kind: "ladyCheck", targetId: playerId });
        break;
      case "ladyReveal":
        break;
      case "vote": {
        const current = mode.votes[playerId] ?? null;
        const next =
          VOTE_CYCLE[(VOTE_CYCLE.indexOf(current) + 1) % VOTE_CYCLE.length];
        const votes = { ...mode.votes };
        if (next === null) delete votes[playerId];
        else votes[playerId] = next;
        setMode({ ...mode, votes });
        break;
      }
    }
  }

  function sortBySeat(ids: string[]): string[] {
    return [...ids].sort(
      (a, b) =>
        (game!.players.find((p) => p.id === a)?.seat ?? 0) -
        (game!.players.find((p) => p.id === b)?.seat ?? 0),
    );
  }

  const idle = mode.kind === "idle";

  const center = idle ? (
    <div className="pointer-events-none">
      <p className="t-caption text-[color:var(--label-secondary)]">
        第 {missionNumber} 轮 · 第 {timeline.proposalNumber} 车
      </p>
      <p className="mt-1 text-[26px] font-bold leading-none tabular-nums">
        <span className="text-[color:var(--good)]">{timeline.successCount}</span>
        <span className="mx-1 text-[color:var(--label-tertiary)]">–</span>
        <span className="text-[color:var(--evil)]">{timeline.failCount}</span>
      </p>
      <p className="t-caption mt-1 text-[color:var(--label-tertiary)]">
        好人 — 坏人
      </p>
    </div>
  ) : (
    <p className="t-footnote pointer-events-none text-[color:var(--label-secondary)]">
      {mode.kind === "opinionTarget" && "点一个人"}
      {mode.kind === "opinionRate" && "换个人或打分"}
      {(mode.kind === "intended" || mode.kind === "proposal") && "点座位选人"}
      {mode.kind === "vote" && "点座位切换票型"}
      {mode.kind === "vision" &&
        `还差 ${Math.max(0, mode.vision.count - mode.picked.length)} 个`}
    </p>
  );

  /* ── The dock. Always reflects the mode, so the idle actions can never be
        mis-tapped while a recording flow is open. ─────────────────────── */

  let dock: React.ReactNode;
  if (mode.kind === "opinionTarget") {
    dock = (
      <Dock>
        <DockHeader
          title={`${seatLabel(game, mode.speakerId)} 说 →`}
          hint="点一个人，记他怎么看这个人"
          onCancel={() => setMode({ kind: "idle" })}
        />
      </Dock>
    );
  } else if (mode.kind === "opinionRate") {
    const cell = getCurrentOpinion(events, mode.speakerId, mode.targetId);
    dock = (
      <Dock>
        <DockHeader
          title={`${seatLabel(game, mode.speakerId)} 说 ${seatLabel(game, mode.targetId)}`}
          hint="点分数存下，然后回到选人"
          action={
            cell
              ? {
                  label: "清除",
                  onClick: () => {
                    void deleteEvent(cell.eventId);
                    setMode({ kind: "opinionTarget", speakerId: mode.speakerId });
                  },
                }
              : undefined
          }
          onCancel={() => setMode({ kind: "idle" })}
        />
        <RatingRow
          current={cell?.rating ?? null}
          onPick={(rating: Rating) => {
            if (cell?.rating !== rating) {
              void addEvent({
                type: "opinion",
                speakerId: mode.speakerId,
                targetId: mode.targetId,
                rating,
              });
            }
            setMode({ kind: "opinionTarget", speakerId: mode.speakerId });
          }}
        />
      </Dock>
    );
  } else if (mode.kind === "intended") {
    dock = (
      <Dock>
        <DockHeader
          title={`${seatLabel(game, mode.playerId)} 想带谁`}
          hint="他嘴上说的，不是真发的车"
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
        <ConfirmRow
          selected={mode.team.length}
          expected={timeline.missions[missionNumber - 1].expectedTeamSize}
          label="记下他想带的人"
          onConfirm={() => {
            void addEvent({
              type: "intended_team",
              playerId: mode.playerId,
              teamPlayerIds: sortBySeat(mode.team),
            });
            setMode({ kind: "idle" });
          }}
        />
      </Dock>
    );
  } else if (mode.kind === "proposal") {
    const warning = getTeamSizeWarning(
      game.playerCount,
      missionNumber,
      mode.team.length,
    );
    dock = (
      <Dock>
        <DockHeader
          title={`${seatLabel(game, mode.leaderId)} 发车`}
          hint={`第 ${missionNumber} 轮 · 第 ${timeline.proposalNumber} 车 · 要 ${warning.expected} 个人`}
          action={{ label: "换车主", onClick: () => setSheet("leader") }}
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
        <ConfirmRow
          selected={mode.team.length}
          expected={warning.expected}
          mismatch={
            warning.severity === "warn" && !mode.allowMismatch
              ? mode.team.length < warning.expected
                ? `还差 ${warning.expected - mode.team.length} 个人`
                : `多了 ${mode.team.length - warning.expected} 个人`
              : undefined
          }
          onOverride={() => setMode({ ...mode, allowMismatch: true })}
          label="记下最终车型"
          onConfirm={() => {
            void addEvent({
              type: "proposal",
              leaderId: mode.leaderId,
              teamPlayerIds: sortBySeat(mode.team),
            });
            setMode({ kind: "idle" });
          }}
        />
      </Dock>
    );
  } else if (mode.kind === "vision") {
    dock = (
      <Dock>
        <DockHeader
          title={mode.vision.prompt}
          hint={mode.vision.hint ?? "只有你看得到"}
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
        <ConfirmRow
          selected={mode.picked.length}
          expected={mode.vision.count}
          mismatch={
            mode.picked.length !== mode.vision.count
              ? `这个身份应该看到 ${mode.vision.count} 个人`
              : undefined
          }
          label="记下我的视野"
          onConfirm={() => {
            // `known`, not a guess: this came from the reveal.
            for (const targetId of mode.picked) {
              void addEvent({
                type: "role_mark",
                targetId,
                mark: mode.vision.mark,
                certainty: "known",
              });
            }
            setVisionVisible(true);
            setMode({ kind: "idle" });
          }}
        />
      </Dock>
    );
  } else if (mode.kind === "ladyAssign") {
    dock = (
      <Dock>
        <DockHeader
          title="谁拿湖中女神"
          hint="第一个车主指定，点一下那个人"
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
      </Dock>
    );
  } else if (mode.kind === "ladyCheck") {
    dock = (
      <Dock>
        <DockHeader
          title={
            mode.targetId
              ? `${seatLabel(game, lady.holderId!)} 验了 ${seatLabel(game, mode.targetId)}`
              : `${seatLabel(game, lady.holderId!)} 要验谁`
          }
          hint={
            mode.targetId
              ? "他当众说了什么？说的不一定是真的"
              : "拿过女神的人不能再验"
          }
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
        {mode.targetId && (
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { value: "good", label: "说好人", color: "var(--green)" },
                { value: "evil", label: "说坏人", color: "var(--red)" },
                { value: "unknown", label: "没说", color: "var(--gray)" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  const targetId = mode.targetId!;
                  // Captured before the event lands: recording the check hands
                  // the token on, so afterwards the user is no longer holder.
                  const wasMine = ladyIsMine;
                  void addEvent({
                    type: "lady_check",
                    holderId: lady.holderId!,
                    targetId,
                    announced: option.value,
                  });
                  // Only the holder saw the real card. The announcement above
                  // is public and may be a lie; this is the truth, and it goes
                  // in the private layer.
                  setMode(
                    wasMine
                      ? { kind: "ladyReveal", targetId }
                      : { kind: "idle" },
                  );
                }}
                className="t-body min-h-[48px] rounded-[12px] font-semibold text-white active:opacity-80"
                style={{ backgroundColor: option.color }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </Dock>
    );
  } else if (mode.kind === "ladyReveal") {
    dock = (
      <Dock>
        <DockHeader
          title={`你验 ${seatLabel(game, mode.targetId)}，看到的是`}
          hint="只有你知道，存进私有层"
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="跳过"
        />
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { side: "good", label: "好人", color: "var(--green)" },
              { side: "evil", label: "坏人", color: "var(--red)" },
            ] as const
          ).map((option) => (
            <button
              key={option.side}
              onClick={() => {
                void addEvent({
                  type: "role_mark",
                  targetId: mode.targetId,
                  mark: { kind: "side", side: option.side },
                  certainty: "known",
                });
                setVisionVisible(true);
                setMode({ kind: "idle" });
              }}
              className="t-body min-h-[48px] rounded-[12px] font-semibold text-white active:opacity-80"
              style={{ backgroundColor: option.color }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Dock>
    );
  } else if (mode.kind === "vote") {
    const counts = { approve: 0, reject: 0, unknown: 0 };
    for (const choice of Object.values(mode.votes)) counts[choice] += 1;
    dock = (
      <Dock>
        <DockHeader
          title="记票型"
          hint={
            activeProposal
              ? `车上：${seatList(game, activeProposal.event.teamPlayerIds)}`
              : undefined
          }
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
        <VoteRow
          approve={counts.approve}
          reject={counts.reject}
          unknown={counts.unknown}
          unrecorded={players.length - Object.keys(mode.votes).length}
          onSetAll={(choice) => {
            const votes: Record<string, VoteChoice> = {};
            for (const player of players) votes[player.id] = choice;
            setMode({ ...mode, votes });
          }}
          onResult={(finalResult) => {
            void addEvent({
              type: "vote",
              proposalId: mode.proposalId,
              votes: mode.votes,
              finalResult,
            });
            setMode({ kind: "idle" });
          }}
        />
      </Dock>
    );
  } else {
    const primary = timeline.isComplete
      ? null
      : lady.due
        ? "记女神验人"
        : timeline.phase === "discussion"
          ? "最终车型"
          : timeline.phase === "voting"
            ? "记投票"
            : "记任务结果";
    dock = (
      <Dock>
        <PrimaryRow
          primaryLabel={primary}
          onPrimary={() => {
            // The token is used before the next 车主 proposes, so while a check
            // is owed it jumps ahead of the phase's own action — and the label
            // above branches on the same condition, so the two cannot drift.
            if (lady.due) {
              setMode({ kind: "ladyCheck", targetId: null });
            } else if (timeline.phase === "discussion") {
              setMode({
                kind: "proposal",
                leaderId: currentLeaderId ?? players[0].id,
                team: [],
              });
            } else if (timeline.phase === "voting" && activeProposal) {
              setMode({
                kind: "vote",
                proposalId: activeProposal.event.id,
                votes: {},
              });
            } else {
              setSheet("mission");
            }
          }}
          onNote={() => {
            setNotePlayerId(null);
            setSheet("note");
          }}
        />
      </Dock>
    );
  }

  return (
    <>
      <main className="mx-auto max-w-md px-4 pb-48 pt-3">
        {/* The header stays put in every mode — the round and the score are
            exactly what you want visible mid-flow. The private toggles sit
            below the table instead, next to the other private controls. */}
        <div className="mb-3 flex items-center gap-2">
          <RoundButton
            glyph="‹"
            label="退出这局，回到对局列表"
            href="/games"
          />

          <div className="flex flex-1 justify-center gap-1">
            {timeline.missions.map((mission) => (
              <span
                key={mission.missionNumber}
                title={`第 ${mission.missionNumber} 轮 · ${mission.expectedTeamSize} 人${mission.requiredFails === 2 ? " · 要 2 张坏票" : ""}`}
                className={`flex h-6 w-7 items-center justify-center rounded-md text-[12px] font-semibold ${
                  mission.result === "success"
                    ? "bg-[color:var(--good)] text-white"
                    : mission.result === "fail"
                      ? "bg-[color:var(--evil)] text-white"
                      : mission.status === "in_progress"
                        ? "bg-[color:var(--fill-2)] text-[color:var(--blue)]"
                        : "bg-[color:var(--fill)] text-[color:var(--label-tertiary)]"
                }`}
              >
                {mission.result
                  ? mission.result === "success"
                    ? "✓"
                    : "✕"
                  : mission.expectedTeamSize}
              </span>
            ))}
          </div>

          <RoundButton
            glyph="⋯"
            label="对局设置"
            href={`/game/${game.id}/settings`}
          />
        </div>

        {roleMissing && !askRoleNow && idle && (
          <button
            onClick={() => setRolePromptForced(true)}
            className="mb-3 flex w-full items-center justify-between rounded-[12px] bg-[color:var(--fill)] px-3.5 py-2.5 text-left active:opacity-70"
          >
            <span className="t-footnote text-[color:var(--label-secondary)]">
              还没填自己的身份 —— 填了才有视野和胜率
            </span>
            <span className="t-footnote font-semibold text-[color:var(--blue)]">
              去填
            </span>
          </button>
        )}

        {lady.enabled && lady.holderId === null && idle && (
          <button
            onClick={() => setMode({ kind: "ladyAssign" })}
            className="mb-3 flex w-full items-center justify-between rounded-[12px] bg-[color:var(--fill)] px-3.5 py-2.5 text-left active:opacity-70"
          >
            <span className="t-footnote text-[color:var(--label-secondary)]">
              还没指定湖中女神 —— 第一个车主发车前定下来
            </span>
            <span className="t-footnote font-semibold text-[color:var(--blue)]">
              去指定
            </span>
          </button>
        )}

        {assassinationDue && idle && (
          <Link
            href={`/game/${game.id}/endgame`}
            className="mb-3 block rounded-[12px] bg-[color:var(--red)] px-4 py-3 text-center text-white active:opacity-85"
          >
            <p className="t-headline">好人拿下 3 轮 · 进入刺杀环节</p>
            <p className="t-caption mt-0.5 text-white/80">点这里开始</p>
          </Link>
        )}

        <RoundTable
          players={players}
          viewerPlayerId={game.viewerPlayerId}
          seatDirection={game.seatDirection ?? "cw"}
          leaderDirection={idle ? (game.leaderDirection ?? "cw") : undefined}
          seatVisual={(player) => seatVisual(player.id)}
          onSelect={onSeat}
          center={center}
          label="牌桌"
        />

        {idle && (
          <div className="mt-4 flex flex-col gap-3">
            <p className="t-footnote text-center text-[color:var(--label-secondary)]">
              点谁，就记谁说的话
              {timeline.rejectionStreak > 0 && (
                <span className="ml-2 text-[color:var(--orange)]">
                  已连挂 {timeline.rejectionStreak} 次
                </span>
              )}
            </p>

            {/* All the private controls in one place, right under the table
                they affect. Each hides independently. */}
            <div className="flex items-center justify-center gap-1.5">
              <LayerToggle
                label="视野"
                on={visionVisible}
                onClick={() => setVisionVisible((v) => !v)}
              />
              <LayerToggle
                label="推测"
                on={guessVisible}
                onClick={() => setGuessVisible((v) => !v)}
              />
            </div>

            {/* The only two things here that leave the device. They sit with
                the private controls because that is what they read from, and
                what they produce is for your eyes only too. */}
            <div className="grid grid-cols-2 gap-2">
              <AiButton
                label="分析局势"
                hint={
                  hasEnoughToAnalyze(events)
                    ? "谁好谁坏，帮你捋一遍"
                    : "再记两笔才有得分析"
                }
                disabled={!hasEnoughToAnalyze(events)}
                onClick={() => setAiTask("analysis")}
              />
              <AiButton
                label="帮我发言"
                hint={
                  hasEnoughToAnalyze(events)
                    ? "一分钟发言的大纲"
                    : "再记两笔才有得说"
                }
                disabled={!hasEnoughToAnalyze(events)}
                onClick={() => setAiTask("speech")}
              />
            </div>

            <Scratchpad key={`${game.id}:${scratchpadVersion}`} />
          </div>
        )}
      </main>

      {dock}

      <RoleSetupSheet
        open={askRoleNow}
        onDefer={() => {
          setRoleDeferred(true);
          setRolePromptForced(false);
        }}
        onPicked={(role) => {
          const vision = visionFor(role, game.playerCount, game.roleSet);
          setRoleDeferred(true); // answered — don't re-open behind the vision step
          setRolePromptForced(false);
          if (vision) setMode({ kind: "vision", role, vision, picked: [] });
        }}
      />

      <PlayerMenuSheet
        playerId={menuPlayerId}
        visionVisible={visionVisible}
        guessVisible={guessVisible}
        onRevealVision={() => setVisionVisible(true)}
        onRevealGuess={() => setGuessVisible(true)}
        onClose={() => setMenuPlayerId(null)}
        onPickOpinion={() => {
          const speakerId = menuPlayerId!;
          setMenuPlayerId(null);
          setMode({ kind: "opinionTarget", speakerId });
        }}
        onPickIntendedTeam={() => {
          const playerId = menuPlayerId!;
          setMenuPlayerId(null);
          setMode({ kind: "intended", playerId, team: [] });
        }}
        onOpenNote={() => {
          setNotePlayerId(menuPlayerId);
          setMenuPlayerId(null);
          setSheet("note");
        }}
        onStartVision={(role) => {
          const vision = visionFor(role, game.playerCount, game.roleSet);
          setMenuPlayerId(null);
          if (vision) setMode({ kind: "vision", role, vision, picked: [] });
        }}
      />

      <LeaderPickerSheet
        open={sheet === "leader"}
        currentId={mode.kind === "proposal" ? mode.leaderId : null}
        onClose={() => setSheet(null)}
        onPick={(leaderId) => {
          if (mode.kind === "proposal") setMode({ ...mode, leaderId });
          setSheet(null);
        }}
      />

      <MissionRecorder open={sheet === "mission"} onClose={() => setSheet(null)} />

      {/* Keyed on the task so switching between the two features starts a
          fresh run rather than showing the previous one's result. */}
      <AiSheet
        key={aiTask ?? "none"}
        task={aiTask}
        onClose={() => setAiTask(null)}
        onScratchpadWritten={() => setScratchpadVersion((v) => v + 1)}
      />

      <TextNoteComposer
        open={sheet === "note"}
        defaultPlayerId={notePlayerId}
        onClose={() => {
          setSheet(null);
          setNotePlayerId(null);
        }}
      />
    </>
  );
}

/** One of the two AI entry points. Sized to be tapped without looking. */
function AiButton({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[52px] flex-col items-center justify-center rounded-[12px] bg-[color:var(--fill)] px-2 py-1.5 active:opacity-70 disabled:opacity-40"
    >
      <span className="t-subhead font-semibold text-[color:var(--blue)]">
        {label}
      </span>
      <span className="t-caption mt-0.5 text-[color:var(--label-tertiary)]">
        {hint}
      </span>
    </button>
  );
}

function LayerToggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label={on ? `隐藏${label}` : `显示${label}`}
      className={`t-caption flex h-8 items-center gap-0.5 rounded-full px-2 font-medium active:opacity-70 ${
        on
          ? "bg-[color:var(--blue)] text-white"
          : "bg-[color:var(--fill)] text-[color:var(--label-secondary)]"
      }`}
    >
      <span aria-hidden>{on ? "◉" : "◌"}</span>
      {label}
    </button>
  );
}
