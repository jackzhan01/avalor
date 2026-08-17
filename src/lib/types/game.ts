/**
 * Core game entities.
 *
 * Seat number is the primary identity: at a real table people say "3号" / "5号",
 * never the player's name. `id` exists only so events can reference a player
 * stably even if seats were ever reordered.
 */

/** Supported table sizes. 9 and 10 are the primary use case. */
export type PlayerCount = 5 | 6 | 7 | 8 | 9 | 10;

export interface Player {
  id: string;
  /** 1-based, fixed for the whole game. This is what people say out loud. */
  seat: number;
  /** Optional. Most games are played entirely by seat number. */
  name?: string;
  /**
   * Reserved for the V1.1 "reveal roles" feature (spec §64). Never displayed in
   * V1, and — critically — never fed into any derivation. See RoleType.
   */
  actualRole?: RoleType;
}

export type RoleType =
  | "merlin"
  | "percival"
  | "loyal"
  | "morgana"
  | "mordred"
  | "assassin"
  | "oberon"
  | "minion";

export const GOOD_ROLES: readonly RoleType[] = ["merlin", "percival", "loyal"];
export const EVIL_ROLES: readonly RoleType[] = [
  "morgana",
  "mordred",
  "assassin",
  "oberon",
  "minion",
];

/**
 * Which roles are in play this game — NOT who has them.
 *
 * This is inert metadata. It is validated (warn-only) against EVIL_COUNTS and
 * stored for future analysis, but it must never feed a selector. The moment it
 * does, V1's "no inference" boundary is broken (spec §95).
 */
export interface RoleSetConfig {
  rolesIncluded: RoleType[];
}

export type GameStatus = "active" | "completed";

/** Clockwise or counter-clockwise as seen on screen. */
export type TurnDirection = "cw" | "ccw";

export type WinningSide = "good" | "evil";

/**
 * Drives ONLY the primary CTA. Opinion and text input stay available in every
 * phase (spec §74) — a player keeps talking while a vote is being counted.
 *
 * Deliberately has no terminal member: a finished game is derived separately as
 * `isComplete`, because "the game ended" is not a phase of play.
 */
export type GamePhase = "discussion" | "voting" | "mission";

export type ProposalStatus =
  | "draft" // recorded but superseded before any vote was taken
  | "voting" // awaiting a vote
  | "rejected"
  | "passed"
  | "mission_completed";

export type VoteChoice = "approve" | "reject" | "unknown";

export type MissionResult = "success" | "fail";

export interface GameRecord {
  id: string;
  schemaVersion: 1;
  name?: string;
  playerCount: PlayerCount;
  /** Embedded, not a separate table: bounded at 10, fixed at creation. */
  players: Player[];
  roleSet?: RoleSetConfig;
  /** Seat rotation anchor for the very first proposal. */
  firstLeaderId: string;
  /**
   * Which seat the person holding the phone occupies.
   *
   * Purely a VIEW ANCHOR: it pins the user to six o'clock on the round table so
   * everyone else sits where they actually sit. It is not a player-identity
   * system (spec §3) and never feeds a derivation. Optional — when a group
   * doesn't number its seats out loud, seat 1 is simply assumed to be the user.
   */
  viewerPlayerId?: string;
  /**
   * The user's own role this game. PRIVATE — it drives what vision they are
   * offered and is never treated as information about anyone else.
   */
  viewerRole?: RoleType;
  /**
   * Which way seat numbers run around the table on screen. Purely visual —
   * it changes where a seat is drawn, never who follows whom.
   */
  seatDirection?: TurnDirection;
  /**
   * Which way the 车主 passes. A game rule, independent of the drawing
   * direction above, because a table can number itself one way and pass the
   * lead the other.
   */
  leaderDirection?: TurnDirection;
  /** Private scratchpad for drafting what to say next. */
  scratchpad?: string;
  /** Endgame: who the assassin went for. */
  assassinTargetId?: string;
  status: GameStatus;
  winningSide?: WinningSide | null;
  /**
   * Durable backstop for the per-game sequence counter. Bumped inside the same
   * Dexie transaction as the event insert.
   */
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Convenience: seat lookup that does not assume `players` is sorted. */
export function playerBySeat(
  players: readonly Player[],
  seat: number,
): Player | undefined {
  return players.find((p) => p.seat === seat);
}

export function playerById(
  players: readonly Player[],
  id: string,
): Player | undefined {
  return players.find((p) => p.id === id);
}

/** Seats ascending. Callers that rotate leaders rely on this ordering. */
export function sortedBySeat(players: readonly Player[]): Player[] {
  return [...players].sort((a, b) => a.seat - b.seat);
}
