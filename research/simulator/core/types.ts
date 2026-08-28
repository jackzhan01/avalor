/**
 * The vocabulary every other simulator module shares.
 *
 * Two families of type live here and they must never be confused, because the
 * whole point of this simulator is that a language model cannot see what the
 * game did not deal it:
 *
 *   HARD KNOWLEDGE   what the rules gave this seat. `PrivateKnowledge` and
 *                    `LadyResult`. Written only by the referee, from the deal.
 *                    An agent action can never produce or amend one.
 *
 *   SOFT BELIEF      what this seat currently thinks. `PrivateMemory`. Written
 *                    only by the agent, through `PrivateMemoryPatch`.
 *
 * They are separate types with no assignability between them on purpose. A
 * persona that "feels sure" about a seat cannot overwrite what the Lady of the
 * Lake actually showed, because there is no code path that would type-check.
 */

import type { RoleType } from "@/lib/types/game";
import { deepFreeze } from "./freeze";

/** 1..10, clockwise around the table. Seat number is the public identity. */
export type Seat = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const SEATS: readonly Seat[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const);

export const PLAYER_COUNT = 10 as const;

export type Side = "good" | "evil";

/**
 * Which way speech and leadership travel, from the point of view of a player
 * facing inward.
 *
 * "left" means the turn passes to each player's left, which is the next
 * clockwise seat, which is `seat + 1`. "right" is `seat - 1`. Naming it after
 * the player rather than after the arithmetic is deliberate: the opening
 * choice is spoken at the table as 「往左」/「往右」, and a constant called
 * `step: -1` would need translating every time somebody read it.
 */
export type PlayDirection = "left" | "right";

/** Which neighbour of the opening leader receives the Lady token. */
export type LadySide = "left" | "right";

/* ── Hard knowledge ────────────────────────────────────────────────────── */

/**
 * What the deal legally showed this seat at reveal.
 *
 * Note what is NOT expressible here: an exact role for anybody else. Before
 * the assassination phase nobody knows another seat's exact role, and the type
 * makes that structural rather than a rule somebody has to remember.
 */
export type PrivateKnowledge =
  /** Loyal servants, and Oberon. */
  | { readonly kind: "none" }
  /** Merlin: every evil except Mordred, as sides only. Sorted ascending. */
  | { readonly kind: "sees_evil"; readonly seats: readonly Seat[] }
  /** Morgana / Assassin / Mordred: the other two, minus Oberon. Sorted. */
  | { readonly kind: "knows_teammates"; readonly seats: readonly Seat[] }
  /**
   * Percival: one of these two is Merlin and the other is Morgana, and he
   * cannot tell which. Stored ASCENDING so the pair carries no ordering
   * information — swapping the Merlin and Morgana seats must render an
   * identical observation, and sorting is what makes that true by
   * construction rather than by a downstream shuffle.
   */
  | { readonly kind: "merlin_or_morgana"; readonly pair: readonly [Seat, Seat] };

/**
 * What the Lady of the Lake actually showed a holder.
 *
 * Permanent and immutable. The public announcement that follows may be a lie;
 * this is the fact, and it lives in the private stream forever.
 */
export interface LadyResult {
  readonly sequence: number;
  readonly missionNumber: number;
  readonly holder: Seat;
  readonly target: Seat;
  readonly trueSide: Side;
}

/* ── Soft belief ───────────────────────────────────────────────────────── */

/** One seat's current read of another. Belief, never fact. */
export interface Belief {
  readonly seat: Seat;
  /** 0..1. A guess, and labelled as one. */
  readonly pEvil: number;
  readonly note: string;
}

/**
 * The compact structured notes a seat carries between decisions.
 *
 * Deliberately NOT a chat transcript and NOT raw chain of thought. A model is
 * asked for beliefs, intentions and commitments it is willing to state, and
 * only those are stored — so a run can be audited, replayed and compared
 * without keeping hidden reasoning nobody can check.
 */
