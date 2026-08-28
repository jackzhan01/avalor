/**
 * A seat played by a language model.
 *
 * It is the same `Agent` as a scripted one: it receives an `Observation` and
 * returns an `Action`. That sameness is the whole point — the two arms of any
 * comparison differ in how the decision is made and in nothing else, and there
 * is no path from here to `GameState`.
 *
 * STATELESS, and here is what that does and does not buy.
 *
 * Every call rebuilds the prompt from the current observation; no conversation
 * object survives between turns. What that buys is that each request is
 * SELF-CONTAINED — auditable on its own, resumable at any decision, and
 * reproducible without replaying a thread.
 *
 * What it does NOT buy is fewer tokens. Request number k carries roughly k
 * events of history, so per-request input grows LINEARLY with the turn count
 * and CUMULATIVE input across a game grows roughly QUADRATICALLY. An earlier
 * version of this comment claimed statelessness kept cumulative input linear.
 * It does not, and no arrangement of full-history prompting would: the total
 * is the sum of the parts, and the parts are growing.
 *
 * WHAT IT WILL NOT DO when things go wrong, in order:
 *
 *   input over the ceiling  →  stop and report `paused_input_limit`. Never
 *                              trim the history, never summarise, never switch
 *                              model, never hand the turn to a scripted policy.
 *   call budget exhausted   →  stop and report `paused_call_limit`.
 *   unparseable answer      →  ask again, with the error, up to `maxRetries`.
 *   still unparseable       →  throw. The game FAILS and says so.
 *
 * That last one is deliberate. Substituting a scripted turn would produce a
 * game belonging to neither arm, and marking such a run "completed" would be
 * worse than a failure because nothing downstream could tell.
 */

import type { SimConfig } from "../config/load";
import { checkInputTokens } from "../core/input-limit";
import type { Observation } from "../core/observation";
import type { PauseReason } from "../core/run-status";
import type { Action, Seat } from "../core/types";
import { jsonSchemaFor, schemaNameFor } from "../model/json-schema";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  NextRequestShape,
  SpendVerdict,
} from "../model/client";
import { ModelCallError, requestKey } from "../model/client";
import { pessimisticTokenEstimate } from "../model/pricing";
import type { ModelAttempt } from "../model/attempt";
import { extractJson, parseAction } from "../model/structured";
import { buildPlayerPrompt } from "../prompts/build";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import type { ArgumentSummary } from "../cognition/context-pack";
import { packSize } from "../cognition/context-pack";
import type { CognitionStore, CognitionUtilisation } from "../cognition/store";
import { utilisationOf } from "../cognition/store";
import {
  applyFusedUpdate,
  checkCognitionBounds,
  cognitionProblems,
  parseCognition,
} from "../cognition/response";
import { buildFactRegistry } from "../cognition/fact-ids";
import { claimContestFrom } from "../cognition/claim-contest";
import type { ContestModel } from "../cognition/contest";
import type { SocialModel } from "../cognition/social";
import { limitsFor } from "../cognition/limits";
import {
  PROMPT_VERSION_COGNITIVE_V2,
  PROMPT_VERSION_CONTEST,
} from "../prompts/version";
import type { PersonaDefinition } from "../prompts/personas";
import type { StrategyDefinition } from "../prompts/strategies";
import type { Agent, RejectionFeedback } from "./agent";

/** A run stopped at a ceiling. Carries everything a checkpoint needs. */
export class PausedError extends Error {
  constructor(
    readonly reason: PauseReason,
    readonly seat: Seat,
    message: string,
    readonly detail: Readonly<Record<string, number | null>> = {},
  ) {
    super(message);
    this.name = "PausedError";
  }
}

/** The model could not produce a legal action within the retry budget. */
export class ModelOutputError extends Error {
  constructor(
    readonly seat: Seat,
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(`${seat}号 连试 ${attempts} 次都没给出合法动作，最后一次：${lastError}`);
    this.name = "ModelOutputError";
  }
}

/** Re-exported so agent callers need only one import. */
export type { ModelAttempt };

