/**
 * Configuration: validated, versioned, and never hard-coded at a call site.
 *
 * The model id and its parameters are the whole reason this file exists. A
 * literal "gpt-5.6-terra" buried in a request builder is how a research run
 * becomes unreproducible — six weeks later nobody can say which model produced
 * a table. Everything that could change an answer lives here, gets stamped
 * into the run manifest, and moves `simulatorVersion` when it moves. Same
 * argument `src/lib/decision/config.ts` makes for the frozen algorithm's
 * constants.
 *
 * The budget section is CONFIGURATION AND VALIDATION ONLY at this milestone.
 * Nothing here bills anything, counts a token or opens a socket; the numbers
 * exist so that the ceilings are agreed on before the first request is ever
 * built, rather than discovered from an invoice.
 *
 * Validation is hand-written. Adding a schema library for two dozen fields
 * would put a dependency in `package.json` for a research tool, and this repo
 * has exactly npm with a short dependency list; that is a trade worth not
 * making.
 */

import defaults from "./default.json";
import m5Pilot from "./m5-pilot.json";
import m51Pilot from "./m5-1-pilot.json";
import m52Pilot from "./m5-2-pilot.json";
import m53Pilot from "./m5-3-pilot.json";
import m53Terra from "./m5-3-terra-pilot.json";
import m53Luna from "./m5-3-luna-pilot.json";
import m54Pilot from "./m5-4-pilot.json";
import m55Pilot from "./m5-5-pilot.json";
import type { PersonaMode } from "../prompts/personas";
import { CATALOG_IDS, type CatalogStrategyId } from "../prompts/strategies";
import {
  COGNITIVE_VERSIONS,
  PROMPT_VERSION_COGNITIVE,
  PROMPT_VERSION_COGNITIVE_V2,
  PROMPT_VERSION_CONTEST,
  PROMPT_VERSION_DISCLOSURE,
  PROMPT_VERSION_LEGACY,
  PROMPT_VERSION_M54,
  PROMPT_VERSION_M55,
} from "../prompts/version";

/** How hard the model is asked to think. Passed through to the provider later. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

export interface ModelConfig {
  /** Never defaulted at a call site. A request builder must read it from here. */
  readonly id: string;
  readonly reasoningEffort: ReasoningEffort;
  /**
   * Whatever else the provider takes. Passed through untouched, because which
   * knobs exist is a provider question and `/api/ai` already learned that the
   * hard way — it sends none of them.
   */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The M5 cognition layer. OFF by default, and off means the old path.
 *
 * Opt-in rather than a flag day, because Experiments 2 and 3 must stay
 * reproducible byte for byte: a config that does not mention cognition builds
 * exactly the seven-layer `prompt-0.2.0` stack it always did.
 *
 * The version coupling is VALIDATED rather than derived — `readCognition`
 * refuses a config whose `promptVersion` disagrees with `enabled`. Deriving it
 * would let a run silently change stacks when somebody edited one field; a
 * refusal makes the operator state both and mean it.
 */
export interface CognitionConfig {
  readonly enabled: boolean;
  /**
   * `fused` is the only implemented mode. `two-pass-critical` is designed
   * (`cognition/modes.ts`) and deliberately not reachable from here yet.
   */
  readonly mode: "fused";
  /** Repair attempts allowed for a malformed cognition block, before failing. */
  readonly maxCognitionRepairs: number;
  /** Record per-field utilisation in the private trace. Private only. */
  readonly telemetry: boolean;
}

/**
 * One stage's model, provider-neutral, and every field optional.
 *
 * `null` means INHERIT from `model` / `limits`. That is not laziness: a
 * default that silently pins the planner to today's model id would make a
 * profile written now unreproducible the moment the top-level model changed,
 * and a required field would force every profile to restate three values it
 * does not care about. Inheritance keeps a one-model run a one-line config and
 * makes a hybrid run state exactly what differs.
 *
 * NOTHING HERE NAMES A PROVIDER. A stage is a model id, an effort and a cap;
 * which vendor serves it is `model/openai-responses.ts`'s problem, and a
 * config that hard-coded a second vendor would have to be edited to run the
 * comparison it exists to describe.
 */
export interface StageModelConfig {
  /** Model id, or null to inherit `model.id`. */
  readonly model: string | null;
  /** Reasoning effort, or null to inherit `model.reasoningEffort`. */
  readonly reasoningEffort: ReasoningEffort | null;
  /** Output cap including reasoning, or null to inherit `limits.maxOutputTokens`. */
  readonly maxOutputTokens: number | null;
}

