/**
 * The state a decision is made in.
 *
 * Deliberately a plain snapshot rather than a live view: it names every input
 * the decision engine is allowed to read, so nothing can quietly reach past it
 * into the event log or, worse, recompute a belief of its own.
 *
 * The belief here is the FROZEN Belief Engine V1 output. The decision engine
 * consumes it; it does not tune it, and it never re-derives it from the events
 * it also holds.
 */

import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import {
  deriveRoleInference,
  deriveSideInference,
  type RoleInference,
  type SideInference,
} from "@/lib/inference";
import { requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import { EVIL_ROLES, type GameRecord, type PlayerCount, type RoleType } from "@/lib/types/game";
import type { DerivedTimeline } from "@/lib/types/derived";

/** What the user can actually do right now. */
export type Action =
  | { kind: "vote"; choice: "approve" | "reject" }
  | { kind: "propose"; team: readonly string[] };

export interface DecisionState {
  game: GameRecord;
  events: readonly GameEvent[];
  timeline: DerivedTimeline;

  /** Frozen Belief Engine V1. Read-only input to every decision. */
  belief: { side: SideInference; roles: RoleInference };

  missionNumber: number;
  successes: number;
  fails: number;
  /** Which attempt this is within the mission, 1-based. */
  proposalNumber: number;
  /** Consecutive rejections; five hands the game to evil. */
  rejectionStreak: number;
  /** How many seats this mission takes, and how many fails sink it. */
  teamSize: number;
  requiredFails: 1 | 2;

  leaderId: string | null;
  /** The team on the table, when there is one awaiting a vote. */
  proposedTeam: readonly string[] | null;

  viewerId: string | null;
  viewerRole: RoleType | null;
  /**
   * Which side the user is playing for. Null when they have not said, in which
   * case there is no objective to maximise and no decision to recommend.
   */
  viewerSide: "good" | "evil" | null;
  /**
   * Seats the user KNOWS are evil, from their own role's sight. Empty for a
   * loyal, and empty for Oberon — the same information-set discipline the
   * belief layer runs on.
   */
  viewerKnownEvil: ReadonlySet<string>;

  legalActions: Action[];
}

function knownEvilFor(game: GameRecord, events: readonly GameEvent[]): Set<string> {
  const known = new Set<string>();
  const role = game.viewerRole;
  if (!role) return known;
  // Recorded sight, not inferred belief: only what the deal actually showed.
  for (const event of events) {
    if (event.type !== "role_mark") continue;
    if (event.certainty !== "known") continue;
    const mark = event.mark;
    if (!mark) continue;
    if (mark.kind === "side") {
      if (mark.side === "evil") known.add(event.targetId);
    } else if (mark.kind === "role" && EVIL_ROLES.includes(mark.role)) {
      known.add(event.targetId);
    }
  }
  return known;
}

/**
 * Every legal move, given whose turn it is and what is on the table.
 *
 * A vote is offered only while a proposal is awaiting one, and a proposal only
 * while the user holds the car. Anything else has no decision to make.
 */
function legalActionsFor(
  state: Omit<DecisionState, "legalActions">,
): Action[] {
  const { viewerId, proposedTeam, leaderId } = state;
  if (!viewerId) return [];
  if (proposedTeam) {
    return [
      { kind: "vote", choice: "approve" },
      { kind: "vote", choice: "reject" },
    ];
  }
  if (leaderId === viewerId) {
    // Team enumeration is left to the caller: C(10,5) is 252 and the engine
    // wants to score a shortlist, not every combination.
    return [];
  }
  return [];
}

export function buildDecisionState(
  events: readonly GameEvent[],
  game: GameRecord,
): DecisionState {
  const list = events as GameEvent[];
  const timeline = deriveTimeline(list, game);
  const active = timeline.activeProposalId
    ? timeline.proposalsById.get(timeline.activeProposalId)
    : null;
  const awaitingVote = active && !active.vote ? active : null;

  const missionNumber = Math.min(Math.max(timeline.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;
  const count = game.playerCount as PlayerCount;

  const viewerRole = game.viewerRole ?? null;
  const viewerSide: "good" | "evil" | null = viewerRole
    ? EVIL_ROLES.includes(viewerRole)
      ? "evil"
      : "good"
    : null;

  const partial: Omit<DecisionState, "legalActions"> = {
    game,
    events,
    timeline,
    belief: {
      side: deriveSideInference(list, game),
      roles: deriveRoleInference(list, game),
    },
    missionNumber,
    successes: timeline.successCount,
    fails: timeline.failCount,
    proposalNumber: timeline.proposalNumber,
    rejectionStreak: timeline.rejectionStreak,
    teamSize: teamSize(count, missionNumber),
    requiredFails: requiredFails(count, missionNumber),
    leaderId: timeline.currentLeaderId,
    proposedTeam: awaitingVote?.event.teamPlayerIds ?? null,
    viewerId: game.viewerPlayerId ?? null,
    viewerRole,
    viewerSide,
    viewerKnownEvil: knownEvilFor(game, events),
  };

  return { ...partial, legalActions: legalActionsFor(partial) };
}
