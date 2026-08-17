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

/**
 * 意向车 — "if I were leader I'd take 1/3/5".
 *
 * A SPEECH ACT, not a game action, and that distinction is why this exists
 * separately from ProposalEvent. Anyone can say it at any time, they need not
 * be the leader, it never goes to a vote, and they can change their mind —
 * exactly like an opinion, except the object is a team rather than a person.
 *
 * Deliberately never merged with the proposal they later make as leader, so
 * "said they'd take 1/3/5 but actually took 2/4/6" stays visible.
 */
export interface IntendedTeamEvent extends BaseGameEvent {
  type: "intended_team";
  playerId: string;
  teamPlayerIds: string[];
}

/**
 * 跳派 — publicly claiming to be Percival.
 *
 * Binary on purpose: in practice it is the only role claim with a payoff.
 * Claiming Merlin invites the assassin; claiming a loyal servant says nothing.
 * `claimed: false` records a retraction (反跳), so the history reads as a chain
 * the same way opinions do.
 */
export interface RoleClaimEvent extends BaseGameEvent {
  type: "role_claim";
  playerId: string;
  claimed: boolean;
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
  | IntendedTeamEvent
  | RoleClaimEvent
  | TextEvent;

export type GameEventType = GameEvent["type"];

/**
 * Events that record what somebody SAID, as opposed to what the game DID.
 *
 * These never affect phase or numbering — a player talking cannot advance the
 * game. They only carry context so the timeline files them under the right
 * round. Everything a player can be recorded as expressing lives here.
 */
export const STATEMENT_TYPES = [
  "opinion",
  "intended_team",
  "role_claim",
  "text",
] as const;

export type StatementEventType = (typeof STATEMENT_TYPES)[number];

/* ── Type guards ───────────────────────────────────────────────────────── */

export const isOpinionEvent = (e: GameEvent): e is OpinionEvent =>
  e.type === "opinion";
export const isProposalEvent = (e: GameEvent): e is ProposalEvent =>
  e.type === "proposal";
export const isVoteEvent = (e: GameEvent): e is VoteEvent => e.type === "vote";
export const isMissionEvent = (e: GameEvent): e is MissionEvent =>
  e.type === "mission";
export const isTextEvent = (e: GameEvent): e is TextEvent => e.type === "text";
export const isIntendedTeamEvent = (e: GameEvent): e is IntendedTeamEvent =>
  e.type === "intended_team";
export const isRoleClaimEvent = (e: GameEvent): e is RoleClaimEvent =>
  e.type === "role_claim";

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
  | Omit<IntendedTeamEvent, keyof BaseGameEvent>
  | Omit<RoleClaimEvent, keyof BaseGameEvent>
  | Omit<TextEvent, keyof BaseGameEvent>;

/**
 * Omit that distributes over a union.
 *
 * Plain `Omit<GameEvent, ...>` collapses the union to only the keys every
 * member shares, which would silently make every type-specific field
 * un-patchable.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An edit may change payload fields, never identity or ordering. */
export type EventPatch = Partial<
  DistributiveOmit<GameEvent, "id" | "gameId" | "sequence" | "type">
>;

/** Ascending by sequence. The store keeps `events` in this order as an invariant. */
export function bySequence(a: GameEvent, b: GameEvent): number {
  return a.sequence - b.sequence;
}
