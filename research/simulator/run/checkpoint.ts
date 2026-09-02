/**
 * A checkpoint that can actually resume a game.
 *
 * The previous one could not, and the reason is worth writing down: it held
 * metadata, a hard-coded `sequence: 0`, and nothing else. No actions, no
 * ledger, no model calls. Resuming from it would have meant starting the game
 * over while believing money had already been spent.
 *
 * WHAT IS AUTHORITATIVE, and what is not. The authoritative content is the
 * SEED, the CONFIG, the GAME ID and the ORDERED LIST OF APPLIED ACTIONS. The
 * position is rebuilt by replaying those through today's referee
 * (`replayPrefix`), never by deserialising a `GameState`. A pickled state
 * would be authoritative the moment anything about the rules changed and would
 * silently continue a game the current referee would never have produced. A
 * replay either reproduces the position or fails loudly, which is the only
 * behaviour worth having.
 *
 * Everything else in the file — fingerprint, sequence, pending seat, versions,
 * pricing — exists to REJECT an incompatible resume before a single request is
 * sent. A resume that quietly continued under a different prompt version would
 * produce one game made of two experiments.
 *
 * PRIVATE. It carries the deal's seed, every action, and raw model output. It
 * lives beside the private trace and must never be published.
 */

import { createHash } from "node:crypto";
import type { CognitionConfig, SimConfig } from "../config/load";
import type { CognitionStoreState } from "../cognition/store";
import type { CognitionReport } from "../agents/llm-agent";
import { redactConfig } from "../config/load";
import type { GameId } from "../core/game-id";
import { asGameId } from "../core/game-id";
import type { PauseReason } from "../core/run-status";
import type { GameState } from "../core/state";
import { SEATS, type Seat } from "../core/types";
import type { LedgerState } from "../model/client";
import type { ModelAttempt } from "../agents/llm-agent";
import type { PersonaMode } from "../prompts/personas";
import type { StrategyId } from "../prompts/strategies";
import { fingerprintDigest, replayPrefix } from "./runner";
import type { RecordedAction } from "./artifacts";

/** Bumped whenever a field's meaning changes. An older file is refused. */
// @3 adds `maxOutputTokens`. An @2 file does not record the cap it ran under,
// so a resume could silently continue the same game at a different one — which
// is the exact mistake that produced two incomparable halves the first time.
// @4 adds the ten cognition ledgers. A @3 file has none, so resuming one into
// a cognition run would continue with ten blank minds and a history they had
// never read — worse than refusing, because it would look like it worked.
export const CHECKPOINT_SCHEMA = "avalon-sim-checkpoint@4";

export interface SeatAssignmentRecord {
  readonly seat: Seat;
  readonly persona: string;
}

export interface PrivateCheckpoint {
  /** Loud, and asserted by a test. This file is not publishable. */
  readonly containsPrivateInformation: true;
  readonly schema: typeof CHECKPOINT_SCHEMA;
  readonly warning: string;

  /* ── Identity and reproduction inputs ────────────────────────────────── */
  readonly simulatorVersion: string;
  readonly promptVersion: string;
  readonly gameId: GameId;
  readonly runId: string;
  readonly seed: number;

  /* ── Experiment arms ─────────────────────────────────────────────────── */
  readonly personaMode: PersonaMode;
  /** The exact mapping, not just the mode — a rotation must not drift. */
  readonly personaAssignment: readonly SeatAssignmentRecord[];
  readonly strategyId: StrategyId;
  readonly customStrategyText: string | null;
  /**
   * The named profile this game was started under, or null for `default.json`.
   *
   * ADDED AFTER A NEAR MISS. Resuming the M5.2 pilot without `--profile` made
   * the CLI fall back to `default.json`, which is `prompt-0.2.0`; the version
   * gate caught it before a single request left, and only because the
   * checkpoint happened to be a cognitive one. A `prompt-0.2.0` checkpoint
   * resumed the same way would have matched, and half a game would have
   * quietly continued under a different arm.
   *
   * A checkpoint written before this field existed has `null` here, and
   * `null` is INDISTINGUISHABLE from "started under default.json". So the CLI
   * refuses a resume without `--profile` when this is null rather than
   * guessing which of the two it means.
   */
  readonly profile: string | null;
  /**
   * The effective output cap. An arm, not a detail.
   *
   * Two halves of one game played at 2000 and at 6000 are two experiments:
   * the cap changes how much the model may think before answering, which
   * changes the answers. Stored explicitly rather than read out of `config`
   * because a caller may override the configured value.
   */
  readonly maxOutputTokens: number;
  /**
   * The cognition arm, and the ten minds it produced.
   *
   * Null for a legacy `prompt-0.2.0` run, which has neither. Stored as the
   * MODEL-OWNED slice only — the referee halves are re-derived on resume from
   * the replayed observation, so a checkpoint can never carry a stale fact.
   */
  readonly cognition: CognitionStoreState | null;
  readonly cognitionConfig: CognitionConfig | null;
  readonly cognitionReports: readonly CognitionReport[];

