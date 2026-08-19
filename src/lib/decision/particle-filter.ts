/**
 * The table's shared read, carried as weighted worlds instead of per-seat
 * numbers.
 *
 * The marginal filter this replaces could not sharpen. Measured against the
 * frozen engine on real games, a public read goes from 0.95 bits per seat at
 * round one to 0.51 by round five, and its top suspects pull 0.66 clear of the
 * rest; the marginal filter went 0.85 to 0.79 and 0.30 to 0.38. Nearly static.
 *
 * No coefficient fixes that, because the problem is the representation. A
 * failed quest says "at least one of these three", which is a statement about
 * the JOINT — and independent per-seat updates cannot hold a statement about
 * the joint. Worse, renormalising the marginals back to the right total pulls
 * whatever separation an update did buy straight back toward the mean.
 *
 * So the filter keeps particles: legal assignments drawn from the frozen
 * posterior, reweighted by the same likelihood factors Belief V1 uses. The
 * marginals the policies read are derived from the weights rather than
 * maintained beside them, so the joint constraint survives by construction.
 *
 * Every particle here is PUBLIC — drawn from the public posterior, updated
 * from public events. Private sight stays with the individual actors.
 */

import { failDistribution } from "@/lib/inference/soft";
import type { RoleType } from "@/lib/types/game";

const EVIL_ROLE_NAMES = ["morgana", "mordred", "oberon", "assassin", "minion"];

/** How correlated votes are, by round. Belief V1 measured these. */
const VOTE_DISPERSION: Record<number, number> = {
  1: 2.03,
  2: 1.83,
  3: 1.78,
  4: 1.52,
  5: 1.41,
};
const APPROVE_IF_EVIL = { dirty: 0.499, clean: 0.403 };
const APPROVE_IF_GOOD = { dirty: 0.396, clean: 0.598 };

export interface ParticleFilter {
  /** Seat sets, one per particle. */
  readonly evil: ReadonlySet<string>[];
  weights: number[];
  readonly seats: readonly string[];
}

export function createFilter(
  worlds: readonly ReadonlyMap<string, RoleType>[],
  seats: readonly string[],
): ParticleFilter {
  const evil = worlds.map((world) => {
    const set = new Set<string>();
    for (const [seat, role] of world) {
      if (EVIL_ROLE_NAMES.includes(role)) set.add(seat);
    }
    return set as ReadonlySet<string>;
  });
  return { evil, weights: evil.map(() => 1 / (evil.length || 1)), seats };
}

/** Per-seat public Evil probability, read off the weights. */
export function marginals(filter: ParticleFilter): Map<string, number> {
  const out = new Map<string, number>();
  for (const seat of filter.seats) out.set(seat, 0);
  let total = 0;
  for (let j = 0; j < filter.weights.length; j += 1) {
    const w = filter.weights[j];
    if (w <= 0) continue;
    total += w;
    for (const seat of filter.evil[j]) out.set(seat, (out.get(seat) ?? 0) + w);
  }
  if (total > 0) {
    for (const [seat, mass] of out) out.set(seat, mass / total);
  }
  return out;
}

/** Effective sample size, for deciding when the cloud has collapsed. */
function effectiveSize(weights: readonly number[]): number {
  let sum = 0;
  let sumSq = 0;
  for (const w of weights) {
    sum += w;
    sumSq += w * w;
  }
  return sumSq > 0 ? (sum * sum) / sumSq : 0;
}

/**
 * Resample when the cloud has collapsed onto a handful of particles.
 *
 * Systematic resampling, one ordered pass, which has lower variance than
 * drawing each particle independently.
 */
function maybeResample(filter: ParticleFilter, rng: () => number): void {
  const n = filter.weights.length;
  if (n === 0 || effectiveSize(filter.weights) > n / 2) return;

  let total = 0;
  for (const w of filter.weights) total += w;
  if (total <= 0) {
    filter.weights = filter.weights.map(() => 1 / n);
    return;
  }

  const step = total / n;
  let target = rng() * step;
  let cumulative = 0;
  let index = 0;
  const picked: number[] = [];
  for (let j = 0; j < n; j += 1) {
    cumulative += filter.weights[j];
    while (picked.length < n && target < cumulative) {
      picked.push(j);
      target += step;
    }
    index = j;
  }
  void index;
  while (picked.length < n) picked.push(n - 1);

  const evil = filter.evil as ReadonlySet<string>[];
  const resampled = picked.map((j) => evil[j]);
  for (let j = 0; j < n; j += 1) evil[j] = resampled[j];
  filter.weights = filter.weights.map(() => 1 / n);
}

/**
 * Reweight on a quest result.
 *
 * The likelihood is exactly the one Belief V1 scores with: how probable this
 * many fail cards is, given how many evils THIS world puts on that team. A
 * world that cannot produce the count — no evils aboard and a card played —
 * dies here, which is the joint constraint the marginal filter could not hold.
 */
export function updateOnMission(
  filter: ParticleFilter,
  team: readonly string[],
  failCards: number,
  requiredFails: number,
  successes: number,
  fails: number,
  rng: () => number,
): void {
  for (let j = 0; j < filter.weights.length; j += 1) {
    if (filter.weights[j] <= 0) continue;
    const aboard = team.filter((seat) => filter.evil[j].has(seat)).length;
    let likelihood: number;
    if (aboard === 0) {
      likelihood = failCards === 0 ? 1 : 0;
    } else {
      const dist = failDistribution(aboard, requiredFails, successes, fails);
      likelihood = dist[failCards] ?? 0;
    }
    filter.weights[j] *= likelihood;
  }
  normalise(filter);
  maybeResample(filter, rng);
}

/** Reweight on a vote, damped by the round's dispersion. */
export function updateOnVotes(
  filter: ParticleFilter,
  team: readonly string[],
  votes: ReadonlyMap<string, boolean>,
  missionNumber: number,
  rng: () => number,
): void {
  const phi = VOTE_DISPERSION[missionNumber] ?? 1.78;
  for (let j = 0; j < filter.weights.length; j += 1) {
    if (filter.weights[j] <= 0) continue;
    const dirty = team.some((seat) => filter.evil[j].has(seat));
    const key = dirty ? "dirty" : "clean";
    let logL = 0;
    for (const [seat, approved] of votes) {
      // A rider votes their own interest; it says little about their side.
      if (team.includes(seat)) continue;
      const isEvil = filter.evil[j].has(seat);
      const p = isEvil
        ? approved ? APPROVE_IF_EVIL[key] : 1 - APPROVE_IF_EVIL[key]
        : approved ? APPROVE_IF_GOOD[key] : 1 - APPROVE_IF_GOOD[key];
      logL += Math.log(Math.max(p, 1e-6));
    }
    filter.weights[j] *= Math.exp(logL / phi);
  }
  normalise(filter);
  maybeResample(filter, rng);
}

function normalise(filter: ParticleFilter): void {
  let total = 0;
  for (const w of filter.weights) total += w;
  if (total > 0) {
    for (let j = 0; j < filter.weights.length; j += 1) filter.weights[j] /= total;
    return;
  }
  // Every world died. That means the simulated events contradict the particle
  // cloud, not that the game is over — fall back to uniform rather than
  // freezing on zeros.
  const n = filter.weights.length || 1;
  for (let j = 0; j < filter.weights.length; j += 1) filter.weights[j] = 1 / n;
}
