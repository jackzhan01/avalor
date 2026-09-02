/**
 * What a voter has to have LOOKED AT before a vote. Not what it has to decide.
 *
 * WHY THIS EXISTS. The M5.3 Terra game passed all five proposals on the first
 * attempt — zero rejected cars in a whole game. Round two produced three fail
 * cards on 1、2、3、4, and round three's proposal still carried seat 1 with no
 * public explanation, and passed 7:3. A table that never rejects is not a
 * disciplined table; it is a table where the vote carries no information,
 * because approving is what happens by default.
 *
 * WHAT THIS IS NOT. It is not a rejection quota, and it must never become one.
 * Nothing here counts rejections, requires one after a failure, or scores a
 * seat on how often it votes down. `voteAnalysisProblems` refuses INCOMPLETE
 * ANALYSIS, never a choice: a seat that works through all six questions and
 * then approves a team containing the previous failed leader has satisfied
 * every check in this file.
 *
 * The distinction is the same one `obligation: true` draws in the strategy
 * catalog — a position can require you to NOTICE something and leave the ACTION
 * entirely free. Removing the choice would delete the thing being studied.
 */

import type { Fragment } from "../model/json-schema";
import type { Seat } from "../core/types";
import { checkChars, type CognitionLimitsV3, type LimitViolation } from "./limits";

/* ── The bounded conclusion ─────────────────────────────────────────────── */

/** How the last mission result constrains what may ride now. */
export type ConstraintFit =
  /** The team is outside the implicated pool entirely. */
  | "avoids"
  /** It carries somebody the failure implicated, and that is explained. */
  | "carries-explained"
  /** It carries somebody implicated, with no public explanation offered. */
  | "carries-unexplained"
  /** It repeats a team that already failed. */
  | "repeats-failed-team"
  /** No mission has resolved yet, so there is nothing to be consistent with. */
  | "no-constraint-yet";

export interface VoteAnalysis {
  /**
   * The constraint the LAST mission result created, in one sentence.
   *
   * Empty when no mission has resolved. Deliberately the model's own wording of
   * a referee fact rather than an id: the point is to check it can state the
   * arithmetic, and a copied id proves nothing.
   */
  readonly newConstraint: string;
  readonly constraintFit: ConstraintFit;
  /** Seats on this team the last failure implicated. May be empty. */
  readonly implicatedRiders: readonly Seat[];
  /** What the leader publicly said about keeping them. Empty if nothing. */
  readonly leaderExplanation: string;
  /**
   * Does passing this team buy more than demanding a different one?
   *
   * A real question with two real answers. Passing a doubtful team resolves it
   * by result; rejecting it costs a rejection and buys a cleaner test.
   */
  readonly informationFromApproving: string;
  /** Rejections already stacked this round, and what a fifth would mean. */
  readonly rejectionStreak: number;
  readonly hammerRisk: string;
  /** The vote, and it is free. */
  readonly choice: "approve" | "reject";
  /** Why, in one line. Public-safe: this is a conclusion, not a ledger. */
  readonly reason: string;
  /** Public fact ids the analysis rests on. */
  readonly evidenceIds: readonly string[];
}

/* ── Schema ─────────────────────────────────────────────────────────────── */

export const CONSTRAINT_FIT_VALUES: readonly ConstraintFit[] = [
  "avoids",
  "carries-explained",
  "carries-unexplained",
  "repeats-failed-team",
  "no-constraint-yet",
];

export function voteAnalysisFragment(limits: CognitionLimitsV3): Fragment {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "newConstraint",
      "constraintFit",
      "implicatedRiders",
      "leaderExplanation",
      "informationFromApproving",
      "rejectionStreak",
      "hammerRisk",
      "choice",
      "reason",
      "evidenceIds",
    ],
    properties: {
      newConstraint: { type: "string", maxLength: limits.constraintStatementChars * 3 },
      constraintFit: { type: "string", enum: [...CONSTRAINT_FIT_VALUES] },
      implicatedRiders: {
        type: "array",
        items: { type: "integer", minimum: 1, maximum: 10 },
        maxItems: 5,
      },
      leaderExplanation: { type: "string", maxLength: limits.claimCaseChars * 3 },
      informationFromApproving: { type: "string", maxLength: limits.claimCaseChars * 3 },
      rejectionStreak: { type: "integer", minimum: 0, maximum: 5 },
      hammerRisk: { type: "string", maxLength: limits.claimConditionChars * 3 },
      choice: { type: "string", enum: ["approve", "reject"] },
      reason: { type: "string", minLength: 1, maxLength: limits.claimCaseChars * 3 },
      evidenceIds: { type: "array", items: { type: "string" }, maxItems: 5 },
    },
  };
}