/**
 * The two-stage split. Inert unless `promptVersion` separates the stages.
 *
 * `maxPublicMessageRepairs` bounds the ONE retry loop that exists here: a
 * spokesperson whose sentence the firewall refused. It is deliberately small.
 * A spokesperson that leaks twice from a prompt containing no secrets is not
 * a wording problem, it is a signal that something upstream is wrong, and
 * grinding through ten identical retries would spend money hiding it.
 */
export interface StagesConfig {
  readonly planner: StageModelConfig;
  readonly spokesperson: StageModelConfig;
  readonly maxPublicMessageRepairs: number;
}

export interface LimitsConfig {
  /**
   * The hard ceiling on a single model request's input.
   *
   * See `core/input-limit.ts` for what happens at the boundary. It is a
   * configuration field AND a constant because the constant is the contract
   * and the field is the dial: a run may lower it, never raise it.
   */
  readonly maxStandardInputTokens: number;
  /**
   * The cap on a single model request's OUTPUT, reasoning tokens included.
   *
   * Configuration rather than a constant because it is the most decisive dial
   * in a live run and it belongs in the artifact. The first paid game died on
   * a hard-coded 2000: with `reasoning.effort: "high"` the model spent the
   * whole budget thinking and returned zero visible text, nine times. That
   * number appeared nowhere in the produced artifacts, so the run's single
   * most important parameter could not be read off its own record.
   *
   * Not to be confused with `smoke.maxOutputTokens`, which bounds the tiny
   * one-request smoke test and is deliberately a different, much smaller
   * number.
   */
  readonly maxOutputTokens: number;
  /** Non-whitespace Unicode characters allowed in one public speech. */
  readonly speechCharLimit: number;
  /** Runaway guard for the referee loop. A game that will not end is a bug. */
  readonly maxActionsPerGame: number;
  /**
   * Cap on LIVE model calls in one game.
   *
   * A ten-player game is roughly a hundred and fifty decisions before retries,
   * so this leaves room for repair attempts without letting a pathological
   * loop spend a batch's budget on one table.
   */
  readonly maxLiveCallsPerGame: number;
}

/**
 * Money. Warn, then stop.
 *
 * Two separate numbers per game on purpose: the warning is for a human
 * watching a batch, the hard limit is for the machine. Collapsing them would
 * mean either being interrupted at every expensive game or discovering the
 * overrun only afterwards.
 */
export interface BudgetConfig {
  readonly costWarningPerGameUsd: number;
  readonly hardCostLimitPerGameUsd: number;
  readonly hardBatchCostLimitUsd: number;
}

/**
 * What the provider charges, and where that number came from.
 *
 * The provenance fields are not decoration. A cost figure in a research trace
 * is only checkable if the reader can see which price list produced it and
 * when it was read — prices change, and a run costed against last quarter's
 * table is a run whose dollar figures quietly mean something else.
 *
 * `cachedInputUsdPerMTok` is separate because cached input is an order of
 * magnitude cheaper, and this simulator re-sends a long static prefix on every
 * turn. Pricing all input as uncached would over-state the bill enough to trip
 * a ceiling that was never really reached; pricing it all as cached would
 * under-state it enough to sail past one that was.
 *
 * `configured: false` remains legal and makes `estimateCostUsd` return null.
 * A budget computed from a made-up price is not a budget — the app's own
 * `.env.example` says the same thing: 「算不出花了多少钱的预算不叫预算」.
 */
export interface PricingConfig {
  readonly configured: boolean;
  /** Which model this table is for. Checked against `model.id` at load. */
  readonly modelId: string;
  readonly sourceUrl: string;
  /** ISO date the price list was read. */
  readonly verifiedOn: string;
  readonly pricingVersion: string;
  readonly uncachedInputUsdPerMTok: number;
  readonly cachedInputUsdPerMTok: number;
  /** Output, INCLUDING reasoning tokens. */
  readonly outputUsdPerMTok: number;
}

/**
 * The one-request connectivity check.
 *
 * The ceiling is real rather than aspirational because the worst case is
 * computed BEFORE sending, from `maxOutputTokens` and a deliberately
 * PESSIMISTIC rate — see `model/pricing.ts`. Those two rates are not a price
 * list and must never be used as one; their only job is to make "at most ten
 * cents" a bound instead of a hope.
 */
