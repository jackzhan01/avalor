/**
 * What a REFUSED cognition attempt records.
 *
 * WHY IT IS A SEPARATE PATH. `onCognition` fires only after every check has
 * passed, so for four milestones a rejected attempt produced no report at all.
 * The M5.5 pilot made the consequence concrete: `purposelessClaim` and
 * `malformedEvidence` were fields nothing could ever set to a rejecting value,
 * and `rejectedAmbiguity` was a metric that could not count the thing it was
 * named after. Reusing `onCognition` for refusals would be worse — it is the
 * ACCEPTED-state hook, and every consumer folds it into the ledger.
 *
 * SANITISED BY CONSTRUCTION, not by filtering. Everything here is either a
 * closed enum, a schema field name, a seat number or a counter. There is no
 * field a private value could occupy: no raw answer, no prose, no role, no
 * pair, no roster. `classify` takes a problem STRING and returns a code from a
 * fixed table — the string itself is never stored and never leaves the agent.
 *
 * FALLS BACK RATHER THAN GUESSES. A problem whose shape is not in the table
 * becomes a generic code for its category. That is deliberate: a classifier
 * that invented a code from unmatched text would be the one way private words
 * could reach this object.
 */

import type { Seat } from "../core/types";
import type { MalformedRef } from "./evidence-refs";

/* ── The categories ─────────────────────────────────────────────────────── */

export type RejectionCategory =
  /** A standing claim repeated with no purpose the public log supports. */
  | "purposeless-claim"
  /** `resolving-ambiguity` citing nothing that qualifies. */
  | "unsupported-ambiguity"
  /** A citation slot holding more than one id, or one that does not resolve. */
  | "malformed-evidence"
  /** The claim-contest block disagrees with itself or with the referee record. */
  | "claim-contest-inconsistency"
  /** The block did not parse, or a bounded field was the wrong shape. */
  | "bounds-or-shape";

export const REJECTION_CATEGORIES: readonly RejectionCategory[] = [
  "purposeless-claim",
  "unsupported-ambiguity",
  "malformed-evidence",
  "claim-contest-inconsistency",
  "bounds-or-shape",
];

/* ── The report ─────────────────────────────────────────────────────────── */

export interface CognitionRejection {
  /**
   * Which decision this was, stable within one game.
   *
   * The task id and the number of public events the seat could see. Two
   * attempts at the same decision share it, which is what lets a reader group
   * the repair chain — and it carries no content, only a position.
   */
  readonly decision: string;
  readonly seat: Seat;
  /** `speech-regular`, `vote`, `assassinate` … the task, not the prompt. */
  readonly taskId: string;
  /** 1 for the first ask. Matches `CognitionReport.attempt`. */
  readonly attempt: number;
  readonly categories: readonly RejectionCategory[];
  /** Closed-vocabulary codes. See `classify`. */
  readonly codes: readonly string[];
  /**
   * Will the seat be asked again?
   *
   * `false` means the repair budget is spent and the run is about to stop —
   * which is what separates 「修好了」 from 「用尽了」 in the aggregate.
   */
  readonly willRetry: boolean;
}

/* ── Classification ─────────────────────────────────────────────────────── */

/**
 * Stable markers for the problems each checker emits.
 *
 * SUBSTRING MATCHING, and the honest cost is written down: if a checker's
 * wording changes, its problems fall through to the category's generic code
 * rather than to a wrong one. That is a degraded label, never a leak and never
 * a behaviour change — the validation outcome is decided long before this runs.
 */
const CLAIM_CODES: readonly (readonly [string, string])[] = [
  ["必须写 `claimPurpose`", "claim.purpose-missing"],
  ["first-claim，但你从", "claim.first-claim-conflict"],
  ["从来没有退过水", "claim.re-entering-without-retraction"],
  ["没有人跳同一个身份", "claim.challenge-unsupported"],
  ["什么都没有发生过", "ambiguity.none-available"],
  ["没有指出是哪一件公开的事", "ambiguity.not-cited"],
  ["没有一件是在你上次报身份之后", "ambiguity.unqualified"],
];

const CONTEST_CODES: readonly (readonly [string, string])[] = [
  ["rivalPlans", "contest.rival-plans"],
  ["claimantAssessments", "contest.claimant-coverage"],
  ["publicClaimMove", "contest.public-move"],
  ["这次发言的 claim", "contest.action-atomicity"],
  ["alignment", "contest.alignment"],
];

/** The category a claim problem belongs to. Ambiguity is its own bucket. */
export function claimRejection(problem: string): {
  readonly category: RejectionCategory;
  readonly code: string;
} {
  const hit = CLAIM_CODES.find(([marker]) => problem.includes(marker));
  const code = hit?.[1] ?? "claim.unclassified";
  return {
    category: code.startsWith("ambiguity.") ? "unsupported-ambiguity" : "purposeless-claim",
    code,
  };
}

