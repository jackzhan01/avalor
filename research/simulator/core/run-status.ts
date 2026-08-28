/**
 * How a run ended, or why it stopped.
 *
 * The three `paused_*` states are the whole point of this file. A research run
 * that hits a ceiling must STOP and say precisely which ceiling, so a human
 * decides what the experiment does next. Every alternative — trimming the
 * history, summarising it, switching models, falling back to a scripted
 * policy — produces games that are quietly not the games being measured, and
 * a status of "completed" on top of them is worse than a failure.
 *
 * Kept in its own module because both `input-limit.ts` and `budget.ts` need
 * it, and neither should own the other's vocabulary.
 */

export type PauseReason =
  /** A single request's input exceeded the token ceiling. */
  | "paused_input_limit"
  /** A game or batch reached its hard USD ceiling. */
  | "paused_cost_limit"
  /** A game reached its cap on live model calls. */
  | "paused_call_limit"
  /**
   * No price list is configured, so the money ceilings cannot be enforced.
   *
   * A distinct reason rather than a cost pause, because the fix is different:
   * nothing was overspent, the guard simply cannot see. Silently continuing
   * would run an unbounded bill behind a gate that reads green.
   */
  | "paused_pricing_unconfigured"
  /**
   * The provider failed in a way that might be transient — a timeout, a
   * dropped socket, 408, 429, or any 5xx.
   *
   * These are checkpointed rather than retried, and deliberately so: a request
   * that timed out may or may not have been billed, and an automatic retry
   * would double a cost nobody can see. A human decides whether to resume.
   * Permanent request errors (most other 4xx) are `failed`, not this.
   */
  | "paused_provider_interruption";

/**
 * The model spent its whole output budget on reasoning and returned nothing
 * usable — twice, on an identical prompt.
 *
 * A `failed` variant rather than a pause, and deliberately so. A pause means
 * "a human decides whether to continue"; this means "continuing under this
 * configuration will produce the same result". The first paid game died here
 * nine times on a hard-coded 2000-token cap, so the status names the cause
 * instead of hiding it behind a generic failure.
 */
export type FailureStatus =
  | "output_limit_exhausted"
  /**
   * The cognition block was structurally unusable after every repair.
   *
   * Its own status rather than a generic failure because the ACTION may have
   * been perfectly legal — what broke is the memory. A run that continued
   * would build every later turn on a ledger nobody can trust, and one marked
   * merely `failed` would send somebody looking at the wrong half.
   */
  | "cognition_invalid";

export type RunStatus = "running" | "completed" | "failed" | FailureStatus | PauseReason;

export const PAUSE_REASONS: readonly PauseReason[] = [
  "paused_input_limit",
  "paused_cost_limit",
  "paused_call_limit",
  "paused_pricing_unconfigured",
  "paused_provider_interruption",
];

export function isPaused(status: RunStatus): status is PauseReason {
  return (PAUSE_REASONS as readonly string[]).includes(status);
}

/**
 * What must NOT be done instead of pausing.
 *
 * Carried on every stop verdict and written into the log, so the list has to
 * be argued with rather than quietly reinvented by whoever is next in front of
 * a stalled batch at midnight.
 */
export const FORBIDDEN_REMEDIES: readonly string[] = [
  "truncate_public_history",
  "summarise_without_configured_policy",
  "switch_model",
  "scripted_fallback",
];

/** Everything needed to pick a paused run back up. */
export interface Checkpoint {
  readonly runId: string;
  readonly gameId: string;
  readonly seed: number;
  readonly seat: number;
  readonly sequence: number;
  readonly runStatus: PauseReason;
  /** Free-form detail: the token count, the dollar figure, the call count. */
  readonly detail: Readonly<Record<string, number>>;
}

export interface CheckpointWhere {
  readonly runId: string;
  readonly gameId: string;
  readonly seed: number;
  readonly seat: number;
  readonly sequence: number;
}

export function makeCheckpoint(
  reason: PauseReason,
  where: CheckpointWhere,
  detail: Readonly<Record<string, number>>,
): Checkpoint {
  return { ...where, runStatus: reason, detail };
}