export interface SmokeConfig {
  readonly ceilingUsd: number;
  readonly maxOutputTokens: number;
  /** Generous stand-in for the tiny prompt's input size. */
  readonly assumedInputTokens: number;
  readonly pessimisticInputUsdPerMTok: number;
  readonly pessimisticOutputUsdPerMTok: number;
}

/** Which experiment arms this run is in. Recorded in both manifests. */
export interface ExperimentConfig {
  readonly personaMode: PersonaMode;
  readonly strategyProfile: CatalogStrategyId;
}

export interface RunConfig {
  readonly concurrency: number;
  readonly maxRetries: number;
}

export interface SimConfig {
  readonly simulatorVersion: string;
  readonly promptVersion: string;
  readonly playerCount: 10;
  readonly model: ModelConfig;
  readonly limits: LimitsConfig;
  readonly cognition: CognitionConfig;
  readonly stages: StagesConfig;
  readonly budget: BudgetConfig;
  readonly pricing: PricingConfig;
  readonly smoke: SmokeConfig;
  readonly experiment: ExperimentConfig;
  readonly run: RunConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireInt(
  value: unknown,
  path: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`${path} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${path} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function requireMoney(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${path} must be a positive number of USD`);
  }
  return value;
}

function requireEffort(value: unknown, path: string): ReasoningEffort {
  if (typeof value !== "string" || !REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    throw new ConfigError(`${path} must be one of ${REASONING_EFFORTS.join(", ")}`);
  }
  return value as ReasoningEffort;
}

/** Merge one level into a known section. Unknown keys are rejected, not ignored. */
function section(
  base: Record<string, unknown>,
  override: unknown,
  path: string,
): Record<string, unknown> {
  if (override === undefined) return base;
  const patch = requireObject(override, path);
  for (const key of Object.keys(patch)) {
    if (!(key in base)) throw new ConfigError(`${path}.${key} is not a known setting`);
  }
  return { ...base, ...patch };
}

export type SimConfigOverrides = {
  readonly simulatorVersion?: string;
  readonly promptVersion?: string;
  readonly model?: Partial<ModelConfig>;
  readonly limits?: Partial<LimitsConfig>;
  readonly cognition?: Partial<CognitionConfig>;
  readonly stages?: Partial<StagesConfig>;
  readonly budget?: Partial<BudgetConfig>;
  readonly pricing?: Partial<PricingConfig>;
  readonly smoke?: Partial<SmokeConfig>;
  readonly experiment?: Partial<ExperimentConfig>;
  readonly run?: Partial<RunConfig>;
};

/**
 * Resolve the shipped defaults against an override object.
 *
 * `playerCount` is deliberately not overridable: the whole simulator is fixed
 * to the ten-player line-up for phase one, and a config that could quietly say
 * 7 would produce a deal that `assertMatchesRepoRules` then rejects anyway,
 * several frames away from the mistake.
 */
/**
 * Named configuration profiles, layered over `default.json`.
 *
 * A profile exists so that running an experiment never requires EDITING the
 * baseline. `default.json` is what makes Experiments 2 and 3 reproducible from
 * a checkout; a temporary edit to run a pilot would quietly break that, and the
 * breakage would only show up months later when somebody tried to rebuild one.
 *
 * Profiles are files rather than flag bundles for the same reason the config
 * exists at all: an arm nobody can read off the repository is an arm nobody can
 * check. `--profile m5-pilot` names a committed file; a reviewer can diff it.
 */
export const PROFILES = {
  "m5-pilot": m5Pilot as unknown as Record<string, unknown>,
  "m5-1-pilot": m51Pilot as unknown as Record<string, unknown>,
  "m5-2-pilot": m52Pilot as unknown as Record<string, unknown>,
  "m5-3-pilot": m53Pilot as unknown as Record<string, unknown>,
  "m5-3-terra-pilot": m53Terra as unknown as Record<string, unknown>,
  "m5-3-luna-pilot": m53Luna as unknown as Record<string, unknown>,
  "m5-4-pilot": m54Pilot as unknown as Record<string, unknown>,
  "m5-5-pilot": m55Pilot as unknown as Record<string, unknown>,
} as const;

export type ProfileName = keyof typeof PROFILES;

export const PROFILE_NAMES: readonly ProfileName[] = [
  "m5-pilot",
  "m5-1-pilot",
  "m5-2-pilot",
  "m5-3-pilot",
  "m5-3-terra-pilot",
  "m5-3-luna-pilot",
  "m5-4-pilot",
  "m5-5-pilot",
];