export interface LlmAgentOptions {
  readonly client: ModelClient;
  readonly persona: PersonaDefinition;
  readonly strategy: StrategyDefinition;
  readonly config: SimConfig;
  /**
   * Called immediately BEFORE a request leaves, so the call ceiling counts it
   * whether or not an answer ever comes back. A request that was sent and then
   * timed out was still sent, and may still have been billed.
   */
  readonly onSend?: () => void;
  /** Every attempt once it settles, valid or not. Trace and metrics read this. */
  readonly onAttempt?: (attempt: ModelAttempt) => void;
  /**
   * Asked before EVERY live request, with the shape of the request being
   * considered so the money ceilings can be projected rather than discovered.
   *
   * This is the wiring that was missing: `checkBudget` existed and was tested,
   * but nothing on the call path ever called it, so the $12/$25/$100 ceilings
   * were decoration. Now a stop here prevents the request.
   */
  readonly mayCall?: (next: NextRequestShape) => SpendVerdict;
  /** Fired when projected spend crosses the warning line. Does not stop. */
  readonly onBudgetWarning?: (verdict: SpendVerdict) => void;
  /**
   * Effective cap on a single response, reasoning included.
   *
   * Optional only so a caller may override the configured value; when absent
   * it comes from `config.limits.maxOutputTokens`. There is deliberately no
   * hard-coded fallback any more — the previous 2000 lived here and in
   * `run/live-game.ts`, matched nothing in the config file, and therefore
   * appeared in no artifact.
   */
  readonly maxOutputTokens?: number;
  /** Fired when an exhausted output budget triggers the one identical retry. */
  readonly onCapacityRetry?: (seat: Seat, taskId: string) => void;

  /* ── M5 cognition. Absent means the legacy `prompt-0.2.0` path. ───────── */
  /**
   * Present only when `config.cognition.enabled`. Supplying it switches this
   * agent to the fused stack: `prompt-0.3.0` layers, a ledger in the prompt,
   * and a `cognition` block required in the answer.
   *
   * Passed in rather than constructed here because the store outlives the
   * agent — a resume rebuilds the agents and must not rebuild the minds.
   */
  readonly cognition?: CognitionHooks;
}

export interface CognitionHooks {
  readonly store: CognitionStore;
  /** Older discussion this seat has already compressed. */
  readonly olderArguments?: readonly ArgumentSummary[];
  /** Fired after a valid cognition block folds into the ledger. */
  readonly onCognition?: (report: CognitionReport) => void;
}

/** What one fused answer did to this seat's memory. Private telemetry. */
export interface CognitionReport {
  readonly seat: Seat;
  readonly taskId: string;
  readonly attempt: number;
  /** Cited ids that named nothing this seat may cite. */
  readonly premisesOverridden: number;
  /**
   * Cited ids that resolved to a REAL referee fact.
   *
   * The number M5.1 exists to move. In the completed pilot it was structurally
   * zero: the fact tables printed no ids, so nothing the model wrote could
   * resolve, and all 871 citations came back unverified.
   */
  readonly premisesVerified: number;
  /** Cited ids that resolved to a claim — cited honestly, still not hard. */
  readonly premisesFromClaims: number;
  /** `closedCommitments` entries that matched no live promise. */
  readonly unmatchedClosures: number;
  /** How many ids the seat could legally have cited at this moment. */
  readonly registrySize: number;
  readonly boundsViolations: number;
  readonly utilisation: CognitionUtilisation;
  readonly packSections: Readonly<Record<string, number>>;
  readonly estimatedTokens: number;
  readonly overSoftTarget: boolean;
  /**
   * The seat's social conclusions, flattened for the trace.
   *
   * Stored as data rather than left to be re-derived from speech text. The one
   * coordination number computed by hand after the M5 pilot was wrong twice
   * before it was right, because it was a regex against prose; a structured
   * record is not a wording judgement.
   */
  readonly social: SocialSnapshot | null;
  /** The claim-contest record, flattened. Null before `prompt-0.4.0`. */
  readonly contest: ContestSnapshot | null;
}

/** One decision's claim-contest record. Mirrors `metrics-contest`. */
export interface ContestSnapshot {
  readonly ownClaimStatus: string;
  readonly intendedClaimRole: string | null;
  readonly act: string;
  readonly targetSeats: readonly Seat[];
  readonly requestedTeam: readonly Seat[] | null;
  readonly requestedVote: string;
  readonly evidenceResolves: boolean;
  readonly stance: string;
  readonly selectedClaimant: Seat | null;
  readonly assessments: readonly {
    readonly seat: Seat;
    readonly level: string;
    readonly publicStatus: string;
    readonly restsOnUnverified: boolean;
  }[];
  readonly rivalSeats: readonly Seat[];
}

