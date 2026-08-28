/**
 * Spending ceilings, as pure decisions.
 *
 * CONFIGURATION AND VALIDATION ONLY at this milestone. Nothing here bills
 * anything, reads a price list, counts a token or opens a socket — the caller
 * supplies what has been spent, exactly the way `checkInputTokens` takes a
 * supplied token count. Fixing the policy before the first request exists is
 * the point: a ceiling agreed on after an invoice arrives is not a ceiling.
 *
 * Three numbers, and the reason there are three:
 *
 *   WARN PER GAME    a human watching a batch wants to know that this table is
 *                    running long before it stops, not after
 *   STOP PER GAME    one pathological game must not be able to spend the batch
 *   STOP PER BATCH   the total the experiment was authorised to spend
 *
 * Collapsing the first two would mean either an interruption at every
 * expensive game or discovering the overrun only afterwards.
 */

import type { BudgetConfig, LimitsConfig } from "../config/load";
import {
  FORBIDDEN_REMEDIES,
  makeCheckpoint,
  type Checkpoint,
  type CheckpointWhere,
  type PauseReason,
} from "./run-status";

export type BudgetVerdictLevel = "ok" | "warn" | "stop";

export interface BudgetVerdict {
  readonly level: BudgetVerdictLevel;
  /** Set only when `level` is "stop". */
  readonly runStatus: PauseReason | null;
  readonly spentThisGameUsd: number;
  readonly spentThisBatchUsd: number;
  /** Which ceiling produced the verdict, for the log. */
  readonly triggeredBy: "game_warning" | "game_limit" | "batch_limit" | null;
  readonly forbiddenRemedies: readonly string[];
}

export interface Spend {
  readonly gameUsd: number;
  readonly batchUsd: number;
}

function requireMoney(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${what} must be a non-negative finite number, got ${value}`);
  }
  return value;
}

/**
 * May another call be paid for?
 *
 * Boundaries are INCLUSIVE for the warning (at the warning level, warn) and
 * EXCLUSIVE-above for the stops (at the limit, still allowed; over it, stop),
 * matching `checkInputTokens` so the two guards cannot be remembered
 * differently.
 */
export function checkBudget(spend: Spend, budget: BudgetConfig): BudgetVerdict {
  const gameUsd = requireMoney(spend.gameUsd, "gameUsd");
  const batchUsd = requireMoney(spend.batchUsd, "batchUsd");

  const base = {
    spentThisGameUsd: gameUsd,
    spentThisBatchUsd: batchUsd,
    forbiddenRemedies: FORBIDDEN_REMEDIES,
  } as const;

  // The batch ceiling is checked first: it is the number the experiment was
  // actually authorised to spend, and blowing it is worse than one long game.
  if (batchUsd > budget.hardBatchCostLimitUsd) {
    return {
      ...base,
      level: "stop",
      runStatus: "paused_cost_limit",
      triggeredBy: "batch_limit",
    };
  }
  if (gameUsd > budget.hardCostLimitPerGameUsd) {
    return {
      ...base,
      level: "stop",
      runStatus: "paused_cost_limit",
      triggeredBy: "game_limit",
    };
  }
  if (gameUsd >= budget.costWarningPerGameUsd) {
    return { ...base, level: "warn", runStatus: null, triggeredBy: "game_warning" };
  }
  return { ...base, level: "ok", runStatus: null, triggeredBy: null };
}

export interface CallVerdict {
  readonly ok: boolean;
  readonly calls: number;
  readonly limit: number;
  readonly runStatus: PauseReason | null;
  readonly forbiddenRemedies: readonly string[];
}

/**
 * Has this game made too many live model calls?
 *
 * A separate ceiling from money because the failure it catches is different:
 * a repair loop that never converges burns calls long before it burns a
 * meaningful number of dollars, and stopping on call count names the actual
 * problem.
 */
export function checkCallBudget(calls: number, limits: LimitsConfig): CallVerdict {
  requireMoney(calls, "calls");
  const ok = calls < limits.maxLiveCallsPerGame;
  return {
    ok,
    calls,
    limit: limits.maxLiveCallsPerGame,
    runStatus: ok ? null : "paused_call_limit",
    forbiddenRemedies: FORBIDDEN_REMEDIES,
  };
}

export function budgetCheckpoint(
  verdict: BudgetVerdict,
  where: CheckpointWhere,
): Checkpoint {
  if (verdict.runStatus === null) {
    throw new Error("budgetCheckpoint called on a verdict that did not stop the run");
  }
  return makeCheckpoint(verdict.runStatus, where, {
    spentThisGameUsd: verdict.spentThisGameUsd,
    spentThisBatchUsd: verdict.spentThisBatchUsd,
  });
}

export function callCheckpoint(verdict: CallVerdict, where: CheckpointWhere): Checkpoint {
  if (verdict.runStatus === null) {
    throw new Error("callCheckpoint called on a verdict that did not stop the run");
  }
  return makeCheckpoint(verdict.runStatus, where, {
    calls: verdict.calls,
    limit: verdict.limit,
  });
}
