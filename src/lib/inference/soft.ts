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

  for (const mission of timeline.missions) {
    const team = mission.teamPlayerIds;
    // No count recorded means no observation — not zero fails.
    if (!team || mission.failCount == null) continue;

    const k = evilOnTeam(hypothesis, team);
    const f = mission.failCount;
    if (f > k) continue; // impossible; the hard layer already removed it

    // Binomial: each evil aboard independently decides whether to play the
    // fail card. This is what makes "the quest passed clean" informative —
    // it is evidence FOR fewer evils aboard, without ever proving it.
    logLikelihood +=
      logChoose(k, f) +
      f * Math.log(params.evilPlaysFail) +
      (k - f) * Math.log(1 - params.evilPlaysFail);
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
