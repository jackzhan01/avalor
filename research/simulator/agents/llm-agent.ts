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

import { resolveStage, type SimConfig } from "../config/load";
import { checkInputTokens } from "../core/input-limit";
import type { Observation } from "../core/observation";
import type { PauseReason } from "../core/run-status";
import { SEATS, type Action, type Seat, type SpeechAction } from "../core/types";
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
import { coordinationViolation } from "../core/evil-coordination";
import { parseVoteAnalysis, voteAnalysisProblems } from "../cognition/vote-discipline";
import {
  assassinationProblems,
  knownEvilTargeted,
  orderedCandidates,
  parseAssassination,
} from "../cognition/assassination";
import {
  claimRejection,
  evidenceRejection,
  structuralRejection,
  type CognitionRejection,
  type RejectionCategory,
} from "../cognition/rejection";
import {
  malformedEvidenceReference,
  malformedRefs,
  malformedRefsNote,
  malformedRefsSummary,
  type MalformedEvidenceMetric,
} from "../cognition/evidence-refs";
import {
  checkClaim,
  claimRepairNote,
  emptyClaimMetric,
  foldClaimMetric,
  type ClaimRealismMetric,
} from "../cognition/claim-persistence";
import {
  pairDisclosureMetric,
  type PairDisclosureMetric,
} from "../cognition/pair-disclosure";
import {
  channelForTask,
  sanitiseIntent,
  taskHasPublicMessage,
  validatePublicMessage,
  type DisclosureAudit,
  type SentenceProvenance,
} from "../cognition/firewall";
import { parseIntent } from "../cognition/intent";
import { machineIdRepairNote } from "../cognition/machine-ids";
import {
  buildSpokespersonPrompt,
  publicTableViewFor,
  renderSelectedAction,
} from "../cognition/spokesperson";
import { contentChars } from "../cognition/limits";
import { claimContestFrom } from "../cognition/claim-contest";
import type { ContestModel } from "../cognition/contest";
import type { SocialModel } from "../cognition/social";
import { limitsFor } from "../cognition/limits";
import { capabilitiesFor } from "../prompts/capabilities";
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
  /**
   * Fired for a REFUSED cognition attempt, immediately before the throw.
   *
   * A SEPARATE HOOK, deliberately. `onCognition` is the accepted-state channel
   * and every consumer folds it into the ledger, so routing a refusal through
   * it would turn a rejected block into remembered state — the exact thing the
   * refusal exists to prevent. Nothing here touches the ledger, the store, the
   * public log or the checkpoint; it is telemetry and only telemetry.
   */
  readonly onRejection?: (rejection: CognitionRejection) => void;
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
  /** What the disclosure firewall did. Null before `prompt-0.5.0`. */
  readonly disclosure: DisclosureSnapshot | null;
  /** The assassination ranking. Non-null only on the one turn that has one. */
  readonly assassination: AssassinationSnapshot | null;
  /**
   * M5.5. Citation elements that were refused, by shape. Null before 0.7.0.
   *
   * `total: 0` and `null` are different answers: zero means the check ran and
   * found nothing, null means the stack does not have the check.
   */
  readonly malformedEvidence: MalformedEvidenceMetric | null;
  /** M5.5. The Percival pair-dilution telemetry. Null for every other seat. */
  readonly pairDisclosure: PairDisclosureMetric | null;
  /** M5.5. A claim event that repeated a standing one with no new purpose. */
  readonly purposelessClaim: boolean;
  /**
   * M5.5. This decision's claim record. Null when the seat submitted no claim.
   *
   * PRIVATE, including `ambiguityEventIds`: it is written to the trace and can
   * be rendered into this seat's own prompt, and nothing carries it to a public
   * field. The firewall independently refuses machine ids in speech.
   */
  readonly claimRealism: ClaimRealismMetric | null;
}

/** One refusal of a finished public sentence. PRIVATE. */
export interface DisclosureRejection {
  readonly attempt: number;
  /** Which secret classes the detector saw. Classes, never the sentence. */
  readonly classes: readonly string[];
  readonly rules: readonly string[];
}

