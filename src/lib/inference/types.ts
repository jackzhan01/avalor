/**
 * Hidden-role inference: what the recorded facts alone can prove.
 *
 * This layer answers a different question from `selectors/`. Those derive what
 * IS — phase, score, who leads. This one derives what CAN STILL BE TRUE: every
 * assignment of evil seats consistent with everything the user wrote down.
 *
 * The design commitment that makes it worth having: THIS LAYER NEVER GUESSES.
 * A hypothesis is eliminated only when a rule of the game makes it impossible,
 * never because it looks unlikely. So a seat shown at 100% is not a model being
 * confident, it is arithmetic — that seat is evil in every surviving world. The
 * probabilistic scoring that ranks the survivors comes later and lives
 * elsewhere; keeping the two apart is what lets the UI say "ruled out" and
 * "suspected" in different words, and mean it.
 *
 * Same discipline as the rest of the app: pure functions, no React, no fetch,
 * no Date.now(), unit-testable in node.
 */

import type { RoleType } from "@/lib/types/game";

/**
 * One complete guess at who the evil seats are.
 *
 * Side-level, not role-level. Roles are resolved in a second layer conditioned
 * on this one, because the joint space is far larger (a 10-player game has 210
 * side splits but 151,200 full role assignments) and almost every question the
 * user actually asks — "is he evil", "can I trust this car" — is answered at
 * this level.
 */
export interface Hypothesis {
  /** Seat ids, sorted, length === evilCount(playerCount). */
  readonly evil: readonly string[];
  /** Membership test. Precomputed because the constraints hit it constantly. */
  readonly isEvil: (playerId: string) => boolean;
}

/** Why a hypothesis died. Surfaced to the user, so it must read as a reason. */
export interface Elimination {
  /** Stable id for grouping, e.g. "mission-fail". */
  kind:
    | "viewer_side"
    | "vision"
    | "percival_pair"
    | "mission_fail"
    | "lady_check";
  /** Human-readable, already in the vernacular the UI uses. */
  reason: string;
  /** How many hypotheses this constraint removed. */
  eliminated: number;
}

export interface SideInference {
  /** Hypotheses consistent with every recorded fact. Never empty in a sane log. */
  surviving: Hypothesis[];
  /** How many were enumerated before any constraint applied. */
  total: number;
  /**
   * playerId → fraction of surviving hypotheses in which this seat is evil.
   *
   * A FREQUENCY, not a belief. 0 and 1 are proofs; anything between is just
   * "this many of the remaining worlds", with every world weighted equally —
   * counting possibilities and nothing else.
   */
  evilFrequency: Map<string, number>;
  /**
   * The same seats, after weighting each world by how well it explains the
   * votes and fail cards.
   *
   * Kept SEPARATE from `evilFrequency` rather than replacing it, because the
   * two make different kinds of claim and the difference is the whole ethic of
   * this layer: one counts what is possible, the other estimates what is
   * likely using hand-set assumptions about how people behave. Anything shown
   * as certain must come from the first.
   *
   * Note the two agree exactly at 0 and 1 — reweighting cannot resurrect a
   * world the hard layer deleted — so proofs are unaffected by any of it.
   */
  evilProbability: Map<string, number>;
  /** What each constraint removed, in the order applied. For the UI's "why". */
  eliminations: Elimination[];
  /**
   * Seats proven evil / good — true in every surviving world.
   *
   * These are the only claims this layer will state as fact.
   */
  provenEvil: string[];
  provenGood: string[];
  /**
   * Shannon entropy over the surviving hypotheses, in bits (log2 of the count,
   * since they are uniform). 0 = solved. This is what decides whether the role
   * layer has earned the right to say anything.
   */
  entropyBits: number;
  /** True when the log contradicts itself and nothing survives. */
  contradictory: boolean;
}

/** Per-seat probability of holding a specific role, marginalised over sides. */
export interface RoleInference {
  /** playerId → role → probability. Only roles actually in play appear. */
  byPlayer: Map<string, Map<RoleType, number>>;
  /** role → playerId → probability. The same numbers, indexed the other way. */
  byRole: Map<RoleType, Map<string, number>>;
  /**
   * role → entropy in bits of "where is this role", 0 meaning solved.
   *
   * PER ROLE, and that turned out to matter more than it looks. Gating the
   * whole layer on the side-level entropy is wrong, and Percival is the case
   * that proves it: he sees his pair, so he knows Merlin is one of exactly two
   * seats — 1 bit, about as sharp a read as this game offers — while the side
   * layer is still sitting at ~4.9 bits because he has no idea who the other
   * two evils are. One global gate would suppress the single most valuable
   * thing he knows. So confidence is asked and answered one role at a time.
   */
  entropyByRole: Map<RoleType, number>;
  /** The log contradicts itself; nothing above is meaningful. */
  contradictory: boolean;
}