/**
 * Which profile a run should use, given the flag and the checkpoint.
 *
 * THE ONE PLACE THAT DECIDES, so the rule cannot be half-applied. It exists
 * because of a real near miss: resuming the completed M5.2 pilot without
 * `--profile` fell back to `default.json` — a different prompt version, a
 * different strategy arm, a different output ceiling. Nothing was damaged
 * because the checkpoint was cognitive and `resumeFromCheckpoint` refused on
 * `prompt_version_mismatch` before any request left. A `prompt-0.2.0`
 * checkpoint resumed the same way would have passed every gate.
 *
 * THE RULE:
 *
 *   fresh run, no flag        →  `default.json`, exactly as before
 *   fresh run, flag           →  that profile
 *   resume, flag              →  that profile, but it must MATCH the checkpoint
 *   resume, no flag, recorded →  the recorded one, and say so out loud
 *   resume, no flag, absent   →  REFUSE
 *
 * The last line is the point. A checkpoint written before `profile` existed
 * records `null`, and `null` is indistinguishable from "this game really was
 * started under default.json". Guessing between those two is exactly the
 * failure this function exists to prevent, so it does not guess.
 */
export type ResumeProfileResolution =
  | { readonly ok: true; readonly profile: ProfileName | null; readonly derived: boolean }
  | { readonly ok: false; readonly error: string };

export function resolveProfileForResume(input: {
  readonly flag: ProfileName | null;
  /** Null for a fresh run. `{profile: null}` for a checkpoint that records none. */
  readonly checkpoint: { readonly profile: string | null } | null;
  /**
   * `--profile-default`: the operator asserts this game really was started
   * under `default.json`.
   *
   * An explicit opt-in rather than the default behaviour, which is the whole
   * fix: the dangerous version of this is the one nobody had to type.
   */
  readonly allowDefault?: boolean;
}): ResumeProfileResolution {
  const { flag, checkpoint } = input;

  if (!checkpoint) return { ok: true, profile: flag, derived: false };

  const recorded = checkpoint.profile;

  if (flag !== null) {
    if (recorded !== null && recorded !== flag) {
      return {
        ok: false,
        error:
          `检查点是用 profile ${recorded} 跑的，命令行给的是 ${flag}。` +
          `一局游戏不能拆成两个 profile —— 用 --profile ${recorded} 续跑，或者开新的一局。`,
      };
    }
    return { ok: true, profile: flag, derived: false };
  }

  if (recorded === null) {
    if (input.allowDefault === true) return { ok: true, profile: null, derived: false };
    return {
      ok: false,
      error:
        "续跑没有给 --profile，而这个检查点里也没有记录 profile（它是加这个字段之前写的）。" +
        `拒绝续跑：不给 --profile 会退回 default.json（${PROMPT_VERSION_LEGACY} + baseline），` +
        "那是另一条实验臂，而「没记录」和「本来就是 default.json」在这里分不出来。" +
        `请显式给出 --profile（${PROFILE_NAMES.join(" / ")}）；` +
        "如果这一局确实是 default.json 跑的，用 --profile-default 明说。",
    };
  }

  if (!isProfileName(recorded)) {
    return {
      ok: false,
      error:
        `检查点记录的 profile 是 ${recorded}，这个版本不认识它。` +
        `已知的是 ${PROFILE_NAMES.join(" / ")}。`,
    };
  }

  return { ok: true, profile: recorded, derived: true };
}

export function isProfileName(name: string): name is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(name);
}

/**
 * Turn a profile file into overrides.
 *
 * `$comment` keys are stripped: they are documentation for a human reading the
 * profile, and a validator that met one would report a field nobody set.
 */
function profileOverrides(raw: Record<string, unknown>): SimConfigOverrides {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$comment") continue;
      out[key] = strip(child);
    }
    return out;
  };
  return strip(raw) as SimConfigOverrides;
}

/**
 * Load a named profile, with caller overrides applied on top.
 *
 * The combination checks live in `loadConfig` (version vs cognition) and in
 * `assertProfileCoherent` below. Both run here, so a bad profile fails at load
 * rather than three hundred requests into a paid game.
 */