/* ── Structural checks ──────────────────────────────────────────────────── */

export interface VoteContext {
  readonly seat: Seat;
  readonly proposedTeam: readonly Seat[];
  readonly rejectionStreak: number;
  /** Has any mission resolved yet? */
  readonly anyMissionResolved: boolean;
  /** The most recent failed team, if there is one. */
  readonly lastFailedTeam: readonly Seat[] | null;
}

/**
 * What is structurally wrong with this analysis.
 *
 * EVERY CHECK IS ABOUT COMPLETENESS OR CONSISTENCY. None is about the vote.
 * The one that comes closest — `carries-unexplained` while claiming the team
 * `avoids` the constraint — is a contradiction between two of the model's own
 * fields, not a judgement about whether it should have rejected.
 */
export function voteAnalysisProblems(
  analysis: VoteAnalysis,
  context: VoteContext,
): string[] {
  const problems: string[] = [];

  if (!context.anyMissionResolved) {
    if (analysis.constraintFit !== "no-constraint-yet") {
      problems.push(
        `还没有任何任务结算，constraintFit 只能是 no-constraint-yet，现在是 ${analysis.constraintFit}`,
      );
    }
  } else if (analysis.constraintFit === "no-constraint-yet") {
    problems.push("已经有任务结算了，constraintFit 不能是 no-constraint-yet —— 那条约束是什么？");
  } else if (analysis.newConstraint.trim().length === 0) {
    problems.push("已经有任务结算了，newConstraint 不能为空：上一轮的结果给出了什么约束？");
  }

  // The riders it names must actually be on the team being voted on.
  for (const seat of analysis.implicatedRiders) {
    if (!context.proposedTeam.includes(seat)) {
      problems.push(`implicatedRiders 里的 ${seat}号 不在这辆车上`);
    }
  }

  // `carries-*` and `avoids` are claims about the same set, so they have to
  // agree with it.
  const carries =
    analysis.constraintFit === "carries-explained" ||
    analysis.constraintFit === "carries-unexplained";
  if (carries && analysis.implicatedRiders.length === 0) {
    problems.push(
      `constraintFit 是 ${analysis.constraintFit}，但 implicatedRiders 是空的 —— 到底带了谁？`,
    );
  }
  if (analysis.constraintFit === "avoids" && analysis.implicatedRiders.length > 0) {
    problems.push("constraintFit 说 avoids，但 implicatedRiders 又不为空，两者对不上");
  }
  if (analysis.constraintFit === "carries-explained" && analysis.leaderExplanation.trim().length === 0) {
    problems.push("说队长解释过，那 leaderExplanation 就不能为空 —— 他具体说了什么？");
  }

  // Repeating a failed team is a fact, not an opinion.
  if (context.lastFailedTeam && analysis.constraintFit !== "repeats-failed-team") {
    const same =
      context.lastFailedTeam.length === context.proposedTeam.length &&
      [...context.lastFailedTeam].sort().every((s, i) => s === [...context.proposedTeam].sort()[i]);
    if (same) {
      problems.push("这辆车和刚挂掉的那辆一模一样，constraintFit 必须是 repeats-failed-team");
    }
  }

  if (analysis.rejectionStreak !== context.rejectionStreak) {
    problems.push(
      `rejectionStreak 抄错了：现在连否 ${context.rejectionStreak} 次，你填的是 ${analysis.rejectionStreak}`,
    );
  }
  if (context.rejectionStreak >= 3 && analysis.hammerRisk.trim().length === 0) {
    problems.push(`已经连否 ${context.rejectionStreak} 次，hammerRisk 不能空着`);
  }
  if (analysis.reason.trim().length === 0) problems.push("reason 不能为空");

  return problems;
}

