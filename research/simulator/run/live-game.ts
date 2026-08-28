/**
 * The live-game entry point. Every safety decision, in one testable place.
 *
 * Split from the CLI shell on purpose: everything below is a function over an
 * options object, so the preflight sequence, the projected-spend arithmetic,
 * the artifact layout, the checkpoint and the resume path can all be tested
 * offline with a client double that never touches the network. The shell in
 * `scripts/run-live-game.ts` does argument parsing, reads the one environment
 * variable, prints, and asks for confirmation — nothing else.
 *
 * THE ORDER OF PREFLIGHT MATTERS and is asserted:
 *
 *   1. pricing configured        — without it the money ceilings are blind
 *   2. persona/strategy resolve  — a typo should not cost a game
 *   3. projected maximum spend   — computed and shown BEFORE anything is created
 *   4. explicit confirmation     — a human says yes to that number
 *   5. output directories        — created only now, so a refused run leaves
 *                                  no empty folders behind
 *   6. the game
 *
 * A dry run performs 1-3 and stops. It makes no request and creates nothing.
 *
 * WHAT HAPPENS WHEN A RUN STOPS EARLY. Every interruption that could be picked
 * up again writes three things: a partial public replay marked with the pause
 * status, a partial private trace with everything accumulated so far, and a
 * resumable checkpoint. A permanent failure writes the first two marked
 * `failed` and NO checkpoint — claiming resumability for something that cannot
 * resume is worse than admitting the game is lost.
 */

import { join } from "node:path";
import type { SimConfig } from "../config/load";
import { loadConfig } from "../config/load";
import { asGameId, newGameId, type GameId } from "../core/game-id";
import type { PauseReason, RunStatus } from "../core/run-status";
import { SEATS, type Seat } from "../core/types";
import {
  llmAgent,
  OutputCapacityExhausted,
  PausedError,
  type ModelAttempt,
} from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import {
  BatchAccount,
  CallLedger,
  ModelCallError,
  isRecoverableProviderError,
  type LedgerState,
  type ModelClient,
} from "../model/client";
import { pessimisticTokenEstimate, projectedRequestUsd } from "../model/pricing";
import { assignPersonas, type PersonaDefinition, type PersonaMode } from "../prompts/personas";
import {
  makeCustomStrategy,
  strategyById,
  strategyFingerprint,
  type CatalogStrategyId,
  type StrategyDefinition,
} from "../prompts/strategies";
import {
  buildPrivateResearchTrace,
  buildPublicReplay,
  serialisePrivateResearchTrace,
  serialisePublicReplay,
  type ModelCallRecord,
  type RecordedAction,
  type SeatConfigurations,
} from "./artifacts";
import { writeFileAtomic } from "./atomic";
import {
  buildCheckpoint,
  resumeFromCheckpoint,
  serialiseCheckpoint,
  type PrivateCheckpoint,
} from "./checkpoint";
import { replayPrefix, runGame, UnrecoverableAgentError } from "./runner";
import { CognitionStore, type CognitionStoreState } from "../cognition/store";
import type { CognitionReport } from "../agents/llm-agent";
import { CognitionInvalidError } from "../agents/llm-agent";
import type { GameState } from "../core/state";

export interface LiveGameOptions {
  readonly seed: number;
  readonly gameId?: GameId;
  readonly personaMode?: PersonaMode;
  readonly strategyProfile?: CatalogStrategyId;
  readonly customStrategyText?: string;
  readonly config?: SimConfig;
  /** Where artifacts go. Created only after preflight passes. */
  readonly outDir: string;
  /** Built by the caller so this module never touches a key or the network. */
  readonly client: ModelClient;
  /** Per-game cap on model output. Drives the spend projection. */
  readonly maxOutputTokens?: number;
  /** Shared across a batch so the $100 ceiling survives between games. */
  readonly batch?: BatchAccount;
  /** A parsed checkpoint. Its identity and arms override the flags. */
  readonly resumeFrom?: PrivateCheckpoint;
  readonly onWarning?: (message: string) => void;
}