  /* ── Progress ────────────────────────────────────────────────────────── */
  readonly actions: readonly RecordedAction[];
  readonly modelAttempts: readonly ModelAttempt[];
  readonly ledger: LedgerState;

  /* ── Where the game actually stood ───────────────────────────────────── */
  readonly sequence: number;
  readonly pendingSeat: Seat | null;
  readonly pendingTask: string | null;
  /** sha256 of the full state fingerprint. Validated after reconstruction. */
  readonly stateFingerprint: string;

  /* ── Why it stopped, and what it may resume under ────────────────────── */
  readonly pauseReason: PauseReason;
  readonly detail: Readonly<Record<string, number | string | null>>;
  /** Redacted. Enough to reject an incompatible resume; never a credential. */
  readonly config: SimConfig;
}

const WARNING =
  "私有检查点：含种子、全部已应用动作、模型原始输出与用量。" +
  "它和私有轨迹放在一起，绝不能作为公开产物分发。";

export interface BuildCheckpointInput {
  readonly state: GameState;
  readonly config: SimConfig;
  readonly personaMode: PersonaMode;
  readonly personaAssignment: Readonly<Record<Seat, { readonly id: string }>>;
  readonly strategyId: StrategyId;
  readonly customStrategyText?: string;
  /** The named profile, or absent for `default.json`. */
  readonly profile?: string;
  readonly maxOutputTokens: number;
  readonly cognition?: CognitionStoreState;
  readonly cognitionConfig?: CognitionConfig;
  readonly cognitionReports?: readonly CognitionReport[];
  readonly actions: readonly RecordedAction[];
  readonly modelAttempts: readonly ModelAttempt[];
  readonly ledger: LedgerState;
  readonly pauseReason: PauseReason;
  readonly detail?: Readonly<Record<string, number | string | null>>;
}

export function buildCheckpoint(input: BuildCheckpointInput): PrivateCheckpoint {
  const { state } = input;
  return {
    containsPrivateInformation: true,
    schema: CHECKPOINT_SCHEMA,
    warning: WARNING,

    simulatorVersion: input.config.simulatorVersion,
    promptVersion: input.config.promptVersion,
    gameId: state.gameId,
    runId: state.runId,
    seed: state.seed,

    personaMode: input.personaMode,
    personaAssignment: SEATS.map((seat) => ({
      seat,
      persona: input.personaAssignment[seat].id,
    })),
    strategyId: input.strategyId,
    customStrategyText: input.customStrategyText ?? null,
    profile: input.profile ?? null,
    maxOutputTokens: input.maxOutputTokens,
    cognition: input.cognition ?? null,
    cognitionConfig: input.cognitionConfig ?? null,
    cognitionReports: [...(input.cognitionReports ?? [])],

    actions: [...input.actions],
    modelAttempts: [...input.modelAttempts],
    ledger: input.ledger,

    // The REAL sequence, not a placeholder. The old checkpoint wrote 0 here,
    // which is what made its "resumability" impossible to check.
    sequence: state.sequence,
    pendingSeat: state.pending?.seat ?? null,
    pendingTask: state.pending?.kind ?? null,
    stateFingerprint: fingerprintDigest(state),

    pauseReason: input.pauseReason,
    detail: input.detail ?? {},
    config: redactConfig(input.config),
  };
}

export function serialiseCheckpoint(checkpoint: PrivateCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

export class CheckpointError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CheckpointError";
  }
}

