/**
 * Drawing whole role assignments from the frozen Belief V1 posterior.
 *
 * A rollout needs complete worlds, not marginals. This takes them from the
 * same enumeration the belief engine already runs, through its read-only tap,
 * so there is exactly one definition of the joint distribution. A second copy
 * of that loop would drift the first time either side changed, and the whole
 * point of freezing the engine is that nothing quietly disagrees with it.
 *
 * `sampler.test.ts` closes the loop the other way: it checks by Monte Carlo
 * that the sampled marginals reproduce the engine's reported ones.
 */

import { computeRolesWith } from "@/lib/inference/roles";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, RoleType } from "@/lib/types/game";

export type Assignment = ReadonlyMap<string, RoleType>;

/** Deterministic PRNG, so a rollout can be replayed exactly. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Two passes, systematic sampling, exact.
 *
 * The first pass records every casting weight; the second walks the cumulative
 * sum and materialises the castings the draw positions land in. That gives
 * i.i.d. draws proportional to weight — sampling WITH replacement — which is
 * what an expectation over worlds needs.
 *
 * A single-pass weighted reservoir was tried first and is wrong here: it
 * samples WITHOUT replacement, so its marginals are not the posterior. The
 * error was visible immediately — 0.068 off on a nine-player game where the
 * sampling error is 0.007, about nine standard errors, which is why the test
 * that ties this to the frozen marginals exists.
 *
 * Two enumerations cost roughly twice one. The rollout draws once per decision
 * state and reuses the worlds across every candidate action, which it wants
 * anyway for common random numbers.
 */
export function sampleAssignments(
  events: readonly GameEvent[],
  game: GameRecord,
  count: number,
  rng: () => number,
): Assignment[] {
  const weights: number[] = [];
  computeRolesWith(events as GameEvent[], game, {
    onAssignment: (weight) => {
      weights.push(weight);
    },
  });

  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0 || weights.length === 0) return [];

  // Draw positions first, sorted, so one ordered walk serves them all.
  const targets = Array.from({ length: count }, () => rng() * total).sort(
    (a, b) => a - b,
  );

  const out: Assignment[] = [];
  let cumulative = 0;
  let next = 0;
  computeRolesWith(events as GameEvent[], game, {
    onAssignment: (weight, materialise) => {
      if (next >= targets.length) return;
      const before = cumulative;
      cumulative += weight;
      // Materialise once and reuse it for every target inside this casting;
      // the enumerator mutates one map as it backtracks, so it must be copied
      // here rather than deferred.
      let built: Map<string, RoleType> | null = null;
      while (next < targets.length && targets[next] >= before && targets[next] < cumulative) {
        built ??= materialise();
        out.push(built);
        next += 1;
      }
    },
  });

  return out;
}

