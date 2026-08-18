/**
 * Soft evidence: weighting the surviving worlds by how well they explain
 * what people actually DID.
 *
 * The hard layer can only speak when a rule is violated, which in practice
 * means "a mission failed" or "you have vision". Between those moments it has
 * nothing to say, and a table of identical numbers is the honest but useless
 * result. This layer fills that gap — not by eliminating anything, but by
 * asking of each surviving world: how surprising is the record, if this world
 * were the true one?
 *
 * THE LINE THIS LAYER MUST NOT CROSS: it never eliminates. Elimination is a
 * claim of impossibility and stays the exclusive property of `constraints.ts`.
 * Everything here only re-weights, which has a useful consequence — a seat
 * proven evil in every surviving world stays at 100% no matter what the
 * weights do, so the hard layer's guarantees survive intact underneath.
 *
 * WHAT IT READS, AND WHAT IT REFUSES TO:
 *
 *   ✓ votes        — costly, and a vote is a decision, not a sentence
 *   ✓ fail cards   — the sharpest signal in the game
 *   ✗ 保踩/意向车  — talk is cheap and, more to the point, we have no data to
 *                    calibrate it with. Encoding a guess about how liars rate
 *                    each other would put a hand-tuned prejudice at the centre
 *                    of the feature. That waits for real logs (see README).
 *
 * WHY VOTES CARRY SIGNAL AT ALL: evil players know who their teammates are, so
 * their votes are informed. Good players do not, so their votes are nearly
 * uninformative about identity — and the model says exactly that by giving
 * good players a near-coin-flip likelihood. The asymmetry IS the inference.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import type { Hypothesis } from "./types";
import { evilOnTeam } from "./hypotheses";

/**
 * Approval rates for each (side × relationship to the car) cell.
 *
 * MEASURED, not guessed — estimated from 12,882 real human games (AvalonLogs),
 * counting conditional frequencies. Counting is all it takes: every parameter
 * here is the probability of a binary event under a condition we can observe
 * in a labelled log, so there is no optimiser and nothing to converge.
 *
 * The measurement overturned the model's original shape, which is worth
 * recording because the mistake is an easy one to make again:
 *
 *   RIDING THE CAR IS NOT AN EVIL TELL. Hand-set, this file had evil approving
 *   their own team at 0.85 against 0.50 for good — an implied discriminative
 *   power of 1.7. The real figures are 0.768 and 0.736: a ratio of 1.04, which
 *   is nothing. Wanting your own car to go is ordinary self-interest, and
 *   scoring it as villainy quietly incriminated everyone who had been aboard.
 *
 *   GOOD PLAYERS' VOTES DO CARRY SIGNAL. The old model treated them as a coin
 *   flip on the grounds that good players cannot see roles. True, but they can
 *   REASON: from outside the car they approve clean teams at 0.598 and teams
 *   with an evil aboard at 0.396. The table's collective read is real evidence,
 *   and assuming it away discarded the single largest sample in the corpus.
 *
 * The surviving signal is smaller than the guesses implied — ratios of 1.26
 * and 0.67 rather than 1.7 — which is itself the useful finding: votes inform,
 * but they inform gently, and any model claiming otherwise is overfitting the
 * modeller's intuitions.
 *
 * ⚠ POPULATION CAVEAT. These come from online pick-up games. Playing with
 * friends across a table is a different population, and parameters fitted on
 * the wrong one are confidently wrong. That is why `damping` stays.
 */
