/**
 * The table's shared read, updated as a simulated game unfolds.
 *
 * The rollout cannot re-run the frozen enumeration after every simulated
 * event — that is 84 to 210 worlds re-scored per proposal, inside a loop that
 * already runs hundreds of games. But leaving the read frozen was worse than
 * an approximation: it left the simulated table as blind on the last quest as
 * on the first, so evil kept riding teams nobody had learned to avoid, and
 * good won about half as often as it should.
 *
 * So this keeps only what the policies actually consume: one public Evil
 * marginal per seat. It is a filter, not the belief engine, and it says so —
 * seats are treated as independent apart from a renormalisation that holds the
 * total to the number of evils the rules demand.
 *
 * Everything here is PUBLIC. Private sight belongs to individual actors and is
 * layered on by the policy; nothing in this file may see it, or five strangers
 * end up voting on what Merlin knows.
 *
 * The evidence structure is the one Belief V1 validated: a quest's fail count
 * against the measured distribution, and a vote against the measured approve
 * rates, damped by the dispersion that layer also measured.
 */

import { failDistribution } from "@/lib/inference/soft";

/** How correlated votes are, by round. Belief V1 measured these. */
const VOTE_DISPERSION: Record<number, number> = {
  1: 2.03,
  2: 1.83,
  3: 1.78,
  4: 1.52,
  5: 1.41,
};

/**
 * Approve rate by side, for the filter's vote update.
 *
 * Deliberately mild. A vote is weak evidence, it is correlated with every
 * other vote on the same proposal, and this filter has none of the machinery
 * that let the belief layer take votes seriously.
 */
const APPROVE_IF_EVIL = { dirty: 0.499, clean: 0.403 };
const APPROVE_IF_GOOD = { dirty: 0.396, clean: 0.598 };

export type Read = Map<string, number>;

/** Distribution of how many of `seats` are evil, treating them independently. */
function evilCountDistribution(seats: readonly string[], read: Read): number[] {
  let dist = [1];
  for (const seat of seats) {
    const q = Math.min(0.999, Math.max(0.001, read.get(seat) ?? 0));
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k += 1) {
      next[k] += dist[k] * (1 - q);
      next[k + 1] += dist[k] * q;
    }
    dist = next;
  }
  return dist;
}

/**
 * Holds the total to the number of evils the rules put at this table.
 *
 * Independent per-seat updates do not conserve it, and letting it drift means
 * team risk stops being comparable across rounds — which is the one thing the
 * policies read this for.
 */
function renormalise(read: Read, evilTotal: number): void {
  let sum = 0;
  for (const q of read.values()) sum += q;
  if (sum <= 0) return;
  const scale = evilTotal / sum;
  for (const [seat, q] of read) {
    read.set(seat, Math.min(0.98, Math.max(0.02, q * scale)));
  }
}

/**
 * Update after a quest comes back.
 *
 * The sharpest evidence in the game, and the first thing worth filtering: for
 * each rider, how much likelier is this fail count if they were evil.
 */
export function applyMissionResult(
  read: Read,
  team: readonly string[],
  failCards: number,
  requiredFails: number,
  successes: number,
  fails: number,
  evilTotal: number,
): void {
  for (const seat of team) {
    const others = team.filter((s) => s !== seat);
    const dist = evilCountDistribution(others, read);

    let ifEvil = 0;
    let ifGood = 0;
    for (let m = 0; m < dist.length; m += 1) {
      if (dist[m] <= 0) continue;
      const asEvil = failDistribution(m + 1, requiredFails, successes, fails);
      const asGood = m > 0
        ? failDistribution(m, requiredFails, successes, fails)
        : null;
      ifEvil += dist[m] * (asEvil[failCards] ?? 1e-4);
      // With no evil aboard at all the only possible count is zero.
      ifGood += dist[m] * (asGood ? (asGood[failCards] ?? 1e-4) : failCards === 0 ? 1 : 1e-4);
    }
    if (ifEvil <= 0 || ifGood <= 0) continue;

    const q = read.get(seat) ?? 0;
    const odds = (q / (1 - q)) * (ifEvil / ifGood);
    read.set(seat, odds / (1 + odds));
  }
  renormalise(read, evilTotal);
}

/**
 * Update after a vote.
 *
 * Divided by the round's dispersion, for the reason Belief V1 found: everyone
 * heard the same discussion, so n votes on one proposal are worth about n/phi
 * independent observations, not n.
 */
export function applyVotes(
  read: Read,
  team: readonly string[],
  votes: ReadonlyMap<string, boolean>,
  missionNumber: number,
  evilTotal: number,
): void {
  const teamRisk = team.reduce((sum, seat) => sum + (read.get(seat) ?? 0), 0);
  const dirty = teamRisk >= 1;
  const phi = VOTE_DISPERSION[missionNumber] ?? 1.78;

  for (const [seat, approved] of votes) {
    // A rider votes their own interest; it says little about their side.
    if (team.includes(seat)) continue;
    const key = dirty ? "dirty" : "clean";
    const pEvil = approved ? APPROVE_IF_EVIL[key] : 1 - APPROVE_IF_EVIL[key];
    const pGood = approved ? APPROVE_IF_GOOD[key] : 1 - APPROVE_IF_GOOD[key];
    const q = read.get(seat) ?? 0;
    const odds = (q / (1 - q)) * Math.pow(pEvil / pGood, 1 / phi);
    read.set(seat, odds / (1 + odds));
  }
  renormalise(read, evilTotal);
}
