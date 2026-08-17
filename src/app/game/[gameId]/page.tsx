"use client";

import { useState } from "react";
import Link from "next/link";
import { RoundTable, RATING_VAR } from "@/components/table/round-table";
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
import { Scratchpad } from "@/components/game/scratchpad";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { getAllRoleMarks, getClaimants, getCurrentOpinion } from "@/lib/selectors";
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
  | { kind: "proposal"; leaderId: string; team: string[] }
  | { kind: "vote"; proposalId: string; votes: Record<string, VoteChoice> }
  | { kind: "vision"; role: RoleType; vision: Vision; picked: string[] };

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

  if (!game || !timeline) return null;

  const claimants = new Set(getClaimants(events));
  const marks = getAllRoleMarks(events);
  const activeProposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  const missionNumber = Math.min(timeline.missionNumber, 5);
  const currentLeaderId = timeline.currentLeaderId;
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
          hint={
            warning.severity === "warn" && mode.team.length > 0
              ? `这轮通常 ${warning.expected} 人，仍可记录`
              : `第 ${missionNumber} 轮 · 第 ${timeline.proposalNumber} 车`
          }
          action={{ label: "换车主", onClick: () => setSheet("leader") }}
          onCancel={() => setMode({ kind: "idle" })}
          cancelLabel="取消"
        />
        <ConfirmRow
          selected={mode.team.length}
          expected={warning.expected}
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
            if (timeline.phase === "discussion") {
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
          <Link
            href="/games"
            aria-label="退出这局，回到对局列表"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--fill)] text-[color:var(--label-secondary)] active:opacity-70"
          >
            <span aria-hidden className="text-[18px] leading-none">‹</span>
          </Link>

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

          <Link
            href={`/game/${game.id}/settings`}
            aria-label="对局设置"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--fill)] text-[color:var(--label-secondary)] active:opacity-70"
          >
            <span aria-hidden>⋯</span>
          </Link>
        </div>

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

            <Scratchpad key={game.id} />
          </div>
        )}
      </main>

      {dock}

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
