/**
 * Two ways to run cognition, described but not chosen.
 *
 * The choice is a cost/quality tradeoff that nobody can settle from three
 * games, so this file defines both behind one provider-neutral interface and
 * leaves the decision to the human review. What it does NOT do is default to
 * one — `CognitionMode` has no default value anywhere in this module, and
 * `criticalTasks` is empty until somebody configures it.
 *
 *   FUSED              one call returns cognition update + action.
 *                      Cheapest. What the current agent already does, plus a
 *                      structured cognition field. Roughly the 133-192 calls
 *                      per game we have measured.
 *
 *   TWO-PASS-CRITICAL  an analysis call updates the ledger, then an action
 *                      call receives the bounded analysis and chooses. Applied
 *                      ONLY to configured critical tasks; everything else
 *                      stays fused.
 *
 * WHAT THE EVIDENCE SAYS, and where it stops. Experiment 3's peak output was
 * 6,562 tokens with reasoning at 66% of output — the model is already spending
 * most of its budget analysing before it answers. Two-pass would make that
 * analysis explicit, inspectable and reusable across the eleven speech turns
 * of one proposal cycle. It would also add one paid call per critical
 * decision. On Experiment 3's shape that is roughly +18 calls (6 proposals,
 * 6 vote rounds after a failure, 1 Lady, plus claims), so call count would go
 * from 133 to about 151 — call cost is not the concern. The concern is that
 * the analysis call carries the same large input as the action call, so the
 * INPUT roughly doubles for those decisions, and input is 87% of this game's
 * uncached spend.
 *
 * THAT ARITHMETIC IS AN ESTIMATE FROM ONE GAME. It is not a recommendation.
 *
 * STATUS: design only. No live path constructs either mode.
 */

import type { Observation } from "../core/observation";
import type { ModelRequest, ModelResponse } from "../model/client";
import type { ContextPack } from "./context-pack";
import type { BoundedCognitionUpdate, StructuredConclusion } from "./protocol";

/** Which decisions are worth a separate analysis pass. */
export type CriticalTask =
  | "leader-close-and-propose"
  | "vote-after-failure"
  | "role-claim-decision"
  | "lady-select"
  | "assassination";

/**
 * The candidates, with why each is on the list. Not enabled by default.
 *
 * Every one is a decision where a wrong answer is not recoverable within the
 * game: a bad team goes on a mission, a bad vote passes it, a claim cannot be
 * unsaid, a Lady check cannot be redone, an assassination ends the game.
 * Ordinary speeches are absent precisely because the next speaker can correct
 * them.
 */
export const CRITICAL_TASK_CANDIDATES: readonly {
  readonly task: CriticalTask;
  readonly why: string;
}[] = Object.freeze([
  {
    task: "leader-close-and-propose",
    why: "收束讨论并定队伍，一步定这一轮。实验 2 正是死在这个任务上，也是输出用量最高的任务之一",
  },
  {
    task: "vote-after-failure",
    why: "已经挂过车之后的上票门槛，是三局里好人反复出错的地方",
  },
  { task: "role-claim-decision", why: "跳身份或对跳不可撤回，且立刻改变全桌的信息结构" },
  { task: "lady-select", why: "验人机会有限；三局里两次验到了持牌人已知的好人，白白浪费" },
  { task: "assassination", why: "一步定胜负，且是刺客整局追踪的唯一兑现点" },
]);

export type CognitionMode =
  | { readonly kind: "fused" }
  | {
      readonly kind: "two-pass-critical";
      /** Empty means "behaves exactly like fused". Deliberate: no silent default. */
      readonly criticalTasks: readonly CriticalTask[];
    };

/** Which path a given task takes under a given mode. */
export function passesFor(mode: CognitionMode, taskId: string): 1 | 2 {
  if (mode.kind === "fused") return 1;
  return mode.criticalTasks.includes(taskId as CriticalTask) ? 2 : 1;
}

/* ── The provider-neutral interface ─────────────────────────────────────── */

/**
 * What an analysis pass returns. No action, and no public message.
 *
 * The absence of an action field is the safety property: an analysis response
 * cannot accidentally become a move, because there is nowhere for a move to
 * live. The referee never sees this object.
 */
export interface AnalysisResult {
  readonly cognitionUpdate: BoundedCognitionUpdate;
  /** Bounded, and the only thing carried into the action call. */
  readonly analysisDigest: string;
}

export interface ActionResult {
  readonly conclusion: StructuredConclusion;
  readonly cognitionUpdate: BoundedCognitionUpdate | null;
  readonly action: unknown;
}

/**
 * One cognition strategy. Both modes implement this, so the agent that calls
 * it does not know or care which is configured.
 */
export interface CognitionRunner {
  readonly mode: CognitionMode;
  /**
   * Null for a fused runner. A two-pass runner returns the analysis for
   * critical tasks and null for everything else.
   */
  analyse(
    observation: Observation,
    pack: ContextPack,
    taskId: string,
  ): Promise<AnalysisResult | null>;
  act(
    observation: Observation,
    pack: ContextPack,
    taskId: string,
    analysis: AnalysisResult | null,
  ): Promise<ActionResult>;
}

/**
 * How each mode turns a pack into requests. Pure description, no I/O.
 *
 * Exported so a test — and the review package — can assert what would be sent
 * without anything being sent. Two-pass emits two request SHAPES for a
 * critical task and one for everything else.
 */
export interface RequestPlan {
  readonly passes: 1 | 2;
  readonly labels: readonly string[];
  /** Rough multiplier on input tokens versus fused, for the same decision. */
  readonly inputMultiplier: number;
}

export function planRequests(mode: CognitionMode, taskId: string): RequestPlan {
  const passes = passesFor(mode, taskId);
  return passes === 2
    ? {
        passes: 2,
        labels: [`analyse:${taskId}`, `act:${taskId}`],
        // Both passes carry the same fact tables and history; only the tail
        // differs. So the input is paid for roughly twice.
        inputMultiplier: 2,
      }
    : { passes: 1, labels: [`act:${taskId}`], inputMultiplier: 1 };
}

/**
 * Projected call and input cost of a mode over one game's task mix.
 *
 * Takes the mix as input rather than hard-coding Experiment 3's, because a
 * projection built from one game and then quoted as a property of the design
 * is exactly the kind of claim this project keeps having to walk back.
 */
export function projectModeCost(
  mode: CognitionMode,
  taskCounts: Readonly<Record<string, number>>,
): { readonly calls: number; readonly inputUnits: number } {
  let calls = 0;
  let inputUnits = 0;
  for (const [taskId, n] of Object.entries(taskCounts)) {
    const plan = planRequests(mode, taskId);
    calls += n * plan.passes;
    inputUnits += n * plan.inputMultiplier;
  }
  return { calls, inputUnits };
}

/* ── Request construction, deferred ─────────────────────────────────────── */

/**
 * Everything needed to build a request, without building one.
 *
 * A deliberate seam: the live client lives in exactly one file and is imported
 * by exactly one script, and M5 must not widen that. When M5B is approved, the
 * activation step is to hand these specs to the existing `ModelClient` — not
 * to add a second place that knows how to talk to a provider.
 */
export interface RequestSpec {
  readonly label: string;
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
}

export type RequestBuilder = (spec: RequestSpec) => ModelRequest;
export type ResponseParser = (response: ModelResponse) => ActionResult;