/**
 * The effective output cap for a run.
 *
 * There is no constant fallback on purpose. The value comes from
 * `config.limits.maxOutputTokens`, which means it is validated on load,
 * written into every artifact, and checked on resume. The 2000 that used to
 * live here as a hard-coded default is what killed the first paid game, and
 * it was invisible in the artifacts precisely because it was not configuration.
 */
export function effectiveMaxOutputTokens(
  config: SimConfig,
  override?: number,
): number {
  return override ?? config.limits.maxOutputTokens;
}

/* ── Preflight ─────────────────────────────────────────────────────────── */

export class PreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

export interface Projection {
  /** Worst case for ONE request, priced as fully uncached input at the cap. */
  readonly perRequestUsd: number;
  /** That, times the call ceiling. The most a game could possibly cost. */
  readonly maxGameUsd: number;
  /** What the ceilings would actually let it reach first. */
  readonly effectiveCeilingUsd: number;
  readonly maxLiveCalls: number;
  readonly assumedInputTokens: number;
  readonly maxOutputTokens: number;
  /** Already spent on THIS game, when resuming. Same ceiling, not a fresh one. */
  readonly alreadySpentUsd: number;
  /** Already spent across the whole batch, restored from the checkpoint. */
  readonly alreadySpentBatchUsd: number;
}

/**
 * The number a human is asked to approve.
 *
 * Deliberately the WORST case rather than an expectation: every request priced
 * as if none of its input were cached and all of its output were used, times
 * the call ceiling. The real bill will be lower, and a projection that was
 * usually right but occasionally low would be worse than one that is always
 * high — this is the number somebody says yes to.
 */
export function projectMaximumSpend(
  config: SimConfig,
  maxOutputTokens: number,
  assumedInputTokens: number,
  alreadySpentUsd = 0,
  callsAlreadyMade = 0,
  alreadySpentBatchUsd = 0,
): Projection {
  const perRequestUsd =
    projectedRequestUsd(assumedInputTokens, maxOutputTokens, config.pricing) ?? 0;
  const remainingCalls = Math.max(0, config.limits.maxLiveCallsPerGame - callsAlreadyMade);
  const maxGameUsd = alreadySpentUsd + perRequestUsd * remainingCalls;
  return {
    perRequestUsd,
    maxGameUsd,
    // Whichever bites first: the call ceiling or the money ceiling.
    effectiveCeilingUsd: Math.min(maxGameUsd, config.budget.hardCostLimitPerGameUsd),
    maxLiveCalls: remainingCalls,
    assumedInputTokens,
    maxOutputTokens,
    alreadySpentUsd,
    alreadySpentBatchUsd,
  };
}

export interface PreflightResult {
  readonly config: SimConfig;
  readonly gameId: GameId;
  readonly seed: number;
  readonly personaMode: PersonaMode;
  readonly personas: Readonly<Record<Seat, PersonaDefinition>>;
  readonly strategy: StrategyDefinition;
  readonly projection: Projection;
  readonly publicPath: string;
  readonly privatePath: string;
  readonly checkpointPath: string;
  readonly resuming: boolean;
}

/**
 * Everything that can be checked without spending anything.
 *
 * Creates no directories and makes no requests, so a dry run and a real run
 * take exactly the same path up to this point — which is the only way a dry
 * run is evidence about the real one.
 */
