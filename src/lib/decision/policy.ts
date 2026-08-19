/**
 * How a human at this table is likely to act.
 *
 * This is NOT the belief layer's likelihood, even where it borrows its
 * numbers. A likelihood scores an action that already happened and may
 * condition on the hypothesis being tested. A policy has to GENERATE an action
 * for a simulated player, and so may only condition on what that player can
 * see.
 *
 * That distinction decides the shape of everything here. The strongest single
 * predictor of a vote is how dirty the car looks — but a loyal cannot see the
 * true composition, so the policy is keyed on the PUBLIC read: the expected
 * number of evils on the team under the frozen posterior, which any seat could
 * work out for themselves. Private sight is then layered on top, per role, and
 * only for the players who have it.
 *
 * Measured on the training split. Fitting these is the policy model's job and
 * is kept out of the belief layer, which is frozen.
 */

import type { RoleType } from "@/lib/types/game";

/** Which policy class a role behaves as. */
export type PolicyRole = "loyal" | "merlin" | "percival" | "evil" | "oberon";

export function policyRoleOf(role: RoleType): PolicyRole {
  if (role === "merlin") return "merlin";
  if (role === "percival") return "percival";
  if (role === "oberon") return "oberon";
  if (role === "morgana" || role === "mordred" || role === "assassin" || role === "minion") {
    return "evil";
  }
  return "loyal";
}

/**
 * What a simulated player is allowed to know. Built from a sampled assignment,
 * never from the truth of the game being decided.
 */
export interface InfoSet {
  seat: string;
  role: PolicyRole;
  side: "good" | "evil";
  /** Teammates this seat can see. Empty for every good role, and for Oberon. */
  knownEvil: ReadonlySet<string>;
  /** Merlin sees every evil but Mordred. */
  visibleEvil: ReadonlySet<string>;
  /** Percival's two candidates, unordered. */
  pair: readonly string[] | null;
}

/*
 * Base approve rate from off the car, by the public read. Bucket edges are the
 * expected evils aboard under the posterior; below 0.8 essentially never
 * happens, since three or four evils among seven to ten seats put more than
 * that on any normal team.
 */
const READ_EDGES = [1.2, 1.6] as const;
const BASE_APPROVE: Record<PolicyRole, readonly [number, number, number]> = {
  loyal: [0.541, 0.431, 0.305],
  merlin: [0.509, 0.39, 0.228],
  percival: [0.557, 0.416, 0.31],
  evil: [0.569, 0.47, 0.387],
  oberon: [0.49, 0.491, 0.405],
};

/** Riding your own car. Everyone approves it; evil slightly more, Oberon most. */
const APPROVE_ABOARD: Record<PolicyRole, number> = {
  loyal: 0.71,
  merlin: 0.71,
  percival: 0.71,
  evil: 0.705,
  oberon: 0.762,
};

/*
 * Private sight, applied as an odds multiplier on the base rate. Each comes
 * from the same measurement the belief layer uses, expressed as the ratio
 * between what that role does and what an uninformed seat does.
 */
const SEES_EVIL_ABOARD = 0.332 / 0.399; // Merlin, an evil he can see is on it
const SEES_PAIR_BOTH = 0.25 / 0.347; // Percival, both candidates aboard
const SEES_PAIR_ONE = 0.451 / 0.415; // Percival, exactly one
const KNOWS_TEAMMATE_ABOARD = 0.499 / 0.403; // evil, a teammate he can see

const clamp = (p: number) => Math.min(0.97, Math.max(0.03, p));

function bucket(publicRead: number): 0 | 1 | 2 {
  if (publicRead < READ_EDGES[0]) return 0;
  if (publicRead < READ_EDGES[1]) return 1;
  return 2;
}

/**
 * P(this seat approves), given only what this seat knows.
 *
 * `publicRead` is the expected number of evils on the team under the posterior
 * every player shares. Nothing else about the hidden assignment reaches here
 * except through `info`, which is that seat's own sight.
 */
export function approveProbability(
  info: InfoSet,
  team: readonly string[],
  publicRead: number,
): number {
  if (team.includes(info.seat)) return APPROVE_ABOARD[info.role];

  let p = BASE_APPROVE[info.role][bucket(publicRead)];
  const onTeam = new Set(team);

  if (info.role === "merlin") {
    const seen = [...info.visibleEvil].some((id) => onTeam.has(id));
    if (seen) p *= SEES_EVIL_ABOARD;
  } else if (info.role === "percival" && info.pair) {
    const aboard = info.pair.filter((id) => onTeam.has(id)).length;
    if (aboard === 2) p *= SEES_PAIR_BOTH;
    else if (aboard === 1) p *= SEES_PAIR_ONE;
  } else if (info.role === "evil") {
    const teammate = [...info.knownEvil].some((id) => onTeam.has(id));
    if (teammate) p *= KNOWS_TEAMMATE_ABOARD;
  }
  // Oberon gets no overlay: he has no private sight to apply.

  return clamp(p);
}

/*
 * Fail cards. The distribution the belief layer measured is reused directly —
 * it is already P(f | evils aboard, fails needed, score), which is exactly
 * what a generative policy needs, and nothing in it depends on information the
 * players lack.
 */
export { failDistribution } from "@/lib/inference/soft";

/**
 * How a leader picks a team, as a multiplier on the chance rate at which the
 * seats he can see as evil end up on it.
 *
 * Good leaders avoid the ones the TABLE suspects, which is public; the private
 * part is Merlin avoiding those he can see, and evil leaders not avoiding
 * their own teammates as hard.
 */
export const LEADER_LOADING: Record<PolicyRole, number> = {
  loyal: 0.697,
  merlin: 0.365,
  percival: 0.63,
  evil: 0.726,
  oberon: 0.779,
};

/** Leaders ride their own car this often. */
export const LEADER_RIDES: Record<PolicyRole, number> = {
  loyal: 0.923,
  merlin: 0.906,
  percival: 0.923,
  evil: 0.865,
  oberon: 0.85,
};
