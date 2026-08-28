/**
 * One attempted model request.
 *
 * Lives here rather than beside the agent so the artifact layer can name it
 * without importing anything that plays the game — `run/artifacts.ts` should
 * not depend on `agents/`, and a shared record type is the only thing the two
 * genuinely have in common.
 */

import type { Seat } from "../core/types";
import type { TokenUsage } from "./pricing";

/**
 * One attempted model request, recorded whether or not it worked.
 *
 * This is BOTH the model-call record the private trace keeps and the
 * per-request metric the cost report reads. One type rather than two, because
 * two would drift and the interesting questions ("how big was the prompt that
 * failed?") span both.
 *
 * `raw` is the model's own output and is PRIVATE: the trace and the checkpoint
 * may hold it, the public replay never may. `usage` is null when the provider
 * threw — its token cost is UNKNOWN, and recording it as zero would quietly
 * under-count a bill.
 */
export interface ModelAttempt {
  readonly seat: Seat;
  readonly taskId: string;
  /** 1 for the first try at this decision. */
  readonly attempt: number;
  readonly promptKey: string;

  /* ── Size, in the units the names claim ──────────────────────────────── */
  /** Characters in the system message (layers 1-3). */
  readonly systemChars: number;
  /** Characters in the user message (layers 4-7, plus any repair note). */
  readonly userChars: number;
  readonly totalInputChars: number;
  /** How many public events the prompt carried. NOT a character count. */
  readonly publicEventCount: number;
  readonly estimatedInputTokens: number;

  /**
   * Which send of this prompt this was: 1 for the first, 2 for the single
   * capacity retry that follows an exhausted output budget.
   *
   * Separate from `attempt` because the two count different things. `attempt`
   * counts REPHRASINGS — each carries a repair note and a different user
   * message. A capacity retry is the identical prompt sent a second time,
   * because the failure was the budget, not the wording, and appending a
   * repair note to it makes the next answer think harder and return even less.
   */
  readonly capacityAttempt: number;

  /* ── What came back ──────────────────────────────────────────────────── */
  /**
   * `output_limit` is not a kind of `invalid`. An invalid answer is one the
   * model finished and got wrong; this one it never finished, so there is
   * nothing to correct and nothing that may be parsed — a truncated prefix
   * that happens to look like JSON is not an answer.
   */
  readonly outcome: "valid" | "invalid" | "provider_error" | "output_limit";
  /** Sanitised. Safe to show a model on the retry and to keep in a trace. */
  readonly validationError?: string;
  /** PRIVATE. Never enters the public replay. */
  readonly raw: string | null;
  /** Null means the provider told us nothing — unknown, not zero. */
  readonly usage: TokenUsage | null;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly modelReturned: string;
  readonly status: "completed" | "incomplete" | "error";
  readonly incompleteReason?: string;
  /**
   * Did this answer become a legal move?
   *
   * Set to `outcome === "valid"` by the agent and corrected to false by the
   * runner if the REFEREE then rejected it — the agent cannot know that.
   */
  appliedLegalAction: boolean;
  /**
   * WHO refused this answer, when somebody did.
   *
   * The M5 pilot reported five "referee-invalid actions". None of them were:
   * every one was a broken `cognition` block, and the runner marks the last
   * attempt `appliedLegalAction = false` for BOTH kinds of repairable
   * rejection. With only that flag to read, the analysis script guessed — and
   * guessed wrong, in a shipped report. So the reason is recorded now.
   */
  rejectedBy?: "referee" | "cognition" | "action-format";
  /** Sanitised, and exactly what was shown to the model on the retry. */
  rejectionReason?: string;
}