export function checkVoteAnalysisBounds(
  analysis: VoteAnalysis,
  limits: CognitionLimitsV3,
): LimitViolation[] {
  return [
    ...checkChars("voteAnalysis.newConstraint", analysis.newConstraint, limits.constraintStatementChars),
    ...checkChars("voteAnalysis.leaderExplanation", analysis.leaderExplanation, limits.claimCaseChars),
    ...checkChars(
      "voteAnalysis.informationFromApproving",
      analysis.informationFromApproving,
      limits.claimCaseChars,
    ),
    ...checkChars("voteAnalysis.hammerRisk", analysis.hammerRisk, limits.claimConditionChars),
    ...checkChars("voteAnalysis.reason", analysis.reason, limits.claimCaseChars),
  ];
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

export type VoteAnalysisParse =
  | { readonly ok: true; readonly analysis: VoteAnalysis }
  | { readonly ok: false; readonly error: string };

export function parseVoteAnalysis(raw: unknown): VoteAnalysisParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "voteAnalysis 必须是一个对象" };
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");

  const fit = o.constraintFit;
  if (typeof fit !== "string" || !(CONSTRAINT_FIT_VALUES as readonly string[]).includes(fit)) {
    return {
      ok: false,
      error: `voteAnalysis.constraintFit 必须是这五个之一：${CONSTRAINT_FIT_VALUES.join(" / ")}`,
    };
  }
  const choice = o.choice;
  if (choice !== "approve" && choice !== "reject") {
    return { ok: false, error: "voteAnalysis.choice 必须是 approve 或 reject" };
  }
  if (!Array.isArray(o.implicatedRiders)) {
    return { ok: false, error: "voteAnalysis.implicatedRiders 必须是数组" };
  }
  for (const s of o.implicatedRiders) {
    if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > 10) {
      return { ok: false, error: "voteAnalysis.implicatedRiders 里有不是 1-10 的座位号" };
    }
  }
  if (!Array.isArray(o.evidenceIds) || o.evidenceIds.some((x) => typeof x !== "string")) {
    return { ok: false, error: "voteAnalysis.evidenceIds 必须是字符串数组" };
  }
  const streak = o.rejectionStreak;
  if (typeof streak !== "number" || !Number.isInteger(streak)) {
    return { ok: false, error: "voteAnalysis.rejectionStreak 必须是整数" };
  }

  return {
    ok: true,
    analysis: {
      newConstraint: str("newConstraint"),
      constraintFit: fit as ConstraintFit,
      implicatedRiders: o.implicatedRiders as readonly Seat[],
      leaderExplanation: str("leaderExplanation"),
      informationFromApproving: str("informationFromApproving"),
      rejectionStreak: streak,
      hammerRisk: str("hammerRisk"),
      choice,
      reason: str("reason"),
      evidenceIds: o.evidenceIds as readonly string[],
    },
  };
}

/* ── The instruction ────────────────────────────────────────────────────── */

/**
 * How to fill it in. Six questions, and the last line is the important one.
 *
 * The instruction says explicitly that approving is a legitimate answer to
 * every one of them, because a list of six sceptical questions with no such
 * line reads as a demand to reject — and a table that rejects on cue is no
 * more informative than one that approves on cue.
 */
export const VOTE_ANALYSIS_INSTRUCTION = [
  "### 投这一票之前，先填 `voteAnalysis`",
  "",
  "六个问题，全部要有答案。填**结论**，不要写推理过程。",
  "",
  "- `newConstraint`：**上一次任务结果给出了什么新约束？** 用你自己的话写一句。",
  "  比如「第二轮 1、2、3、4 出了三张失败票，这四个人里至少有三个坏人」。还没有任务结算就留空。",
  "- `constraintFit`：这辆车和那条约束的关系，五选一 ——",
  "  `avoids`（完全避开）/ `carries-explained`（带了被牵连的人，但队长解释过）/",
  "  `carries-unexplained`（带了，没解释）/ `repeats-failed-team`（原样重带挂过的车）/",
  "  `no-constraint-yet`（还没有任务结算）。",
  "- `implicatedRiders`：这辆车上被上一次失败牵连的人。没有就给空数组。",
  "- `leaderExplanation`：**队长为留下这些人公开说了什么？** 一个字都没说就留空 ——",
  "  留空本身就是一条信息。",
  "- `informationFromApproving`：**放过去换到的信息，比要求换人更多吗？**",
  "  放行用结果换信息是真选项；要求换人也是。哪个更值，你自己判断。",
  "- `rejectionStreak` / `hammerRisk`：抄现在连否几次，并说清再否下去的代价。",
  "  连否五次这一轮直接判坏人赢 —— 这条永远在天平上。",
  "",
  "然后 `choice` 和 `reason`。",
  "",
  "**这六个问题不是要你投反对。** 每一个的合理答案里都包含「所以我上票」。",
  "一辆带着被牵连的人的车，如果队长给了一个能公开核对的理由，放过去可能正是对的；",
  "连否到第四次的时候，放一辆不完美的车过去往往也是对的。",
  "**要求的只有一件事：这六件事你看过了。看完怎么投，完全是你的判断。**",
].join("\n");
