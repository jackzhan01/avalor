/**
 * Two artifacts, named so they cannot be confused, because one of them ruins
 * the experiment if it is published.
 *
 *   PublicReplay            what the table saw. Safe to hand to anyone,
 *                           including the models in a later study.
 *
 *   PrivateResearchTrace    the deal, the seed, the hidden cards, the private
 *                           Lady truths, the evil discussion, every memory
 *                           patch. Enough to replay the game exactly, and
 *                           enough to invalidate any downstream evaluation
 *                           that gets to read it.
 *
 * The naming is the safety mechanism. There is no `buildReplay()` that a tired
 * caller could reach for at midnight and get the wrong one — every function
 * says which artifact it makes, the private one carries a
 * `containsPrivateInformation: true` flag and a warning string, and
 * `publicReplay.test.ts` asserts the forbidden fields cannot appear in the
 * serialised public form.
 *
 * WHY THE SEED IS NOT IN THE PUBLIC ARTIFACT. Seed plus this code
 * deterministically reproduces the deal. A seed in the public metadata would
 * let a reader reconstruct every role before reaching the final reveal, which
 * is precisely the ordering guarantee the public replay is supposed to make.
 * The final `game_end` event still carries the reveal — that is the intended
 * and only place roles become public.
 *
 * AND WHY THE GAME ID IS NOT DERIVED FROM IT EITHER. An earlier version hashed
 * `runId` and the seed to make a join key. That was the same leak wearing a
 * hat: seeds are small integers, so anyone with a public replay and this source
 * could enumerate them, match the digest and recover the deal without reading
 * to the end. The id is now supplied by the run boundary, opaque, and carries
 * no seed-derived material — see `core/game-id.ts`.
 *
 * Nothing here writes files. `serialise*` returns a string and the caller
 * decides where it goes, which is also what keeps these testable without
 * touching a disk.
 */

import type { RoleType } from "@/lib/types/game";
import type { CognitionConfig, ModelConfig, SimConfig } from "../config/load";
import { COGNITION_LIMITS } from "../cognition/limits";
import type { CognitionReport } from "../agents/llm-agent";
import { redactConfig } from "../config/load";
import type { PrivateEvent, PublicEvent } from "../core/events";
import type { GameId } from "../core/game-id";
import type { ModelAttempt } from "../model/attempt";
import type { PersonaMode } from "../prompts/personas";
import type { GameState, Outcome } from "../core/state";
import type { RunStatus } from "../core/run-status";
import { SEATS, type Action, type LadyResult, type PrivateMemory, type Seat } from "../core/types";

/* ── Shared ────────────────────────────────────────────────────────────── */

export interface RecordedAction {
  /** The log sequence the game stood at when this action was submitted. */
  readonly atSequence: number;
  readonly seat: Seat;
  readonly action: Action;
}

/** Just enough to name who was playing. Carries NO role. */
export interface PublicSeatEntry {
  readonly seat: Seat;
  readonly agent: string;
  /** Persona id. Public: it is how the seat was configured, not what it holds. */
  readonly persona: string | null;
  /** Strategy profile id. Public for the same reason. */
  readonly strategy: string | null;
}

/**
 * How a seat was configured, as the caller knows it.
 *
 * `customStrategyText` is the experimenter's own words and goes ONLY into the
 * private manifest — a custom profile is configuration and has to be recorded
 * verbatim for a result to be traceable to what produced it, but it is not
 * part of what the table saw.
 */
export interface SeatConfiguration {
  readonly persona: string | null;
  readonly strategy: string | null;
  readonly customStrategyText?: string;
}

export type SeatConfigurations = Partial<Record<Seat, SeatConfiguration>>;

function seatAgents(
  agents: Readonly<Record<Seat, { name: string }>>,
  seats: SeatConfigurations,
): PublicSeatEntry[] {
  return SEATS.map((seat) => ({
    seat,
    agent: agents[seat].name,
    persona: seats[seat]?.persona ?? null,
    strategy: seats[seat]?.strategy ?? null,
  }));
}

function openingLadySide(state: GameState): "left" | "right" | null {
  const opening = state.log.find((e) => e.type === "opening_direction");
  return opening && opening.type === "opening_direction" ? opening.ladySide : null;
}

/* ── Public replay ─────────────────────────────────────────────────────── */

