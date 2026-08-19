/**
 * How a leader picks a car.
 *
 * The rule this replaces built the team one seat at a time, drawing each pick
 * from weights proportional to how clean that seat looked. Two things are
 * wrong with that. It cannot express "these two are fine apart and alarming
 * together", which is most of what a real leader is avoiding; and drawing
 * seat by seat from a soft distribution keeps handing out slots to seats the
 * leader would never take, so the simulated table stayed near-random when real
 * leaders sharpen hard. Matched against real proposals on identical public
 * posteriors, the old rule put a high-risk seat on the car 0.33 of the time in
 * round two where real good leaders were at 0.20, and its teams sat at the
 * 40th percentile of legal-team risk where real ones sit at the 22nd.
 *
 * So the choice is made over WHOLE TEAMS:
 *
 *     P(T | H, I_leader) ∝ exp(U(T))
 *     U_good(T) = −β_r · risk(T) + γ_r · [leader ∈ T]
 *     U_evil(T) = −β_r^E · publicRisk(T) + η_r · |T ∩ knownEvil| + γ_r · [leader ∈ T]
 *
 * `risk(T)` is a JOINT quantity — the posterior probability that the team
 * carries enough evils to fail the quest — not a sum of per-seat numbers. The
 * expectation of a sum is the sum of expectations no matter how the seats
 * correlate, so a linear risk cannot see the correlation at all; the threshold
 * probability is the whole reason for carrying particles.
 *
 * Every input is either public or the leader's own legitimate sight. Oberon
 * knows no teammates and this file gives him none.
 *
 * One thing fell out rather than being put in: a good leader knows he is good,
 * so restricting the cloud to his own information set drives his own seat to
 * zero risk, and the risk term alone already wants him aboard. γ came out near
 * zero — even slightly negative in rounds two and three — because riding was
 * never a separate preference to begin with.
 */

import type { InfoSet } from "./policy";
import type { ParticleFilter } from "./particle-filter";

export interface ProposalParams {
  /** β by round: how hard a good leader avoids risk. */
  goodRisk: readonly number[];
  /** β^E by round: how hard an evil leader keeps the car looking clean. */
  evilRisk: readonly number[];
  /**
   * η by round: how much an evil leader wants a teammate aboard.
   *
   * It came out NEGATIVE at every round. Real evil leaders take a teammate
   * less often than a policy that merely minimises public risk stumbles into —
   * by round five they are at 0.59 of chance where risk-minimisation alone
   * gives 0.84. They are hiding, not stacking, and the sign says so.
   */
  evilGain: readonly number[];
  /** γ by round: the pull of riding your own car. Evil rides less, and the
   * gap is real — 0.71 against 0.88 in round three — so it gets its own row. */
  ride: readonly number[];
  rideEvil: readonly number[];
}

/**
 * Fitted on train+validation by matching real leaders on matched inputs — the
 * same table, the same round, the same public posterior — against three public
 * statistics: where the chosen team sits among all legal teams by risk, how
 * often the leader rides, and how often he takes a seat the table already
 * suspects. Ground-truth roles were used only to split good from evil.
 */
export const DEFAULT_PROPOSAL: ProposalParams = {
  goodRisk: [10.84, 38.84, 28.17, 20.17, 14.08],
  // Round one is unidentified: with no evidence yet every legal team carries
  // the same risk, so beta cannot be read off the choice. Zero, not fitted.
  evilRisk: [0, 39.43, 15.83, 16.67, 12.5],
  evilGain: [-0.16, -0.74, -0.3, -0.58, -0.77],
  ride: [0.66, -0.62, -0.57, 1.49, 1.68],
  rideEvil: [2.34, 2.32, 1.53, 2.44, 2.41],
};

/** Teams of `size` seats, as bitmasks over seat index. Cached per (n, size). */
const teamCache = new Map<string, number[]>();

export function legalTeams(n: number, size: number): number[] {
  const key = `${n}:${size}`;
  const hit = teamCache.get(key);
  if (hit) return hit;
  const out: number[] = [];
  const walk = (start: number, left: number, mask: number) => {
    if (left === 0) {
      out.push(mask);
      return;
    }
    for (let i = start; i <= n - left; i += 1) walk(i + 1, left - 1, mask | (1 << i));
  };
  walk(0, size, 0);
  teamCache.set(key, out);
  return out;
}