export interface BehaviourParams {
  /** Good, riding the car. Self-interest, near-identical for both sides. */
  goodApprovesAboard: number;
  /** Good, watching from outside a car that happens to carry an evil. */
  goodApprovesOffTainted: number;
  /** Good, watching from outside a genuinely clean car. */
  goodApprovesOffClean: number;
  /** Evil, riding the car. */
  evilApprovesAboard: number;
  /** Evil, outside, but a teammate is aboard — good for their side. */
  evilApprovesOffTeammate: number;
  /** Evil, outside a clean car. Letting it run is a free success for good. */
  evilApprovesOffClean: number;
  /** An evil player on a quest actually plays the fail card. */
  evilPlaysFail: number;
  /**
   * Global scaling on the total log-likelihood.
   *
   * Introduced as an admitted fudge — the scoring treats every vote as
   * independent, which is false, so the total was halved to stop forty
   * correlated votes driving the posterior to 99%.
   *
   * MEASURING IT REVERSED THE REASONING. Swept against Brier score on 6,441
   * held-out games:
   *
   *     0.5 → 0.1712    1.0 → 0.1522    1.5 → 0.1526
   *     0.8 → 0.1564    1.2 → 0.1511    2.0 → 0.1587
   *
   * The old 0.5 was the worst value tested. Far from being over-confident,
   * the model was systematically UNDER-confident — saying 55% where the truth
   * came in at 68% — and the damping was the cause rather than the cure.
   *
   * Set to 1.0, not the empirical optimum of 1.2. The curve is nearly flat
   * between them (0.7%), 1.0 means simply "trust the likelihood as computed",
   * and a value above 1 amplifies evidence with no principle behind it. That
   * 0.7% is well inside the error introduced by fitting on online pick-up
   * games and applying to a table of friends.
   */
  damping: number;
  /**
   * Which fail-card model to use. "constant" is the old single rate, kept so
   * the two can be compared on the same held-out games.
   */
  failModel?: "constant" | "table";
}

/** Measured on 12,882 AvalonLogs games. See the note above before editing. */
export const DEFAULT_PARAMS: BehaviourParams = {
  goodApprovesAboard: 0.736,
  goodApprovesOffTainted: 0.396,
  goodApprovesOffClean: 0.598,
  evilApprovesAboard: 0.768,
  evilApprovesOffTeammate: 0.499,
  evilApprovesOffClean: 0.403,
  evilPlaysFail: 0.58,
  damping: 1.0,
  failModel: "table",
};

/**
 * The same rates, per round — because a vote in round 1 is not a vote in
 * round 5.
 *
 * Found by ablation: scoring with votes made the posterior WORSE than ignoring
 * them for the first three rounds (−1.9% in round 1), and only paid off in
 * round 5. The pooled parameters are roughly round-3 strength, so applying
 * them to the opening car inflates noise into evidence.
 *
 * Measuring per round shows why. Discriminative power (evil rate ÷ good rate)
 * climbs steadily as the game gets serious:
 *
 *              dirty car   clean car
 *   round 1      1.07        0.90     ← essentially nothing
 *   round 3      1.38        0.65
 *   round 5      3.72        0.40     ← very strong
 *
 * Which is exactly what the game should produce: on the opening proposal
 * nobody knows anything and approving costs evil nothing, while by the last
 * round every vote is a commitment under full information. The engine now
 * reads each vote at the strength that round's votes actually carry.
 */
export const VOTES_BY_ROUND: Record<
  number,
  Pick<
    BehaviourParams,
    | "goodApprovesOffTainted"
    | "goodApprovesOffClean"
    | "evilApprovesOffTeammate"
    | "evilApprovesOffClean"
  >
> = {
  1: {
    goodApprovesOffTainted: 0.543,
    evilApprovesOffTeammate: 0.578,
    goodApprovesOffClean: 0.617,
    evilApprovesOffClean: 0.557,
  },
  2: {
    goodApprovesOffTainted: 0.411,
    evilApprovesOffTeammate: 0.499,
    goodApprovesOffClean: 0.524,
    evilApprovesOffClean: 0.424,
  },
  3: {
    goodApprovesOffTainted: 0.348,
    evilApprovesOffTeammate: 0.48,
    goodApprovesOffClean: 0.613,
    evilApprovesOffClean: 0.399,
  },
  4: {
    goodApprovesOffTainted: 0.284,
    evilApprovesOffTeammate: 0.447,
    goodApprovesOffClean: 0.609,
    evilApprovesOffClean: 0.328,
  },
  5: {
    goodApprovesOffTainted: 0.123,
    evilApprovesOffTeammate: 0.46,
    goodApprovesOffClean: 0.541,
    evilApprovesOffClean: 0.217,
  },
};