export function loadProfile(
  name: ProfileName,
  overrides: SimConfigOverrides = {},
): SimConfig {
  const base = profileOverrides(PROFILES[name]);
  const merged: SimConfigOverrides = {
    ...base,
    ...overrides,
    ...(base.cognition || overrides.cognition
      ? { cognition: { ...base.cognition, ...overrides.cognition } }
      : {}),
    ...(base.stages || overrides.stages
      ? { stages: { ...base.stages, ...overrides.stages } }
      : {}),
    ...(base.limits || overrides.limits
      ? { limits: { ...base.limits, ...overrides.limits } }
      : {}),
    ...(base.experiment || overrides.experiment
      ? { experiment: { ...base.experiment, ...overrides.experiment } }
      : {}),
    ...(base.model || overrides.model
      ? { model: { ...base.model, ...overrides.model } }
      : {}),
    ...(base.pricing || overrides.pricing
      ? { pricing: { ...base.pricing, ...overrides.pricing } }
      : {}),
    ...(base.budget || overrides.budget
      ? { budget: { ...base.budget, ...overrides.budget } }
      : {}),
    ...(base.run || overrides.run ? { run: { ...base.run, ...overrides.run } } : {}),
  };
  const config = loadConfig(merged);
  assertProfileCoherent(name, config);
  return config;
}

/**
 * Combination checks a per-field validator cannot express.
 *
 * Each of these is a pairing that would produce a run whose artifacts describe
 * something other than what happened — the failure mode this whole file exists
 * to prevent.
 */
/** Which strategy arm belongs to which cognitive prompt version. */
const ARM_FOR_VERSION: Readonly<Record<string, CatalogStrategyId>> = {
  [PROMPT_VERSION_COGNITIVE]: "expert-cognitive",
  [PROMPT_VERSION_COGNITIVE_V2]: "expert-social",
  [PROMPT_VERSION_CONTEST]: "expert-claim-contest",
  [PROMPT_VERSION_DISCLOSURE]: "expert-disclosure-safe",
  [PROMPT_VERSION_M54]: "expert-disciplined",
  // 0.7.0 keeps M5.4's arm on purpose. M5.5 changes what the prompts ASK
  // and what the checks REFUSE; the strategy text is byte-identical, so a
  // new arm id would claim a difference that does not exist.
  [PROMPT_VERSION_M55]: "expert-disciplined",
};

export function assertProfileCoherent(name: string, config: SimConfig): void {
  const arm = config.experiment.strategyProfile;
  const cognitiveArms = Object.values(ARM_FOR_VERSION);

  // The cognitive arms are written against a ledger in the prompt and a
  // `cognition` block in the answer. On the legacy stack their obligations
  // would be advice the model has nowhere to record.
  if (cognitiveArms.includes(arm) && !config.cognition.enabled) {
    throw new ConfigError(
      `${name}: 策略档 ${arm} 需要 cognition.enabled=true。` +
        `它的「必须看到」是靠 cognition 块记录的，旧路径没有那个字段。`,
    );
  }
  // And the reverse: the two frozen arms are what Experiments 2 and 3 ran, on
  // the legacy stack. Running one under cognition would produce a third thing
  // wearing a recorded name.
  if (config.cognition.enabled && !cognitiveArms.includes(arm)) {
    throw new ConfigError(
      `${name}: cognition 开着时策略档只能是 ${cognitiveArms.join(" 或 ")}，现在是 ${arm}。` +
        `baseline 与 community-meta 是实验 2 / 3 的历史臂，不要在新提示栈下重跑同名的东西。`,
    );
  }
  if (config.cognition.enabled) {
    const expected = ARM_FOR_VERSION[config.promptVersion];
    if (!expected) {
      throw new ConfigError(
        `${name}: cognition 开着但 promptVersion 是 ${config.promptVersion}`,
      );
    }
    // The pairing is one-to-one on purpose. `expert-social` asks the model to
    // fill a `social` block that only the 0.3.1 schema carries, and
    // `expert-cognitive` under 0.3.1 would be the completed pilot's arm running
    // against a different prompt stack — a fourth thing wearing a third name.
    if (arm !== expected) {
      throw new ConfigError(
        `${name}: promptVersion ${config.promptVersion} 配的策略档是 ${expected}，现在是 ${arm}。` +
          `已经打完的那局用的是 ${PROMPT_VERSION_COGNITIVE} + expert-cognitive，不要拆开重组。`,
      );
    }
  }
}