export function preflight(options: LiveGameOptions): PreflightResult {
  const config = options.config ?? loadConfig();
  const resume = options.resumeFrom;

  // 1. Without a price list the ceilings cannot see anything, and running
  //    behind a blind gate is worse than stopping in front of a visible one.
  if (!config.pricing.configured) {
    throw new PreflightError(
      "pricing_unconfigured",
      "config.pricing.configured 是 false —— 预算闸看不见任何东西，拒绝开跑。",
    );
  }
  if (config.pricing.modelId !== config.model.id) {
    throw new PreflightError(
      "pricing_model_mismatch",
      `价目表是给 ${config.pricing.modelId} 的，但要跑的是 ${config.model.id}。`,
    );
  }

  // A resume keeps the identity and the arms it was paused with. Anything the
  // caller passed that disagrees is a mistake, not an override — silently
  // preferring one would produce a game made of two experiments.
  if (resume) {
    const clash = (what: string, was: unknown, now: unknown) =>
      new PreflightError(
        "resume_flag_conflict",
        `续跑不能改 ${what}：检查点是 ${String(was)}，命令行给的是 ${String(now)}`,
      );
    if (options.gameId && options.gameId !== resume.gameId) {
      throw clash("game id", resume.gameId, options.gameId);
    }
    if (options.seed !== resume.seed) throw clash("seed", resume.seed, options.seed);
    if (options.personaMode && options.personaMode !== resume.personaMode) {
      throw clash("persona 模式", resume.personaMode, options.personaMode);
    }
    if (options.strategyProfile && options.strategyProfile !== resume.strategyId) {
      throw clash("策略档", resume.strategyId, options.strategyProfile);
    }
    if (
      options.customStrategyText !== undefined &&
      options.customStrategyText !== resume.customStrategyText
    ) {
      throw clash("自定义策略文本", resume.customStrategyText, options.customStrategyText);
    }
  }

  const seed = resume ? resume.seed : options.seed;
  if (!Number.isInteger(seed) || seed < 0) {
    throw new PreflightError("bad_seed", `seed 必须是非负整数，收到 ${seed}`);
  }

  // 2. A typo in a profile name should cost nothing, so it is caught here.
  const personaMode = resume
    ? resume.personaMode
    : (options.personaMode ?? config.experiment.personaMode);
  const customText = resume
    ? (resume.customStrategyText ?? undefined)
    : options.customStrategyText;
  const strategy = customText
    ? makeCustomStrategy(customText)
    : strategyById(
        (resume ? resume.strategyId : (options.strategyProfile ?? config.experiment.strategyProfile)) as CatalogStrategyId,
      );

  const personas = assignPersonas(seed, personaMode);
  const gameId = resume
    ? asGameId(resume.gameId)
    : options.gameId
      ? asGameId(options.gameId)
      : newGameId();
  const maxOutputTokens = effectiveMaxOutputTokens(config, options.maxOutputTokens);

  // 3. The number a human will be asked to approve. On a resume it starts from
  //    what has already been spent, against the SAME ceiling.
  const projection = projectMaximumSpend(
    config,
    maxOutputTokens,
    // A late-game prompt, estimated pessimistically. Requests grow with the
    // history, so the last ones are the expensive ones.
    pessimisticTokenEstimate("字".repeat(20_000)),
    resume ? spentFrom(resume.ledger, config) : 0,
    resume ? resume.ledger.calls : 0,
    resume ? resume.ledger.batchUsd : 0,
  );

  return {
    config,
    gameId,
    seed,
    personaMode,
    personas,
    strategy,
    projection,
    // Separated so a public replay can be shared without anyone having to
    // remember which of two files in one folder was safe.
    publicPath: join(options.outDir, "public", `${gameId}.public-replay.jsonl`),
    privatePath: join(options.outDir, "private", `${gameId}.private-trace.jsonl`),
    checkpointPath: join(options.outDir, "private", `${gameId}.checkpoint.json`),
    resuming: Boolean(resume),
  };
}

function spentFrom(ledger: LedgerState, config: SimConfig): number {
  const cached = Math.min(ledger.usage.cachedInputTokens, ledger.usage.inputTokens);
  const uncached = ledger.usage.inputTokens - cached;
  if (!config.pricing.configured) return 0;
  return (
    (uncached * config.pricing.uncachedInputUsdPerMTok) / 1_000_000 +
    (cached * config.pricing.cachedInputUsdPerMTok) / 1_000_000 +
    (ledger.usage.outputTokens * config.pricing.outputUsdPerMTok) / 1_000_000
  );
}

/* ── The run ───────────────────────────────────────────────────────────── */