/** Round-specific rates where we have them, pooled ones as the fallback. */
function ratesForRound(
  params: BehaviourParams,
  missionNumber: number,
): BehaviourParams {
  const round = VOTES_BY_ROUND[Math.min(Math.max(missionNumber, 1), 5)];
  return round ? { ...params, ...round } : params;
}

/**
 * How each informed role votes, measured on the same 12,882 games.
 *
 * The side layer treats all good players alike, which is wrong in a specific
 * and useful way: SOME GOOD PLAYERS CAN SEE. Merlin knows which cars are
 * dirty, so from outside he approves clean teams at 0.746 and tainted ones at
 * 0.371 — a spread of 0.374. A loyal follower, guessing, manages 0.144.
 * Percival sits between them at 0.207, exactly as his partial sight predicts.
 *
 * The check that this is measuring what it claims: OBERON scores 0.016. He is
 * evil but knows no teammates, so he should be unable to tell a dirty car from
 * a clean one — and he can't. A spurious correlation would not have produced
 * that.
 *
 * Without this, "who is Merlin" stays a flat 1/6 no matter what happens at the
 * table, which is precisely the complaint that prompted it.
 */
export interface RoleVotingParams {
  /** P(approve | outside a car carrying at least one evil). */
  offTainted: number;
  /** P(approve | outside a car with no evil aboard). */
  offClean: number;
}

type VotingGroup =
  | "merlin"
  | "percival"
  | "oberon"
  | "goodOther"
  | "evilOther";

/** Pooled across the game. Kept as the fallback for rounds with thin data. */
export const ROLE_VOTING: Record<VotingGroup, RoleVotingParams> = {
  merlin: { offTainted: 0.371, offClean: 0.746 },
  percival: { offTainted: 0.397, offClean: 0.603 },
  // Evil, but blind to his own side — behaves like someone with no information.
  oberon: { offTainted: 0.448, offClean: 0.464 },
  goodOther: { offTainted: 0.406, offClean: 0.55 },
  evilOther: { offTainted: 0.51, offClean: 0.39 },
};

/*
 * A ROUND-SPLIT WAS TRIED HERE AND MADE THINGS WORSE. Recorded so nobody
 * repeats it.
 *
 * The round effect is real, and it runs OPPOSITE to the side layer's: Merlin
 * is easiest to spot EARLY. Against a loyal follower's ability to tell a dirty
 * car from a clean one:
 *
 *   round 1   +0.212 vs +0.028   → 7.6× as discriminating
 *   round 3   +0.441 vs +0.206   → 2.2×
 *   round 5   +0.534 vs +0.372   → 1.4×
 *
 * On the opening car a loyal follower knows nothing while Merlin already knows
 * everything; by the last round the table has reasoned most of it out and he
 * no longer stands out. A compelling story — and splitting the parameters by
 * round still measured worse, on the scenario that matters (finding Merlin
 * from an evil seat, sides known):
 *
 *   pooled      top-1 27.1%   Brier 0.0950
 *   per round   top-1 26.7%   Brier 0.0961
 *
 * Why it fails where the same split succeeded for sides: the side layer gets
 * every seat's every vote in each round, while this one gets only Merlin's.
 * Cut into five, the variance added swamps the bias removed. It would need
 * either far more games or shrinkage toward the pooled values — not worth the
 * complexity until the numbers ask for it.
 */

function roleRates(group: VotingGroup): RoleVotingParams {
  return ROLE_VOTING[group];
}

/**
 * Per-seat evidence that this seat holds a role with special sight.
 *
 * Returned as a LOG RATIO against that seat's own side average, so it composes
 * with the side layer instead of double-counting it: the side layer already
 * scored "a good player voted this way", and this only adds "…and they voted
 * like someone who could see".
 *
 * Precomputed per seat rather than per role assignment. A 10-player game has
 * 151,200 assignments but only 10 seats, and the likelihood depends solely on
 * which seat holds the role — so this turns a six-figure computation into a
 * ten-entry lookup.
 */