export function loadConfig(overrides: SimConfigOverrides = {}): SimConfig {
  const raw = defaults as unknown as Record<string, unknown>;

  const model = section(requireObject(raw.model, "model"), overrides.model, "model");
  const limits = section(requireObject(raw.limits, "limits"), overrides.limits, "limits");
  const cognition = section(
    requireObject(raw.cognition ?? {}, "cognition"),
    overrides.cognition,
    "cognition",
  );
  const stages = section(
    requireObject(raw.stages ?? {}, "stages"),
    overrides.stages,
    "stages",
  );
  const budget = section(requireObject(raw.budget, "budget"), overrides.budget, "budget");
  const pricing = section(requireObject(raw.pricing, "pricing"), overrides.pricing, "pricing");
  const smoke = section(requireObject(raw.smoke, "smoke"), overrides.smoke, "smoke");
  const experiment = section(
    requireObject(raw.experiment, "experiment"),
    overrides.experiment,
    "experiment",
  );
  const run = section(requireObject(raw.run, "run"), overrides.run, "run");

  const playerCount = requireInt(raw.playerCount, "playerCount", { min: 10, max: 10 });
  if (playerCount !== 10) throw new ConfigError("this simulator is fixed at 10 players");

  const costWarningPerGameUsd = requireMoney(
    budget.costWarningPerGameUsd,
    "budget.costWarningPerGameUsd",
  );
  const hardCostLimitPerGameUsd = requireMoney(
    budget.hardCostLimitPerGameUsd,
    "budget.hardCostLimitPerGameUsd",
  );
  const hardBatchCostLimitUsd = requireMoney(
    budget.hardBatchCostLimitUsd,
    "budget.hardBatchCostLimitUsd",
  );

  // A warning that fires at or after the stop is not a warning, and a batch
  // ceiling below one game's ceiling can never be respected by both.
  if (costWarningPerGameUsd >= hardCostLimitPerGameUsd) {
    throw new ConfigError(
      "budget.costWarningPerGameUsd must be below budget.hardCostLimitPerGameUsd",
    );
  }
  if (hardCostLimitPerGameUsd > hardBatchCostLimitUsd) {
    throw new ConfigError(
      "budget.hardCostLimitPerGameUsd must not exceed budget.hardBatchCostLimitUsd",
    );
  }

  return {
    simulatorVersion: requireString(
      overrides.simulatorVersion ?? raw.simulatorVersion,
      "simulatorVersion",
    ),
    promptVersion: requireString(
      overrides.promptVersion ?? raw.promptVersion,
      "promptVersion",
    ),
    playerCount: 10,
    model: {
      id: requireString(model.id, "model.id"),
      reasoningEffort: requireEffort(model.reasoningEffort, "model.reasoningEffort"),
      params: requireObject(model.params ?? {}, "model.params"),
    },
    limits: {
      // Never raised above the contract in `core/input-limit.ts`.
      maxStandardInputTokens: requireInt(
        limits.maxStandardInputTokens,
        "limits.maxStandardInputTokens",
        { min: 1, max: 250_000 },
      ),
      // Reasoning tokens are drawn from this same budget, so a value that
      // merely fits the answer is not enough — it has to fit the thinking too.
      maxOutputTokens: requireInt(limits.maxOutputTokens, "limits.maxOutputTokens", {
        min: 1,
        max: 200_000,
      }),
      speechCharLimit: requireInt(limits.speechCharLimit, "limits.speechCharLimit", {
        min: 1,
        max: 10_000,
      }),
      maxActionsPerGame: requireInt(
        limits.maxActionsPerGame,
        "limits.maxActionsPerGame",
        { min: 100 },
      ),
      maxLiveCallsPerGame: requireInt(
        limits.maxLiveCallsPerGame,
        "limits.maxLiveCallsPerGame",
        { min: 1, max: 100_000 },
      ),
    },
    // The RESOLVED version, so an override is gated too. Reading the raw JSON
    // here would let `loadConfig({promptVersion, cognition})` slip past the
    // check that exists to keep the two stacks apart.
    cognition: readCognition(
      cognition,
      requireString(overrides.promptVersion ?? raw.promptVersion, "promptVersion"),
    ),
    stages: readStages(stages),
    budget: { costWarningPerGameUsd, hardCostLimitPerGameUsd, hardBatchCostLimitUsd },
    pricing: readPricing(pricing, requireString(model.id, "model.id")),
    smoke: readSmoke(smoke),
    experiment: readExperiment(experiment),
    run: {
      concurrency: requireInt(run.concurrency, "run.concurrency", { min: 1, max: 64 }),
      maxRetries: requireInt(run.maxRetries, "run.maxRetries", { min: 0, max: 10 }),
    },
  };
}

