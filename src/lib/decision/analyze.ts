/**
 * The product surface. Everything the app needs, and nothing it should know.
 *
 * The UI asks one question — what is going on and what should I do — and gets
 * back numbers with names it can render. Behind it sit the frozen belief
 * engine, an exhaustive risk ranking over legal teams and a Monte Carlo
 * rollout, and none of those words appear in the answer.
 *
 * Three commitments this file exists to keep:
 *
 *   DETERMINISTIC   the same state and the same seed give the same answer,
 *                   every time, on any machine
 *   OFFLINE         no network, no model, no key. The recommendation is a
 *                   function of the log and the rules
 *   HONEST          when the evidence does not separate the options it says
 *                   so, rather than rounding a coin flip into advice
 *
 * Belief and team risk are computed EXACTLY from the surviving worlds — no
 * sampling — so those numbers never move between calls. Only the action values
 * are estimated, and they carry their own uncertainty.
 */

import {
  deriveRoleInference,
  deriveSideInference,
} from "@/lib/inference";
import { weighHypotheses } from "@/lib/inference/soft";
import { teamSize as sizeFor } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { evaluateActions } from "./rollout";
import { buildDecisionState, type Action, type DecisionState } from "./state";

/** Bumped whenever an answer could change for the same input. */
export const ALGORITHM_VERSION = "product-v1.0.0";

const EVIL_ROLES: RoleType[] = [
  "morgana",
  "mordred",
  "oberon",
  "assassin",
  "minion",
];

/**
 * How far apart two action values have to be before the difference is worth
 * acting on, in win probability.
 *
 * Three points of win chance. Below that the honest answer is that both moves
 * are about as good, whatever the arithmetic happens to prefer today.
 */
export const MEANINGFUL_DELTA = 0.03;

/** Default Monte Carlo effort. Tuned against a ten-player table on a laptop. */
export const DEFAULT_WORLDS = 400;
/** How many of the exhaustively ranked teams get a rollout. */
export const DEFAULT_SHORTLIST = 5;

/**
 * Worlds per candidate team, which is far fewer than a vote gets.
 *
 * The proposal recommendation does not come from the rollout at all — it comes
 * from the exact risk ranking over every legal team, and its confidence from
 * how far the pick sits below the field. The rollout is here only to put a win
 * number beside each option, and that number is shown with its own error bar.
 * So five candidates at 150 worlds is honest and takes a third as long as five
 * at 400, which is the difference between three seconds and eight on a
 * ten-player table.
 */
export const DEFAULT_PROPOSAL_WORLDS = 150;

export interface AnalyzeOptions {
  /** Monte Carlo worlds per action. More is slower and tighter. */
  worlds?: number;
  /** Anything fixed gives a reproducible answer. */
  seed?: number;
  /** How many candidate teams to evaluate by rollout. */
  shortlist?: number;
  /** Skip the rollout and return belief only — fast path for a live table. */
  beliefOnly?: boolean;
}

export interface PlayerBelief {
  playerId: string;
  seat: number;
  /** P(this seat is evil), from the joint role posterior. */
  evilProbability: number;
  /** Roles actually dealt, most likely first. Never includes roles not in play. */
  roles: { role: RoleType; probability: number }[];
  /**
   * True in every world still standing, or in none.
   *
   * Read off the COUNT of surviving worlds, never the weights, so no
   * behavioural assumption can manufacture one.
   */
  proven: "good" | "evil" | null;
}

export interface TeamRisk {
  team: string[];
  /** Expected number of evils aboard. */
  expectedEvil: number;
  /** P(enough evils aboard to sink this quest). The joint, not a sum. */
  failRisk: number;
  /** Where it sits among every legal team, 0 safest to 1 riskiest. */
  percentile: number;
}

export type Confidence = "strong" | "lean" | "too-close";

export interface ActionEstimate {
  /** P(the viewer's side wins | this action). */
  win: number;
  /** One standard error on that estimate. */
  se: number;
}