export function roleVotingEvidence(
  events: GameEvent[],
  game: GameRecord,
  hypothesis: Hypothesis,
): Map<string, { merlin: number; percival: number; oberon: number }> {
  const timeline = deriveTimeline(events, game);
  const out = new Map<
    string,
    { merlin: number; percival: number; oberon: number }
  >();
  for (const player of game.players) {
    out.set(player.id, { merlin: 0, percival: 0, oberon: 0 });
  }

  for (const proposalId of timeline.proposalOrder) {
    const proposal = timeline.proposalsById.get(proposalId);
    if (!proposal?.vote) continue;
    const team = proposal.event.teamPlayerIds;
    const evilAboard = evilOnTeam(hypothesis, team);

    for (const [playerId, choice] of Object.entries(proposal.vote.votes)) {
      if (choice !== "approve" && choice !== "reject") continue;
      // Only votes cast from OUTSIDE the car carry role information — aboard,
      // everyone votes their own interest and the roles are indistinguishable.
      if (team.includes(playerId)) continue;
      const cell = out.get(playerId);
      if (!cell) continue;

      const isEvil = hypothesis.isEvil(playerId);
      const tainted = isEvil
        ? evilAboard - 0 > 0 // a teammate aboard
        : evilAboard > 0;
      const key = tainted ? "offTainted" : "offClean";
      const approved = choice === "approve";
      const p = (params: RoleVotingParams) =>
        approved ? params[key] : 1 - params[key];
      const baseline = p(roleRates(isEvil ? "evilOther" : "goodOther"));
      if (baseline <= 0) continue;

      if (!isEvil) {
        cell.merlin += Math.log(p(roleRates("merlin")) / baseline);
        cell.percival += Math.log(p(roleRates("percival")) / baseline);
      } else {
        cell.oberon += Math.log(p(roleRates("oberon")) / baseline);
      }
    }
  }

  return out;
}

/* ── Fail cards, measured as a distribution ───────────────────────────────
 *
 * Not a per-player rate fed through a binomial. The binomial assumes each evil
 * aboard decides independently, and the data says plainly that they do not:
 * with three evils on a quest needing one fail, 28.4% of quests saw zero cards
 * and 17.6% saw three, against 18.5% and 7.9% under a binomial with the same
 * marginal rate. They are positively correlated — the same situation moves
 * them the same way, so they tend to all hold or all fire.
 *
 * Storing P(f | k, need, score) outright needs no assumption about the
 * mechanism at all, and it captures the spread the binomial flattens.
 *
 * The score matters as much as the team: at 0-0 a lone evil plays the card
 * 29% of the time, buying trust with the opening quest; at match point, 93%.
 *
 * Generated by research/fail-table.js, two-level Dirichlet backoff.
 */

/** k|need → P(出牌数 f = 0..k)。比分未知时的回退层。 */
const FAIL_DIST_BY_TEAM: Record<string, readonly number[]> = {
  "1|1": [0.3849, 0.6151],   // n=9917
  "1|2": [0.4710, 0.5290],   // n=1930
  "2|1": [0.3346, 0.4150, 0.2503],   // n=3840
  "2|2": [0.0210, 0.1445, 0.8346],   // n=1321
  "3|1": [0.2787, 0.3301, 0.2152, 0.1760],   // n=394
  "3|2": [0.0133, 0.0978, 0.3156, 0.5733],   // n=210
  "4|1": [0.0556, 0.4444, 0.0556, 0.1667, 0.2778],   // n=12
  "4|2": [0.1136, 0.0682, 0.4091, 0.1591, 0.2500],   // n=7
};