export interface PrivateMemory {
  readonly version: number;
  readonly beliefs: readonly Belief[];
  /** What this seat means to do next. At most a handful of short lines. */
  readonly intentions: readonly string[];
  /** What it has already said in public and should stay consistent with. */
  readonly commitments: readonly string[];
  readonly lastUpdatedSequence: number;
}

/**
 * Frozen, and shared. Ten seats all start from the same empty notes and none of
 * them can write to it — the referee replaces the whole object on a patch.
 */
const EMPTY_MEMORY: PrivateMemory = deepFreeze({
  version: 0,
  beliefs: [],
  intentions: [],
  commitments: [],
  lastUpdatedSequence: 0,
});

export function emptyMemory(): PrivateMemory {
  return EMPTY_MEMORY;
}

/**
 * An agent's proposed edit to its own memory.
 *
 * Every field is optional and replaces wholesale; there is no operation that
 * touches hard knowledge, which is the point.
 */
export interface PrivateMemoryPatch {
  readonly beliefs?: readonly Belief[];
  readonly intentions?: readonly string[];
  readonly commitments?: readonly string[];
}

/* ── Speech acts ───────────────────────────────────────────────────────── */

/** A public stance toward another seat, in the same units the repo's social layer uses. */
export interface Stance {
  readonly seat: Seat;
  /** -1 hardest accusation, +1 strongest defence, 0 an explicit "can't read them". */
  readonly valence: number;
  /** 0..1, how much this reading itself should be trusted. */
  readonly confidence: number;
}

/** 跳派 and friends: a public claim to hold a role. Never checked by the referee. */
export interface RoleClaim {
  readonly seat: Seat;
  readonly claimed: RoleType;
  readonly sinceSequence: number;
}

/* ── Actions ───────────────────────────────────────────────────────────── */

/** Every action may carry a memory patch; nothing else may write memory. */
interface ActionBase {
  readonly memoryPatch?: PrivateMemoryPatch;
}

/**
 * The opening leader's strategic call.
 *
 * Not a random draw: which neighbour gets the Lady and which way the table
 * turns are the first real decision of the game, and they are made by a player
 * who has already seen their own role.
 */
export interface OpeningDirectionAction extends ActionBase {
  readonly kind: "choose_opening_direction";
  readonly ladySide: LadySide;
  readonly publicMessage: string;
}

export interface SpeechAction extends ActionBase {
  readonly kind: "speech";
  readonly publicMessage: string;
  /**
   * 意向车 — a speech act, never an authoritative proposal. Kept separate from
   * the team in `LeaderCloseAndProposeAction` precisely so "said they'd take
   * 1/3/5 and then took 2/4/6" stays visible, which is the same separation the
   * notebook's `intended_team` event exists for.
   */
  readonly tentativeTeam?: readonly Seat[] | null;
  /** "I cannot put a car together right now." Mutually exclusive with a tentative team. */
  readonly noTeamYet?: boolean;
  readonly stances?: readonly Stance[];
  readonly claim?: RoleType | null;
  /**
   * 退水 — publicly withdrawing a claim this seat is currently standing on.
   *
   * A first-class act rather than "claim: null", because the two mean opposite
   * things: `claim: null` is a speech that says nothing about identity, and a
   * seat that has already claimed keeps standing on it. Retracting is a MOVE,
   * and the table has to see it happen.
   *
   * Optional, and omitted from the emitted event unless true, so every game
   * played before `prompt-0.4.0` replays byte for byte.
   */
  readonly retractClaim?: boolean;
}

/**
 * The leader's closing speech AND the authoritative car, as ONE decision.
 *
 * Split across two turns they were two agent decisions and, once a model is
 * behind them, two calls — which is both twice the cost and an invitation to
 * incoherence, because nothing forced the car to match what the leader had
 * just finished saying. The referee still publishes two distinct facts in
 * order (the speech, then the proposal); it is the DECISION that is one.
 *
 * The closing speech keeps its own independent 220-character budget. It does
 * not pool with the opening speech and unused room does not carry over.
 */