export interface VoteDecision {
  type: "vote";
  approve: ActionEstimate;
  reject: ActionEstimate;
  /** Approve minus reject, paired across worlds so the noise mostly cancels. */
  delta: number;
  deltaSe: number;
  /**
   * The advice, from the win-rate difference alone. Null when that difference
   * is inside its own noise — no certainty is manufactured to fill the gap.
   */
  recommendation: "approve" | "reject" | null;
  /**
   * Which way the car's own risk points, always present.
   *
   * A separate field on purpose, and the reason is worth stating. One seat's
   * vote at a nine-player table changes the outcome only when the other eight
   * split evenly, so even a car that is CERTAIN to fail moves the win rate by
   * a couple of points and lands as too-close. That is correct and it is also
   * useless as advice. The risk direction is deterministic, needs no rollout,
   * and is what a player actually wants when the value difference is flat —
   * but it is not a claim about winning, so it is not called a recommendation.
   */
  riskDirection: "approve" | "reject";
  confidence: Confidence;
  explanation: string;
}

export interface TeamOption extends TeamRisk {
  estimate: ActionEstimate | null;
}

export interface ProposalDecision {
  type: "proposal";
  recommended: TeamOption;
  alternatives: TeamOption[];
  /**
   * How much cleaner the recommendation is than a middling legal car.
   *
   * NOT the gap to the runner-up, and the difference matters. The shortlist is
   * the safest handful of teams, so they are all about equally good by
   * construction and the gap between them is noise — measuring that would say
   * "too close" every single time while hiding that the pick is far better
   * than most of the board. What a leader wants to know is whether his choice
   * is worth making at all, which is a question about the whole field.
   */
  edgeOverMedian: number;
  /** Spread of fail risk across every legal team, worst minus best. */
  fieldSpread: number;
  confidence: Confidence;
  explanation: string;
}

export interface GameAnalysis {
  version: string;
  seed: number;
  beliefs: {
    players: PlayerBelief[];
    /** The log contradicts itself; nothing above means anything. */
    contradictory: boolean;
    /** Worlds still standing, out of how many the table started with. */
    surviving: number;
    total: number;
  };
  currentTeam?: TeamRisk;
  decision?: VoteDecision | ProposalDecision;
  /** Why there is no decision, when there is none. */
  noDecisionReason?: "no-viewer" | "no-side" | "nothing-to-decide";
}

/* ── exact posterior helpers ─────────────────────────────────────────────── */

interface Posterior {
  seats: string[];
  /** Per surviving world: bitmask of evil seats, and its weight. */
  masks: number[];
  weights: number[];
  contradictory: boolean;
  surviving: number;
  total: number;
}