/**
 * What the firewall did on one speaking turn. PRIVATE.
 *
 * Counts and class names only. The rejected sentence itself is deliberately
 * NOT carried: a trace field holding leaked text would recreate, inside the
 * research artifact, exactly the exposure the firewall just prevented — and
 * the private trace is the file most likely to be read by something else.
 */
export interface DisclosureSnapshot {
  /**
   * The accepted public sentence and the evidence ids that authorised it.
   *
   * PRIVATE, but the sentence itself is public by the time this is written.
   * Only ACCEPTED sentences are recorded — a refused one is described by its
   * rules and never by its text, because a trace holding leaked text would
   * recreate the exposure the firewall just prevented.
   */
  readonly provenance: SentenceProvenance;
  readonly allowedBasisIds: number;
  readonly rejectedBasisIds: number;
  /** Envelope fields the firewall replaced wholesale. */
  readonly redactedFields: readonly string[];
  /** The secret classes the PLANNER tried to push across. */
  readonly plannerLeakClasses: readonly string[];
  readonly channelCorrected: boolean;
  readonly messageRejections: readonly DisclosureRejection[];
  readonly audit: DisclosureAudit;
}

/**
 * The spokesperson could not produce a clean sentence within the repair budget.
 *
 * TERMINAL, and a different failure from `CognitionInvalidError`. The action
 * was legal and the reasoning may have been fine; what failed is the one gate
 * that stands between a private value and the public log. Continuing would
 * mean either publishing a leak or silently dropping a turn, and a game
 * missing a turn is a game nobody can compare against another.
 */
export class DisclosureInvalidError extends Error {
  constructor(
    readonly seat: Seat,
    readonly taskId: string,
    readonly attempts: number,
    readonly lastRules: string,
  ) {
    super(
      `${seat}号 · ${taskId}：公开发言连续 ${attempts} 次被防泄露闸拦下，最后一次命中 ${lastRules}。` +
        `动作是合法的，泄露的是那句话 —— 不放行、不改写、不把被拦下的句子回喂给模型，停下。`,
    );
    this.name = "DisclosureInvalidError";
  }
}

/**
 * One assassination ranking, flattened for the trace. PRIVATE.
 *
 * `knownEvilTarget` is the named strategic error. It is RECORDED, never acted
 * on: no code path reads it back into a prompt, a repair, or the action. A
 * simulator that corrected this would be reporting a game that did not happen.
 */
export interface AssassinationSnapshot {
  readonly target: Seat;
  /** Candidate seats in the SYSTEM's order — known-evil seats last. */
  readonly rankedSeats: readonly Seat[];
  readonly candidateCount: number;
  /** Seats the Assassin was privately shown. Post-mortem context. */
  readonly knownEvil: readonly Seat[];
  /** STRATEGIC ERROR: the chosen seat was one he already knew was evil. */
  readonly knownEvilTarget: boolean;
  readonly signalsUsed: readonly string[];
  readonly targetConfidence: number | null;
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

      // Stage 1's cap. `options.maxOutputTokens` still wins when a caller
      // passes one, so nothing about the existing single-stage path moves.
      const plannerStage = resolveStage(config, "planner");
      const maxOutputTokens = options.maxOutputTokens ?? plannerStage.maxOutputTokens;

