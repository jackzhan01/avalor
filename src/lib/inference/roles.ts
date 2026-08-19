/**
 * The role layer: not just "is he evil" but "is he Merlin".
 *
 * Conditioned on the side layer rather than enumerated jointly. A 10-player
 * game has 210 side splits but 151,200 full role assignments, and almost every
 * question worth asking is answered at the side level — so sides are solved
 * first and roles are marginalised over the survivors.
 *
 * The marginals are EXACT, not approximate: for each surviving split we
 * enumerate every legal way to hand out the named roles and count. Only the
 * named roles are enumerated (忠臣 and 爪牙 are whatever is left over), which
 * keeps the worst case at 210 × 6P2 × 4P4 = 151,200 — microseconds of counting,
 * and no approximation to apologise for later.
 *
 * WHEN TO SHOW IT is a separate question from whether it can be computed, and
 * the two must not be conflated. See `ROLE_CONFIDENCE_BITS`.
 */

import { rolesInPlay } from "@/lib/rules/avalon";
import { deriveLady, getAllRoleMarks } from "@/lib/selectors";
import type { GameEvent } from "@/lib/types/events";
import { EVIL_ROLES, type GameRecord, type RoleType } from "@/lib/types/game";
import { memoize2ByRef } from "@/lib/utils/memo";
import { deriveSideInference } from "./side";
import { roleVotingEvidence, weighHypotheses } from "./soft";
import { merlinEvidence } from "./merlin";
import type { Hypothesis, RoleInference } from "./types";

/**
 * How sharp a role's location distribution must be before we'll state it.
 *
 * 1.6 bits ≈ three equally likely seats. Asked PER ROLE, never globally — see
 * the note on `entropyByRole`, and the Percival case that forced it.
 *
 * This is the honest version of "show sides early, roles later". Time is not
 * the variable; information is. Merlin has a sharp Mordred read on turn one,
 * and a loyal servant may still have nothing at mission four.
 */
export const ROLE_CERTAIN_BITS = 1.6;

/** Roles that exist at most once. 忠臣/爪牙 fill whatever is left. */
const NAMED_GOOD: readonly RoleType[] = ["merlin", "percival"];
const NAMED_EVIL: readonly RoleType[] = [
  "morgana",
  "mordred",
  "assassin",
  "oberon",
];

/**
 * Seats whose role is already pinned, given this split.
 *
 * Three sources, all hard:
 *   - the user's own role, which they told us
 *   - a vision mark naming a specific role
 *   - Percival's pair, which RESOLVES once the split is fixed: whichever of the
 *     two is evil in this world is Morgana, so the other one is Merlin. That is
 *     the single most powerful piece of role information in the game, and it
 *     only becomes usable at this layer.
 */
function forcedRoles(
  events: GameEvent[],
  game: GameRecord,
  hypothesis: Hypothesis,
): Map<string, RoleType> {
  const forced = new Map<string, RoleType>();

  if (game.viewerPlayerId && game.viewerRole) {
    forced.set(game.viewerPlayerId, game.viewerRole);
  }

  const pair: string[] = [];
  for (const [targetId, state] of getAllRoleMarks(events)) {
    if (state.certainty !== "known") continue;
    if (state.mark.kind === "role") forced.set(targetId, state.mark.role);
    else if (state.mark.kind === "merlin_or_morgana") pair.push(targetId);
  }

  if (pair.length === 2) {
    const [a, b] = pair;
    const aEvil = hypothesis.isEvil(a);
    // The split already decided which is which; we only read it off.
    if (aEvil !== hypothesis.isEvil(b)) {
      forced.set(aEvil ? a : b, "morgana");
      forced.set(aEvil ? b : a, "merlin");
    }
  }

  return forced;
}

/**
 * Roles a seat CANNOT hold, from the blind spots built into the rulebook.
 *
 * Vision is not merely a list of evil seats — it also carries the negative
 * information of who was left out of it. Merlin is shown every evil EXCEPT
 * Mordred, so a seat Merlin saw is provably not Mordred. Evil players
 * recognise each other except Oberon, so a teammate they were shown is
 * provably not Oberon. Dropping this loses the single question Merlin most
 * wants answered in a Mordred game.
 *
 * The subtlety that makes this more than a one-liner: a `known` evil mark can
 * come from TWO places — the opening reveal, or the user's own lady check —
 * and they are indistinguishable in the event log, both being a role_mark with
 * certainty "known". But the lady sees Mordred perfectly well. So seats the
 * user personally examined are exempted; only marks that must have come from
 * the deal carry the blind spot.
 */