export interface LeaderCloseAndProposeAction extends ActionBase {
  readonly kind: "leader_close_and_propose";
  readonly publicMessage: string;
  readonly team: readonly Seat[];
  /** A short research annotation. Never a request for hidden reasoning. */
  readonly rationale?: string;
}

export interface VoteAction extends ActionBase {
  readonly kind: "vote";
  readonly choice: "approve" | "reject";
}

export interface MissionAction extends ActionBase {
  readonly kind: "mission";
  readonly card: "success" | "fail";
}

export interface LadySelectAction extends ActionBase {
  readonly kind: "lady_select";
  readonly target: Seat;
}

export interface LadyAnnounceAction extends ActionBase {
  readonly kind: "lady_announce";
  /** What the holder says out loud. May contradict what they were shown. */
  readonly announced: Side;
  readonly publicMessage: string;
}

export interface EvilDiscussAction extends ActionBase {
  readonly kind: "evil_discuss";
  /** Heard only by the other three evil seats. Same length limit as public speech. */
  readonly message: string;
}

export interface AssassinateAction extends ActionBase {
  readonly kind: "assassinate";
  readonly target: Seat;
  readonly rationale?: string;
}

export type Action =
  | OpeningDirectionAction
  | SpeechAction
  | LeaderCloseAndProposeAction
  | VoteAction
  | MissionAction
  | LadySelectAction
  | LadyAnnounceAction
  | EvilDiscussAction
  | AssassinateAction;

export type ActionKind = Action["kind"];

/* ── Decision requests ─────────────────────────────────────────────────── */

export type SpeechSlot = "opening" | "regular" | "closing";

/**
 * What the referee is waiting for. Exactly one seat at a time, always.
 *
 * Votes and mission cards are collected one request at a time in ascending
 * seat order, but nothing any seat submits becomes visible to anyone until the
 * whole set is in — see `observationFor`, which has no path to `pendingVotes`.
 */
export type DecisionRequest =
  | { readonly kind: "choose_opening_direction"; readonly seat: Seat }
  | { readonly kind: "speech"; readonly seat: Seat; readonly slot: SpeechSlot }
  | {
      readonly kind: "leader_close_and_propose";
      readonly seat: Seat;
      readonly teamSize: number;
    }
  | { readonly kind: "vote"; readonly seat: Seat }
  | { readonly kind: "mission"; readonly seat: Seat }
  | {
      readonly kind: "lady_select";
      readonly seat: Seat;
      readonly eligible: readonly Seat[];
    }
  | { readonly kind: "lady_announce"; readonly seat: Seat }
  | { readonly kind: "evil_discuss"; readonly seat: Seat }
  | { readonly kind: "assassinate"; readonly seat: Seat };

/* ── Failure ───────────────────────────────────────────────────────────── */

export type IllegalActionCode =
  | "wrong_phase"
  | "wrong_seat"
  | "wrong_kind"
  | "speech_too_long"
  | "bad_team_size"
  | "bad_seat"
  | "duplicate_seat"
  | "tentative_team_conflict"
  /** 退水 while also claiming something new. Two moves, one speech. */
  | "claim_conflict"
  /** 退水 with nothing standing to withdraw. */
  | "no_claim_to_retract"
  | "not_on_team"
  | "good_cannot_fail"
  | "already_submitted"
  | "lady_ineligible"
  | "bad_target"
  | "bad_value";

/**
 * The referee REJECTS. It does not warn and it does not repair.
 *
 * That is the one place this differs from `deriveTimeline`, which is written
 * for a human keeping notes and must never block a save. Here an illegal
 * action is a bug in an agent or a malformed model output, and swallowing it
 * would silently produce games that are not this game.
 */
export class IllegalActionError extends Error {
  constructor(
    readonly code: IllegalActionCode,
    message: string,
  ) {
    super(message);
    this.name = "IllegalActionError";
  }
}

export type { RoleType };
