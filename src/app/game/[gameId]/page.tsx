"use client";

import { useState } from "react";
import Link from "next/link";
import { RoundTable, RATING_VAR } from "@/components/table/round-table";
import {
  ModeBanner,
  PrimaryDock,
  RatingDock,
  TeamDock,
  VoteDock,
} from "@/components/game/mode-bar";
import { PlayerMenuSheet } from "@/components/game/player-menu-sheet";
import { MissionRecorder } from "@/components/game/mission-recorder";
import { TextNoteComposer } from "@/components/game/text-note-composer";
import { LeaderPickerSheet } from "@/components/game/leader-picker-sheet";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { getAllRoleMarks, getClaimants, getCurrentOpinion } from "@/lib/selectors";
import { getTeamSizeWarning, visionFor, type Vision } from "@/lib/rules/avalon";
import { markColor, markShort, seatLabel, seatList } from "@/lib/format/labels";
import type { Rating } from "@/lib/types/events";
import type { RoleType, VoteChoice } from "@/lib/types/game";
import type { SeatVisual } from "@/components/table/round-table";

/**
 * The table is the screen.
 *
 * Everything in a round happens on one circle that mirrors the real seating.
 * Modes change what a tap means; the banner always names the current mode,
 * because that is the one thing this design can genuinely confuse.
 */
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
  /**
   * The private layer starts hidden on every load and every navigation back
   * here. Someone glancing over your shoulder mid-game sees nothing, and this
   * state is deliberately not persisted so it can never be left on.
   */
  const [privateVisible, setPrivateVisible] = useState(false);

  if (!game || !timeline) return null;

  const claimants = new Set(getClaimants(events));
  const marks = getAllRoleMarks(events);
  const activeProposal = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  const missionNumber = Math.min(timeline.missionNumber, 5);
  const currentLeaderId = timeline.currentLeaderId;

  function seatVisual(playerId: string): SeatVisual {
    const markState = marks.get(playerId);
    const privateMark =
      privateVisible && markState
        ? {
            text: markShort(markState.mark),
            color: markColor(markState.mark),
            certain: markState.certainty === "known",
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
              ? { text: "车", color: "var(--yellow)", title: "这辆车的队长" }
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
              ? { text: "车", color: "var(--yellow)", title: "当前队长" }
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

  const center =
    mode.kind === "idle" ? (
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
        {mode.kind === "vision" && `还差 ${mode.vision.count - mode.picked.length} 个`}
      </p>
    );

  const teamWarning =
    mode.kind === "proposal"
      ? getTeamSizeWarning(game.playerCount, missionNumber, mode.team.length)
      : null;

  let dock: React.ReactNode = null;
  if (mode.kind === "opinionRate") {
    const cell = getCurrentOpinion(events, mode.speakerId, mode.targetId);
    dock = (
      <RatingDock
        targetLabel={seatLabel(game, mode.targetId)}
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
        onClear={
          cell
            ? () => {
                void deleteEvent(cell.eventId);
                setMode({ kind: "opinionTarget", speakerId: mode.speakerId });
              }
            : undefined
        }
      />
    );
  } else if (mode.kind === "intended") {
    dock = (
      <TeamDock
        selected={mode.team.length}
        expected={timeline.missions[missionNumber - 1].expectedTeamSize}
        confirmLabel="记下他想带的人"
        onConfirm={() => {
          void addEvent({
            type: "intended_team",
            playerId: mode.playerId,
            teamPlayerIds: sortBySeat(mode.team),
          });
          setMode({ kind: "idle" });
        }}
      />
    );
  } else if (mode.kind === "proposal") {
    dock = (
      <TeamDock
        selected={mode.team.length}
        expected={teamWarning?.expected ?? 0}
        warning={
          teamWarning?.severity === "warn" ? "人数不对，仍可记录" : undefined
        }
        confirmLabel="记下这辆车"
        onConfirm={() => {
          void addEvent({
            type: "proposal",
            leaderId: mode.leaderId,
            teamPlayerIds: sortBySeat(mode.team),
          });
          setMode({ kind: "idle" });
        }}
      />
    );
  } else if (mode.kind === "vision") {
    dock = (
      <TeamDock
        selected={mode.picked.length}
        expected={mode.vision.count}
        warning={mode.vision.hint}
        confirmLabel="记下我的视野"
        onConfirm={() => {
          // Marked as `known`, not a guess: this came from the reveal.
          for (const targetId of mode.picked) {
            void addEvent({
              type: "role_mark",
              targetId,
              mark: mode.vision.mark,
              certainty: "known",
            });
          }
          setPrivateVisible(true);
          setMode({ kind: "idle" });
        }}
      />
    );
  } else if (mode.kind === "vote") {
    const counts = { approve: 0, reject: 0, unknown: 0 };
    for (const choice of Object.values(mode.votes)) counts[choice] += 1;
    dock = (
      <VoteDock
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
    );
  } else {
    const primary = timeline.isComplete
      ? null
      : timeline.phase === "discussion"
        ? "点车"
        : timeline.phase === "voting"
          ? "记投票"
          : "记任务结果";
    dock = (
      <PrimaryDock
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
    );
  }

  let banner: React.ReactNode = null;
  if (mode.kind === "opinionTarget" || mode.kind === "opinionRate") {
    banner = (
      <ModeBanner
        title={`${seatLabel(game, mode.speakerId)} 说 →`}
        hint="点一个人，记他怎么看这个人"
        onCancel={() => setMode({ kind: "idle" })}
      />
    );
  } else if (mode.kind === "intended") {
    banner = (
      <ModeBanner
        title={`${seatLabel(game, mode.playerId)} 想带谁`}
        hint="他嘴上说的，不是真点的车"
        onCancel={() => setMode({ kind: "idle" })}
        cancelLabel="取消"
      />
    );
  } else if (mode.kind === "proposal") {
    banner = (
      <ModeBanner
        title={`${seatLabel(game, mode.leaderId)} 点车`}
        hint={`第 ${missionNumber} 轮 · 第 ${timeline.proposalNumber} 车`}
        action={{ label: "换队长", onClick: () => setSheet("leader") }}
        onCancel={() => setMode({ kind: "idle" })}
        cancelLabel="取消"
      />
    );
  } else if (mode.kind === "vote" && activeProposal) {
    banner = (
      <ModeBanner
        title="记票型"
        hint={`车上：${seatList(game, activeProposal.event.teamPlayerIds)}`}
        onCancel={() => setMode({ kind: "idle" })}
        cancelLabel="取消"
      />
    );
  } else if (mode.kind === "vision") {
    banner = (
      <ModeBanner
        title={mode.vision.prompt}
        hint="只有你看得到"
        onCancel={() => setMode({ kind: "idle" })}
        cancelLabel="取消"
      />
    );
  }

  return (
    <>
      {banner}

      <main className="mx-auto max-w-md px-4 pb-40 pt-3">
        {mode.kind === "idle" && (
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex gap-1">
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
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPrivateVisible((v) => !v)}
                aria-pressed={privateVisible}
                aria-label={privateVisible ? "隐藏视野" : "显示视野"}
                className={`t-caption flex h-9 items-center gap-1 rounded-full px-2.5 font-medium active:opacity-70 ${
                  privateVisible
                    ? "bg-[color:var(--blue)] text-white"
                    : "bg-[color:var(--fill)] text-[color:var(--label-secondary)]"
                }`}
              >
                <span aria-hidden>{privateVisible ? "◉" : "◌"}</span>
                视野
              </button>
              <Link
                href={`/game/${game.id}/settings`}
                aria-label="对局设置"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--fill)] text-[color:var(--label-secondary)] active:opacity-70"
              >
                <span aria-hidden>⋯</span>
              </Link>
            </div>
          </div>
        )}

        <RoundTable
          players={players}
          viewerPlayerId={game.viewerPlayerId}
          seatVisual={(player) => seatVisual(player.id)}
          onSelect={onSeat}
          center={center}
          label="牌桌"
        />

        {mode.kind === "idle" && (
          <div className="mt-4 text-center">
            {timeline.isComplete ? (
              <Link
                href={`/game/${game.id}/settings`}
                className="t-subhead text-[color:var(--blue)]"
              >
                这局打完了 · 去结束或导出
              </Link>
            ) : (
              <p className="t-footnote text-[color:var(--label-secondary)]">
                点谁，就记谁说的话
                {timeline.rejectionStreak > 0 && (
                  <span className="ml-2 text-[color:var(--orange)]">
                    已连挂 {timeline.rejectionStreak} 次
                  </span>
                )}
              </p>
            )}
          </div>
        )}
      </main>

      {dock}

      <PlayerMenuSheet
        playerId={menuPlayerId}
        privateVisible={privateVisible}
        onRevealPrivate={() => setPrivateVisible(true)}
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
