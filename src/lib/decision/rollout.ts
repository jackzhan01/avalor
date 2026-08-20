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
import { evilCount, requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameRecord, PlayerCount } from "@/lib/types/game";
import {
  approveProbability,
  policyRoleOf,
  type InfoSet,
} from "./policy";
import {
  createFilter,
  marginals,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
} from "./particle-filter";
import {
  chooseTeam,
  emptyHistory,
  noteMission,
  noteVote,
  type ProposalHistory,
} from "./proposal";
import type { ParticleFilter } from "./particle-filter";
import { publicView } from "./public-view";
import { applySocial } from "./social-update";
import { EvilOdds, syntheticRound, type SocialEvidence } from "@/lib/social";
import type { GameEvent } from "@/lib/types/events";

/**
 * The room this simulation is running with, if any.
 *
 * `quality` is how well a good seat's stance tracks the truth, and it may be
 * a per-round array; `deception` is how hard evil works to protect its own.
 * They are separate dials because the study needs them separate: a table that
 * talks badly is WORSE than a silent one, since the liars are then the only
 * seats with signal, and pooling the two knobs would hide that entirely.
 */
export interface SocialConfig {
  quality: number | readonly number[];
  deception?: number;
}

/**
 * What the table says in one round, however it is produced.
 *
 * The synthetic generator and a language model both arrive here, so a closed
 * loop and a controlled sweep run down the same path and differ only in who is
 * talking. `events` is a PUBLIC log of the simulated game so far, in exactly
 * the shape seatBrief consumes — which is what lets a model see a simulated
 * game the same way it saw a recorded one.
 *
 * `read` is the current posterior. An arm may hand it to its speakers as
 * external belief memory or withhold it; that choice is the arm.
 */
export interface TalkInput {
  round: number;
  seats: readonly string[];
  info: ReadonlyMap<string, InfoSet>;
  game: GameRecord;
  events: readonly GameEvent[];
  read: ReadonlyMap<string, number>;
  sequence: number;
}