function popcount(x: number): number {
  let v = x - ((x >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * The user-conditioned posterior over evil sets.
 *
 * Conditioned on what the USER knows, which is the right basis for advising
 * them — their own role and sight are theirs to use. It is not the public read
 * and must never be handed to a simulated opponent.
 */
function posteriorOf(events: readonly GameEvent[], game: GameRecord): Posterior {
  const seats = [...game.players].sort((a, b) => a.seat - b.seat).map((p) => p.id);
  const side = deriveSideInference(events as GameEvent[], game);
  if (side.contradictory || side.surviving.length === 0) {
    return {
      seats,
      masks: [],
      weights: [],
      contradictory: true,
      surviving: 0,
      total: side.total,
    };
  }
  const weights = weighHypotheses(side.surviving, events as GameEvent[], game);
  const masks = side.surviving.map((hypothesis) => {
    let mask = 0;
    seats.forEach((seat, i) => {
      if (hypothesis.isEvil(seat)) mask |= 1 << i;
    });
    return mask;
  });
  return {
    seats,
    masks,
    weights,
    contradictory: false,
    surviving: side.surviving.length,
    total: side.total,
  };
}

function riskOf(
  posterior: Posterior,
  teamMask: number,
  requiredFails: number,
): { expectedEvil: number; failRisk: number } {
  let expected = 0;
  let fail = 0;
  for (let h = 0; h < posterior.masks.length; h += 1) {
    const w = posterior.weights[h];
    if (w <= 0) continue;
    const aboard = popcount(posterior.masks[h] & teamMask);
    expected += w * aboard;
    if (aboard >= requiredFails) fail += w;
  }
  // Summed normalised weights leave float dust, and a probability of
  // 1.0000000000000002 reaching the UI is a bug report waiting to happen.
  return {
    expectedEvil: Math.max(0, expected),
    failRisk: Math.min(1, Math.max(0, fail)),
  };
}

/** Every k-subset of the seats, as bitmasks. Cached per (n, k). */
const teamCache = new Map<string, number[]>();

function legalTeamMasks(n: number, size: number): number[] {
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

function maskOf(seats: readonly string[], team: readonly string[]): number {
  let mask = 0;
  for (const seat of team) {
    const i = seats.indexOf(seat);
    if (i >= 0) mask |= 1 << i;
  }
  return mask;
}

function seatsOf(seats: readonly string[], mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < seats.length; i += 1) if (mask & (1 << i)) out.push(seats[i]);
  return out;
}

/* ── beliefs ─────────────────────────────────────────────────────────────── */

function beliefsOf(
  events: readonly GameEvent[],
  game: GameRecord,
  posterior: Posterior,
): GameAnalysis["beliefs"] {
  const side = deriveSideInference(events as GameEvent[], game);
  const roles = deriveRoleInference(events as GameEvent[], game);
  const players = [...game.players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => {
      const row = roles.byPlayer.get(player.id);
      const ranked = row
        ? [...row.entries()]
            .filter(([, p]) => p > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([role, probability]) => ({ role, probability }))
        : [];
      let evil = 0;
      for (const { role, probability } of ranked) {
        if (EVIL_ROLES.includes(role)) evil += probability;
      }
      return {
        playerId: player.id,
        seat: player.seat,
        // The role layer's own marginal, so the two views never disagree.
        evilProbability: Math.min(
          1,
          Math.max(0, ranked.length ? evil : (side.evilProbability.get(player.id) ?? 0)),
        ),
        roles: ranked,
        proven: side.provenEvil.includes(player.id)
          ? ("evil" as const)
          : side.provenGood.includes(player.id)
            ? ("good" as const)
            : null,
      };
    });

  return {
    players,
    contradictory: posterior.contradictory,
    surviving: posterior.surviving,
    total: posterior.total,
  };
}

/* ── confidence ──────────────────────────────────────────────────────────── */

/**
 * How much to trust a gap between two action values.
 *
 * Two gates, and both have to pass. The difference must clear its own noise —
 * two standard errors, so a coin flip does not get promoted by a lucky run —
 * and it must be big enough to matter at a real table. The old entropy
 * threshold on role certainty is deliberately not revived: what a player needs
 * to know is whether the MOVES differ, not whether the roles are solved.
 */
export function confidenceOf(delta: number, se: number): Confidence {
  const size = Math.abs(delta);
  if (!Number.isFinite(size) || size < 2 * se) return "too-close";
  return size >= MEANINGFUL_DELTA ? "strong" : "lean";
}

/* ── explanations ────────────────────────────────────────────────────────── */

const seatLabel = (game: GameRecord, id: string) =>
  `${game.players.find((p) => p.id === id)?.seat ?? "?"}号`;

/** The riskiest seats on a team, by the same posterior the advice used. */
function worstSeats(
  game: GameRecord,
  posterior: Posterior,
  team: readonly string[],
  howMany: number,
): string[] {
  const per = new Map<string, number>();
  for (const seat of team) {
    const i = posterior.seats.indexOf(seat);
    if (i < 0) continue;
    let p = 0;
    for (let h = 0; h < posterior.masks.length; h += 1) {
      if (posterior.masks[h] & (1 << i)) p += posterior.weights[h];
    }
    per.set(seat, p);
  }
  return [...per.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, howMany)
    .map(([seat]) => seatLabel(game, seat));
}

function voteExplanation(
  state: DecisionState,
  posterior: Posterior,
  risk: TeamRisk,
  recommendation: "approve" | "reject" | null,
  confidence: Confidence,
): string {
  const game = state.game;
  const worst = worstSeats(game, posterior, risk.team, 2);
  const pct = Math.round(risk.failRisk * 100);
  const hammer = state.rejectionStreak >= 4;

  if (confidence === "too-close") {
    const lean = recommendation === "reject" ? "下票" : "上票";
    const where = recommendation === "reject" ? "偏脏的一半" : "偏干净的一半";
    return (
      `这辆车崩掉的概率约 ${pct}%，在所有合法车里属于${where}。` +
      `你一票通常改变不了结果 —— 所以上票下票的胜率差落在噪声里 —— ` +
      `真要选就${lean}。`
    );
  }
  if (recommendation === "reject") {
    if (hammer) {
      return `这辆车崩掉的概率约 ${pct}%，但这是第 5 车 —— 否掉直接把这局送给坏人。仍然建议下票，说明模型认为这辆车比连挂还糟。`;
    }
    return `这辆车崩掉的概率约 ${pct}%，风险主要来自 ${worst.join("、")}。下票之后还有机会换一辆更干净的。`;
  }
  if (hammer) {
    return `第 5 车，否掉就输。这辆车崩掉的概率约 ${pct}%，上票是唯一还能赢的走法。`;
  }
  return `这辆车崩掉的概率约 ${pct}%，在所有合法车里属于较干净的那一档（第 ${Math.round(risk.percentile * 100)} 百分位）。`;
}

function proposalExplanation(
  state: DecisionState,
  posterior: Posterior,
  best: TeamOption,
  confidence: Confidence,
): string {
  const game = state.game;
  const names = best.team.map((id) => seatLabel(game, id)).join("、");
  const pct = Math.round(best.failRisk * 100);
  const rank = Math.round(best.percentile * 100);
  const rides = state.viewerId ? best.team.includes(state.viewerId) : false;

  const head = `建议点 ${names}：崩车概率约 ${pct}%，在全部合法车里排第 ${rank} 百分位。`;
  const ride = rides ? "这辆车带上了你自己。" : "这辆车没带你自己。";
  if (confidence === "too-close") {
    return `${head}${ride}不过现在场上每辆合法车的风险都差不多 —— 信息还不够多，点谁差别不大。`;
  }
  return `${head}${ride}`;
}

/* ── the entry point ─────────────────────────────────────────────────────── */

export async function analyzeGame(
  events: readonly GameEvent[],
  game: GameRecord,
  options: AnalyzeOptions = {},
): Promise<GameAnalysis> {
  const seed = options.seed ?? 1;
  const worlds = options.worlds ?? DEFAULT_WORLDS;
  const state = buildDecisionState(events as GameEvent[], game);
  const posterior = posteriorOf(events, game);
  const beliefs = beliefsOf(events, game, posterior);

  const analysis: GameAnalysis = {
    version: ALGORITHM_VERSION,
    seed,
    beliefs,
  };

  if (state.proposedTeam && !posterior.contradictory) {
    const mask = maskOf(posterior.seats, state.proposedTeam);
    const { expectedEvil, failRisk } = riskOf(posterior, mask, state.requiredFails);
    const all = legalTeamMasks(posterior.seats.length, state.proposedTeam.length)
      .map((m) => riskOf(posterior, m, state.requiredFails).failRisk)
      .sort((a, b) => a - b);
    // Mid-rank: before any evidence every legal team ties exactly, and a
    // strictly-below count would report all of them as the safest.
    let below = 0;
    let equal = 0;
    for (const value of all) {
      if (value < failRisk - 1e-12) below += 1;
      else if (value <= failRisk + 1e-12) equal += 1;
    }
    analysis.currentTeam = {
      team: [...state.proposedTeam],
      expectedEvil,
      failRisk,
      percentile: (below + equal / 2) / Math.max(all.length, 1),
    };
  }

  if (options.beliefOnly) return analysis;
  if (!state.viewerId) {
    analysis.noDecisionReason = "no-viewer";
    return analysis;
  }
  if (!state.viewerSide) {
    analysis.noDecisionReason = "no-side";
    return analysis;
  }
  if (posterior.contradictory) {
    analysis.noDecisionReason = "nothing-to-decide";
    return analysis;
  }

  const votes = state.legalActions.filter((a) => a.kind === "vote");
  if (votes.length === 2 && analysis.currentTeam) {
    analysis.decision = await decideVote(state, posterior, analysis.currentTeam, {
      worlds,
      seed,
    });
    return analysis;
  }

  /*
   * Holding the car. `legalActions` deliberately does NOT enumerate proposals
   * — 252 of them would not belong in a state object — so the condition is
   * read off the table instead: nothing up for a vote, and the car is yours.
   */
  if (!state.proposedTeam && state.leaderId === state.viewerId) {
    analysis.decision = await decideProposal(state, posterior, {
      worlds: options.worlds ?? DEFAULT_PROPOSAL_WORLDS,
      seed,
      shortlist: options.shortlist ?? DEFAULT_SHORTLIST,
    });
    return analysis;
  }

  analysis.noDecisionReason = "nothing-to-decide";
  return analysis;
}

/**
 * Paired difference between two actions.
 *
 * The rollout gives both actions the same world and the same random stream, so
 * their outcomes are positively correlated and the difference is far tighter
 * than either estimate alone. Taking the standard error from the per-world
 * differences is what turns that into a smaller interval rather than throwing
 * the pairing away.
 */
function pairedDelta(
  a: Uint8Array,
  b: Uint8Array,
): { delta: number; se: number } {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { delta: 0, se: Infinity };
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i] - b[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i += 1) variance += (a[i] - b[i] - mean) ** 2;
  return { delta: mean, se: Math.sqrt(variance / Math.max(n - 1, 1) / n) };
}

async function decideVote(
  state: DecisionState,
  posterior: Posterior,
  risk: TeamRisk,
  options: { worlds: number; seed: number },
): Promise<VoteDecision> {
  const actions: Action[] = [
    { kind: "vote", choice: "approve" },
    { kind: "vote", choice: "reject" },
  ];
  const values = await evaluateActions(state, actions, { ...options, collect: true });
  const approve = values.find(
    (v) => v.action.kind === "vote" && v.action.choice === "approve",
  )!;
  const reject = values.find(
    (v) => v.action.kind === "vote" && v.action.choice === "reject",
  )!;

  const { delta, se } = pairedDelta(approve.wins!, reject.wins!);
  const confidence = confidenceOf(delta, se);
  const recommendation =
    confidence === "too-close" ? null : delta > 0 ? "approve" : "reject";
  // Below the middle of the legal teams by risk, this car is a good one to let
  // through; above it, there is a cleaner one to wait for.
  const riskDirection = risk.percentile < 0.5 ? "approve" : "reject";

  return {
    type: "vote",
    approve: { win: approve.q, se: approve.se },
    reject: { win: reject.q, se: reject.se },
    delta,
    deltaSe: se,
    recommendation,
    riskDirection,
    confidence,
    explanation: voteExplanation(
      state,
      posterior,
      risk,
      recommendation ?? riskDirection,
      confidence,
    ),
  };
}

async function decideProposal(
  state: DecisionState,
  posterior: Posterior,
  options: { worlds: number; seed: number; shortlist: number },
): Promise<ProposalDecision> {
  const count = state.game.playerCount as PlayerCount;
  const round = Math.min(Math.max(state.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;
  const size = sizeFor(count, round);
  const n = posterior.seats.length;

  /*
   * Exhaustive over every legal team — 252 of them at the largest table — by
   * the exact joint risk. The rollout is far too slow to run on all of them
   * (that would be hours), so it ranks the shortlist this produces. The search
   * is complete; only the valuation is sampled.
   */
  const ranked = legalTeamMasks(n, size)
    .map((mask) => ({ mask, ...riskOf(posterior, mask, state.requiredFails) }))
    .sort((a, b) => a.failRisk - b.failRisk);

  const sorted = ranked.map((r) => r.failRisk);
  const percentileOf = (value: number) => {
    let below = 0;
    let equal = 0;
    for (const v of sorted) {
      if (v < value - 1e-12) below += 1;
      else if (v <= value + 1e-12) equal += 1;
    }
    return (below + equal / 2) / Math.max(sorted.length, 1);
  };

  const shortlist = ranked.slice(0, Math.max(2, options.shortlist));
  const values = await evaluateActions(
    state,
    shortlist.map((r) => ({
      kind: "propose" as const,
      team: seatsOf(posterior.seats, r.mask),
    })),
    { worlds: options.worlds, seed: options.seed, collect: true },
  );

  const options_: TeamOption[] = shortlist.map((r, i) => ({
    team: seatsOf(posterior.seats, r.mask),
    expectedEvil: r.expectedEvil,
    failRisk: r.failRisk,
    percentile: percentileOf(r.failRisk),
    estimate: values[i] ? { win: values[i].q, se: values[i].se } : null,
  }));

  /*
   * Ranked by the exact risk, not by the sampled value.
   *
   * The shortlist members differ by a couple of points of fail risk, which is
   * far inside the rollout's own noise, so ordering them by win estimate would
   * be ordering them by luck. The exact number decides; the estimate is shown
   * because a player wants to know roughly what they are playing for.
   */
  const best = options_[0];
  const alternatives = options_.slice(1);

  const median = sorted[Math.floor(sorted.length / 2)] ?? best.failRisk;
  const edgeOverMedian = median - best.failRisk;
  const fieldSpread = (sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0);

  /*
   * When every legal car carries about the same risk — which is exactly the
   * situation before anything has happened — no choice is worth much, and the
   * honest answer is that it hardly matters who goes.
   */
  const confidence: Confidence =
    fieldSpread < 0.05
      ? "too-close"
      : edgeOverMedian >= 0.15
        ? "strong"
        : edgeOverMedian >= 0.05
          ? "lean"
          : "too-close";

  return {
    type: "proposal",
    recommended: best,
    alternatives,
    edgeOverMedian,
    fieldSpread,
    confidence,
    explanation: proposalExplanation(state, posterior, best, confidence),
  };
}
