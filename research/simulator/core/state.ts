/**
 * The authoritative game state. The referee owns it; nothing else may.
 *
 * It holds the full deal, every hidden mission card and every vote that has
 * not yet been revealed — that is what makes it authoritative, and it is
 * exactly why no agent-facing function accepts or returns it. There is one
 * door out, `observationFor(state, seat)` in `observation.ts`, and the leakage
 * suite exists to prove nothing else opened another.
 *
 * IMMUTABLE BY REPLACEMENT. Every array and nested object reachable from here
 * is frozen, and grows by building a new frozen value rather than by mutation.
 * Two things fall out of that and both are load-bearing:
 *
 *   an observation can hand out the public log BY REFERENCE with no copy, and
 *   a retained observation can never gain a future event, because the array it
 *   points at is never touched again;
 *
 *   an agent that casts away `readonly` and pushes gets a TypeError instead of
 *   a silently altered game.
 *
 * The two exceptions are `pendingVotes` and `missionCards`, which stay plain
 * mutable records. They are the only fields no observation has any path to, so
 * there is nothing to protect them from, and they are rewritten constantly.
 *
 * Appending to the log is therefore O(n). For a game of roughly a hundred and
 * fifty events that is nothing, and it is the price of the guarantee above.
 */

import type { RoleType } from "@/lib/types/game";
import type { Deal } from "./deal";
import type { GameId } from "./game-id";
import type { GameEndReason, PrivateEvent, PublicEvent } from "./events";
import { deepFreeze, EMPTY } from "./freeze";
import type { SpeechTurn } from "./order";
import { emptyMemory, SEATS } from "./types";
import type {
  DecisionRequest,
  LadyResult,
  PlayDirection,
  PrivateMemory,
  RoleClaim,
  Seat,
  Side,
} from "./types";
import type { SimConfig } from "../config/load";

/**
 * Note the absence of a `"proposal"` phase.
 *
 * The leader's closing speech and the authoritative car are ONE agent
 * decision — see `LeaderCloseAndProposeAction` — so the discussion phase ends
 * by going straight to the vote. A phase nothing can ever be in is a state
 * somebody will eventually write a branch for.
 */
export type Phase =
  | "setup"
  | "reveal"
  | "opening_direction"
  | "discussion"
  | "vote"
  | "mission"
  | "lady_select"
  | "lady_announce"
  | "assassination_reveal"
  | "assassination_discuss"
  | "assassination_strike"
  | "terminal";

export type MissionSlot = "success" | "fail" | "pending";

export interface TentativeTeam {
  readonly seat: Seat;
  readonly team: readonly Seat[] | null;
  readonly noTeamYet: boolean;
}

export interface Outcome {
  readonly winner: Side;
  readonly reason: GameEndReason;
  readonly assassinTarget: Seat | null;
}

export interface GameState {
  readonly runId: string;
  /**
   * The public identity of this game. Opaque, supplied, and carrying NO
   * seed-derived material — see `core/game-id.ts` for why deriving it from the
   * seed was a leak rather than a label.
   */
  readonly gameId: GameId;
  readonly seed: number;
  readonly config: SimConfig;
  /** THE SECRET. Present here and nowhere an agent can reach. */
  readonly deal: Deal;
  readonly initialLeader: Seat;

  phase: Phase;
  sequence: number;
  /** What the referee is waiting for. Exactly one seat, or null at terminal. */
  pending: DecisionRequest | null;

  /** Fixed at the opening and never changed again. */
  playDirection: PlayDirection | null;

  missionNumber: number;
  /** Proposal attempt within this mission, 1-based, capped by the rejection track. */
  attempt: number;
  rejectionStreak: number;
  successes: number;
  fails: number;
  missionTrack: readonly MissionSlot[];

  leader: Seat;
  speakingOrder: readonly SpeechTurn[];
  /** How many of `speakingOrder` have been delivered this attempt. */
  speechIndex: number;
  /** 意向车 floated during this attempt only. Cleared when the attempt ends. */
  tentativeTeams: readonly TentativeTeam[];
  /** The authoritative team, once the leader has submitted it. */
  proposedTeam: readonly Seat[] | null;

  /** HIDDEN until all ten are in. No observation has a path to this. */
  pendingVotes: Partial<Record<Seat, "approve" | "reject">>;
  /** HIDDEN forever. Only the aggregate fail count is ever published. */
  missionCards: Partial<Record<Seat, "success" | "fail">>;

  ladyHolder: Seat | null;
  /** Everyone who has ever held the token. None of them may be examined again. */
  ladyHeldBy: readonly Seat[];
  ladyChecks: number;
  /** The pending check, between `lady_select` and `lady_announce`. */
  ladyPending: { readonly target: Seat; readonly trueSide: Side } | null;
  /** Permanent hard knowledge, per holder. Never written by an agent action. */
  ladyResults: Record<Seat, readonly LadyResult[]>;

  /** Set once the evil team has been shown each other's exact roles. */
  evilRolesRevealed: boolean;
  /** Which evil seats have spoken in the closing discussion, in seat order. */
  evilDiscussIndex: number;

  standingClaims: readonly RoleClaim[];
  memory: Record<Seat, PrivateMemory>;

  log: readonly PublicEvent[];
  privateLog: readonly PrivateEvent[];

  outcome: Outcome | null;
}

function emptyRecord<T>(make: () => T): Record<Seat, T> {
  const out = {} as Record<Seat, T>;
  for (const seat of SEATS) out[seat] = make();
  return out;
}

export interface CreateStateInput {
  readonly runId: string;
  readonly gameId: GameId;
  readonly seed: number;
  readonly config: SimConfig;
  readonly deal: Deal;
  readonly initialLeader: Seat;
}

/**
 * A game at the moment before anything has happened.
 *
 * `phase` is "setup" and `pending` is null; `advance()` in `referee.ts` is what
 * emits `game_start` and asks the opening leader for a direction. Splitting
 * construction from the first transition keeps the state a plain value that a
 * test can build and inspect without the machine running.
 */
export function createState(input: CreateStateInput): GameState {
  return {
    runId: input.runId,
    gameId: input.gameId,
    seed: input.seed,
    config: input.config,
    deal: deepFreeze(input.deal),
    initialLeader: input.initialLeader,

    phase: "setup",
    sequence: 0,
    pending: null,

    playDirection: null,

    missionNumber: 1,
    attempt: 1,
    rejectionStreak: 0,
    successes: 0,
    fails: 0,
    missionTrack: deepFreeze<readonly MissionSlot[]>([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]),

    leader: input.initialLeader,
    speakingOrder: EMPTY,
    speechIndex: 0,
    tentativeTeams: EMPTY,
    proposedTeam: null,

    pendingVotes: {},
    missionCards: {},

    ladyHolder: null,
    ladyHeldBy: EMPTY,
    ladyChecks: 0,
    ladyPending: null,
    ladyResults: emptyRecord<readonly LadyResult[]>(() => EMPTY),

    evilRolesRevealed: false,
    evilDiscussIndex: 0,

    standingClaims: EMPTY,
    memory: emptyRecord<PrivateMemory>(emptyMemory),

    log: EMPTY,
    privateLog: EMPTY,

    outcome: null,
  };
}

/** Roles in the deck, for the public opening event. Sorted, and NOT the deal. */
export function rolesInPlay(deal: Deal): RoleType[] {
  return [...new Set(SEATS.map((s) => deal.bySeat[s]))].sort();
}