export interface PublicRunMetadata {
  /**
   * Caller-supplied. Whoever supplies one MUST NOT encode the seed in it —
   * the whole point of leaving the seed out is defeated by a run id of
   * `sim-4242`. The default is the constant "sim" for exactly that reason.
   */
  readonly runId: string;
  /** Opaque, supplied, seed-free. The join key between the two artifacts. */
  readonly gameId: GameId;
  readonly simulatorVersion: string;
  readonly promptVersion: string;
  /** Redacted. `redactConfig` is where that is enforced, and it runs once. */
  readonly model: ModelConfig;
  readonly config: SimConfig;
  readonly initialLeader: Seat;
  readonly playDirection: "left" | "right" | null;
  readonly ladySide: "left" | "right" | null;
  readonly seats: readonly PublicSeatEntry[];
  /**
   * Which persona arm this game was in.
   *
   * Recorded in BOTH artifacts. A run whose experiment arm cannot be read off
   * its own artifact is a run that cannot be compared to anything.
   */
  readonly personaMode: PersonaMode;
  /**
   * The output cap this run actually sent, reasoning tokens included.
   *
   * Recorded explicitly rather than left to be read out of `config.limits`,
   * because a caller may override the configured value and an artifact that
   * disagreed with the requests it describes would be worse than one that
   * said nothing. Public because it is an experiment parameter, not a secret:
   * two runs at different caps are not comparable, and a reader has to be
   * able to see that without the private trace.
   */
  readonly maxOutputTokens: number;
  /**
   * Which strategy arm this game was in.
   *
   * Public, and top-level, because it is half of what a paired comparison
   * varies — `promptVersion` is the other half and is already up here. Both
   * belong where a reader looks first, not inferred from ten seat rows.
   */
  readonly strategyId: string;
  readonly status: RunStatus;
}

export interface PublicReplay {
  readonly artifact: "public-replay";
  readonly metadata: PublicRunMetadata;
  /** Public events only, in sequence order. The final one carries the reveal. */
  readonly events: readonly PublicEvent[];
  readonly outcome: Outcome | null;
}

/**
 * The game as the table saw it.
 *
 * Contains no seed, no deal outside the final reveal, no mission-card
 * submitter, no private Lady truth, no memory patch, no evil discussion and no
 * model response. Those absences are asserted rather than described.
 */
export interface PublicReplayOptions {
  readonly status?: RunStatus;
  readonly seats?: SeatConfigurations;
  /** Defaults to whatever the config says this run was configured for. */
  readonly personaMode?: PersonaMode;
  /** Defaults to the configured limit. Pass the resolved value when overriding. */
  readonly maxOutputTokens?: number;
  readonly strategyId?: string;
}

export function buildPublicReplay(
  state: GameState,
  agents: Readonly<Record<Seat, { name: string }>>,
  options: PublicReplayOptions = {},
): PublicReplay {
  const safe = redactConfig(state.config);
  const status = options.status ?? "completed";
  return {
    artifact: "public-replay",
    metadata: {
      runId: state.runId,
      gameId: state.gameId,
      simulatorVersion: safe.simulatorVersion,
      promptVersion: safe.promptVersion,
      // Both taken from the SAME redacted object. Reading `model` from the raw
      // config and `config` from the redacted one is how a key reached an
      // artifact the first time this was written.
      model: safe.model,
      config: safe,
      initialLeader: state.initialLeader,
      playDirection: state.playDirection,
      ladySide: openingLadySide(state),
      seats: seatAgents(agents, options.seats ?? {}),
      personaMode: options.personaMode ?? state.config.experiment.personaMode,
      maxOutputTokens: options.maxOutputTokens ?? safe.limits.maxOutputTokens,
      strategyId: options.strategyId ?? "unknown",
      status,
    },
    events: [...state.log],
    outcome: state.outcome,
  };
}

export type PublicReplayLine =
  | { readonly t: "public-metadata"; readonly data: PublicRunMetadata }
  | { readonly t: "event"; readonly data: PublicEvent }
  | { readonly t: "outcome"; readonly data: Outcome };

export function publicReplayLines(replay: PublicReplay): PublicReplayLine[] {
  const lines: PublicReplayLine[] = [{ t: "public-metadata", data: replay.metadata }];
  for (const event of replay.events) lines.push({ t: "event", data: event });
  if (replay.outcome) lines.push({ t: "outcome", data: replay.outcome });
  return lines;
}

export function serialisePublicReplay(replay: PublicReplay): string {
  return toJsonl(publicReplayLines(replay));
}

/* ── Private research trace ────────────────────────────────────────────── */

export interface PrivateSeatEntry extends PublicSeatEntry {
  readonly role: RoleType;
  /** The experimenter's own strategy text, verbatim. Private only. */
  readonly customStrategyText: string | null;
}