/** One decision's social record. Mirrors `metrics.SocialObservation`. */
export interface SocialSnapshot {
  readonly focalCandidates: readonly {
    readonly seat: Seat;
    readonly influence: string;
    readonly credibility: string;
    readonly claimedRole: string | null;
    readonly restsOnUnverified: boolean;
  }[];
  readonly stance: string | null;
  readonly focalSeat: Seat | null;
  readonly proposition: string;
  readonly publicAction: string;
  readonly coordinateWith: readonly Seat[];
  readonly proposedTeam: readonly Seat[] | null;
  readonly votingBloc: string;
}

/**
 * Cognition was structurally unusable after every permitted repair.
 *
 * Terminal on purpose, and distinct from `ModelOutputError`: the action may
 * have been perfectly legal. What failed is the memory, and accepting a move
 * whose reasoning record is corrupt would leave a ledger nobody can trust and
 * a game whose later turns build on it.
 */
export class CognitionInvalidError extends Error {
  constructor(
    readonly seat: Seat,
    readonly taskId: string,
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(
      `${seat}号 · ${taskId}：连试 ${attempts} 次，cognition 结构始终不合法，最后一次：${lastError}。` +
        `动作可能是合法的，但认知记录不可用 —— 不接受损坏的认知，停下。`,
    );
    this.name = "CognitionInvalidError";
  }
}

/**
 * How a rejected attempt is described back to the model.
 *
 * Appended to the user message rather than folded into a chat history: the
 * builder stays stateless and the retry is still one self-contained request.
 */
function repairNote(feedback: RejectionFeedback): string {
  return [
    "",
    "## ⚠ 上一次的回答被裁判打回了",
    "",
    `第 ${feedback.attempt} 次重试。裁判给的理由是：**${feedback.error}**`,
    "",
    "请重新给出这一次任务要求的 JSON。只改需要改的地方，格式和上面的说明完全一致。",
  ].join("\n");
}