/** k|need|已成功-已失败 → P(出牌数 f = 0..k)。主表。 */
const FAIL_DIST: Record<string, readonly number[]> = {
  "1|1|0-0": [0.7053, 0.2947],   // n=3220
  "1|1|0-1": [0.3092, 0.6908],   // n=712
  "1|1|0-2": [0.0716, 0.9284],   // n=303
  "1|1|1-0": [0.3074, 0.6926],   // n=2427
  "1|1|1-1": [0.2442, 0.7558],   // n=1573
  "1|1|2-0": [0.1595, 0.8405],   // n=849
  "1|1|2-2": [0.0611, 0.9389],   // n=833
  "1|2|1-2": [0.6982, 0.3018],   // n=833
  "1|2|2-1": [0.2989, 0.7011],   // n=1096
  "1|2|2-2": [0.4415, 0.5585],   // n=1
  "2|1|0-0": [0.5965, 0.3378, 0.0657],   // n=1001
  "2|1|0-1": [0.2778, 0.5301, 0.1920],   // n=291
  "2|1|0-2": [0.0402, 0.2738, 0.6860],   // n=110
  "2|1|1-0": [0.2912, 0.4927, 0.2161],   // n=1187
  "2|1|1-1": [0.3122, 0.4622, 0.2256],   // n=600
  "2|1|2-0": [0.2143, 0.4896, 0.2960],   // n=349
  "2|1|2-2": [0.0190, 0.1269, 0.8541],   // n=302
  "2|2|1-2": [0.0332, 0.1615, 0.8052],   // n=506
  "2|2|2-1": [0.0100, 0.1327, 0.8573],   // n=815
  "3|1|0-0": [0.4773, 0.3494, 0.1403, 0.0330],   // n=65
  "3|1|0-1": [0.2833, 0.3710, 0.1913, 0.1544],   // n=28
  "3|1|0-2": [0.1072, 0.1782, 0.1340, 0.5805],   // n=24
  "3|1|1-0": [0.3509, 0.3633, 0.2184, 0.0674],   // n=128
  "3|1|1-1": [0.2108, 0.3882, 0.3087, 0.0922],   // n=57
  "3|1|2-0": [0.2643, 0.3839, 0.2343, 0.1175],   // n=50
  "3|1|2-2": [0.0733, 0.0869, 0.2671, 0.5726],   // n=42
  "3|2|1-2": [0.0016, 0.0277, 0.2539, 0.7168],   // n=110
  "3|2|2-1": [0.0104, 0.1693, 0.3455, 0.4748],   // n=100
  "4|1|0-2": [0.0463, 0.4259, 0.0463, 0.1389, 0.3426],   // n=3
  "4|1|1-0": [0.0463, 0.4259, 0.0463, 0.2500, 0.2315],   // n=3
  "4|1|1-1": [0.0521, 0.4792, 0.0521, 0.1563, 0.2604],   // n=1
  "4|1|2-2": [0.0417, 0.3333, 0.0417, 0.1750, 0.4083],   // n=5
  "4|2|1-2": [0.1229, 0.0465, 0.2789, 0.1994, 0.3523],   // n=7
};

/** P(f fail cards | k evils aboard, need required, score going in). */
export function failDistribution(
  evilsAboard: number,
  requiredFails: number,
  successes: number,
  fails: number,
): readonly number[] {
  return (
    FAIL_DIST[`${evilsAboard}|${requiredFails}|${successes}-${fails}`] ??
    FAIL_DIST_BY_TEAM[`${evilsAboard}|${requiredFails}`] ??
    []
  );
}

/** log C(n, k), via a small exact table — n never exceeds 5 here. */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let result = 0;
  for (let i = 0; i < k; i++) result += Math.log((n - i) / (i + 1));
  return result;
}

/**
 * log P(everything recorded | this world is the true one).
 *
 * Unnormalised — only differences between hypotheses matter, and the caller
 * softmaxes them.
 */