export interface PrivateManifest {
  readonly runId: string;
  readonly gameId: GameId;
  /** The thing the public artifact must never carry. */
  readonly seed: number;
  readonly simulatorVersion: string;
  readonly promptVersion: string;
  readonly model: ModelConfig;
  readonly config: SimConfig;
  readonly initialLeader: Seat;
  readonly playDirection: "left" | "right" | null;
  readonly ladySide: "left" | "right" | null;
  readonly seats: readonly PrivateSeatEntry[];
  readonly personaMode: PersonaMode;
  readonly maxOutputTokens: number;
  readonly strategyId: string;
  /** sha256 of the FULL rendered profile. Proves two arms were what they claim. */
  readonly strategyFingerprint: string;
  /**
   * The cognition arm and its effective limits. PRIVATE.
   *
   * Private rather than public because the ledger it describes is private: a
   * public artifact saying "these seats kept dossiers" invites a reader to
   * wonder what was in them, and the answer is in the file next door.
   */
  readonly cognition: CognitionConfig | null;
  readonly cognitionLimits: Readonly<Record<string, number>> | null;
  readonly deal: Readonly<Record<Seat, RoleType>>;
  readonly status: RunStatus;
}

/**
 * One attempted model request. PRIVATE.
 *
 * Raw model output belongs here and only here — `publicReplayLines` has no
 * branch that could emit it, and `artifacts.test.ts` asserts the serialised
 * public form contains none of it.
 */
export type ModelCallRecord = ModelAttempt;

export interface PrivateResearchTrace {
  readonly artifact: "private-research-trace";
  /** Loud on purpose, and asserted by a test. */
  readonly containsPrivateInformation: true;
  readonly warning: string;
  readonly manifest: PrivateManifest;
  readonly publicEvents: readonly PublicEvent[];
  readonly privateEvents: readonly PrivateEvent[];
  /** Every validated action, in order. Sufficient for deterministic replay. */
  readonly actions: readonly RecordedAction[];
  /** Where each seat's notes ended up. The per-step edits are in `actions`. */
  readonly finalMemory: Readonly<Record<Seat, PrivateMemory>>;
  readonly ladyResults: Readonly<Record<Seat, readonly LadyResult[]>>;
  readonly modelCalls: readonly ModelCallRecord[];
  /** Per-request cognition telemetry. Empty for a legacy run. */
  readonly cognitionReports: readonly CognitionReport[];
  /** Sanitised. Present only when the run failed or was interrupted. */
  readonly failureReason: string | null;
  readonly outcome: Outcome | null;
}

const PRIVATE_WARNING =
  "私有研究轨迹：含发牌、种子、隐藏任务牌、女神真实结果、坏人密谈与私有记忆。" +
  "绝不能作为公开回放分发 —— 任何读到它的下游评测都等于在看答案。";

export interface PrivateTraceOptions {
  readonly status?: RunStatus;
  readonly modelCalls?: readonly ModelCallRecord[];
  readonly seats?: SeatConfigurations;
  readonly personaMode?: PersonaMode;
  readonly maxOutputTokens?: number;
  readonly strategyId?: string;
  readonly strategyFingerprint?: string;
  readonly cognition?: CognitionConfig;
  /** Per-request cognition telemetry. Private; never in the public replay. */
  readonly cognitionReports?: readonly CognitionReport[];
  /** Sanitised provider or agent failure. Private, like everything else here. */
  readonly failureReason?: string;
}

export function buildPrivateResearchTrace(
  state: GameState,
  agents: Readonly<Record<Seat, { name: string }>>,
  actions: readonly RecordedAction[],
  options: PrivateTraceOptions = {},
): PrivateResearchTrace {
  const safe = redactConfig(state.config);
  const status = options.status ?? "completed";
  const seats = options.seats ?? {};
  return {
    artifact: "private-research-trace",
    containsPrivateInformation: true,
    warning: PRIVATE_WARNING,
    manifest: {
      runId: state.runId,
      gameId: state.gameId,
      seed: state.seed,
      simulatorVersion: safe.simulatorVersion,
      promptVersion: safe.promptVersion,
      model: safe.model,
      config: safe,
      initialLeader: state.initialLeader,
      playDirection: state.playDirection,
      ladySide: openingLadySide(state),
      seats: SEATS.map((seat) => ({
        seat,
        role: state.deal.bySeat[seat],
        agent: agents[seat].name,
        persona: seats[seat]?.persona ?? null,
        strategy: seats[seat]?.strategy ?? null,
        customStrategyText: seats[seat]?.customStrategyText ?? null,
      })),
      personaMode: options.personaMode ?? state.config.experiment.personaMode,
      maxOutputTokens: options.maxOutputTokens ?? safe.limits.maxOutputTokens,
      strategyId: options.strategyId ?? "unknown",
      strategyFingerprint: options.strategyFingerprint ?? "",
      cognition: options.cognition ?? null,
      cognitionLimits: options.cognition?.enabled ? { ...COGNITION_LIMITS } : null,
      deal: { ...state.deal.bySeat },
      status,
    },
    publicEvents: [...state.log],
    privateEvents: [...state.privateLog],
    actions: [...actions],
    finalMemory: { ...state.memory },
    ladyResults: { ...state.ladyResults },
    modelCalls: options.modelCalls ?? [],
    cognitionReports: [...(options.cognitionReports ?? [])],
    failureReason: options.failureReason ?? null,
    outcome: state.outcome,
  };
}

