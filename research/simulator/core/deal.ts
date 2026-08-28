/**
 * Dealing the fixed ten-player table.
 *
 * The line-up is not a choice this simulator makes; it is the repository's own
 * intended ten-player configuration, and three independent pieces of evidence
 * pin it down:
 *
 *   - `DEFAULT_ROLE_SET[10]` in `src/lib/rules/avalon.ts` names merlin,
 *     percival, loyal, morgana, assassin, mordred and oberon;
 *   - `describeComposition(10, …)` spends the six good and four evil seats
 *     that `EVIL_COUNTS[10] = 4` allows, leaving four loyal and zero minion;
 *   - PRODUCT-V1 states the role layer enumerates 151,200 complete deals at
 *     ten players, and 10!/4! is exactly 151,200 — the 4! being four
 *     interchangeable loyal servants.
 *
 * `assertMatchesRepoRules()` re-derives the composition from those rule
 * functions at deal time, so if anyone ever edits the table this fails loudly
 * instead of quietly simulating a different game.
 */

import {
  DEFAULT_ROLE_SET,
  defaultRoleSet,
  describeComposition,
  evilCount,
  goodCount,
} from "@/lib/rules/avalon";
import { EVIL_ROLES, type RoleType } from "@/lib/types/game";
import { makeRng, shuffled, type Rng } from "./rng";
import { PLAYER_COUNT, SEATS, type Seat, type Side } from "./types";

/**
 * The ten cards, one per seat. Order here is the order they are shuffled in,
 * which is part of the replay contract: change it and old seeds deal
 * differently.
 */
export const ROLE_SLOTS: readonly RoleType[] = [
  "merlin",
  "percival",
  "loyal",
  "loyal",
  "loyal",
  "loyal",
  "morgana",
  "assassin",
  "mordred",
  "oberon",
];

export interface Deal {
  readonly bySeat: Readonly<Record<Seat, RoleType>>;
  /** Every seat holding each role. Only `loyal` ever has more than one. */
  readonly byRole: Readonly<Partial<Record<RoleType, readonly Seat[]>>>;
  readonly evilSeats: readonly Seat[];
  readonly goodSeats: readonly Seat[];
  readonly merlin: Seat;
  readonly percival: Seat;
  readonly morgana: Seat;
  readonly mordred: Seat;
  readonly assassin: Seat;
  readonly oberon: Seat;
}

export function sideOf(role: RoleType): Side {
  return (EVIL_ROLES as readonly RoleType[]).includes(role) ? "evil" : "good";
}

/**
 * Cross-check the hard-coded line-up against the repository's rule functions.
 *
 * Called on every deal. It is cheap, and a silent divergence between this file
 * and `rules/avalon.ts` is the exact class of bug that would make a whole
 * research run answer a question about a game nobody plays.
 */
export function assertMatchesRepoRules(): void {
  if (ROLE_SLOTS.length !== PLAYER_COUNT) {
    throw new Error(`ROLE_SLOTS has ${ROLE_SLOTS.length} cards, need ${PLAYER_COUNT}`);
  }

  const composition = describeComposition(PLAYER_COUNT, defaultRoleSet(PLAYER_COUNT));
  if (composition.problems.length > 0) {
    throw new Error(`repo composition complains: ${composition.problems.join(" ")}`);
  }

  const expected = new Map<RoleType, number>();
  for (const line of [...composition.good, ...composition.evil]) {
    expected.set(line.role, line.count);
  }
  const actual = new Map<RoleType, number>();
  for (const role of ROLE_SLOTS) actual.set(role, (actual.get(role) ?? 0) + 1);

  for (const [role, count] of expected) {
    if (actual.get(role) !== count) {
      throw new Error(
        `role ${role}: repo rules want ${count}, ROLE_SLOTS has ${actual.get(role) ?? 0}`,
      );
    }
  }
  for (const role of actual.keys()) {
    if (!expected.has(role)) throw new Error(`role ${role} is not in the repo's 10p set`);
  }

  const evils = ROLE_SLOTS.filter((r) => sideOf(r) === "evil").length;
  if (evils !== evilCount(PLAYER_COUNT)) {
    throw new Error(`dealt ${evils} evils, rules say ${evilCount(PLAYER_COUNT)}`);
  }
  if (ROLE_SLOTS.length - evils !== goodCount(PLAYER_COUNT)) {
    throw new Error("good count disagrees with the rules table");
  }
  // The role SET must also be the one the rules file names, not merely a set
  // with the right shape.
  const declared = new Set(DEFAULT_ROLE_SET[PLAYER_COUNT]);
  for (const role of actual.keys()) {
    if (!declared.has(role)) throw new Error(`role ${role} is not in DEFAULT_ROLE_SET[10]`);
  }
}