function readStage(value: unknown, path: string): StageModelConfig {
  const raw = value === undefined ? {} : requireObject(value, path);
  for (const key of Object.keys(raw)) {
    if (!["model", "reasoningEffort", "maxOutputTokens"].includes(key)) {
      throw new ConfigError(`${path}.${key} is not a known setting`);
    }
  }
  return {
    model:
      raw.model === undefined || raw.model === null
        ? null
        : requireString(raw.model, `${path}.model`),
    reasoningEffort:
      raw.reasoningEffort === undefined || raw.reasoningEffort === null
        ? null
        : requireEffort(raw.reasoningEffort, `${path}.reasoningEffort`),
    maxOutputTokens:
      raw.maxOutputTokens === undefined || raw.maxOutputTokens === null
        ? null
        : requireInt(raw.maxOutputTokens, `${path}.maxOutputTokens`, { min: 1, max: 200_000 }),
  };
}

function readStages(raw: Record<string, unknown>): StagesConfig {
  return {
    planner: readStage(raw.planner, "stages.planner"),
    spokesperson: readStage(raw.spokesperson, "stages.spokesperson"),
    maxPublicMessageRepairs: requireInt(
      raw.maxPublicMessageRepairs ?? 1,
      "stages.maxPublicMessageRepairs",
      { min: 0, max: 5 },
    ),
  };
}

/** The effective model, effort and cap for one stage. Inheritance resolved. */
export function resolveStage(
  config: SimConfig,
  stage: "planner" | "spokesperson",
): { readonly model: string; readonly reasoningEffort: ReasoningEffort; readonly maxOutputTokens: number } {
  const s = config.stages[stage];
  return {
    model: s.model ?? config.model.id,
    reasoningEffort: s.reasoningEffort ?? config.model.reasoningEffort,
    maxOutputTokens: s.maxOutputTokens ?? config.limits.maxOutputTokens,
  };
}