export function llmAgent(seat: Seat, options: LlmAgentOptions): Agent {
  const { client, persona, strategy, config } = options;

  return {
    name: `llm:${config.model.id}:${persona.id}:${strategy.id}`,

    async act(observation: Observation, feedback?: RejectionFeedback): Promise<Action> {
      if (observation.seat !== seat) {
        throw new Error(`agent for ${seat}号 was handed ${observation.seat}号's observation`);
      }

      const cognitionHooks = options.cognition;
      const ledger = cognitionHooks ? cognitionHooks.store.for(observation) : null;

      // Two stacks, one branch. The legacy side is untouched so that
      // `prompt-0.2.0` runs stay reproducible byte for byte.
      const cognitive =
        cognitionHooks && ledger
          ? buildCognitivePrompt({
              observation,
              persona,
              strategy,
              ledger,
              config,
              ...(cognitionHooks.olderArguments
                ? { olderArguments: cognitionHooks.olderArguments }
                : {}),
              ...(feedback ? { repairNote: repairNote(feedback) } : {}),
            })
          : null;

      const prompt =
        cognitive ??
        buildPlayerPrompt({
          observation,
          persona,
          strategy,
          speechCharLimit: config.limits.speechCharLimit,
        });
      const user = cognitive
        ? cognitive.user
        : feedback
          ? `${prompt.user}\n${repairNote(feedback)}`
          : prompt.user;

      // Pre-flight, in the required order: the input ceiling first, because a
      // request that may not be sent must not consume a call.
      const estimated = pessimisticTokenEstimate(`${prompt.system}\n${user}`);
      const verdict = checkInputTokens(estimated, config.limits.maxStandardInputTokens);
      if (!verdict.ok) {
        throw new PausedError(
          "paused_input_limit",
          seat,
          `估算输入 ${verdict.tokens} token，上限 ${verdict.limit}。` +
            `不截断、不摘要、不换模型、不退回脚本 —— 存检查点后停下。`,
        );
      }

      const maxOutputTokens = options.maxOutputTokens ?? config.limits.maxOutputTokens;

      const request: ModelRequest = {
        model: config.model.id,
        reasoningEffort: config.model.reasoningEffort,
        system: prompt.system,
        user,
        maxOutputTokens,
        format: cognitive
          ? { name: cognitive.schemaName, schema: cognitive.jsonSchema, strict: true }
          : {
              name: schemaNameFor(prompt.schema),
              schema: jsonSchemaFor(prompt.schema),
              strict: true,
            },
        params: config.model.params,
      };

      const shapeOf = (capacityAttempt: number) =>
        ({
          seat,
          taskId: prompt.taskId,
          attempt: (feedback?.attempt ?? 0) + 1,
          capacityAttempt,
          promptKey: requestKey(request),
          systemChars: [...prompt.system].length,
          userChars: [...user].length,
          totalInputChars: [...prompt.system].length + [...user].length,
          publicEventCount: observation.publicLog.length,
          estimatedInputTokens: estimated,
        }) as const;

      /**
       * One physical request: budget gate, send, record.
       *
       * The gate lives here rather than above the loop because a capacity
       * retry is a real, separately billed call — projecting spend once and
       * then sending twice is exactly how a ceiling gets escaped.
       */
      const send = async (capacityAttempt: number): Promise<ModelResponse> => {
        const allowed = options.mayCall?.({
          estimatedInputTokens: estimated,
          maxOutputTokens,
        });
        if (allowed && !allowed.ok) {
          throw new PausedError(
            allowed.reason ?? "paused_cost_limit",
            seat,
            `${allowed.detail} 不截断、不摘要、不换模型、不退回脚本 —— 存检查点后停下。`,
            {
              projectedGameUsd: allowed.projectedGameUsd,
              projectedBatchUsd: allowed.projectedBatchUsd,
            },
          );
        }
        if (allowed?.level === "warn") options.onBudgetWarning?.(allowed);

        // Counted before it leaves, not after it succeeds.
        options.onSend?.();
        try {
          return await client.complete(request);
        } catch (error) {
          if (error instanceof ModelCallError) {
            // Its token cost is unknown, not zero. Recorded either way.
            options.onAttempt?.({
              ...shapeOf(capacityAttempt),
              outcome: "provider_error",
              validationError: error.describe(),
              raw: null,
              usage: null,
              latencyMs: 0,
              cached: false,
              modelReturned: "",
              status: "error",
              appliedLegalAction: false,
            });
          }
          // Sanitised on the way out of the client; nothing here re-widens it.
          throw error;
        }
      };

      const record = (
        capacityAttempt: number,
        response: ModelResponse,
        outcome: ModelAttempt["outcome"],
        validationError?: string,
      ) => {
        options.onAttempt?.({
          ...shapeOf(capacityAttempt),
          outcome,
          ...(validationError ? { validationError } : {}),
          raw: response.text,
          usage: response.usage,
          latencyMs: response.latencyMs,
          cached: response.cached,
          modelReturned: response.modelReturned,
          status: response.status,
          ...(response.incompleteReason
            ? { incompleteReason: response.incompleteReason }
            : {}),
          appliedLegalAction: outcome === "valid",
        });
      };

      let sendNumber = 1;
      let response = await send(sendNumber);

      if (isOutputExhausted(response)) {
        // NOT parsed, and no repair note. The model did not finish; whatever
        // prefix came back is a fragment, and a fragment that happens to open
        // with `{` is still not an answer. Appending "your JSON was invalid"
        // here is actively harmful — it gives the model more to reason about,
        // and reasoning is what ate the budget in the first place.
        record(1, response, "output_limit", exhaustedMessage(maxOutputTokens));
        options.onCapacityRetry?.(seat, prompt.taskId);

        // Exactly one retry, byte-identical: same observation, same system and
        // user message, same model, same effort, same cap. Nothing about the
        // request changes, because nothing about the request was wrong.
        sendNumber = 2;
        response = await send(sendNumber);
        if (isOutputExhausted(response)) {
          record(sendNumber, response, "output_limit", exhaustedMessage(maxOutputTokens));
          throw new OutputCapacityExhausted(seat, prompt.taskId, maxOutputTokens);
        }
      }

      const parsed = parseAction(response.text, observation.request!);
      record(
        sendNumber,
        response,
        parsed.ok ? "valid" : "invalid",
        parsed.ok ? undefined : parsed.error,
      );

      if (!parsed.ok) {
        // Thrown as a rejection the runner understands, so the retry goes
        // through the same path a referee rejection does.
        throw new UnparseableAnswer(seat, parsed.error);
      }

      // The action is legal. Now the memory — and a corrupt one is NOT
      // waved through just because the move was fine. A ledger nobody can
      // trust poisons every later turn that reads it.
      if (cognitionHooks && cognitive && ledger) {
        const attemptNumber = (feedback?.attempt ?? 0) + 1;
        // Reuses the action parser's own extractor, so a fenced or
        // prefixed answer is handled the same way in both halves.
        let raw: unknown;
        try {
          raw = (JSON.parse(extractJson(response.text)) as Record<string, unknown>).cognition;
        } catch {
          raw = null;
        }
        const wantsContest = config.promptVersion === PROMPT_VERSION_CONTEST;
        const social = wantsContest || config.promptVersion === PROMPT_VERSION_COGNITIVE_V2;
        const limits = limitsFor(config.promptVersion);
        const cognition = parseCognition(raw, {
          limits,
          withSocial: social,
          ...(wantsContest ? { withContest: true } : {}),
        });

        if (!cognition.ok) {
          if (attemptNumber > config.cognition.maxCognitionRepairs) {
            throw new CognitionInvalidError(
              seat,
              prompt.taskId,
              attemptNumber,
              cognition.error,
            );
          }
          // Same repair channel as a malformed action, with a FIELD-SPECIFIC
          // note: "invalid" costs a whole request and teaches nothing.
          throw new UnparseableAnswer(seat, `cognition 有问题：${cognition.error}`);
        }

        // The contest checks need the referee's own claim record and the team
        // size this mission wants. Both are derivable from the observation, and
        // both are what turns "is this shape legal" into a real question.
        const claimContest = claimContestFrom(observation.publicLog);
        // The action is already parsed and legal at this point, so the
        // atomicity check can compare what the block SAYS the seat did with
        // what the seat actually submitted.
        const submitted = parsed.action as {
          kind: string;
          claim?: string | null;
          retractClaim?: boolean;
          stances?: readonly { seat: number; valence: number }[];
        };
        const problems = cognitionProblems(cognition.cognition, {
          seat,
          contest: claimContest,
          teamSize:
            observation.request?.kind === "leader_close_and_propose"
              ? observation.request.teamSize
              : observation.position.teamSizeThisMission,
          previousContest: ledger.contest,
          speech:
            submitted.kind === "speech"
              ? {
                  claim: submitted.claim ?? null,
                  retractClaim: submitted.retractClaim === true,
                  stances: submitted.stances ?? [],
                }
              : null,
        });
        if (problems.length > 0) {
          if (attemptNumber > config.cognition.maxCognitionRepairs) {
            throw new CognitionInvalidError(seat, prompt.taskId, attemptNumber, problems[0]);
          }
          throw new UnparseableAnswer(seat, `cognition 有问题：${problems[0]}`);
        }

        // Bounds are REPORTED, never repaired by truncation: half a sentence
        // of evidence reads like a whole thought, and the pilot exists to
        // calibrate these numbers against what the model actually writes.
        const violations = checkCognitionBounds(cognition.cognition, limits);
        // Built HERE rather than inside the reducer: it is derived from the
        // observation, and the reducer takes a ledger. Passing it in keeps the
        // one place that decides "is this premise hard" a place that can see
        // exactly what the prompt rendered.
        const registry = buildFactRegistry(
          ledger.publicFacts,
          ledger.claims,
          observation,
          wantsContest ? claimContest : undefined,
        );
        const folded = applyFusedUpdate(
          ledger,
          observation,
          cognition.cognition,
          observation.publicLog.length,
          { registry, limits, ...(wantsContest ? { claimContest } : {}) },
        );
        cognitionHooks.store.put(folded.ledger);
        cognitionHooks.onCognition?.({
          seat,
          taskId: prompt.taskId,
          attempt: attemptNumber,
          premisesOverridden: folded.premisesOverridden,
          premisesVerified: folded.premisesVerified,
          premisesFromClaims: folded.premisesFromClaims,
          unmatchedClosures: folded.unmatchedClosures,
          registrySize: registry.entries.length,
          boundsViolations: violations.length,
          utilisation: utilisationOf(folded.ledger),
          packSections: {
            factTables: cognitive.pack.factTables.length,
            ownPrivateFacts: cognitive.pack.ownPrivateFacts.length,
            cognition: cognitive.pack.cognition.length,
            currentCycle: cognitive.pack.currentCycle.length,
            claimContest: cognitive.pack.claimContest.length,
            olderArguments: cognitive.pack.olderArguments.length,
            total: packSize(cognitive.pack),
          },
          estimatedTokens: cognitive.pack.diagnostics.estimatedTokens,
          overSoftTarget: cognitive.pack.diagnostics.overSoftTarget,
          social: snapshotOf(folded.ledger.social),
          contest: contestSnapshotOf(folded.ledger.contest),
        });
      }

      return parsed.action;
    },
  };
}

