/**
 * The input-size ceiling every future model request must clear before it is sent.
 *
 * No request may go out when its input exceeds 250,000 tokens. This milestone
 * builds no model client, so what lives here is the pure decision — given a
 * token count somebody else measured, may this request be sent, and if not,
 * what happens to the run. The counting itself arrives with the model client,
 * once the supported tokeniser for the configured model has actually been
 * checked rather than assumed. Guessing a tokeniser now and discovering later
 * that it undercounts would be worse than having no count at all, because the
 * guard would look green while letting oversized requests through.
 *
 * WHAT MUST NOT HAPPEN AT THE BOUNDARY is listed once, in
 * `run-status.ts::FORBIDDEN_REMEDIES`, and carried on every stop verdict.
 *
 * The second half of the contract is that the request builder must be
 * STATELESS: every request is rebuilt from the current canonical observation,
 * includes the public history exactly once, and never accumulates prior
 * observation snapshots in a growing chat thread.
 *
 * Note what that does and does not bound. A single request is bounded by the
 * CURRENT history, which is what this ceiling checks. Cumulative input across
 * a game is still roughly quadratic in the turn count, because request k
 * carries about k events — statelessness does not change that and was never
 * going to. What it avoids is the SECOND growth term a chat thread would add
 * by also carrying every earlier observation snapshot. `prompts/build.ts` is
 * written to that rule and `prompts/build.test.ts` asserts it.
 */

import {
  FORBIDDEN_REMEDIES,
  makeCheckpoint,
  type Checkpoint,
  type CheckpointWhere,
} from "./run-status";

/**
 * The contract. A run may configure a LOWER ceiling; `loadConfig` refuses a
 * higher one.
 */
export const MAX_STANDARD_INPUT_TOKENS = 250_000;

export interface InputWithinLimit {
  readonly ok: true;
  readonly tokens: number;
  readonly limit: number;
}

export interface InputOverLimit {
  readonly ok: false;
  readonly tokens: number;
  readonly limit: number;
  readonly overBy: number;
  readonly reason: "input_limit_exceeded";
  /** What the batch runner must set on the run. Not a suggestion. */
  readonly runStatus: "paused_input_limit";
  /** What the caller must NOT do instead of stopping. Carried for the log. */
  readonly forbiddenRemedies: readonly string[];
}

export type InputLimitVerdict = InputWithinLimit | InputOverLimit;

/**
 * May a request carrying `tokens` tokens of input be sent?
 *
 * Pure and total: it makes no request, reads no environment and counts no
 * tokens itself. The count is supplied by the caller, which is what lets this
 * be tested exactly at 250,000 and 250,001 today and re-pointed at a real
 * tokeniser later without changing a line of the policy.
 *
 * The boundary is INCLUSIVE: exactly at the limit is allowed.
 */
export function checkInputTokens(
  tokens: number,
  limit: number = MAX_STANDARD_INPUT_TOKENS,
): InputLimitVerdict {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`token count must be a non-negative finite number, got ${tokens}`);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`limit must be a positive finite number, got ${limit}`);
  }
  if (tokens <= limit) return { ok: true, tokens, limit };
  return {
    ok: false,
    tokens,
    limit,
    overBy: tokens - limit,
    reason: "input_limit_exceeded",
    runStatus: "paused_input_limit",
    forbiddenRemedies: FORBIDDEN_REMEDIES,
  };
}

/**
 * A resumable marker for a run that hit the ceiling.
 *
 * Written next to the trace so a paused run can be picked up after the prompt
 * or the configured limit changes, rather than being restarted from seed zero
 * and losing the games that already completed.
 */
export function checkpointFor(
  verdict: InputOverLimit,
  where: CheckpointWhere,
): Checkpoint {
  return makeCheckpoint("paused_input_limit", where, {
    tokens: verdict.tokens,
    limit: verdict.limit,
  });
}

export type { Checkpoint, CheckpointWhere };
export type { RunStatus, PauseReason } from "./run-status";
