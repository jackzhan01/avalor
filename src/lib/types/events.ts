/**
 * The event log. This is the single source of truth for a game.
 *
 * Every piece of state the UI shows must be derivable from these events by a
 * pure function in `src/lib/selectors/`. Nothing else is authoritative.
 *
 * ORDERING: always use `sequence`, never `timestamp`. Device clocks jump
 * (timezone travel, NTP correction, manual changes), so a sort by `timestamp`
 * can silently reorder a game. `timestamp` is for display only. Any code that
 * sorts by it is a bug.
 */

import type { MissionResult, VoteChoice } from "./game";

export interface BaseGameEvent {
  id: string;
  gameId: string;
  /**
   * Denormalized cache of a DERIVED value, not independent truth.
   *
   * Correct by construction on append, but an edit or delete can change what
   * mission/proposal an event belongs to. `assignContext()` reconciles these
   * after every edit and delete. Never trust these over `deriveTimeline`.
   */
  missionNumber: number;
  proposalNumber?: number;
  /** Per-game counter: starts at 1, monotonic, never reused, never renumbered. */
  sequence: number;
  /** ISO 8601. Display only — see the ORDERING note above. */
  timestamp: string;
}

/** Rating scale. 1 = 强踩, 3 = 中立, 5 = 强保. */
export type Rating = 1 | 2 | 3 | 4 | 5;

/**
 * "Speaker publicly expressed this attitude toward target."
 *
 * This records PUBLIC EXPRESSION, not belief (spec §58). A rating of 5 means
 * "said they strongly trust them", not "believes they are good with p=1".
 *
 * The absence of an opinion is NOT a rating of 3. See selectors/opinions.ts.
 */
export interface OpinionEvent extends BaseGameEvent {
  type: "opinion";
  speakerId: string;
  targetId: string;
  rating: Rating;
}

/** 点车: a leader put a team forward. */
export interface ProposalEvent extends BaseGameEvent {
  type: "proposal";
  leaderId: string;
  teamPlayerIds: string[];
}

export interface VoteEvent extends BaseGameEvent {
  type: "vote";
  proposalId: string;
  /**
   * Seat-level votes, keyed by player id. Partial data is legal: a seat may be
   * recorded as "unknown", or be absent from the map entirely (never recorded).
   * Those two are different and must stay different.
   *
   * Never collapse this to a count. A 6-4 pass by one coalition and a 6-4 pass
   * by another are completely different information (spec §21).
   */
  votes: Record<string, VoteChoice>;
  /**
   * Authoritative. NEVER recompute this from `votes` — partial vote data would
   * miscount. If a complete vector contradicts this, the vector is what's
   * wrong: emit a warning and honour finalResult.
   */
  finalResult: "passed" | "rejected";
}

export interface MissionEvent extends BaseGameEvent {
  type: "mission";
  proposalId: string;
  /**
   * Snapshot of who actually went. Authoritative for "who was on the mission",
   * even if the proposal is later edited — `proposalId` is only for grouping.
   */
  teamPlayerIds: string[];
  result: MissionResult;
  /** Optional: the user may not have counted, or may not have been told. */
  failCount?: number;
}

/** Escape hatch for anything pairwise ratings can't express (spec §27). */
export interface TextEvent extends BaseGameEvent {
  type: "text";
  /** Optional: a note may be about the table generally, not one player. */
  playerId?: string;
  text: string;
}

export type GameEvent =
  | OpinionEvent
  | ProposalEvent
  | VoteEvent
  | MissionEvent
  | TextEvent;

export type GameEventType = GameEvent["type"];

/* ── Type guards ───────────────────────────────────────────────────────── */

export const isOpinionEvent = (e: GameEvent): e is OpinionEvent =>
  e.type === "opinion";
export const isProposalEvent = (e: GameEvent): e is ProposalEvent =>
  e.type === "proposal";
export const isVoteEvent = (e: GameEvent): e is VoteEvent => e.type === "vote";
export const isMissionEvent = (e: GameEvent): e is MissionEvent =>
  e.type === "mission";
export const isTextEvent = (e: GameEvent): e is TextEvent => e.type === "text";

/* ── Drafts (what the UI hands to the store) ───────────────────────────── */

/**
 * A new event minus everything the store assigns: id, gameId, sequence,
 * timestamp, missionNumber, proposalNumber.
 */
export type EventDraft =
  | Omit<OpinionEvent, keyof BaseGameEvent>
  | Omit<ProposalEvent, keyof BaseGameEvent>
  | Omit<VoteEvent, keyof BaseGameEvent>
  | Omit<MissionEvent, keyof BaseGameEvent>
  | Omit<TextEvent, keyof BaseGameEvent>;

/** An edit may change payload fields, never identity or ordering. */
export type EventPatch = Partial<
  Omit<GameEvent, "id" | "gameId" | "sequence" | "type">
>;

/** Ascending by sequence. The store keeps `events` in this order as an invariant. */
export function bySequence(a: GameEvent, b: GameEvent): number {
  return a.sequence - b.sequence;
}
