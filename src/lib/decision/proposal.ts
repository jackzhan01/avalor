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

/**
 * What the public log says about each seat, carried through a game.
 *
 * Every field is readable by anyone at the table. Masks are over seat index.
 */
export interface ProposalHistory {
  rodeSuccess: number;
  rodeFail: number;
  everRode: number;
  lastSuccess: number;
  lastFail: number;
  /** Masks of teams the table has approved. */
  approved: number[];
  aboardTotal: number[];
  aboardPassed: number[];
  votes: number[];
  agreed: number[];
  /** Seats that rode a failed quest together, as (a << 4) | b with a < b. */
  failPairs: Set<number>;
}

export function emptyHistory(n: number): ProposalHistory {
  return {
    rodeSuccess: 0,
    rodeFail: 0,
    everRode: 0,
    lastSuccess: 0,
    lastFail: 0,
    approved: [],
    aboardTotal: new Array(n).fill(0),
    aboardPassed: new Array(n).fill(0),
    votes: new Array(n).fill(0),
    agreed: new Array(n).fill(0),
    failPairs: new Set(),
  };
}

export function noteVote(
  h: ProposalHistory,
  teamMask: number,
  approvedBy: number,
  passed: boolean,
  n: number,
): void {
  for (let s = 0; s < n; s += 1) {
    if (teamMask & (1 << s)) {
      h.aboardTotal[s] += 1;
      if (passed) h.aboardPassed[s] += 1;
    }
    h.votes[s] += 1;
    if (((approvedBy & (1 << s)) !== 0) === passed) h.agreed[s] += 1;
  }
  if (passed) h.approved.push(teamMask);
}

export function noteMission(
  h: ProposalHistory,
  teamMask: number,
  success: boolean,
  n: number,
): void {
  h.everRode |= teamMask;
  if (success) {
    h.rodeSuccess |= teamMask;
    h.lastSuccess = teamMask;
    return;
  }
  h.rodeFail |= teamMask;
  h.lastFail = teamMask;
  for (let a = 0; a < n; a += 1) {
    if (!(teamMask & (1 << a))) continue;
    for (let b = a + 1; b < n; b += 1) {
      if (teamMask & (1 << b)) h.failPairs.add((a << 4) | b);
    }
  }
}

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
  /**
   * Merlin, who is solving a harder problem than a loyal leader.
   *
   * He does use his sight — his car sits at the 12th percentile of what HE can
   * see in round one and the 2nd by round five, where a loyal leader stays
   * flat near the 15th. But he does not spend it freely: given a legal car
   * with none of the evils he can see, he takes one anyway 42% of the time in
   * round one, 25% in round three, and only stops at 13% in round five.
   *
   * The first guess was camouflage — that he deliberately picks ordinary
   * looking cars to avoid naming himself. The data says something simpler and
   * stricter. Fitting beta alone against his private percentile produces cars
   * sitting at the 45th public percentile in round two, where real Merlins are
   * at the 26th. He is not buying ordinariness; he is refusing to hand the
   * table a car it will not approve. So he carries BOTH terms — his own risk
   * and the risk everyone else can see — and lambda is the weight on the
   * second. That is where the unspent sight goes.
   */
  merlinRisk: readonly number[];
  merlinPublic: readonly number[];
  historyRisk: readonly number[];
  historyRide: readonly number[];
  /**
   * Which model the uninformed good leaders use.
   *
   * "moment" reproduces where their car lands in the risk ordering and how
   * often they ride. "mle" fits the same two terms to the actual choice, over
   * all legal teams. "history" adds the composition features below.
   */
  goodModel: "moment" | "mle" | "history";
  /** Risk and ride again, by round, fitted by maximum likelihood. */
  mleRisk: readonly number[];
  mleRide: readonly number[];
  /** The nine history features, pooled across rounds. Order matches below. */
  history: readonly number[];
}

/**
 * Fitted on train+validation by matching real leaders on matched inputs — the
 * same table, the same round, the same public posterior — against public
 * statistics of the choice: where the chosen team sits among all legal teams
 * by risk, and how often the leader rides. Ground-truth roles were used only
 * to split the fit by who the leader was, never as an input to the choice.
 *
 * Percival is fitted with the loyal leaders and not separately. Knowing one of
 * two seats is Morgana does not say which, and it shows: his chosen cars sit
 * at the 16th percentile of his own restricted posterior against a loyal
 * leader's 15th. He has sight that does not help him pick.
 */