export type PrivateTraceLine =
  /**
   * The first line of the file, so anything that opens it — a person, a
   * script, a diff — sees what it is holding before it sees a single event.
   * The flag lived only on the in-memory object until a test noticed the file
   * itself said nothing.
   */
  | {
      readonly t: "private-header";
      readonly data: {
        readonly artifact: "private-research-trace";
        readonly containsPrivateInformation: true;
        readonly warning: string;
        /** Sanitised. Present only when the run failed or was interrupted. */
        readonly failureReason: string | null;
      };
    }
  | { readonly t: "private-manifest"; readonly data: PrivateManifest }
  | { readonly t: "event"; readonly data: PublicEvent }
  | { readonly t: "private-event"; readonly data: PrivateEvent }
  | { readonly t: "action"; readonly data: RecordedAction }
  | { readonly t: "model-call"; readonly data: ModelCallRecord }
  | {
      readonly t: "final-memory";
      readonly data: Readonly<Record<Seat, PrivateMemory>>;
    }
  /**
   * Every Lady inspection's TRUE side, by holder.
   *
   * This line existed on the in-memory trace object and nowhere in the file:
   * `PrivateResearchTrace.ladyResults` was built, typed, and then silently
   * dropped by the serialiser. The truth was recoverable from the
   * `lady_result` private events, so nothing was lost — but the type was
   * lying about what a trace round-trips, and a reader trusting the type
   * would have found an empty object.
   *
   * PRIVATE, and structurally so: `publicReplayLines` has no branch that can
   * emit it, and the public replay carries only what a holder ANNOUNCED.
   */
  | {
      readonly t: "lady-results";
      readonly data: Readonly<Record<Seat, readonly LadyResult[]>>;
    }
  /** Per-request cognition utilisation. PRIVATE, and absent for legacy runs. */
  | { readonly t: "cognition-telemetry"; readonly data: readonly CognitionReport[] }
  | { readonly t: "outcome"; readonly data: Outcome };

export function privateTraceLines(trace: PrivateResearchTrace): PrivateTraceLine[] {
  const lines: PrivateTraceLine[] = [
    {
      t: "private-header",
      data: {
        artifact: trace.artifact,
        containsPrivateInformation: trace.containsPrivateInformation,
        warning: trace.warning,
        // On the header line, so anything opening the file learns why the run
        // stopped before it reads a single event.
        failureReason: trace.failureReason,
      },
    },
    { t: "private-manifest", data: trace.manifest },
  ];
  for (const event of trace.publicEvents) lines.push({ t: "event", data: event });
  for (const event of trace.privateEvents) lines.push({ t: "private-event", data: event });
  for (const action of trace.actions) lines.push({ t: "action", data: action });
  for (const call of trace.modelCalls) lines.push({ t: "model-call", data: call });
  lines.push({ t: "final-memory", data: trace.finalMemory });
  lines.push({ t: "lady-results", data: trace.ladyResults });
  if (trace.cognitionReports.length > 0) {
    lines.push({ t: "cognition-telemetry", data: trace.cognitionReports });
  }
  if (trace.outcome) lines.push({ t: "outcome", data: trace.outcome });
  return lines;
}

export function serialisePrivateResearchTrace(trace: PrivateResearchTrace): string {
  return toJsonl(privateTraceLines(trace));
}

/* ── JSONL ─────────────────────────────────────────────────────────────── */

function toJsonl(lines: readonly unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Pull the actions back out of a serialised private trace, for replay.
 *
 * Only the private trace has them, which is the point: a public replay is for
 * reading, a private trace is for reproducing.
 */
export function actionsFromPrivateTrace(text: string): RecordedAction[] {
  return parseJsonl<PrivateTraceLine>(text)
    .filter((line): line is Extract<PrivateTraceLine, { t: "action" }> => line.t === "action")
    .map((line) => line.data);
}