function excludedRoles(
  events: GameEvent[],
  game: GameRecord,
): Map<string, RoleType> {
  const excluded = new Map<string, RoleType>();
  const viewerRole = game.viewerRole;
  if (!viewerRole) return excluded;

  const inPlay = new Set(rolesInPlay(game.playerCount, game.roleSet));
  const blind: RoleType | null =
    viewerRole === "merlin" && inPlay.has("mordred")
      ? "mordred"
      : EVIL_ROLES.includes(viewerRole) &&
          viewerRole !== "oberon" &&
          inPlay.has("oberon")
        ? "oberon"
        : null;
  if (!blind) return excluded;

  const viaLady = new Set<string>();
  for (const check of deriveLady(events, game).checks) {
    if (check.holderId === game.viewerPlayerId) viaLady.add(check.targetId);
  }

  for (const [targetId, state] of getAllRoleMarks(events)) {
    if (state.certainty !== "known" || viaLady.has(targetId)) continue;
    const marksEvil =
      state.mark.kind === "side"
        ? state.mark.side === "evil"
        : state.mark.kind === "role"
          ? EVIL_ROLES.includes(state.mark.role)
          : false;
    if (marksEvil) excluded.set(targetId, blind);
  }

  return excluded;
}

/** Every injection of `roles` into `seats`, respecting the forced assignments. */
function* permutations(
  seats: readonly string[],
  roles: readonly RoleType[],
  forced: Map<string, RoleType>,
  excluded: Map<string, RoleType>,
): Generator<Map<string, RoleType>> {
  const assignment = new Map<string, RoleType>();
  const usedSeat = new Set<string>();

  function* place(index: number): Generator<Map<string, RoleType>> {
    if (index === roles.length) {
      // Every seat that was forced to a role in this side must have received
      // it; a forced seat left holding 忠臣/爪牙 means this permutation
      // contradicts what we know.
      for (const [seatId, role] of forced) {
        if (!seats.includes(seatId)) continue;
        if (assignment.get(seatId) !== role) {
          // Only named roles are enumerated, so a seat forced to 忠臣 or 爪牙
          // is satisfied precisely by being left unassigned here.
          if (roles.includes(role)) return;
          if (assignment.has(seatId)) return;
        }
      }
      yield new Map(assignment);
      return;
    }

    const role = roles[index];
    for (const seatId of seats) {
      if (usedSeat.has(seatId)) continue;
      // Respect a seat pinned to a different role, and a role pinned elsewhere.
      const pin = forced.get(seatId);
      if (pin !== undefined && pin !== role) continue;
      // A rulebook blind spot: this seat cannot be holding this role.
      if (excluded.get(seatId) === role) continue;
      let roleIsPinnedElsewhere = false;
      for (const [otherSeat, otherRole] of forced) {
        if (otherRole === role && otherSeat !== seatId) {
          roleIsPinnedElsewhere = true;
          break;
        }
      }
      if (roleIsPinnedElsewhere) continue;

      usedSeat.add(seatId);
      assignment.set(seatId, role);
      yield* place(index + 1);
      assignment.delete(seatId);
      usedSeat.delete(seatId);
    }
  }

  yield* place(0);
}

/**
 * Which Merlin model to score with. "info" derives his features from what he
 * could see; "class" is the older treatment of him as a differently-behaving
 * good player. Only the evaluation harness passes this — production always
 * uses the default.
 */
export interface RoleOptions {
  merlinModel?: "info" | "class";
}