export interface LiveGameResult {
  readonly status: RunStatus;
  readonly gameId: GameId;
  /** Only paths that were actually written. */
  readonly publicPath: string | null;
  readonly privatePath: string | null;
  readonly checkpointPath: string | null;
  readonly ledger: ReturnType<CallLedger["snapshot"]>;
  readonly outcome: string;
  /** One entry per SENT request, including failures. See `cost-report.ts`. */
  readonly attempts: readonly ModelAttempt[];
  /** Ordinary schema/legality repair retries — the model finished and erred. */
  readonly retries: number;
  /** Identical-prompt resends after an exhausted output budget. Counted apart. */
  readonly capacityRetries: number;
  /** Repairs caused by a malformed cognition block, not by a malformed action. */
  readonly cognitionRepairs: number;
  /** The output cap this run actually used, from `limits.maxOutputTokens`. */
  readonly maxOutputTokens: number;
  /** sha256 of the full rendered profile. Private-trace material, surfaced here. */
  readonly strategyFingerprint: string;
  readonly strategyId: string;
  readonly resumed: boolean;
}

export async function runLiveGame(
  options: LiveGameOptions,
  ready: PreflightResult,
): Promise<LiveGameResult> {
  const { config, gameId, personaMode, personas, strategy, seed } = ready;
  const resume = options.resumeFrom;

  /*
   * Batch spend survives a resume even when the caller brought their own
   * account.
   *
   * The old line was `options.batch ?? new BatchAccount(resume.ledger.batchUsd)`,
   * which only restored history when NOBODY passed an account — and the CLI
   * passed a fresh empty one unconditionally, so every resume silently reset
   * the batch total to zero. The $100 ceiling was therefore escapable by
   * pausing and resuming.
   *
   * `ensureAtLeast` is idempotent, so resuming the same checkpoint twice
   * cannot double-count, and it never lowers an account that already holds
   * more — several games share one batch, and the others' spend is not this
   * game's to erase.
   */
  const batch = options.batch ?? new BatchAccount();
  if (resume) batch.ensureAtLeast(resume.ledger.batchUsd);
  const ledger = new CallLedger(config, batch);
  if (resume) ledger.restore(resume.ledger);

  const maxOutputTokens = effectiveMaxOutputTokens(config, options.maxOutputTokens);

  // Ordinary repair retries and capacity retries are different events and are
  // counted apart: one means "the model got it wrong", the other means "the
  // model never finished". Conflating them would hide the second entirely.
  let capacityRetries = 0;
  let cognitionRepairs = 0;
  // Computed once, from the resolved profile, and written into both artifacts.
  const strategyDigest = strategyFingerprint(strategy);

  /**
   * Ten minds, created once and outliving the agents.
   *
   * A resume rebuilds every agent from scratch; without this the game would
   * continue with ten blank memories and a public log they had never seen.
   */
  const cognitionStore = new CognitionStore(resume?.cognition ?? undefined);
  const cognitionReports: CognitionReport[] = [...(resume?.cognitionReports ?? [])];

  // Everything accumulated so far comes back, so a resumed game's trace is the
  // whole game rather than the tail of it.
  const attempts: ModelAttempt[] = [...(resume?.modelAttempts ?? [])];
  const seats: SeatConfigurations = {};
  const agents = {} as Record<Seat, Agent>;

  for (const seat of SEATS) {
    seats[seat] = {
      persona: personas[seat].id,
      strategy: strategy.id,
      ...(strategy.customText ? { customStrategyText: strategy.customText } : {}),
    };
    agents[seat] = llmAgent(seat, {
      client: options.client,
      persona: personas[seat],
      strategy,
      config,
      maxOutputTokens,
      onSend: () => ledger.beginAttempt(),
      onCapacityRetry: () => {
        capacityRetries += 1;
      },
      // Opt-in, and the ONLY switch. A config that never mentions cognition
      // builds the seven-layer `prompt-0.2.0` stack exactly as before.
      ...(config.cognition.enabled
        ? {
            cognition: {
              store: cognitionStore,
              onCognition: (report: CognitionReport) => {
                if (report.attempt > 1) cognitionRepairs += 1;
                if (config.cognition.telemetry) cognitionReports.push(report);
              },
            },
          }
        : {}),
      onAttempt: (attempt) => {
        attempts.push(attempt);
        if (attempt.usage === null) ledger.failAttempt();
        else {
          ledger.settleAttempt({
            usage: attempt.usage,
            latencyMs: attempt.latencyMs,
            cached: attempt.cached,
          });
          if (attempt.outcome === "invalid") ledger.recordRetry();
        }
      },
      mayCall: (next) => ledger.mayCall(next),
      onBudgetWarning: (verdict) => options.onWarning?.(verdict.detail),
    });
  }

  let resumed: { state: GameState; actions: readonly RecordedAction[] } | undefined;
  if (resume) {
    const restored = resumeFromCheckpoint(resume, {
      config,
      personaMode,
      personaAssignment: personas,
      strategyId: strategy.id,
      maxOutputTokens,
      cognitionEnabled: config.cognition.enabled,
      ...(strategy.customText ? { customStrategyText: strategy.customText } : {}),
    });
    resumed = { state: restored.state, actions: restored.actions };
  }

  const write = (
    state: GameState,
    actions: readonly RecordedAction[],
    status: RunStatus,
    failureReason?: string,
  ) => {
    writeFileAtomic(
      ready.publicPath,
      serialisePublicReplay(
        buildPublicReplay(state, agents, {
          seats,
          personaMode,
          status,
          maxOutputTokens,
          strategyId: strategy.id,
        }),
      ),
    );
    writeFileAtomic(
      ready.privatePath,
      serialisePrivateResearchTrace(
        buildPrivateResearchTrace(state, agents, actions, {
          seats,
          personaMode,
          status,
          maxOutputTokens,
          strategyId: strategy.id,
          strategyFingerprint: strategyDigest,
          ...(config.cognition.enabled
            ? { cognition: config.cognition, cognitionReports }
            : {}),
          modelCalls: attempts as readonly ModelCallRecord[],
          ...(failureReason ? { failureReason } : {}),
        }),
      ),
    );
  };

  const saveCheckpoint = (
    state: GameState,
    actions: readonly RecordedAction[],
    reason: PauseReason,
    detail: Readonly<Record<string, number | string | null>>,
  ) => {
    writeFileAtomic(
      ready.checkpointPath,
      serialiseCheckpoint(
        buildCheckpoint({
          state,
          config,
          personaMode,
          personaAssignment: personas,
          strategyId: strategy.id,
          ...(strategy.customText ? { customStrategyText: strategy.customText } : {}),
          maxOutputTokens,
          ...(config.cognition.enabled
            ? {
                cognition: cognitionStore.export(),
                cognitionConfig: config.cognition,
                cognitionReports,
              }
            : {}),
          actions,
          modelAttempts: attempts,
          ledger: ledger.export(),
          pauseReason: reason,
          detail,
        }),
      ),
    );
  };

  // Progress is captured as ACTIONS, not as a state handle. An interruption
  // rebuilds the position from them with `replayPrefix` — the same
  // deterministic path a resume takes — so a partial artifact is provably
  // reconstructible rather than a snapshot of a live object.
  const applied: RecordedAction[] = [...(resumed?.actions ?? [])];

  try {
    const result = await runGame({
      seed,
      agents,
      config,
      runId: "live",
      gameId,
      ...(resumed ? { resume: resumed } : {}),
      onActionApplied: (action) => applied.push(action),
      onRejection: (seat, feedback, source) => {
        // Something refused the answer the agent just produced. The agent could
        // not know that, so the correction happens here — WITH the reason.
        //
        // The reason used to be dropped on the floor, and the M5 pilot's five
        // re-asks then had to be diagnosed months later by replaying the game
        // and re-submitting each recorded answer. Four turned out to be an
        // empty `premiseIds` array and one an empty hypothesis label; the
        // shipped report had called all five referee rejections.
        for (let i = attempts.length - 1; i >= 0; i -= 1) {
          if (attempts[i].seat === seat) {
            attempts[i].appliedLegalAction = false;
            attempts[i].rejectionReason = feedback.error;
            attempts[i].rejectedBy =
              source === "referee"
                ? "referee"
                : feedback.error.startsWith("cognition 有问题")
                  ? "cognition"
                  : "action-format";
            break;
          }
        }
      },
    });
    write(result.state, result.actions, "completed");
    return {
      status: "completed",
      gameId,
      publicPath: ready.publicPath,
      privatePath: ready.privatePath,
      checkpointPath: null,
      ledger: ledger.snapshot(),
      outcome: `${result.outcome.winner} / ${result.outcome.reason}`,
      attempts,
      retries: ledger.snapshot().retries,
      capacityRetries,
      cognitionRepairs,
      maxOutputTokens,
      strategyFingerprint: strategyDigest,
      strategyId: strategy.id,
      resumed: Boolean(resume),
    };
  } catch (error) {
    const stopped = classify(error);
    // Rebuild the position the game actually reached. If this throws, the
    // checkpoint would not have resumed either, and finding that out here is
    // far better than finding it out from a resume that cannot move.
    const state = replayPrefix(seed, applied, { config, gameId, runId: "live" });
    write(state, applied, stopped.status, stopped.failureReason);
    if (stopped.pauseReason) {
      saveCheckpoint(state, applied, stopped.pauseReason, stopped.detail);
    }
    return {
      status: stopped.status,
      gameId,
      publicPath: ready.publicPath,
      privatePath: ready.privatePath,
      // Only claimed when it really is resumable.
      checkpointPath: stopped.pauseReason ? ready.checkpointPath : null,
      ledger: ledger.snapshot(),
      outcome: stopped.outcome,
      attempts,
      retries: ledger.snapshot().retries,
      capacityRetries,
      cognitionRepairs,
      maxOutputTokens,
      strategyFingerprint: strategyDigest,
      strategyId: strategy.id,
      resumed: Boolean(resume),
    };
  }
}

