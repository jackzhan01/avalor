/**
 * Vote Decision V0: what is this vote worth?
 *
 * Q(a) is estimated by drawing whole worlds from the frozen posterior, playing
 * each of them out with the human-policy model, and counting how often the
 * user's side wins. Both actions are scored on the SAME worlds with the SAME
 * random stream, so their difference carries far less Monte Carlo noise than
 * either level does — which matters when both sit near a half.
 *
 * NOT YET VALID. The base-rate check in research/rollout-calibration.test.ts
 * plays opening positions and gets a good win rate of 0.17 to 0.28 where real
 * games of those sizes run 0.40 to 0.43. Until that closes, no Q from here
 * means anything and none should be shown to anyone.
 *
 * The cause is the first approximation below, and it is not the mild one it
 * was written as. A real table narrows after a quest fails and later teams get
 * cleaner; this one never updates, so every simulated round is as blind as the
 * first, evil keeps riding, and good loses roughly half the games it should.
 * Fixing it means an in-rollout belief update, cheap enough to run per
 * simulated proposal — that is the next piece of work, and it comes before any
 * decision number is reported.
 *
 * Three approximations, all V0, all recorded rather than buried:
 *
 *   The simulated table does not learn. Its public read is taken once from the
 *   decision state and held fixed, because re-deriving the posterior inside
 *   every simulated proposal would cost more than the whole rollout. Late
 *   simulated rounds are therefore less discriminating than real ones, which
 *   shrinks the gap between actions rather than inventing one.
 *
 *   Assassination is a terminal rate, not a model. Reaching three successes
 *   converts to a win at the frequency real games of this shape did — by table
 *   size and whether Percival was dealt, not one flat constant. It CANNOT see
 *   any action that changes how exposed Merlin is, which is exactly what a
 *   good player agonises over, so nothing resting on Merlin's exposure is
 *   inside what this can value.
 *
 *   Simulated players never speak. Everything they do comes from the vote,
 *   proposal and fail-card policies.
 */

import { failDistribution } from "@/lib/inference/soft";
import { deriveSideInference } from "@/lib/inference";
import { evilCount, requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameRecord, PlayerCount } from "@/lib/types/game";
import {
  approveProbability,
  policyRoleOf,
  LEADER_LOADING,
  LEADER_RIDES,
  type InfoSet,
} from "./policy";
import {
  createFilter,
  marginals,
  updateOnMission,
  updateOnVotes,
} from "./particle-filter";
import { publicView } from "./public-view";
import { makeRng, sampleAssignments, type Assignment } from "./sampler";
import type { Action, DecisionState } from "./state";

type Mission = 1 | 2 | 3 | 4 | 5;

/**
 * P(good actually wins | good has completed three missions), measured on the
 * corpus. Keyed by table size and whether Percival is dealt, which is as far
 * as the sample supports.
 */
const TERMINAL_GOOD_WIN: Record<string, number> = {
  "7|true": 0.64,
  "7|false": 0.641,
  "8|true": 0.65,
  "8|false": 0.553,
  "9|true": 0.711,
  "9|false": 0.667,
  "10|true": 0.611,
  "10|false": 0.611,
};
const TERMINAL_FALLBACK = 0.648;

function terminalGoodWin(game: GameRecord, assignment: Assignment): number {
  const hasPercival = [...assignment.values()].includes("percival");
  return TERMINAL_GOOD_WIN[game.playerCount + "|" + hasPercival] ?? TERMINAL_FALLBACK;
}

const EVIL_ROLE_NAMES = ["morgana", "mordred", "oberon", "assassin", "minion"];