/** Flatten a contest model for the trace. Null before `prompt-0.4.0`. */
function contestSnapshotOf(model: ContestModel | null): ContestSnapshot | null {
  if (!model || !model.ownClaimStrategy || !model.publicClaimMove || !model.alignment) {
    return null;
  }
  return {
    ownClaimStatus: model.ownClaimStrategy.currentStatus,
    intendedClaimRole: model.ownClaimStrategy.intendedClaimRole,
    act: model.publicClaimMove.act,
    targetSeats: model.publicClaimMove.targetSeats,
    requestedTeam: model.publicClaimMove.requestedTeam,
    requestedVote: model.publicClaimMove.requestedVote,
    evidenceResolves: model.publicClaimMove.evidenceResolves,
    stance: model.alignment.stance,
    selectedClaimant: model.alignment.selectedClaimant,
    assessments: model.claimantAssessments.map((a) => ({
      seat: a.claimantSeat,
      level: a.currentAssessment,
      publicStatus: a.publicClaimStatus,
      restsOnUnverified: a.restsOnUnverified,
    })),
    rivalSeats: model.rivalPlans.map((r) => r.rivalSeat),
  };
}

/** Flatten a social model for the trace. Null on the `prompt-0.3.0` path. */
function snapshotOf(model: SocialModel | null): SocialSnapshot | null {
  if (!model) return null;
  return {
    focalCandidates: model.focalCandidates.map((f) => ({
      seat: f.seat,
      influence: f.influence,
      credibility: f.credibility,
      claimedRole: f.claimedRole,
      restsOnUnverified: f.restsOnUnverified,
    })),
    stance: model.alignment?.stance ?? null,
    focalSeat: model.alignment?.focalSeat ?? null,
    proposition: model.alignment?.proposition ?? "",
    publicAction: model.alignment?.publicAction ?? "",
    coordinateWith: model.coalitionPlan?.coordinateWith ?? [],
    proposedTeam: model.coalitionPlan?.proposedTeam ?? null,
    votingBloc: model.coalitionPlan?.votingBloc ?? "undecided",
  };
}

