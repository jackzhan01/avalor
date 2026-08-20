/**
 * Social evidence entering the belief, as evidence rather than as an answer.
 *
 * The old rollout took a per-seat cue and blended it into the marginals after
 * the fact. That could not work: a blend is not a likelihood, it does not
 * survive contact with the joint, and — once team selection moved onto the
 * particle cloud — the leaders stopped seeing it at all, which is why the cue
 * strength went inert.
 *
 * Here talk is a likelihood over WORLDS, the same as everything else the
 * filter absorbs. If `l_s` is the log-likelihood ratio for seat s being evil,
 * a world's weight is multiplied by exp(sum of l_s over its evil seats): the
 * terms for good seats are common to every world and cancel in the
 * normalisation. So the cloud stays a posterior, and risk, team choice and
 * votes all see the same thing.
 */

import type { ParticleFilter } from "./particle-filter";

export function applySocial(
  filter: ParticleFilter,
  logOdds: ReadonlyMap<string, number>,
): void {
  if (logOdds.size === 0) return;

  let total = 0;
  for (let j = 0; j < filter.weights.length; j += 1) {
    if (filter.weights[j] <= 0) continue;
    let logL = 0;
    for (const seat of filter.evil[j]) logL += logOdds.get(seat) ?? 0;
    filter.weights[j] *= Math.exp(logL);
    total += filter.weights[j];
  }

  if (total > 0) {
    for (let j = 0; j < filter.weights.length; j += 1) filter.weights[j] /= total;
    return;
  }
  const n = filter.weights.length || 1;
  for (let j = 0; j < filter.weights.length; j += 1) filter.weights[j] = 1 / n;
}