/** Each seat's own sight under this world. Nobody gets more than their role gives. */
function informationSets(assignment: Assignment): Map<string, InfoSet> {
  const evilSeats: string[] = [];
  let merlinSeat = "";
  let morganaSeat = "";
  let mordredSeat = "";
  for (const [seat, role] of assignment) {
    if (role === "merlin") merlinSeat = seat;
    else if (role === "morgana") morganaSeat = seat;
    else if (role === "mordred") mordredSeat = seat;
    if (EVIL_ROLE_NAMES.includes(role)) evilSeats.push(seat);
  }

  const out = new Map<string, InfoSet>();
  for (const [seat, role] of assignment) {
    const side: "good" | "evil" = evilSeats.includes(seat) ? "evil" : "good";
    // Evil sees its teammates, minus Oberon. Oberon sees nobody.
    const knownEvil =
      side === "evil" && role !== "oberon"
        ? new Set(
            evilSeats.filter(
              (s) => s !== seat && assignment.get(s) !== "oberon",
            ),
          )
        : new Set<string>();
    // Merlin sees every evil but Mordred.
    const visibleEvil =
      role === "merlin"
        ? new Set(evilSeats.filter((s) => s !== mordredSeat))
        : new Set<string>();
    const pair =
      role === "percival" && merlinSeat && morganaSeat
        ? [merlinSeat, morganaSeat]
        : null;
    out.set(seat, {
      seat,
      role: policyRoleOf(role),
      side,
      knownEvil,
      visibleEvil,
      pair,
    });
  }
  return out;
}

/**
 * How correlated one table's votes are, as a shift shared by everyone voting
 * on the same proposal.
 *
 * Sampling each vote independently from its marginal rate was the first
 * version and it broke the simulator outright. Nine players approving at about
 * 0.45 each put the tally near four, the threshold is five, so almost every
 * simulated proposal was rejected and the five-rejection rule handed evil the
 * game — good won 14-25% of the time against a real 40-43%.
 *
 * The correlation is not a guess: the belief layer measured it as a dispersion
 * of 2.03 at round one, falling to 1.41 by round five. Everyone heard the same
 * discussion, so the table moves together. Here the same fact is generated
 * rather than scored — one draw per proposal, shifting every player's log-odds
 * by the same amount, which spreads the tally instead of concentrating it.
 *
 * SIGMA is fitted so the simulated first-proposal pass rate lands on the 0.657
 * the corpus shows.
 */
const MOOD_SIGMA = 1.15;

/** Standard normal from a uniform stream, Box-Muller, one value per call. */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const logit = (p: number) => Math.log(p / (1 - p));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * The channel the structured log never recorded: table talk.
 *
 * Real good leaders take evils at 0.896 of chance on the FIRST round, when the
 * public posterior is still flat. No transform of that posterior can produce
 * it — a monotonic function of a uniform read is still uniform. The avoidance
 * has to come from information the logs do not contain: how people spoke, who
 * pushed to ride, what the table felt.
 *
 * So the simulator gets a reduced-form stand-in rather than a language model.
 * Each world draws one PUBLIC cue per seat, generated from the hidden roles and
 * corrupted by noise:
 *
 *     cue_i = SOCIAL_DELTA * [i is evil] + N(0, 1)
 *
 * Every simulated player sees the same cue and none can invert it — the noise
 * is a whole standard deviation against a signal well under one, so a seat
 * reading badly is usually just a seat reading badly. That is the point: it is
 * an observation channel, not a peek at the answer. No actor ever reads a role
 * from it, and nothing here reaches the user's own decision.
 *
 * SOCIAL_DELTA is fitted so the simulated round-one Evil loading of good
 * leaders lands on the 0.896 the corpus shows — 0.6 puts it at 0.88 to 0.91
 * across table sizes. It is NOT fitted to the win rate or the mission failure
 * rate, which are left to fall where they may and reported as the check.
 *
 * It works and it is not enough. A single static cue can set the level at
 * round one; it cannot reproduce the DEEPENING. Real good leaders go from
 * 0.896 of chance at round one to 0.405 by round five, while the simulator
 * barely moves — 0.88 down to 0.79. The remainder is the belief filter not
 * sharpening the way a real table does, not the cue being too weak.
 */
const SOCIAL_DELTA = 0.6;

/** One public cue per seat, drawn once per world. */
function socialCue(
  assignment: Assignment,
  rng: () => number,
  delta = SOCIAL_DELTA,
): Map<string, number> {
  const cue = new Map<string, number>();
  for (const [seat, role] of assignment) {
    const isEvil = EVIL_ROLE_NAMES.includes(role);
    cue.set(seat, (isEvil ? delta : 0) + normal(rng));
  }
  return cue;
}

/**
 * The read every simulated player shares: the log-derived posterior tilted by
 * the public cue, renormalised to the number of evils the rules put here.
 */