function popcount(x: number): number {
  let v = x - ((x >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * The cloud as (evil bitmask → weight), restricted to the worlds this leader's
 * own sight allows and renormalised.
 *
 * Restricting rather than re-inferring is the point: the particles already
 * carry the public posterior, and a leader's private knowledge is exactly a
 * statement about which of those worlds are still live for him. Merlin's
 * blindness to Mordred and Oberon's blindness to everyone fall out of the
 * information set instead of being special-cased here.
 */
export function leaderView(
  filter: ParticleFilter,
  seats: readonly string[],
  info: InfoSet | undefined,
): Map<number, number> {
  const index = new Map<string, number>();
  seats.forEach((seat, i) => index.set(seat, i));
  const out = new Map<number, number>();
  let total = 0;

  for (let j = 0; j < filter.weights.length; j += 1) {
    const w = filter.weights[j];
    if (w <= 0) continue;
    const evil = filter.evil[j];

    if (info) {
      const selfEvil = evil.has(info.seat);
      if (info.side === "evil" !== selfEvil) continue;
      // Merlin's sightings and an evil's teammates must actually be evil here.
      let ok = true;
      for (const seen of info.visibleEvil) if (!evil.has(seen)) { ok = false; break; }
      if (ok) {
        for (const mate of info.knownEvil) if (!evil.has(mate)) { ok = false; break; }
      }
      if (ok && info.pair) {
        // Percival was shown two seats and told one is Merlin. He does not
        // know which, so both orderings stay live and nothing else does.
        const world = filter.worlds[j];
        const a = world.get(info.pair[0]);
        const b = world.get(info.pair[1]);
        ok =
          (a === "merlin" && b === "morgana") || (a === "morgana" && b === "merlin");
      }
      if (!ok) continue;
    }

    let mask = 0;
    for (const seat of evil) {
      const i = index.get(seat);
      if (i !== undefined) mask |= 1 << i;
    }
    out.set(mask, (out.get(mask) ?? 0) + w);
    total += w;
  }

  if (total <= 0) return new Map();
  for (const [mask, w] of out) out.set(mask, w / total);
  return out;
}

/**
 * P(the team carries enough evils to fail this quest), per legal team.
 *
 * Indexed the same way as `legalTeams(n, size)`.
 */
export function teamRisk(
  view: ReadonlyMap<number, number>,
  teams: readonly number[],
  need: number,
): number[] {
  const out = new Array<number>(teams.length).fill(0);
  for (const [evilMask, w] of view) {
    if (w <= 0) continue;
    for (let t = 0; t < teams.length; t += 1) {
      if (popcount(teams[t] & evilMask) >= need) out[t] += w;
    }
  }
  return out;
}

/** Draw a team from the softmax over legal teams. */
export function chooseTeam(
  seats: readonly string[],
  size: number,
  need: number,
  leader: string,
  info: InfoSet | undefined,
  filter: ParticleFilter,
  round: number,
  rng: () => number,
  params: ProposalParams = DEFAULT_PROPOSAL,
): string[] {
  const n = seats.length;
  const teams = legalTeams(n, size);
  if (!teams.length) return seats.slice(0, size);
  const r = Math.min(Math.max(round, 1), 5) - 1;
  const leaderBit = 1 << Math.max(0, seats.indexOf(leader));

  const evilLeader = info?.side === "evil";
  // An evil leader reads the risk the TABLE will read, because his problem is
  // getting the car approved, not avoiding his own people. A good leader reads
  // his own, which for Merlin and Percival is sharper than the public one.
  const view = leaderView(filter, seats, evilLeader ? undefined : info);
  const risk = teamRisk(view, teams, need);

  let mateMask = 0;
  if (evilLeader && info) {
    for (const mate of info.knownEvil) {
      const i = seats.indexOf(mate);
      if (i >= 0) mateMask |= 1 << i;
    }
  }

  const beta = evilLeader ? params.evilRisk[r] : params.goodRisk[r];
  const gain = evilLeader ? params.evilGain[r] : 0;
  const gamma = (evilLeader ? params.rideEvil : params.ride)[r];

  let best = -Infinity;
  const utility = new Array<number>(teams.length);
  for (let t = 0; t < teams.length; t += 1) {
    let u = -beta * risk[t] + (teams[t] & leaderBit ? gamma : 0);
    if (gain) u += gain * popcount(teams[t] & mateMask);
    utility[t] = u;
    if (u > best) best = u;
  }

  let total = 0;
  for (let t = 0; t < teams.length; t += 1) {
    utility[t] = Math.exp(utility[t] - best);
    total += utility[t];
  }

  let target = rng() * total;
  let pick = teams.length - 1;
  for (let t = 0; t < teams.length; t += 1) {
    target -= utility[t];
    if (target <= 0) {
      pick = t;
      break;
    }
  }

  const chosen: string[] = [];
  for (let i = 0; i < n; i += 1) if (teams[pick] & (1 << i)) chosen.push(seats[i]);
  return chosen;
}