      const request: ModelRequest = {
        model: plannerStage.model,
        reasoningEffort: plannerStage.reasoningEffort,
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

      /**
       * One leg of the turn: a request, its texts, and how it is labelled.
       *
       * Introduced by M5.3, because a speaking turn is now TWO physical
       * requests and both must be gated, counted and recorded the same way.
       * The alternative — a second copy of the budget gate for the
       * spokesperson — is how a ceiling gets escaped by the half nobody
       * remembered to wire up.
       */
      interface Leg {
        readonly taskId: string;
        readonly request: ModelRequest;
        readonly system: string;
        readonly user: string;
        readonly estimated: number;
        readonly maxOutputTokens: number;
      }

      const plannerLeg: Leg = {
        taskId: prompt.taskId,
        request,
        system: prompt.system,
        user,
        estimated,
        maxOutputTokens,
      };

      const shapeOf = (leg: Leg, capacityAttempt: number) =>
        ({
          seat,
          taskId: leg.taskId,
          attempt: (feedback?.attempt ?? 0) + 1,
          capacityAttempt,
          promptKey: requestKey(leg.request),
          systemChars: [...leg.system].length,
          userChars: [...leg.user].length,
          totalInputChars: [...leg.system].length + [...leg.user].length,
          publicEventCount: observation.publicLog.length,
          estimatedInputTokens: leg.estimated,
        }) as const;

      /**
       * One physical request: budget gate, send, record.
       *
       * The gate lives here rather than above the loop because a capacity
       * retry is a real, separately billed call — projecting spend once and
       * then sending twice is exactly how a ceiling gets escaped.
       */
      const send = async (leg: Leg, capacityAttempt: number): Promise<ModelResponse> => {
        const allowed = options.mayCall?.({
          estimatedInputTokens: leg.estimated,
          maxOutputTokens: leg.maxOutputTokens,
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
          return await client.complete(leg.request);
        } catch (error) {
          if (error instanceof ModelCallError) {
            // Its token cost is unknown, not zero. Recorded either way.
            options.onAttempt?.({
              ...shapeOf(leg, capacityAttempt),
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
        leg: Leg,
        capacityAttempt: number,
        response: ModelResponse,
        outcome: ModelAttempt["outcome"],
        validationError?: string,
      ) => {
        options.onAttempt?.({
          ...shapeOf(leg, capacityAttempt),
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

      /**
       * Stage 2: turn the sanitised envelope into one public sentence.
       *
       * Declared as a function rather than inlined because it has three exits
       * — a repairable planner error, a terminal disclosure failure, and
       * success — and the reader should be able to see all three at once.
       *
       * THE RETRY IS BYTE-IDENTICAL when the firewall refuses. The rejected
       * sentence is never shown back: showing a model its own leaking sentence
       * to "fix" is showing it the secret, and the prompt it was given never
       * contained one. A length overrun is different and does get a note —
       * but the note carries the count, never the text.
       */
      /*
       * The four per-decision records, declared BEFORE `runPublicStage`.
       *
       * Not a style choice. `runPublicStage` closes over `pairRejections` and
       * is CALLED above the point where these used to sit, so a `let` after it
       * put the closure in the temporal dead zone: the first pair-grouping
       * rejection would have thrown a ReferenceError instead of counting.
       */
      /**
       * Record one refused attempt and hand back the message to throw with.
       *
       * Called at every cognition-validation refusal so the two stay in step:
       * a refusal that skipped this would be invisible in exactly the way the
       * M5.5 pilot's were. It emits and returns; the caller still throws, so
       * the control flow — and therefore the retry behaviour — is unchanged.
       */
      const refuse = (input: {
        readonly categories: readonly RejectionCategory[];
        readonly codes: readonly string[];
        readonly attempt: number;
        readonly willRetry: boolean;
      }): void => {
        cognitionHooks?.onRejection?.({
          // Task plus position: stable across the repair chain for one
          // decision, and carrying no content of any kind.
          decision: `${prompt.taskId}@${observation.publicLog.length}`,
          seat,
          taskId: prompt.taskId,
          attempt: input.attempt,
          categories: input.categories,
          codes: input.codes,
          willRetry: input.willRetry,
        });
      };

      let assassination: AssassinationSnapshot | null = null;
      let malformedEvidence: MalformedEvidenceMetric | null = null;
      let purposelessClaim = false;
      let claimRealism: ClaimRealismMetric | null = null;
      let pairRejections = 0;

      const runPublicStage = async (input: {
        readonly plannerText: string;
        readonly taskId: string;
      }): Promise<{ readonly mergedText: string; readonly snapshot: DisclosureSnapshot }> => {
        if (!cognitive || !ledger) throw new Error("two-stage requires the cognitive stack");

        let plannerObject: Record<string, unknown>;
        try {
          plannerObject = JSON.parse(extractJson(input.plannerText)) as Record<string, unknown>;
        } catch {
          throw new UnparseableAnswer(seat, "规划者的回答不是可解析的 JSON");
        }

        const intent = parseIntent(plannerObject.communicationIntent);
        if (!intent.ok) throw new UnparseableAnswer(seat, intent.error);

        const registry = buildFactRegistry(
          ledger.publicFacts,
          ledger.claims,
          observation,
          claimContestFrom(observation.publicLog),
        );
        const { intent: sanitised, audit } = sanitiseIntent({
          intent: intent.intent,
          observation,
          registry,
          persona,
          taskId: input.taskId,
          taskChannel: channelForTask(input.taskId),
        });

        const stage = resolveStage(config, "spokesperson");
        const built = buildSpokespersonPrompt({
          view: publicTableViewFor(observation),
          intent: sanitised,
          persona,
          taskId: input.taskId,
          speechCharLimit: config.limits.speechCharLimit,
          selectedAction: renderSelectedAction(input.taskId, plannerObject),
          ...(capabilities.naturalPublicSpeech ? { naturalSpeech: true } : {}),
        });

        const limit = config.limits.speechCharLimit;
        const maxRepairs = config.stages.maxPublicMessageRepairs;
        const rejections: DisclosureRejection[] = [];
        /**
         * The repair note for the NEXT attempt, or empty.
         *
         * Only ever set for reasons that are SAFE to describe back: a length
         * overrun (a count) and a machine id (a shape). A disclosure refusal
         * leaves it empty and the prompt byte-identical — handing the model its
         * own leaking sentence to fix is handing it the secret.
         */
        let note = "";

        for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
          const sayUser = note ? `${built.user}\n\n${note}` : built.user;
          const sayEstimated = pessimisticTokenEstimate(`${built.system}\n${sayUser}`);
          const sayLeg: Leg = {
            taskId: `${input.taskId}#say`,
            request: {
              model: stage.model,
              reasoningEffort: stage.reasoningEffort,
              system: built.system,
              user: sayUser,
              maxOutputTokens: stage.maxOutputTokens,
              format: { name: built.schemaName, schema: built.jsonSchema, strict: true },
              params: config.model.params,
            },
            system: built.system,
            user: sayUser,
            estimated: sayEstimated,
            maxOutputTokens: stage.maxOutputTokens,
          };

          const sayResponse = await send(sayLeg, 1);
          if (isOutputExhausted(sayResponse)) {
            record(sayLeg, 1, sayResponse, "output_limit", exhaustedMessage(stage.maxOutputTokens));
            throw new OutputCapacityExhausted(seat, sayLeg.taskId, stage.maxOutputTokens);
          }

          let message: unknown;
          try {
            message = (JSON.parse(extractJson(sayResponse.text)) as Record<string, unknown>)[
              built.messageField
            ];
          } catch {
            message = null;
          }
          if (typeof message !== "string" || message.trim().length === 0) {
            record(sayLeg, 1, sayResponse, "invalid", "发言者没有给出一个非空字符串");
            note = "";
            continue;
          }

          if (contentChars(message) > limit) {
            // Safe to describe: the note carries the count, never the words.
            record(
              sayLeg,
              1,
              sayResponse,
              "invalid",
              `公开发言超长：${contentChars(message)} 个非空白字符，上限 ${limit}`,
            );
            note = [
              "",
              "## ⚠ 上一句太长了",
              "",
              `刚才那句是 ${contentChars(message)} 个非空白字符，上限 ${limit}。请说得更短。`,
            ].join("\n");
            continue;
          }

          const verdict = validatePublicMessage({
            message,
            observation,
            taskId: input.taskId,
            ...(capabilities.naturalPublicSpeech ? { naturalSpeech: true } : {}),
            ...(capabilities.pairGroupingBlocked ? { pairGrouping: true } : {}),
          });
          if (!verdict.ok) {
            for (const d of verdict.disclosures) {
              if (d.rule.startsWith("percival-pair-")) pairRejections += 1;
            }
            // Does NOT enter the public log and is not shown to any other agent.
            rejections.push({
              attempt: attempt + 1,
              classes: verdict.disclosures.map((d) => d.secretClass),
              rules: [
                ...verdict.disclosures.map((d) => d.rule),
                ...verdict.machineIds.map((h) => `machine-id:${h.kind}`),
              ],
            });
            record(
              sayLeg,
              1,
              sayResponse,
              "invalid",
              verdict.disclosures.length > 0
                ? `disclosure_rejected：${verdict.disclosures.map((d) => d.rule).join("、")}`
                : `machine_id_rejected：${verdict.machineIds.map((h) => h.text).join("、")}`,
            );
            // TWO REASONS, TWO CHANNELS. A machine id is a SHAPE, and naming
            // the shape back carries nothing private — so that one gets a
            // repair note and the next attempt can actually do better. A
            // disclosure gets no note at all and a byte-identical retry.
            note =
              verdict.disclosures.length === 0 && verdict.machineIds.length > 0
                ? machineIdRepairNote(verdict.machineIds)
                : "";
            continue;
          }

          record(sayLeg, 1, sayResponse, "valid");
          const merged = { ...plannerObject, [built.messageField]: message };
          delete (merged as Record<string, unknown>).communicationIntent;
          return {
            mergedText: JSON.stringify(merged),
            snapshot: {
              // The public sentence and the ids that authorised it. This is what
              // keeps 0.6.0 auditable while the table hears only Chinese: the
              // reviewer can still resolve every public claim back to a referee
              // record, mechanically.
              provenance: {
                taskId: input.taskId,
                sentence: message,
                authorisedBy: audit.allowedBasisIds,
              },
              allowedBasisIds: audit.allowedBasisIds.length,
              rejectedBasisIds: audit.rejectedBasisIds.length,
              redactedFields: audit.redactedFields.map((r) => r.what),
              plannerLeakClasses: audit.redactedFields
                .map((r) => r.secretClass)
                .filter((c): c is NonNullable<typeof c> => c !== null),
              channelCorrected: audit.channelCorrected,
              messageRejections: rejections,
              audit,
            },
          };
        }

        throw new DisclosureInvalidError(
          seat,
          input.taskId,
          rejections.length,
          rejections.at(-1)?.rules.join("、") ?? "unknown",
        );
      };

      let sendNumber = 1;
      let response = await send(plannerLeg, sendNumber);

      if (isOutputExhausted(response)) {
        // NOT parsed, and no repair note. The model did not finish; whatever
        // prefix came back is a fragment, and a fragment that happens to open
        // with `{` is still not an answer. Appending "your JSON was invalid"
        // here is actively harmful — it gives the model more to reason about,
        // and reasoning is what ate the budget in the first place.
        record(plannerLeg, 1, response, "output_limit", exhaustedMessage(maxOutputTokens));
        options.onCapacityRetry?.(seat, prompt.taskId);

        // Exactly one retry, byte-identical: same observation, same system and
        // user message, same model, same effort, same cap. Nothing about the
        // request changes, because nothing about the request was wrong.
        sendNumber = 2;
        response = await send(plannerLeg, sendNumber);
        if (isOutputExhausted(response)) {
          record(plannerLeg, sendNumber, response, "output_limit", exhaustedMessage(maxOutputTokens));
          throw new OutputCapacityExhausted(seat, prompt.taskId, maxOutputTokens);
        }
      }

      /* ── M5.3: the public sentence comes from a second, blind request ──── */

      // Only `prompt-0.5.0`, and only for tasks that produce words. A vote has
      // no message, so it stays one request and one answer.
      const capabilities = capabilitiesFor(config.promptVersion);
      const twoStage =
        cognitive !== null &&
        ledger !== null &&
        capabilities.twoStageSpeech &&
        taskHasPublicMessage(prompt.taskId);

      let answerText = response.text;
      let disclosure: DisclosureSnapshot | null = null;

      if (twoStage && cognitive && ledger) {
        const staged = await runPublicStage({
          plannerText: response.text,
          taskId: prompt.taskId,
        });
        answerText = staged.mergedText;
        disclosure = staged.snapshot;
      }

      const parsed = parseAction(answerText, observation.request!);

      /* ── Vote discipline ──────────────────────────────────────────────── */
      //
      // COMPLETENESS, NOT A QUOTA. Every check refuses an analysis that is
      // internally inconsistent or that skipped a question. None of them can
      // refuse a vote — a seat that works through all six and approves a team
      // carrying the previous failed leader passes every one.
      if (parsed.ok && capabilities.voteDiscipline && parsed.action.kind === "vote") {
        let rawAnalysis: unknown;
        try {
          rawAnalysis = (JSON.parse(extractJson(answerText)) as Record<string, unknown>)
            .voteAnalysis;
        } catch {
          rawAnalysis = null;
        }
        const analysis = parseVoteAnalysis(rawAnalysis);
        if (!analysis.ok) {
          record(plannerLeg, sendNumber, response, "invalid", analysis.error);
          throw new UnparseableAnswer(seat, analysis.error);
        }
        const p = observation.position;
        const lastFailed = [...observation.publicLog]
          .reverse()
          .find((e) => e.type === "mission_result" && e.result === "fail");
        const problems = voteAnalysisProblems(analysis.analysis, {
          seat,
          proposedTeam: p.proposedTeam ?? [],
          rejectionStreak: p.rejectionStreak,
          anyMissionResolved: p.missionTrack.some((slot) => slot !== "pending"),
          lastFailedTeam:
            lastFailed && lastFailed.type === "mission_result" ? lastFailed.team : null,
        });
        if (problems.length > 0) {
          throw new UnparseableAnswer(seat, `voteAnalysis 有问题：${problems[0]}`);
        }
        // The two `choice` fields are the same decision written twice; a
        // disagreement means the analysis is about a different vote.
        const chosen = (parsed.action as { choice?: string }).choice;
        if (chosen && chosen !== analysis.analysis.choice) {
          const detail = `voteAnalysis.choice 是 ${analysis.analysis.choice}，动作里的 choice 是 ${chosen}`;
          record(plannerLeg, sendNumber, response, "invalid", detail);
          throw new UnparseableAnswer(seat, detail);
        }
      }


      /* ── The assassination candidate ranking ──────────────────────────── */
      //
      // COMPLETENESS AGAIN, never a target. The check that does real work is
      // `counterEvidence`: a candidate with a case for and nothing against was
      // asserted rather than assessed, and that is exactly the shape the M5.3
      // Terra ranking had for its runner-up.
      if (parsed.ok && capabilities.assassinRanking && parsed.action.kind === "assassinate") {
        let rawRanking: unknown;
        try {
          rawRanking = (JSON.parse(extractJson(answerText)) as Record<string, unknown>)
            .assassination;
        } catch {
          rawRanking = null;
        }
        const ranking = parseAssassination(rawRanking);
        if (!ranking.ok) {
          record(plannerLeg, sendNumber, response, "invalid", ranking.error);
          throw new UnparseableAnswer(seat, ranking.error);
        }
        // The roster this seat was privately shown. Visible only in this
        // phase, which is what makes the list exact rather than a guess — and
        // it is NOT a list of forbidden targets.
        const knownEvil = (observation.evilRoster ?? []).map((e) => e.seat);
        // Who announced a Lady result, from the PUBLIC log — the same record
        // the whole table saw, so the check asks about public behaviour rather
        // than about anything only this seat knows.
        const ladyAnnouncers = new Map<
          Seat,
          { readonly target: Seat; readonly announced: "good" | "evil" }[]
        >();
        for (const event of observation.publicLog) {
          if (event.type !== "lady_announced") continue;
          const list = ladyAnnouncers.get(event.holder) ?? [];
          list.push({ target: event.target, announced: event.announced });
          ladyAnnouncers.set(event.holder, list);
        }
        const context = {
          seat,
          knownEvil,
          ...(capabilities.ladyNeutralAssassination
            ? { ladyAnnouncers, requireLadyAnalysis: true }
            : {}),
        };
        const problems = assassinationProblems(ranking.ranking, context);
        if (problems.length > 0) {
          record(plannerLeg, sendNumber, response, "invalid", problems[0]);
          throw new UnparseableAnswer(seat, `assassination 有问题：${problems[0]}`);
        }
        const chosen = (parsed.action as { target?: number }).target;
        if (chosen !== undefined && chosen !== ranking.ranking.target) {
          const detail = `assassination.target 是 ${ranking.ranking.target}，动作里的 target 是 ${chosen}`;
          record(plannerLeg, sendNumber, response, "invalid", detail);
          throw new UnparseableAnswer(seat, detail);
        }
        // Naming a seat he already knew was evil is a MISTAKE, not an illegal
        // move. It is recorded and the action goes through untouched — the
        // target is never repaired, replaced, or re-asked.
        const ordered = orderedCandidates(ranking.ranking, context);
        assassination = {
          target: ranking.ranking.target,
          rankedSeats: ordered.map((c) => c.seat),
          candidateCount: ranking.ranking.candidates.length,
          knownEvil,
          knownEvilTarget: knownEvilTargeted(ranking.ranking, context),
          signalsUsed: [...new Set(ranking.ranking.candidates.flatMap((c) => c.signals))],
          targetConfidence:
            ranking.ranking.candidates.find((c) => c.seat === ranking.ranking.target)
              ?.confidence ?? null,
        };
      }

      /* ── The evil mission-card coordination convention ────────────────── */
      //
      // A HOUSE STRATEGY, enforced here rather than in the referee: the referee
      // stays a referee, and any fail card remains legal by the rules. What is
      // refused is a CONVENTION violation, and it is refused rather than
      // rewritten — silently turning the card into `success` would produce a
      // game whose record disagrees with what the agent decided.
      if (parsed.ok && capabilities.evilCoordination) {
        const card = (parsed.action as { kind: string; card?: "success" | "fail" });
        if (card.kind === "mission" && card.card) {
          const violation = coordinationViolation(observation.missionCoordination, card.card);
          if (violation) {
            record(plannerLeg, sendNumber, response, "invalid", violation);
            throw new UnparseableAnswer(seat, violation);
          }
        }
      }

      /*
       * THE ACTION-LEVEL RECORD, and it stays here on purpose.
       *
       * Moving it below the cognition checks was tried and reverted: `retries`
       * counts MALFORMED ACTIONS, `cognitionRepairs` counts refused cognition,
       * and `pilot-m5-1.test.ts` pins that separation with a comment saying
       * conflating them once produced a wrong shipped report. Recording a
       * cognition refusal as `outcome: "invalid"` would route it into
       * `ledger.recordRetry()` and merge the two counters again.
       *
       * The cost is that an attempt cognition later refuses is written as
       * `valid` here — visible in the M5.5 pilot, where seat 7's three refused
       * answers all carry `outcome: "valid"`. That is why the runner
       * back-annotates `rejectedBy: "cognition"`, and why the new
       * `cognition-rejection` lines exist: the refusal is recorded in the two
       * channels that mean it, without corrupting the one that does not.
       */
      record(
        plannerLeg,
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
        // THE M5.3 DEFECT WAS HERE. This used to be
        //
        //     const wantsContest = config.promptVersion === PROMPT_VERSION_CONTEST;
        //
        // which is false for `prompt-0.5.0` — a stack that ASKS for both blocks
        // under a strict schema. The builder knew about 0.5.0; this half did
        // not. For two completed live games the model answered `social` and
        // `contest` and both were parsed away: never validated, never folded,
        // never rendered on the next turn, never recorded. The `k…` ids were
        // not minted either, so citing one resolved as an invented id.
        //
        // Capabilities are now DECLARED, not re-derived from a string here.
        const limits = capabilities.limits;
        const cognition = parseCognition(raw, {
          limits,
          withSocial: capabilities.social,
          ...(capabilities.claimContest ? { withContest: true } : {}),
          ...(capabilities.stableCommitmentIds ? { withCommitmentIds: true } : {}),
        });

        if (!cognition.ok) {
          const exhausted = attemptNumber > config.cognition.maxCognitionRepairs;
          refuse({
            categories: ["bounds-or-shape"],
            codes: ["shape.unparseable"],
            attempt: attemptNumber,
            willRetry: !exhausted,
          });
          if (exhausted) {
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
          const exhausted = attemptNumber > config.cognition.maxCognitionRepairs;
          record(plannerLeg, sendNumber, response, "invalid", problems[0]);
          // Every problem is classified, not just the first: one attempt can
          // be wrong in two ways, and a summary that recorded one of them
          // would understate what the model was actually asked to fix.
          const classified = problems.map(structuralRejection);
          refuse({
            categories: [...new Set(classified.map((c) => c.category))],
            codes: [...new Set(classified.map((c) => c.code))].slice(0, 6),
            attempt: attemptNumber,
            willRetry: !exhausted,
          });
          if (exhausted) {
            throw new CognitionInvalidError(seat, prompt.taskId, attemptNumber, problems[0]);
          }
          throw new UnparseableAnswer(seat, `cognition 有问题：${problems[0]}`);
        }

        // M5.5. ONE ID PER BOX, and it has to resolve. The registry has to be
        // built before the check rather than after, because "does this id
        // exist" is a question about THIS seat at THIS moment — the same
        // registry the prompt rendered.
        const checkRegistry = buildFactRegistry(
          ledger.publicFacts,
          ledger.claims,
          observation,
          capabilities.claimContest ? claimContest : undefined,
        );
        if (capabilities.validatedEvidenceRefs) {
          const bad = malformedRefs(cognition.cognition, checkRegistry);
          if (bad.length > 0) {
            malformedEvidence = malformedEvidenceReference(bad);
            const exhausted = attemptNumber > config.cognition.maxCognitionRepairs;
            const { category, codes } = evidenceRejection(bad);
            refuse({
              categories: [category],
              codes,
              attempt: attemptNumber,
              willRetry: !exhausted,
            });
            if (exhausted) {
              throw new CognitionInvalidError(
                seat,
                prompt.taskId,
                attemptNumber,
                malformedRefsSummary(bad),
              );
            }
            // The note describes the SHAPE and quotes nothing the model wrote —
            // an unresolvable id may be another seat's, and echoing it would
            // turn a citation mistake into a probe.
            throw new UnparseableAnswer(
              seat,
              `${malformedRefsSummary(bad)}${malformedRefsNote(bad)}`,
            );
          }
          malformedEvidence = malformedEvidenceReference([]);
        }

        // M5.5. A standing claim stays standing. Repaired, never forbidden —
        // a repeated claim with a purpose the public log supports goes through.
        if (capabilities.persistentClaims && submitted.kind === "speech") {
          // TYPED, from the canonical parser. Read as `SpeechAction` rather
          // than through a cast onto a bag of optionals: the M5.5 pilot showed
          // that a field the parser never copied reads as `undefined` forever,
          // and a structural type is what makes that a compile error instead of
          // a silent null. See `structured.ts`.
          const spoken = parsed.action as SpeechAction;
          const purpose = spoken.claimPurpose ?? null;
          const verdict = checkClaim({
            seat,
            submittedClaim: (submitted.claim ?? null) as never,
            retracting: submitted.retractClaim === true,
            purpose,
            ...(spoken.ambiguityEventIds
              ? { ambiguityEventIds: spoken.ambiguityEventIds }
              : {}),
            publicLog: observation.publicLog,
          });
          if (submitted.claim) {
            claimRealism = foldClaimMetric(emptyClaimMetric(), purpose, verdict);
          }
          if (verdict.problem) {
            purposelessClaim = true;
            const exhausted = attemptNumber > config.cognition.maxCognitionRepairs;
            const { category, code } = claimRejection(verdict.problem);
            refuse({
              categories: [category],
              codes: [code],
              attempt: attemptNumber,
              willRetry: !exhausted,
            });
            if (exhausted) {
              throw new CognitionInvalidError(
                seat,
                prompt.taskId,
                attemptNumber,
                verdict.problem,
              );
            }
            throw new UnparseableAnswer(
              seat,
              `claim_purposeless：${verdict.problem}${claimRepairNote(verdict)}`,
            );
          }
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
          capabilities.claimContest ? claimContest : undefined,
        );
        const folded = applyFusedUpdate(
          ledger,
          observation,
          cognition.cognition,
          observation.publicLog.length,
          { registry, limits, ...(capabilities.claimContest ? { claimContest } : {}) },
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
          disclosure,
          assassination,
          malformedEvidence,
          pairDisclosure: capabilities.pairGroupingBlocked
            ? pairDisclosureMetric(observation, pairRejections)
            : null,
          purposelessClaim,
          claimRealism,
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