function blendCue(
  read: Map<string, number>,
  cue: ReadonlyMap<string, number>,
  evilTotal: number,
): Map<string, number> {
  const out = new Map<string, number>();
  let sum = 0;
  for (const [seat, raw] of read) {
    // Particle marginals really do hit 0 and 1 — every world agreeing is a
    // proof, not a rounding artefact — and the odds form divides by zero
    // there. Clamped just inside, which keeps a proof looking like a proof
    // while leaving the arithmetic finite.
    const q = Math.min(0.995, Math.max(0.005, raw));
    const odds = (q / (1 - q)) * Math.exp(cue.get(seat) ?? 0);
    const p = odds / (1 + odds);
    out.set(seat, p);
    sum += p;
  }
  if (sum > 0) {
    const scale = evilTotal / sum;
    for (const [seat, p] of out) {
      out.set(seat, Math.min(0.98, Math.max(0.02, p * scale)));
    }
  }
  return out;
}

interface SimState {
  successes: number;
  fails: number;
  missionNumber: number;
  rejections: number;
  leaderIndex: number;
}

/** The leader picks a team, avoiding whoever he can see or the table suspects. */
function proposeTeam(
  seats: readonly string[],
  sim: SimState,
  info: ReadonlyMap<string, InfoSet>,
  publicRead: ReadonlyMap<string, number>,
  count: PlayerCount,
  rng: () => number,
): string[] {
  const leader = seats[sim.leaderIndex];
  const who = info.get(leader);
  if (!who) return seats.slice(0, teamSize(count, Math.min(sim.missionNumber, 5) as Mission));
  const size = teamSize(count, Math.min(sim.missionNumber, 5) as Mission);

  const team: string[] = [];
  if (rng() < LEADER_RIDES[who.role]) team.push(leader);

  // Weight is how much he wants that seat: public suspicion discounts it for
  // everyone, and the evils this leader can actually see are discounted again.
  const pool = seats.filter((s) => !team.includes(s));
  const weights = pool.map((seat) => {
    let w = 1 - Math.min(0.9, publicRead.get(seat) ?? 0);
    if (who.visibleEvil.has(seat) || who.knownEvil.has(seat)) {
      w *= LEADER_LOADING[who.role];
    }
    return Math.max(0.01, w);
  });

  while (team.length < size && pool.length > 0) {
    let total = 0;
    for (const w of weights) total += w;
    let target = rng() * total;
    let pick = 0;
    for (let i = 0; i < pool.length; i += 1) {
      target -= weights[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    team.push(pool[pick]);
    pool.splice(pick, 1);
    weights.splice(pick, 1);
  }
  return team;
}

/** Plays one sampled world out and reports whether the user's side won. */
function playOut(
  state: DecisionState,
  assignment: Assignment,
  firstAction: Action | null,
  publicWorlds: readonly Assignment[],
  rng: () => number,
  trace?: SimTrace,
  delta?: number,
): boolean {
  const game = state.game;
  const count = game.playerCount as PlayerCount;
  const seats = [...game.players].sort((a, b) => a.seat - b.seat).map((p) => p.id);
  const info = informationSets(assignment);
  const evilTotal = evilCount(count);
  // The table believes in WORLDS, not per-seat numbers. A failed quest is a
  // statement about a team, and marginals cannot hold one.
  const filter = createFilter(publicWorlds, seats);
  // One draw per world: this table talked the way it talked.
  const cue = socialCue(assignment, rng, delta);
  let shared = blendCue(marginals(filter), cue, evilTotal);
  const refresh = () => {
    shared = blendCue(marginals(filter), cue, evilTotal);
  };
  const readOf = (team: readonly string[]) =>
    team.reduce((sum, seat) => sum + (shared.get(seat) ?? 0), 0);

  const sim: SimState = {
    successes: state.successes,
    fails: state.fails,
    missionNumber: state.missionNumber,
    rejections: state.rejectionStreak,
    leaderIndex: Math.max(0, seats.indexOf(state.leaderId ?? seats[0])),
  };

  let pending: readonly string[] | null = state.proposedTeam;
  let forced = firstAction;

  const evilWins = state.viewerSide === "evil";
  const goodWins = state.viewerSide === "good";

  for (let guard = 0; guard < 200; guard += 1) {
    if (sim.fails >= 3) {
      if (trace) trace.goodWon = false;
      return evilWins;
    }
    if (sim.successes >= 3) {
      const held = rng() < terminalGoodWin(game, assignment);
      if (trace) trace.goodWon = held;
      return held ? goodWins : evilWins;
    }
    if (sim.rejections >= 5) {
      if (trace) trace.goodWon = false;
      return evilWins;
    }

    if (!pending) {
      pending = proposeTeam(seats, sim, info, shared, count, rng);
    }

    const teamRisk = readOf(pending);
    // One shared mood for this proposal, then each seat votes its own rate
    // shifted by it. This is what makes a tally that can actually reach the
    // threshold; see MOOD_SIGMA.
    const mood = normal(rng) * MOOD_SIGMA;
    let approvals = 0;
    const cast = new Map<string, boolean>();
    for (const seat of seats) {
      let approve: boolean;
      if (forced && seat === state.viewerId) {
        approve = forced.kind === "vote" && forced.choice === "approve";
      } else {
        const who = info.get(seat);
        const base = who ? approveProbability(who, pending, teamRisk) : 0.5;
        approve = rng() < logistic(logit(base) + mood);
      }
      cast.set(seat, approve);
      if (approve) approvals += 1;
    }
    if (trace) {
      trace.proposals += 1;
      if (approvals * 2 > seats.length) trace.approvals += 1;
      // Matched to how the corpus measures it: the leader is not a random
      // draw, so only the seats he ADDED are compared against chance, and
      // against the pool that excludes him.
      const leaderSeat = seats[sim.leaderIndex];
      const leaderAboard = pending.includes(leaderSeat);
      const leaderEvil = info.get(leaderSeat)?.side === "evil";
      const added = pending.filter((s2) => s2 !== leaderSeat);
      const aboard = added.filter((s2) => info.get(s2)?.side === "evil").length;
      const restEvil = evilTotal - (leaderEvil ? 1 : 0);
      const expected =
        seats.length > 1 ? (added.length * restEvil) / (seats.length - 1) : 0;
      void leaderAboard;
      trace.loadingObserved += aboard;
      trace.loadingExpected += expected;
      if (!leaderEvil) {
        const r = Math.min(sim.missionNumber, 5) - 1;
        trace.byRoundObserved[r] += aboard;
        trace.byRoundExpected[r] += expected;
        if (sim.missionNumber === 1) {
          trace.r1GoodObserved += aboard;
          trace.r1GoodExpected += expected;
        }
      }
    }
    forced = null;
    updateOnVotes(filter, pending, cast, Math.min(sim.missionNumber, 5), rng);
    refresh();

    if (approvals * 2 <= seats.length) {
      sim.rejections += 1;
      if (trace && sim.rejections >= 5) trace.hitRejectionLimit = true;
      sim.leaderIndex = (sim.leaderIndex + 1) % seats.length;
      pending = null;
      continue;
    }

    if (trace) {
      const raw = marginals(filter);
      trace.readByRound[Math.min(sim.missionNumber, 5) - 1] = seats.map(
        (s2) => shared.get(s2) ?? 0,
      );
      trace.rawByRound[Math.min(sim.missionNumber, 5) - 1] = seats.map(
        (s2) => raw.get(s2) ?? 0,
      );
    }

    const evilsAboard = pending.filter((s) => info.get(s)?.side === "evil").length;
    const need = requiredFails(count, Math.min(sim.missionNumber, 5) as Mission);
    let failCards = 0;
    if (evilsAboard > 0) {
      const dist = failDistribution(evilsAboard, need, sim.successes, sim.fails);
      if (dist.length > 0) {
        const u = rng();
        let acc = 0;
        failCards = dist.length - 1;
        for (let f = 0; f < dist.length; f += 1) {
          acc += dist[f];
          if (u < acc) {
            failCards = f;
            break;
          }
        }
      }
    }
    updateOnMission(
      filter,
      pending,
      failCards,
      need,
      sim.successes,
      sim.fails,
      rng,
    );

    if (trace) {
      trace.missionsPlayed += 1;
      trace.failCards.push(failCards);
    }

    refresh();

    if (failCards >= need) sim.fails += 1;
    else sim.successes += 1;

    sim.missionNumber = Math.min(sim.missionNumber + 1, 5);
    sim.rejections = 0;
    sim.leaderIndex = (sim.leaderIndex + 1) % seats.length;
    pending = null;
  }
  // A game that will not end is a bug in the policy, not a draw.
  return evilWins;
}

/** Research-only: what one playthrough actually did. */
export interface SimTrace {
  goodWon: boolean;
  proposals: number;
  approvals: number;
  missionsPlayed: number;
  successes: number;
  fails: number;
  hitRejectionLimit: boolean;
  /** Fail cards played, per quest that ran. */
  failCards: number[];
  /** Evils actually on each proposed team, and what chance would have given. */
  loadingObserved: number;
  loadingExpected: number;
  /** The same, restricted to round one with a good leader. */
  r1GoodObserved: number;
  r1GoodExpected: number;
  /** Good-leader loading per round, which is where the real gap shows. */
  byRoundObserved: number[];
  byRoundExpected: number[];
  /**
   * The shared read as each quest began, so its sharpening can be compared
   * against what the frozen engine does on real games.
   */
  readByRound: number[][];
  /** The particle marginals alone, before the social cue is mixed in. */
  rawByRound: number[][];
}

export interface ActionValue {
  action: Action;
  q: number;
  /** Standard error of q over the sampled worlds. */
  se: number;
  worlds: number;
}

/**
 * How many worlds the simulated table carries as its belief.
 *
 * Enough to keep a spread after several reweightings, small enough that a
 * rollout does hundreds of games without the filter dominating the cost.
 */
const PARTICLES = 120;

export interface RolloutOptions {
  worlds?: number;
  seed?: number;
}

/**
 * Scores every candidate action over one shared set of worlds.
 *
 * Common random numbers: world i is played with a stream seeded from
 * (seed, i) for EVERY action, so two playthroughs diverge only where the
 * decision actually changes the game. Without that, the difference between two
 * numbers near a half would be buried in sampling noise.
 */
export function evaluateActions(
  state: DecisionState,
  actions: readonly Action[],
  options: RolloutOptions = {},
): ActionValue[] {
  const worlds = options.worlds ?? 400;
  const seed = options.seed ?? 1;
  if (!state.viewerSide || actions.length === 0) return [];

  // Simulated players reason from the PUBLIC posterior. The user's own sight
  // must not leak into what the rest of the table appears to know.
  // Two draws, and they are not the same thing. The table's BELIEF comes from
  // the public posterior; the hidden truth each rollout plays out comes from
  // the user-conditioned one, because the user does know their own role.
  const view = publicView(state.events, state.game);
  const publicWorlds = sampleAssignments(
    view.events,
    view.game,
    PARTICLES,
    makeRng(seed ^ 0x5eed),
  );

  // Worlds come from the USER-conditioned posterior: the user does know their
  // own role, and the value of their decision is the value under what they know.
  const drawn = sampleAssignments(state.events, state.game, worlds, makeRng(seed));

  return actions.map((action) => {
    let wins = 0;
    for (let i = 0; i < drawn.length; i += 1) {
      const rng = makeRng(seed * 1_000_003 + i * 7919 + 13);
      if (playOut(state, drawn[i], action, publicWorlds, rng)) wins += 1;
    }
    const n = drawn.length || 1;
    const q = wins / n;
    return { action, q, se: Math.sqrt(Math.max(q * (1 - q), 1e-9) / n), worlds: n };
  });
}

/**
 * Research-only: play one world out and report what happened.
 *
 * The calibration harness needs the shape of the simulated games, not their
 * value, and reaching into playOut is better than a second copy of it.
 */
export function traceOne(
  state: DecisionState,
  assignment: Assignment,
  publicWorlds: readonly Assignment[],
  rng: () => number,
  delta?: number,
): SimTrace {
  const trace: SimTrace = {
    goodWon: false,
    proposals: 0,
    approvals: 0,
    missionsPlayed: 0,
    successes: 0,
    fails: 0,
    hitRejectionLimit: false,
    failCards: [],
    loadingObserved: 0,
    loadingExpected: 0,
    r1GoodObserved: 0,
    r1GoodExpected: 0,
    byRoundObserved: [0, 0, 0, 0, 0],
    byRoundExpected: [0, 0, 0, 0, 0],
    readByRound: [],
    rawByRound: [],
  };
  playOut(state, assignment, null, publicWorlds, rng, trace, delta);
  return trace;
}

export { sampleAssignments as _sampleAssignments };
