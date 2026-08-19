/**
 * The table's shared read, carried as weighted worlds instead of per-seat
 * numbers.
 *
 * The marginal filter this replaces could not sharpen. Against the frozen
 * engine on real games a public read goes from 0.95 bits per seat to 0.51 and
 * its top suspects pull 0.66 clear; the marginal filter went 0.85 to 0.79 and
 * 0.30 to 0.38. Nearly static, and no coefficient fixes it — a failed quest
 * says "at least one of these three", which is a statement about the JOINT,
 * and independent per-seat updates cannot hold one.
 *
 * Every factor here is imported from the frozen Belief V1 likelihood rather
 * than restated. An earlier version had its own copy of the approve rates,
 * which is precisely the second inference model this must not become: two
 * definitions drift the first time either moves.
 *
 * Everything is PUBLIC — particles drawn from the public posterior, updated
 * from public events. Private sight stays with the individual actors.
 */

import {
  failDistribution,
  proposalLogFactor,
  voteLogFactor,
} from "@/lib/inference/soft";
import type { RoleType } from "@/lib/types/game";

const EVIL_ROLE_NAMES = ["morgana", "mordred", "oberon", "assassin", "minion"];

export interface ParticleFilter {
  /** The full casting each particle stands for. */
  worlds: readonly ReadonlyMap<string, RoleType>[];
  /** Evil seats of that casting, precomputed — every factor here reads it. */
  evil: ReadonlySet<string>[];
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
  return {
    worlds,
    evil,
    weights: evil.map(() => 1 / (evil.length || 1)),
    seats,
  };
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

/** Per-seat role probability, for the reads that need more than a side. */
export function roleMarginals(
  filter: ParticleFilter,
): Map<string, Map<RoleType, number>> {
  const out = new Map<string, Map<RoleType, number>>();
  for (const seat of filter.seats) out.set(seat, new Map());
  let total = 0;
  for (let j = 0; j < filter.weights.length; j += 1) {
    const w = filter.weights[j];
    if (w <= 0) continue;
    total += w;
    for (const [seat, role] of filter.worlds[j]) {
      const row = out.get(seat);
      if (row) row.set(role, (row.get(role) ?? 0) + w);
    }
  }
  if (total > 0) {
    for (const row of out.values()) {
      for (const [role, mass] of row) row.set(role, mass / total);
    }
  }
  return out;
}

/** Effective sample size, for deciding when the cloud has collapsed. */
export function effectiveSize(weights: readonly number[]): number {
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
 * Systematic resampling: one ordered pass with evenly spaced pointers, which
 * has lower variance than drawing each particle independently.
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
  const picked: number[] = [];
  for (let j = 0; j < n; j += 1) {
    cumulative += filter.weights[j];
    while (picked.length < n && target < cumulative) {
      picked.push(j);
      target += step;
    }
  }
  while (picked.length < n) picked.push(n - 1);

  filter.evil = picked.map((j) => filter.evil[j]);
  filter.worlds = picked.map((j) => filter.worlds[j]);
  filter.weights = filter.weights.map(() => 1 / n);
}

function normalise(filter: ParticleFilter): void {
  let total = 0;
  for (const w of filter.weights) total += w;
  if (total > 0) {
    for (let j = 0; j < filter.weights.length; j += 1) filter.weights[j] /= total;
    return;
  }
  // Every world died: the events contradict the whole cloud, which means the
  // cloud was too small, not that the game is over. Uniform rather than frozen.
  const n = filter.weights.length || 1;
  for (let j = 0; j < filter.weights.length; j += 1) filter.weights[j] = 1 / n;
}

/**
 * Reweight on a quest result.
 *
 * A world that cannot produce the observed count dies here — no evils aboard
 * and a card played is impossible, not merely unlikely. That elimination is
 * the joint constraint the marginal filter could not hold.
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
    if (failCards > aboard) {
      // More cards than there are hands to play them. Not unlikely — the hard
      // layer of the frozen engine removes this world outright, and since the
      // cloud was drawn before this quest resolved, the filter must do it here.
      filter.weights[j] = 0;
      continue;
    }
    // An unseen combination contributes nothing rather than killing the world,
    // exactly as the frozen scorer treats it: unobserved is not ruled out.
    const q = failDistribution(aboard, requiredFails, successes, fails)[failCards];
    if (q !== undefined) filter.weights[j] *= Math.max(q, 1e-4);
  }
  normalise(filter);
  maybeResample(filter, rng);
}

/** Reweight on a vote, through the frozen per-seat vote factor. */
export function updateOnVotes(
  filter: ParticleFilter,
  team: readonly string[],
  votes: ReadonlyMap<string, boolean>,
  missionNumber: number,
  rng: () => number,
): void {
  for (let j = 0; j < filter.weights.length; j += 1) {
    if (filter.weights[j] <= 0) continue;
    const evilAboard = team.filter((seat) => filter.evil[j].has(seat)).length;
    let logL = 0;
    for (const [seat, approved] of votes) {
      logL += voteLogFactor(
        filter.evil[j].has(seat),
        team.includes(seat),
        evilAboard,
        approved,
        missionNumber,
      );
    }
    filter.weights[j] *= Math.exp(logL);
  }
  normalise(filter);
  maybeResample(filter, rng);
}

/** Reweight on a team being put up, through the frozen proposal factor. */
export function updateOnProposal(
  filter: ParticleFilter,
  leader: string,
  team: readonly string[],
  missionNumber: number,
  playerCount: number,
  rng: () => number,
): void {
  for (let j = 0; j < filter.weights.length; j += 1) {
    if (filter.weights[j] <= 0) continue;
    filter.weights[j] *= Math.exp(
      proposalLogFactor(
        [...filter.evil[j]],
        leader,
        team,
        missionNumber,
        playerCount,
      ),
    );
  }
  normalise(filter);
  maybeResample(filter, rng);
}