function only(byRole: Map<RoleType, Seat[]>, role: RoleType): Seat {
  const seats = byRole.get(role);
  if (!seats || seats.length !== 1) {
    throw new Error(`expected exactly one ${role}, got ${seats?.length ?? 0}`);
  }
  return seats[0];
}

/** Build a deal from an explicit seat→role map. Used by fixtures and tests. */
export function dealFromAssignment(bySeat: Readonly<Record<Seat, RoleType>>): Deal {
  const byRole = new Map<RoleType, Seat[]>();
  for (const seat of SEATS) {
    const role = bySeat[seat];
    if (!role) throw new Error(`seat ${seat} has no role`);
    const list = byRole.get(role) ?? [];
    list.push(seat);
    byRole.set(role, list);
  }

  const evilSeats = SEATS.filter((s) => sideOf(bySeat[s]) === "evil");
  const goodSeats = SEATS.filter((s) => sideOf(bySeat[s]) === "good");

  return {
    bySeat: { ...bySeat },
    byRole: Object.fromEntries(
      [...byRole].map(([role, seats]) => [role, [...seats].sort((a, b) => a - b)]),
    ) as Deal["byRole"],
    evilSeats,
    goodSeats,
    merlin: only(byRole, "merlin"),
    percival: only(byRole, "percival"),
    morgana: only(byRole, "morgana"),
    mordred: only(byRole, "mordred"),
    assassin: only(byRole, "assassin"),
    oberon: only(byRole, "oberon"),
  };
}

/**
 * Deal ten cards from a seeded stream.
 *
 * The stream is a NAMED CHILD of the run seed rather than the run stream
 * itself, so that adding a draw anywhere else in the referee cannot shift what
 * a given seed deals. Replay depends on that stability.
 */
export function dealRoles(rng: Rng): Deal {
  assertMatchesRepoRules();
  const cards = shuffled(rng, ROLE_SLOTS);
  const bySeat = {} as Record<Seat, RoleType>;
  SEATS.forEach((seat, i) => {
    bySeat[seat] = cards[i];
  });
  return dealFromAssignment(bySeat);
}

export interface Setup {
  readonly deal: Deal;
  readonly initialLeader: Seat;
}

/**
 * Everything the seed decides, in one place and in a fixed order.
 *
 * Deal first, then the opening leader, each from its own named stream. Note
 * what the seed does NOT decide: which way the table turns, and who gets the
 * Lady. Those are the opening leader's choice, made after they have seen their
 * own card.
 */
export function setupFromSeed(seed: number): Setup {
  const deal = dealRoles(makeRng(hashLabel(seed, "deal")));
  const leaderRng = makeRng(hashLabel(seed, "leader"));
  const initialLeader = SEATS[Math.min(PLAYER_COUNT - 1, Math.floor(leaderRng() * PLAYER_COUNT))];
  return { deal, initialLeader };
}

/** FNV-1a fold of a label into a seed. Kept local so `rng.ts` stays generic. */
function hashLabel(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