export type TalkSource = (input: TalkInput) => Promise<SocialEvidence[]>;
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
export function informationSets(assignment: Assignment): Map<string, InfoSet> {
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

interface SimState {
  successes: number;
  fails: number;
  missionNumber: number;
  rejections: number;
  leaderIndex: number;
}

/**
 * The leader picks a car.
 *
 * The choice itself lives in proposal.ts, over whole teams rather than seat by
 * seat; this only supplies the round, the size and the threshold that decides
 * what "risky" means for this quest.
 */
function proposeTeam(
  seats: readonly string[],
  sim: SimState,
  info: ReadonlyMap<string, InfoSet>,
  filter: ParticleFilter,
  count: PlayerCount,
  rng: () => number,
  history: ProposalHistory,
): string[] {
  const round = Math.min(sim.missionNumber, 5) as Mission;
  const size = teamSize(count, round);
  const leader = seats[sim.leaderIndex];
  return chooseTeam(
    seats,
    size,
    1,
    leader,
    info.get(leader),
    filter,
    round,
    rng,
    undefined,
    history,
  );
}

/** Plays one sampled world out and reports whether the user's side won. */
async function playOut(
  state: DecisionState,
  assignment: Assignment,
  firstAction: Action | null,
  publicWorlds: readonly Assignment[],
  rng: () => number,
  trace?: SimTrace,
  social?: SocialConfig,
  talk?: TalkSource,
): Promise<boolean> {
  const game = state.game;
  const count = game.playerCount as PlayerCount;
  const seats = [...game.players].sort((a, b) => a.seat - b.seat).map((p) => p.id);
  const info = informationSets(assignment);
  const evilTotal = evilCount(count);
  void evilTotal;
  // The table believes in WORLDS, not per-seat numbers. A failed quest is a
  // statement about a team, and marginals cannot hold one.
  const filter = createFilter(publicWorlds, seats);
  /*
   * The room, if this study is running with one.
   *
   * Talk enters as a likelihood over worlds through the filter, not as a tilt
   * applied to the answer afterwards — see decision/social-update.ts. So the
   * shared read is simply the posterior, and team choice, risk and votes all
   * see the same thing, which the old blended cue could not manage.
   */
  const quality = social?.quality ?? 0;
  const talkative = Array.isArray(quality)
    ? quality.some((q) => q > 0)
    : (quality as number) > 0;
  /*
   * Both kinds of speaker come through one source. The synthetic generator is
   * wrapped as one rather than special-cased, so the controlled sweep and the
   * closed loop cannot drift apart in how their talk reaches the belief.
   */
  const speak: TalkSource | null =
    talk ??
    (talkative
      ? async (input) =>
          syntheticRound(input.round, {
            seats: input.seats,
            evilSeats: new Set(
              input.seats.filter((seat) => info.get(seat)?.side === "evil"),
            ),
            quality,
            deception: social?.deception,
            rng,
          }).map((one, i) => ({ ...one, sequence: input.sequence + i + 1 }))
      : null);

  const odds = new EvilOdds();
  const applied = new Map<string, number>();
  let talkedThrough = 0;

  const hearRound = async (round: number) => {
    if (!speak) return;
    while (talkedThrough < round) {
      talkedThrough += 1;
      // Talk is not testimony: an accusation from a seat the table already
      // distrusts is worth less. Credibility comes from the belief itself.
      const read = marginals(filter);
      const batch = await speak({
        round: talkedThrough,
        seats,
        info,
        game,
        events: log,
        read,
        sequence: seq,
      });
      seq += Math.max(batch.length, 1);
      const credibility = new Map<string, number>();
      for (const seat of seats) {
        credibility.set(seat, Math.max(0, 1 - (read.get(seat) ?? 0)));
      }
      odds.absorb(batch, talkedThrough, credibility);
      spoken.push(...batch);
    }
    // Only the change since last time — decay means old talk keeps moving.
    const now = odds.snapshot();
    const delta = new Map<string, number>();
    for (const seat of seats) {
      const d = (now.get(seat) ?? 0) - (applied.get(seat) ?? 0);
      if (d !== 0) delta.set(seat, d);
      applied.set(seat, now.get(seat) ?? 0);
    }
    applySocial(filter, delta);
  };

  let shared = marginals(filter);
  const refresh = () => {
    shared = marginals(filter);
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

  // What the simulated table has publicly seen, which the leader reads back.
  const history = emptyHistory(seats.length);
  /*
   * The same thing again, as an event log.
   *
   * Redundant with `history` on purpose: that one is packed for the proposal
   * features, this one is the shape seatBrief reads, so a speaker in a
   * simulated game gets exactly the brief it would get in a recorded one. It
   * is public only — no assignment, no marks.
   */
  const log: GameEvent[] = [];
  const spoken: SocialEvidence[] = [];
  let seq = 1;
  // Distributive, or the union collapses to its shared fields and every
  // type-specific one stops type-checking. The corpus loader hit this too.
  type Partial = GameEvent extends infer T
    ? T extends GameEvent
      ? Omit<T, "id" | "gameId" | "timestamp">
      : never
    : never;
  const note = (event: Partial) => {
    log.push({
      ...event,
      id: `sim-${seq}`,
      gameId: game.id,
      timestamp: game.createdAt,
    } as GameEvent);
    seq += 1;
  };
  const maskOf = (team: readonly string[]) => {
    let mask = 0;
    for (const seat of team) {
      const i = seats.indexOf(seat);
      if (i >= 0) mask |= 1 << i;
    }
    return mask;
  };

  let pending: readonly string[] | null = state.proposedTeam;
  // The car already on the table is part of the log the public worlds were
  // drawn from. Scoring it again here would count one proposal twice.
  let alreadyScored = pending !== null;
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

    await hearRound(Math.min(sim.missionNumber, 5));
    refresh();

    if (!pending) {
      // A forced proposal is the action being valued: play the car the caller
      // asked about, then let the policy take over. Without this the propose
      // action existed in the type and did nothing, so every candidate team
      // scored identically and the hybrid had nothing to rank.
      if (forced?.kind === "propose" && seats[sim.leaderIndex] === state.viewerId) {
        pending = forced.team;
        forced = null;
      } else {
        pending = proposeTeam(seats, sim, info, filter, count, rng, history);
      }
    }

    // Who the leader picked is evidence before anyone votes on it — and on
    // held-out real games it is the factor that closes almost the whole
    // sharpening gap. See research/particle-equivalence.test.ts.
    if (!alreadyScored) {
      updateOnProposal(
        filter,
        seats[sim.leaderIndex],
        pending,
        Math.min(sim.missionNumber, 5),
        seats.length,
        rng,
      );
      refresh();
    }
    alreadyScored = false;

    const proposalId = `sim-${seq}`;
    note({
      type: "proposal",
      leaderId: seats[sim.leaderIndex],
      teamPlayerIds: [...pending],
      missionNumber: Math.min(sim.missionNumber, 5),
      proposalNumber: sim.rejections + 1,
      sequence: seq,
    });

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
        // The attempt number is not belief evidence, but it is the strongest
        // single driver of a real vote: the hammer passes 98% of the time.
        const base = who
          ? approveProbability(who, pending, teamRisk, sim.rejections + 1)
          : 0.5;
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

    {
      let approvedBy = 0;
      for (let i = 0; i < seats.length; i += 1) {
        if (cast.get(seats[i])) approvedBy |= 1 << i;
      }
      noteVote(
        history,
        maskOf(pending),
        approvedBy,
        approvals * 2 > seats.length,
        seats.length,
      );
      const votes: Record<string, "approve" | "reject"> = {};
      for (const seat of seats) votes[seat] = cast.get(seat) ? "approve" : "reject";
      note({
        type: "vote",
        proposalId,
        votes,
        finalResult: approvals * 2 > seats.length ? "passed" : "rejected",
        missionNumber: Math.min(sim.missionNumber, 5),
        proposalNumber: sim.rejections + 1,
        sequence: seq,
      });
    }

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

    const succeeded = failCards < need;
    noteMission(history, maskOf(pending), succeeded, seats.length);
    note({
      type: "mission",
      proposalId,
      teamPlayerIds: [...pending],
      result: succeeded ? "success" : "fail",
      failCount: failCards,
      missionNumber: Math.min(sim.missionNumber, 5),
      sequence: seq,
    });
    if (succeeded) sim.successes += 1;
    else sim.fails += 1;

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
export async function evaluateActions(
  state: DecisionState,
  actions: readonly Action[],
  options: RolloutOptions = {},
): Promise<ActionValue[]> {
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

  const out: ActionValue[] = [];
  for (const action of actions) {
    let wins = 0;
    for (let i = 0; i < drawn.length; i += 1) {
      const rng = makeRng(seed * 1_000_003 + i * 7919 + 13);
      if (await playOut(state, drawn[i], action, publicWorlds, rng)) wins += 1;
    }
    const n = drawn.length || 1;
    const q = wins / n;
    out.push({
      action,
      q,
      se: Math.sqrt(Math.max(q * (1 - q), 1e-9) / n),
      worlds: n,
    });
  }
  return out;
}

/**
 * Research-only: play one world out and report what happened.
 *
 * The calibration harness needs the shape of the simulated games, not their
 * value, and reaching into playOut is better than a second copy of it.
 */
export async function traceOne(
  state: DecisionState,
  assignment: Assignment,
  publicWorlds: readonly Assignment[],
  rng: () => number,
  social?: SocialConfig,
  talk?: TalkSource,
): Promise<SimTrace> {
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
  await playOut(state, assignment, null, publicWorlds, rng, trace, social, talk);
  return trace;
}

export { sampleAssignments as _sampleAssignments };