/** Parse and shape-check. Says which field is wrong rather than "invalid". */
export function parseCheckpoint(text: string): PrivateCheckpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CheckpointError("unparseable", "检查点不是合法 JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new CheckpointError("unparseable", "检查点不是一个对象");
  }
  const cell = raw as Record<string, unknown>;

  if (cell.schema !== CHECKPOINT_SCHEMA) {
    throw new CheckpointError(
      "schema_mismatch",
      `检查点 schema 是 ${String(cell.schema)}，这个版本只认 ${CHECKPOINT_SCHEMA}`,
    );
  }
  if (cell.containsPrivateInformation !== true) {
    throw new CheckpointError("not_private", "这不是一份私有检查点");
  }
  if (!Array.isArray(cell.actions)) {
    throw new CheckpointError("bad_actions", "检查点里没有 actions 数组");
  }
  if (typeof cell.seed !== "number" || !Number.isInteger(cell.seed)) {
    throw new CheckpointError("bad_seed", "检查点里的 seed 不是整数");
  }
  asGameId(cell.gameId);
  return cell as unknown as PrivateCheckpoint;
}

/* ── Resuming ──────────────────────────────────────────────────────────── */

export interface ResumeContext {
  readonly config: SimConfig;
  readonly personaMode: PersonaMode;
  readonly personaAssignment: Readonly<Record<Seat, { readonly id: string }>>;
  readonly strategyId: StrategyId;
  readonly customStrategyText?: string;
  readonly maxOutputTokens: number;
  readonly cognitionEnabled: boolean;
}

export interface Resumed {
  readonly state: GameState;
  readonly actions: readonly RecordedAction[];
  readonly modelAttempts: readonly ModelAttempt[];
  readonly ledger: LedgerState;
  readonly cognition: CognitionStoreState | null;
  readonly cognitionReports: readonly CognitionReport[];
}

/**
 * Rebuild the position and refuse anything that does not match.
 *
 * Every check below stops the resume BEFORE a request is sent. They are
 * ordered cheapest-first, but the order that matters is that all of them
 * happen before the network is touched at all.
 */