export const DEFAULT_PROPOSAL: ProposalParams = {
  goodRisk: [4.92, 39.54, 21.6, 18.66, 12.76],
  // Round one is unidentified: with no evidence yet every legal team carries
  // the same risk, so beta cannot be read off the choice. Zero, not fitted.
  evilRisk: [0, 43.01, 16.05, 16.4, 12.5],
  evilGain: [-0.14, -0.68, -0.25, -0.56, -0.77],
  ride: [1.75, -2, -0.41, 1.56, 2.43],
  rideEvil: [2.36, 2.36, 1.69, 2.31, 2.41],
  merlinRisk: [1.83, 5.18, 4.72, 3.81, 5.53],
  // Falls to nothing by round five: he defers to the table early and plays
  // his own read when the game is on the line.
  merlinPublic: [28.89, 41.34, 17.52, 13.29, 0],
  /*
   * Left on "moment" deliberately, and it is the worse PREDICTOR.
   *
   * The history features beat it soundly at guessing the next car — held-out
   * log-likelihood -3.268 against -3.573, the real team ranked first 0.204 of
   * the time against 0.144. They did not buy back any of the late-round
   * loading decline; they cost a little of it. What they learn is habit —
   * reuse the car that just worked, do not reach for someone nobody has
   * tested — which predicts a leader without making him better at spotting an
   * evil. Since the simulator exists to produce realistic GAMES rather than
   * realistic guesses at single proposals, the moment fit stays.
   *
   * The other two are kept runnable, not dead: research/good-model-sweep.
   */
  goodModel: "moment",
  mleRisk: [-0.043, -4.931, -6.018, -5.614, -5.105],
  mleRide: [2.942, 2.175, 1.406, 2.698, 2.966],
  // With the history terms carrying part of it, risk needs much less weight:
  // "rode the quest that failed" is most of what drives posterior risk anyway.
  historyRisk: [-0.038, -1.478, -2.307, -3.447, -3.743],
  historyRide: [2.971, 2.918, 2.116, 2.894, 3.006],
  history: [-0.771, -2.483, 4.107, -1.479, 2.385, -0.71, -0.077, -2.165, -2.702],
};

/**
 * The nine composition features of a team, in the order `history` weights them.
 *
 * Fitted on train+validation as a conditional logit over every legal team, and
 * they earn their place: held-out log-likelihood per proposal goes from -3.573
 * to -3.268 and the real team is ranked first 0.204 of the time against 0.144.
 * See research/history-features.test.ts.
 */
export function historyFeatures(
  team: number,
  size: number,
  h: ProposalHistory,
  n: number,
  out: number[],
): void {
  out[0] = popcount(team & h.rodeSuccess) / size;
  out[1] = popcount(team & h.rodeFail) / size;
  out[2] = h.lastSuccess ? popcount(team & h.lastSuccess) / size : 0;
  out[3] = h.lastFail ? popcount(team & h.lastFail) / size : 0;
  let best = 0;
  for (const a of h.approved) {
    const o = popcount(team & a) / size;
    if (o > best) best = o;
  }
  out[4] = best;
  let pairs = 0;
  for (const key of h.failPairs) {
    if (team & (1 << (key >> 4)) && team & (1 << (key & 15))) pairs += 1;
  }
  out[5] = size > 1 ? pairs / ((size * (size - 1)) / 2) : 0;
  let agree = 0;
  let passRate = 0;
  let never = 0;
  for (let s = 0; s < n; s += 1) {
    if (!(team & (1 << s))) continue;
    agree += h.votes[s] > 0 ? h.agreed[s] / h.votes[s] : 0.5;
    passRate += h.aboardTotal[s] > 0 ? h.aboardPassed[s] / h.aboardTotal[s] : 0.5;
    if (!(h.everRode & (1 << s))) never += 1;
  }
  out[6] = agree / size;
  out[7] = passRate / size;
  out[8] = never / size;
}

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
  history?: ProposalHistory,
): string[] {
  const n = seats.length;
  const teams = legalTeams(n, size);
  if (!teams.length) return seats.slice(0, size);
  const r = Math.min(Math.max(round, 1), 5) - 1;
  const leaderBit = 1 << Math.max(0, seats.indexOf(leader));

  const evilLeader = info?.side === "evil";
  const merlin = info?.role === "merlin";
  // An evil leader reads the risk the TABLE will read, because his problem is
  // getting the car approved, not avoiding his own people. A good leader reads
  // his own — which for Merlin is a great deal sharper, and for Percival is
  // barely different from public, since knowing one of two seats is Morgana
  // does not say which.
  const view = leaderView(filter, seats, evilLeader ? undefined : info);
  const risk = teamRisk(view, teams, need);
  // What the table will read off this car, which Merlin has to manage.
  const seen = merlin
    ? teamRisk(leaderView(filter, seats, undefined), teams, need)
    : null;

  let mateMask = 0;
  if (evilLeader && info) {
    for (const mate of info.knownEvil) {
      const i = seats.indexOf(mate);
      if (i >= 0) mateMask |= 1 << i;
    }
  }

  // Uninformed good leaders can run any of the three fits; the others are
  // moment-matched and stay that way.
  const plain = !evilLeader && !merlin;
  const useHistory = plain && params.goodModel === "history" && !!history;
  const beta = evilLeader
    ? params.evilRisk[r]
    : merlin
      ? params.merlinRisk[r]
      : useHistory
        ? -params.historyRisk[r]
        : params.goodModel === "mle"
          ? -params.mleRisk[r]
          : params.goodRisk[r];
  const gain = evilLeader ? params.evilGain[r] : 0;
  const publicWeight = merlin ? params.merlinPublic[r] : 0;
  const gamma = evilLeader
    ? params.rideEvil[r]
    : plain && useHistory
      ? params.historyRide[r]
      : plain && params.goodModel === "mle"
        ? params.mleRide[r]
        : params.ride[r];
  const feats = useHistory ? new Array<number>(9).fill(0) : null;

  let best = -Infinity;
  const utility = new Array<number>(teams.length);
  for (let t = 0; t < teams.length; t += 1) {
    let u = -beta * risk[t] + (teams[t] & leaderBit ? gamma : 0);
    if (gain) u += gain * popcount(teams[t] & mateMask);
    if (seen) u -= publicWeight * seen[t];
    if (feats && history) {
      historyFeatures(teams[t], size, history, n, feats);
      for (let k = 0; k < 9; k += 1) u += params.history[k] * feats[k];
    }
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