export function scoreHypothesis(
  hypothesis: Hypothesis,
  events: GameEvent[],
  game: GameRecord,
  params: BehaviourParams = DEFAULT_PARAMS,
): number {
  const timeline = deriveTimeline(events, game);
  let logLikelihood = 0;

  /* ── Votes ───────────────────────────────────────────────────────────── */

  for (const proposalId of timeline.proposalOrder) {
    const proposal = timeline.proposalsById.get(proposalId);
    if (!proposal?.vote) continue;

    const team = proposal.event.teamPlayerIds;
    const evilAboard = evilOnTeam(hypothesis, team);
    // A round-1 vote is nearly noise and a round-5 vote is nearly proof; the
    // rates are read at the strength that round actually carries.
    const rates = ratesForRound(params, proposal.missionNumber);

    for (const [playerId, choice] of Object.entries(proposal.vote.votes)) {
      // "unknown" is a recorded non-observation. It must contribute nothing,
      // exactly as a seat that was never recorded contributes nothing.
      if (choice !== "approve" && choice !== "reject") continue;

      // Both sides are split the same three ways, so that "riding the car"
      // cancels out instead of being scored as a tell. Note the good rates
      // depend on whether the car is ACTUALLY tainted, which the good player
      // cannot see — that is not a leak, it is the fact that the table's
      // collective read is better than chance, and it is measurable.
      const aboard = team.includes(playerId);
      const evilOnBoard = hypothesis.isEvil(playerId)
        ? evilAboard - (aboard ? 1 : 0) > 0
        : evilAboard > 0;

      let pApprove: number;
      if (!hypothesis.isEvil(playerId)) {
        pApprove = aboard
          ? rates.goodApprovesAboard
          : evilOnBoard
            ? rates.goodApprovesOffTainted
            : rates.goodApprovesOffClean;
      } else {
        pApprove = aboard
          ? rates.evilApprovesAboard
          : evilOnBoard
            ? rates.evilApprovesOffTeammate
            : rates.evilApprovesOffClean;
      }

      logLikelihood += Math.log(
        choice === "approve" ? pApprove : 1 - pApprove,
      );
    }
  }

  /* ── Fail cards ──────────────────────────────────────────────────────── */

  // The score going into each mission, accumulated as we go. It is a recorded
  // fact, not hypothesis-dependent, so it is the same in every world.
  let successes = 0;
  let fails = 0;
  const advance = (result: string | null) => {
    if (result === "success") successes += 1;
    else if (result === "fail") fails += 1;
  };

  for (const mission of timeline.missions) {
    const team = mission.teamPlayerIds;
    // No count recorded means no observation — not zero fails.
    if (!team || mission.failCount == null) {
      advance(mission.result);
      continue;
    }

    const k = evilOnTeam(hypothesis, team);
    const f = mission.failCount;
    if (f > k) {
      advance(mission.result); // impossible; the hard layer already removed it
      continue;
    }

    if (params.failModel === "constant") {
      // The old model, kept so the two can be compared on the same games.
      const p = params.evilPlaysFail;
      logLikelihood +=
        logChoose(k, f) + f * Math.log(p) + (k - f) * Math.log(1 - p);
    } else {
      const dist = failDistribution(k, mission.requiredFails, successes, fails);
      // An unseen combination contributes nothing rather than -Infinity: the
      // hard layer already removed the impossible, so anything reaching here
      // is merely unobserved, and unobserved is not the same as ruled out.
      const q = dist[f];
      if (q !== undefined) logLikelihood += Math.log(Math.max(q, 1e-4));
    }

    advance(mission.result);
  }

  return logLikelihood * params.damping;
}

/**
 * Softmax the scores into weights that sum to 1.
 *
 * Shifted by the maximum before exponentiating — the standard guard against
 * underflow, which matters here because a long game can accumulate scores well
 * past the point where exp() would flush to zero.
 */
export function weighHypotheses(
  hypotheses: readonly Hypothesis[],
  events: GameEvent[],
  game: GameRecord,
  params: BehaviourParams = DEFAULT_PARAMS,
): number[] {
  if (hypotheses.length === 0) return [];
  const scores = hypotheses.map((h) => scoreHypothesis(h, events, game, params));
  const max = Math.max(...scores);
  const weights = scores.map((s) => Math.exp(s - max));
  const total = weights.reduce((a, b) => a + b, 0);
  return total > 0
    ? weights.map((w) => w / total)
    : hypotheses.map(() => 1 / hypotheses.length);
}