export function resumeFromCheckpoint(
  checkpoint: PrivateCheckpoint,
  context: ResumeContext,
): Resumed {
  const { config } = context;
  const refuse = (code: string, message: string): never => {
    throw new CheckpointError(code, message);
  };

  /* 1. Versions. A game half-played under a different prompt is two games. */
  if (checkpoint.promptVersion !== config.promptVersion) {
    refuse(
      "prompt_version_mismatch",
      `检查点的 promptVersion 是 ${checkpoint.promptVersion}，当前是 ${config.promptVersion}`,
    );
  }
  if (checkpoint.simulatorVersion !== config.simulatorVersion) {
    refuse(
      "simulator_version_mismatch",
      `检查点的 simulatorVersion 是 ${checkpoint.simulatorVersion}，当前是 ${config.simulatorVersion}`,
    );
  }

  /* 2. The model and how hard it was asked to think. */
  if (checkpoint.config.model.id !== config.model.id) {
    refuse(
      "model_mismatch",
      `检查点跑的是 ${checkpoint.config.model.id}，现在配置的是 ${config.model.id}`,
    );
  }
  if (checkpoint.config.model.reasoningEffort !== config.model.reasoningEffort) {
    refuse(
      "effort_mismatch",
      `检查点的 reasoning effort 是 ${checkpoint.config.model.reasoningEffort}，现在是 ${config.model.reasoningEffort}`,
    );
  }

  /* 3. The experiment arms, including the exact seat→persona mapping. */
  if (checkpoint.personaMode !== context.personaMode) {
    refuse(
      "persona_mode_mismatch",
      `检查点的 persona 模式是 ${checkpoint.personaMode}，现在是 ${context.personaMode}`,
    );
  }
  for (const entry of checkpoint.personaAssignment) {
    const now = context.personaAssignment[entry.seat]?.id;
    if (now !== entry.persona) {
      refuse(
        "persona_assignment_mismatch",
        `${entry.seat}号 的 persona 从 ${entry.persona} 变成了 ${String(now)}`,
      );
    }
  }
  if (checkpoint.strategyId !== context.strategyId) {
    refuse(
      "strategy_mismatch",
      `检查点的策略档是 ${checkpoint.strategyId}，现在是 ${context.strategyId}`,
    );
  }
  if ((checkpoint.customStrategyText ?? null) !== (context.customStrategyText ?? null)) {
    refuse("custom_strategy_mismatch", "自定义策略文本和检查点里的不一样");
  }
  const checkpointCognition = checkpoint.cognitionConfig?.enabled === true;
  if (checkpointCognition !== context.cognitionEnabled) {
    refuse(
      "cognition_mismatch",
      `检查点是${checkpointCognition ? "开着" : "关着"}认知层跑的，现在是${context.cognitionEnabled ? "开着" : "关着"}。` +
        `两套提示栈不能拼成一局 —— 请开新的一局。`,
    );
  }
  if (checkpoint.maxOutputTokens !== context.maxOutputTokens) {
    // Not a knob to turn mid-game. Raising the cap is the right response to an
    // exhausted budget, but it starts a NEW experiment — a game whose first
    // half thought within 2000 tokens and whose second half had 6000 is not a
    // game anybody can draw a conclusion from.
    refuse(
      "max_output_tokens_mismatch",
      `检查点的 maxOutputTokens 是 ${checkpoint.maxOutputTokens}，现在是 ${context.maxOutputTokens}。` +
        `改这个值等于换了实验，请开新的一局，不要续这份检查点。`,
    );
  }

  /* 4. Pricing. Resuming with a different price table would make one game's
        cost the sum of two different accountings. */
  if (!config.pricing.configured) {
    refuse("pricing_unconfigured", "价格未配置，预算闸看不见东西，拒绝续跑");
  }
  if (checkpoint.config.pricing.pricingVersion !== config.pricing.pricingVersion) {
    refuse(
      "pricing_version_mismatch",
      `检查点按 ${checkpoint.config.pricing.pricingVersion} 计价，现在是 ${config.pricing.pricingVersion}`,
    );
  }

  /* 5. Rebuild, then check the position really is the one that was saved. */
  const state = replayPrefix(checkpoint.seed, checkpoint.actions, {
    config,
    gameId: checkpoint.gameId,
    runId: checkpoint.runId,
  });

  if (state.sequence !== checkpoint.sequence) {
    refuse(
      "sequence_mismatch",
      `重建后 sequence 是 ${state.sequence}，检查点写的是 ${checkpoint.sequence}`,
    );
  }
  if ((state.pending?.seat ?? null) !== checkpoint.pendingSeat) {
    refuse(
      "pending_seat_mismatch",
      `重建后轮到 ${String(state.pending?.seat)}，检查点写的是 ${String(checkpoint.pendingSeat)}`,
    );
  }
  if ((state.pending?.kind ?? null) !== checkpoint.pendingTask) {
    refuse(
      "pending_task_mismatch",
      `重建后要的是 ${String(state.pending?.kind)}，检查点写的是 ${String(checkpoint.pendingTask)}`,
    );
  }
  const digest = fingerprintDigest(state);
  if (digest !== checkpoint.stateFingerprint) {
    // The catch-all. If the referee changed in any way the four checks above
    // did not notice, the reconstructed game is a different game.
    refuse(
      "fingerprint_mismatch",
      `重建出来的局面和检查点对不上（${digest.slice(0, 12)}… vs ${checkpoint.stateFingerprint.slice(0, 12)}…）`,
    );
  }
  if (!state.pending) {
    refuse("already_finished", "这份检查点里的对局已经打完了，没有可以续的地方");
  }

  return {
    state,
    actions: checkpoint.actions,
    modelAttempts: checkpoint.modelAttempts,
    ledger: checkpoint.ledger,
    cognition: checkpoint.cognition,
    cognitionReports: checkpoint.cognitionReports ?? [],
  };
}

/** A stable id for a checkpoint file, for logs. Not a secret. */
export function checkpointDigest(checkpoint: PrivateCheckpoint): string {
  return createHash("sha256")
    .update(`${checkpoint.gameId}:${checkpoint.sequence}:${checkpoint.stateFingerprint}`)
    .digest("hex")
    .slice(0, 16);
}