function requireRate(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${path} must be a non-negative USD-per-million-tokens rate`);
  }
  return value;
}

const PERSONA_MODE_VALUES: readonly string[] = [
  "homogeneous-neutral",
  "heterogeneous-rotated",
];
// Derived from the catalog rather than repeated, so adding an arm cannot
// leave a config validator that silently refuses it.
const STRATEGY_VALUES: readonly string[] = CATALOG_IDS;

function readExperiment(raw: Record<string, unknown>): ExperimentConfig {
  const personaMode = requireString(raw.personaMode, "experiment.personaMode");
  if (!PERSONA_MODE_VALUES.includes(personaMode)) {
    throw new ConfigError(
      `experiment.personaMode must be one of ${PERSONA_MODE_VALUES.join(", ")}`,
    );
  }
  const strategyProfile = requireString(raw.strategyProfile, "experiment.strategyProfile");
  // `custom` is built per run from experimenter text, so it is not selectable
  // here — a config naming it would have nothing to build it from.
  if (!STRATEGY_VALUES.includes(strategyProfile)) {
    throw new ConfigError(
      `experiment.strategyProfile must be one of ${STRATEGY_VALUES.join(", ")}`,
    );
  }
  return {
    personaMode: personaMode as PersonaMode,
    strategyProfile: strategyProfile as CatalogStrategyId,
  };
}

function readPricing(raw: Record<string, unknown>, modelId: string): PricingConfig {
  if (typeof raw.configured !== "boolean") {
    throw new ConfigError("pricing.configured must be a boolean");
  }
  const uncachedInputUsdPerMTok = requireRate(
    raw.uncachedInputUsdPerMTok,
    "pricing.uncachedInputUsdPerMTok",
  );
  const cachedInputUsdPerMTok = requireRate(
    raw.cachedInputUsdPerMTok,
    "pricing.cachedInputUsdPerMTok",
  );
  const outputUsdPerMTok = requireRate(raw.outputUsdPerMTok, "pricing.outputUsdPerMTok");

  if (raw.configured) {
    // Saying "configured" while leaving a rate at zero would produce a budget
    // that can never be exceeded — the exact failure this flag exists to prevent.
    if (uncachedInputUsdPerMTok <= 0 || outputUsdPerMTok <= 0) {
      throw new ConfigError("pricing.configured is true but a rate is still zero");
    }
    if (cachedInputUsdPerMTok > uncachedInputUsdPerMTok) {
      throw new ConfigError("cached input cannot cost more than uncached input");
    }
    // A price table for a different model is worse than none: every figure in
    // the trace would be confidently wrong.
    const pricedModel = requireString(raw.modelId, "pricing.modelId");
    if (pricedModel !== modelId) {
      throw new ConfigError(
        `pricing.modelId is "${pricedModel}" but model.id is "${modelId}"`,
      );
    }
  }

  return {
    configured: raw.configured,
    modelId: typeof raw.modelId === "string" ? raw.modelId : "",
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
    verifiedOn: typeof raw.verifiedOn === "string" ? raw.verifiedOn : "",
    pricingVersion: typeof raw.pricingVersion === "string" ? raw.pricingVersion : "",
    uncachedInputUsdPerMTok,
    cachedInputUsdPerMTok,
    outputUsdPerMTok,
  };
}

/**
 * Cognition, plus the version gate that keeps the two stacks apart.
 *
 * The refusal is the point. `prompt-0.2.0` means seven layers and no ledger;
 * `prompt-0.3.0` means the cognition stack. A config claiming one while
 * running the other would produce an artifact whose recorded version does not
 * describe the prompts that generated it — and every comparison downstream
 * would be against a label rather than a build.
 */
function readCognition(
  raw: Record<string, unknown>,
  promptVersion: string,
): CognitionConfig {
  const enabled = raw.enabled === true;
  const mode = raw.mode ?? "fused";
  if (mode !== "fused") {
    throw new ConfigError(
      `cognition.mode 目前只支持 "fused"，收到 ${String(mode)}。` +
        `two-pass-critical 已经设计好（cognition/modes.ts）但尚未接通。`,
    );
  }
  if (enabled && !COGNITIVE_VERSIONS.includes(promptVersion)) {
    throw new ConfigError(
      `开了 cognition 就必须用 promptVersion ${COGNITIVE_VERSIONS.join(" 或 ")}，现在是 ${promptVersion}。` +
        `三套提示栈不能共用一个版本号 —— 产物上记的版本必须真的描述生成它的那批提示。`,
    );
  }
  if (!enabled && COGNITIVE_VERSIONS.includes(promptVersion)) {
    throw new ConfigError(
      `promptVersion ${promptVersion} 是认知栈专用的，但 cognition.enabled 是 false。` +
        `要跑旧路径请用 ${PROMPT_VERSION_LEGACY}。`,
    );
  }
  return {
    enabled,
    mode: "fused",
    maxCognitionRepairs: requireInt(
      raw.maxCognitionRepairs ?? 2,
      "cognition.maxCognitionRepairs",
      { min: 0, max: 5 },
    ),
    telemetry: raw.telemetry !== false,
  };
}

function readSmoke(raw: Record<string, unknown>): SmokeConfig {
  const ceilingUsd = requireMoney(raw.ceilingUsd, "smoke.ceilingUsd");
  const maxOutputTokens = requireInt(raw.maxOutputTokens, "smoke.maxOutputTokens", {
    min: 1,
    max: 100_000,
  });
  const assumedInputTokens = requireInt(raw.assumedInputTokens, "smoke.assumedInputTokens", {
    min: 1,
    max: 100_000,
  });
  const pessimisticInputUsdPerMTok = requireRate(
    raw.pessimisticInputUsdPerMTok,
    "smoke.pessimisticInputUsdPerMTok",
  );
  const pessimisticOutputUsdPerMTok = requireRate(
    raw.pessimisticOutputUsdPerMTok,
    "smoke.pessimisticOutputUsdPerMTok",
  );
  if (pessimisticInputUsdPerMTok <= 0 || pessimisticOutputUsdPerMTok <= 0) {
    throw new ConfigError("the pessimistic smoke rates must be positive to bound anything");
  }
  return {
    ceilingUsd,
    maxOutputTokens,
    assumedInputTokens,
    pessimisticInputUsdPerMTok,
    pessimisticOutputUsdPerMTok,
  };
}

/**
 * The config as it may be written to an artifact on disk.
 *
 * Today it is nearly a pass-through, because nothing secret is in the config:
 * keys come from the environment and are read by the model client, which does
 * not exist yet. The function exists anyway so that when it does, there is one
 * obvious place for the redaction to live rather than a decision to make under
 * pressure at the end of a milestone.
 */
export function redactConfig(config: SimConfig): SimConfig {
  const params = { ...config.model.params };
  for (const key of Object.keys(params)) {
    if (/key|secret|token|authorization/i.test(key)) params[key] = "[redacted]";
  }
  return { ...config, model: { ...config.model, params } };
}