/**
 * Did the model run out of output budget before it finished?
 *
 * Deliberately narrow: only `max_output_tokens`. Other incomplete reasons —
 * a content filter, a provider-side abort — are different problems with
 * different fixes, and quietly resending an identical prompt for them would
 * be a retry policy nobody chose.
 */
export function isOutputExhausted(response: ModelResponse): boolean {
  return response.status === "incomplete" && response.incompleteReason === "max_output_tokens";
}

function exhaustedMessage(cap: number): string {
  return `输出预算耗尽：推理 token 吃满了 ${cap} 的上限，没有留下可用的回答`;
}

/**
 * Two identical requests both ran out of output budget.
 *
 * Permanent, not a pause. A third send would produce a third identical
 * result, and a checkpoint would only hand somebody a file that cannot move.
 * The fix is a bigger `limits.maxOutputTokens`, and that is a decision for a
 * human, made between runs.
 */
export class OutputCapacityExhausted extends Error {
  constructor(
    readonly seat: Seat,
    readonly taskId: string,
    readonly maxOutputTokens: number,
  ) {
    super(
      `${seat}号 · ${taskId}：两次相同请求都在 ${maxOutputTokens} 输出上限处耗尽，` +
        `推理 token 没给回答留下空间。这是容量问题，不是格式问题 —— ` +
        `不重试、不截断、不摘要、不换模型，请调高 limits.maxOutputTokens 后重跑。`,
    );
    this.name = "OutputCapacityExhausted";
  }
}

/** A malformed answer. The runner treats it exactly like a referee rejection. */
export class UnparseableAnswer extends Error {
  constructor(
    readonly seat: Seat,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "UnparseableAnswer";
  }
}

/** Ten seats, one model, per-seat persona and strategy. */
export function llmTable(
  bySeat: Readonly<Record<Seat, LlmAgentOptions>>,
): Readonly<Record<Seat, Agent>> {
  const table = {} as Record<Seat, Agent>;
  for (const key of Object.keys(bySeat)) {
    const seat = Number(key) as Seat;
    table[seat] = llmAgent(seat, bySeat[seat]);
  }
  return table;
}