interface Stopped {
  readonly status: RunStatus;
  readonly pauseReason: PauseReason | null;
  readonly outcome: string;
  readonly failureReason?: string;
  readonly detail: Readonly<Record<string, number | string | null>>;
}

/**
 * Pause or failure?
 *
 * A ceiling and a transient provider problem are both resumable. A malformed
 * schema, an unknown model or a rejected key will fail again the same way, and
 * calling that resumable would send somebody back to a checkpoint that cannot
 * move. Provider failures are never retried automatically here: a request that
 * timed out may or may not have been billed.
 */
function classify(error: unknown): Stopped {
  if (error instanceof PausedError) {
    return {
      status: error.reason,
      pauseReason: error.reason,
      outcome: `paused: ${error.message}`,
      detail: { ...error.detail, seat: error.seat },
    };
  }
  if (error instanceof ModelCallError) {
    const sanitised = error.describe();
    if (isRecoverableProviderError(error)) {
      return {
        status: "paused_provider_interruption",
        pauseReason: "paused_provider_interruption",
        outcome: `paused: ${sanitised}`,
        failureReason: sanitised,
        detail: {
          httpStatus: error.httpStatus,
          providerType: error.providerType,
          providerCode: error.providerCode,
        },
      };
    }
    return {
      status: "failed",
      pauseReason: null,
      outcome: `provider: ${sanitised}`,
      failureReason: sanitised,
      detail: {},
    };
  }
  if (error instanceof OutputCapacityExhausted) {
    // Permanent, and named. A checkpoint here would only promise a resume
    // that cannot move: the same prompt under the same cap produces the same
    // exhaustion. The remedy is configuration, decided by a human.
    return {
      status: "output_limit_exhausted",
      pauseReason: null,
      outcome: `failed: ${error.message}`,
      failureReason: error.message,
      detail: {
        seat: error.seat,
        taskId: error.taskId,
        maxOutputTokens: error.maxOutputTokens,
      },
    };
  }
  if (error instanceof CognitionInvalidError) {
    return {
      status: "cognition_invalid",
      pauseReason: null,
      outcome: `failed: ${error.message}`,
      failureReason: error.message,
      detail: { seat: error.seat, taskId: error.taskId, attempts: error.attempts },
    };
  }
  if (error instanceof UnrecoverableAgentError) {
    return {
      status: "failed",
      pauseReason: null,
      outcome: error.message,
      failureReason: error.message,
      detail: {},
    };
  }
  throw error;
}