/** The category a `cognitionProblems` string belongs to. */
export function structuralRejection(problem: string): {
  readonly category: RejectionCategory;
  readonly code: string;
} {
  const hit = CONTEST_CODES.find(([marker]) => problem.includes(marker));
  if (hit) return { category: "claim-contest-inconsistency", code: hit[1] };
  return { category: "bounds-or-shape", code: "shape.unclassified" };
}

/** Malformed citations, as codes: the kind and the field, never the value. */
export function evidenceRejection(hits: readonly MalformedRef[]): {
  readonly category: RejectionCategory;
  readonly codes: readonly string[];
} {
  return {
    category: "malformed-evidence",
    codes: [...new Set(hits.map((h) => `evidence.${h.kind}:${h.field}`))].slice(0, 6),
  };
}

/* ── Aggregation, for the private report ────────────────────────────────── */

export interface RejectionSummary {
  readonly total: number;
  readonly byCategory: Readonly<Record<RejectionCategory, number>>;
  readonly bySeat: Readonly<Record<string, number>>;
  readonly byTask: Readonly<Record<string, number>>;
  /**
   * Decisions that were rejected at least once and then accepted.
   *
   * Counted over DECISIONS rather than attempts: a decision repaired on the
   * third ask is one repair, not two, and a reader asking "how often did the
   * repair path work" wants that number.
   */
  readonly repaired: number;
  /** Decisions whose repair budget ran out. */
  readonly exhausted: number;
}

export function summariseRejections(
  rejections: readonly CognitionRejection[],
): RejectionSummary {
  const byCategory = Object.fromEntries(
    REJECTION_CATEGORIES.map((c) => [c, 0]),
  ) as Record<RejectionCategory, number>;
  const bySeat: Record<string, number> = {};
  const byTask: Record<string, number> = {};
  const lastOfDecision = new Map<string, CognitionRejection>();

  for (const r of rejections) {
    for (const c of r.categories) byCategory[c] += 1;
    bySeat[String(r.seat)] = (bySeat[String(r.seat)] ?? 0) + 1;
    byTask[r.taskId] = (byTask[r.taskId] ?? 0) + 1;
    const key = `${r.seat}:${r.decision}`;
    const prior = lastOfDecision.get(key);
    if (!prior || r.attempt > prior.attempt) lastOfDecision.set(key, r);
  }

  let repaired = 0;
  let exhausted = 0;
  for (const r of lastOfDecision.values()) {
    // The last rejection of a decision tells the whole story: if it still
    // expected a retry, one followed and the decision went through.
    if (r.willRetry) repaired += 1;
    else exhausted += 1;
  }
  return { total: rejections.length, byCategory, bySeat, byTask, repaired, exhausted };
}

/** One line per category, for the private research report. */
export function renderRejectionSummary(summary: RejectionSummary): string {
  if (summary.total === 0) return "认知拒绝：0 次。";
  const lines = [
    `认知拒绝 ${summary.total} 次　修好 ${summary.repaired} 处决策，用尽 ${summary.exhausted} 处`,
    "",
    "按类别：",
  ];
  for (const c of REJECTION_CATEGORIES) {
    if (summary.byCategory[c] > 0) lines.push(`  ${c.padEnd(28)} ${summary.byCategory[c]}`);
  }
  const seats = Object.entries(summary.bySeat).sort((a, b) => b[1] - a[1]);
  if (seats.length > 0) {
    lines.push("", `按座位：${seats.map(([s, n]) => `${s}号 ${n}`).join("　")}`);
  }
  const tasks = Object.entries(summary.byTask).sort((a, b) => b[1] - a[1]);
  if (tasks.length > 0) {
    lines.push(`按任务：${tasks.map(([t, n]) => `${t} ${n}`).join("　")}`);
  }
  return lines.join("\n");
}

/* ── Attribution ────────────────────────────────────────────────────────── */

/**
 * The message prefixes a cognition refusal carries.
 *
 * The runner reads these to set `ModelAttempt.rejectedBy`, which is how a
 * cognition refusal is told apart from a malformed action AFTER the fact. The
 * list lives here rather than in the runner because the messages are produced
 * here and in `llm-agent`; a copy in the consumer is how M5.5's two new
 * prefixes came to be filed as `action-format`.
 *
 * ONE SOURCE, and a test asserts every refusal the agent can throw starts with
 * one of them.
 */
export const COGNITION_REFUSAL_PREFIXES: readonly string[] = [
  "cognition 有问题",
  "evidence_ref_malformed",
  "claim_purposeless",
];

/** Was this attempt refused by cognition validation? Same rule the runner uses. */
export function refusedByCognition(error: string | undefined): boolean {
  return error !== undefined && COGNITION_REFUSAL_PREFIXES.some((p) => error.startsWith(p));
}