function computeRoles(
  events: GameEvent[],
  game: GameRecord,
  opts: RoleOptions = {},
): RoleInference {
  const side = deriveSideInference(events, game);
  const inPlay = new Set(rolesInPlay(game.playerCount, game.roleSet));

  const namedGood = NAMED_GOOD.filter((r) => inPlay.has(r));
  const namedEvil = NAMED_EVIL.filter((r) => inPlay.has(r));

  // seat → role → total weight of the assignments putting that role there.
  const counts = new Map<string, Map<RoleType, number>>();
  for (const player of game.players) counts.set(player.id, new Map());
  let totalAssignments = 0;
  const excluded = excludedRoles(events, game);
  // Each surviving world's share, from votes and fail cards. Without this the
  // side layer's conclusions would silently be thrown away here.
  const sideWeights = weighHypotheses(side.surviving, events, game);

  side.surviving.forEach((hypothesis, index) => {
    const evilSeats = hypothesis.evil;
    const goodSeats = game.players
      .map((p) => p.id)
      .filter((id) => !hypothesis.isEvil(id));
    const forced = forcedRoles(events, game, hypothesis);
    const sideWeight = sideWeights[index] ?? 1 / side.surviving.length;
    // Per-seat log-evidence for the sighted roles, under THIS world's split —
    // which car counted as "dirty" depends on who the evils are.
    const evidence = roleVotingEvidence(events, game, hypothesis);
    // Merlin is scored from what he could SEE, which is not settled until the
    // assignment says which evil is Mordred — so it is looked up per casting
    // rather than computed once per world.
    const merlinBySeat = merlinEvidence(events, game, hypothesis);

    for (const goodAssignment of permutations(
      goodSeats,
      namedGood,
      forced,
      excluded,
    )) {
      for (const evilAssignment of permutations(
        evilSeats,
        namedEvil,
        forced,
        excluded,
      )) {
        // How well this exact casting explains the votes. Only the roles with
        // special sight contribute; everyone else already had their side
        // scored by the layer below, and counting it twice would inflate it.
        let mordredSeat = "";
        for (const [seatId, role] of evilAssignment) {
          if (role === "mordred") {
            mordredSeat = seatId;
            break;
          }
        }
        const merlinHere = merlinBySeat.get(mordredSeat) ?? merlinBySeat.get("");

        let logWeight = 0;
        for (const [seatId, role] of goodAssignment) {
          if (role === "merlin") {
            logWeight +=
              (opts.merlinModel === "class"
                ? evidence.get(seatId)?.merlin
                : merlinHere?.get(seatId)) ?? 0;
          }
          else if (role === "percival") {
            logWeight += evidence.get(seatId)?.percival ?? 0;
          }
        }
        for (const [seatId, role] of evilAssignment) {
          if (role !== "oberon") continue;
          logWeight += evidence.get(seatId)?.oberon ?? 0;
        }

        const weight = sideWeight * Math.exp(logWeight);
        totalAssignments += weight;
        for (const [seatId, role] of goodAssignment) bump(counts, seatId, role, weight);
        for (const [seatId, role] of evilAssignment) bump(counts, seatId, role, weight);
        // Leftover seats hold the filler roles, and those are worth reporting
        // too — "he is almost certainly just a 忠臣" is a real conclusion.
        for (const seatId of goodSeats) {
          if (!goodAssignment.has(seatId) && inPlay.has("loyal")) {
            bump(counts, seatId, "loyal", weight);
          }
        }
        for (const seatId of evilSeats) {
          if (!evilAssignment.has(seatId) && inPlay.has("minion")) {
            bump(counts, seatId, "minion", weight);
          }
        }
      }
    }
  });

  const byPlayer = new Map<string, Map<RoleType, number>>();
  const byRole = new Map<RoleType, Map<string, number>>();

  for (const [seatId, roleCounts] of counts) {
    const probabilities = new Map<RoleType, number>();
    for (const [role, count] of roleCounts) {
      if (totalAssignments === 0) continue;
      const p = count / totalAssignments;
      probabilities.set(role, p);
      let row = byRole.get(role);
      if (!row) byRole.set(role, (row = new Map()));
      row.set(seatId, p);
    }
    byPlayer.set(seatId, probabilities);
  }

  const entropyByRole = new Map<RoleType, number>();
  for (const [role, row] of byRole) {
    let bits = 0;
    for (const p of row.values()) if (p > 0) bits -= p * Math.log2(p);
    entropyByRole.set(role, bits);
  }

  return {
    byPlayer,
    byRole,
    entropyByRole,
    contradictory: side.contradictory || totalAssignments === 0,
  };
}

function bump(
  counts: Map<string, Map<RoleType, number>>,
  seatId: string,
  role: RoleType,
  weight: number,
): void {
  const row = counts.get(seatId);
  if (!row) return;
  row.set(role, (row.get(role) ?? 0) + weight);
}

export const deriveRoleInference = memoize2ByRef(computeRoles);

/** Unmemoised, for the evaluation harness to A/B the Merlin model. */
export const computeRolesWith = computeRoles;

/** Whether "where is this role" has narrowed enough to be worth saying out loud. */
export function isConfidentAbout(
  inference: RoleInference,
  role: RoleType,
): boolean {
  if (inference.contradictory) return false;
  const bits = inference.entropyByRole.get(role);
  return bits !== undefined && bits <= ROLE_CERTAIN_BITS;
}

/**
 * Most likely holder of a role, or null when the read is still too diffuse.
 *
 * Returning null rather than the argmax is deliberate: the argmax of a flat
 * distribution is noise, and presenting it as an answer is exactly the
 * false-precision failure this layer was built to avoid.
 */
export function likeliestHolder(
  inference: RoleInference,
  role: RoleType,
): { playerId: string; probability: number } | null {
  const row = inference.byRole.get(role);
  if (!row || !isConfidentAbout(inference, role)) return null;
  let best: { playerId: string; probability: number } | null = null;
  for (const [playerId, probability] of row) {
    if (!best || probability > best.probability) best = { playerId, probability };
  }
  return best;
}
