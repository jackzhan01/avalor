import { describe, expect, it, vi } from "vitest";
import { loadConfig, ConfigError } from "../config/load";
import { budgetCheckpoint, callCheckpoint, checkBudget, checkCallBudget } from "./budget";
import { FORBIDDEN_REMEDIES, isPaused } from "./run-status";

/**
 * Configuration and validation only. Nothing here bills, prices or calls
 * anything, and a test asserts that no request is made in either direction —
 * the same standing guarantee the input guard carries.
 */

const budget = loadConfig().budget;
const limits = loadConfig().limits;

describe("the shipped budget defaults", () => {
  it("are the agreed figures", () => {
    expect(budget.costWarningPerGameUsd).toBe(12);
    expect(budget.hardCostLimitPerGameUsd).toBe(25);
    expect(budget.hardBatchCostLimitUsd).toBe(100);
    expect(limits.maxLiveCallsPerGame).toBe(600);
    expect(limits.maxStandardInputTokens).toBe(250_000);
  });

  it("name the model and how hard it is asked to think", () => {
    expect(loadConfig().model.id).toBe("gpt-5.6-terra");
    expect(loadConfig().model.reasoningEffort).toBe("high");
  });

  it("refuse a warning that fires at or after the stop", () => {
    expect(() => loadConfig({ budget: { costWarningPerGameUsd: 25 } })).toThrow(ConfigError);
    expect(() => loadConfig({ budget: { costWarningPerGameUsd: 30 } })).toThrow(ConfigError);
  });

  it("refuse a batch ceiling below one game's ceiling", () => {
    expect(() => loadConfig({ budget: { hardBatchCostLimitUsd: 10 } })).toThrow(ConfigError);
  });

  it("refuse a reasoning effort nobody defined", () => {
    expect(() =>
      loadConfig({ model: { reasoningEffort: "extreme" as unknown as "high" } }),
    ).toThrow(ConfigError);
  });

  it("refuse nonsense money", () => {
    expect(() => loadConfig({ budget: { hardCostLimitPerGameUsd: 0 } })).toThrow(ConfigError);
    expect(() => loadConfig({ budget: { hardCostLimitPerGameUsd: -5 } })).toThrow(ConfigError);
  });
});

describe("the money guard", () => {
  it("is quiet below the warning", () => {
    const verdict = checkBudget({ gameUsd: 5, batchUsd: 40 }, budget);
    expect(verdict.level).toBe("ok");
    expect(verdict.triggeredBy).toBeNull();
    expect(verdict.runStatus).toBeNull();
  });

  it("warns from the warning level, and does not stop", () => {
    expect(checkBudget({ gameUsd: 12, batchUsd: 40 }, budget).level).toBe("warn");
    expect(checkBudget({ gameUsd: 24.99, batchUsd: 40 }, budget).level).toBe("warn");
    expect(checkBudget({ gameUsd: 24.99, batchUsd: 40 }, budget).runStatus).toBeNull();
  });

  it("allows exactly the limit and stops above it", () => {
    expect(checkBudget({ gameUsd: 25, batchUsd: 40 }, budget).level).toBe("warn");
    const over = checkBudget({ gameUsd: 25.01, batchUsd: 40 }, budget);
    expect(over.level).toBe("stop");
    expect(over.triggeredBy).toBe("game_limit");
    expect(over.runStatus).toBe("paused_cost_limit");
  });

  it("stops on the batch ceiling first, because that is what was authorised", () => {
    const over = checkBudget({ gameUsd: 1, batchUsd: 100.01 }, budget);
    expect(over.triggeredBy).toBe("batch_limit");
    expect(over.runStatus).toBe("paused_cost_limit");
  });

  it("names what must not be done instead of stopping", () => {
    const over = checkBudget({ gameUsd: 999, batchUsd: 999 }, budget);
    expect(over.forbiddenRemedies).toEqual(FORBIDDEN_REMEDIES);
    expect(over.forbiddenRemedies).toContain("switch_model");
    expect(over.forbiddenRemedies).toContain("scripted_fallback");
  });

  it("refuses nonsense spend", () => {
    expect(() => checkBudget({ gameUsd: -1, batchUsd: 0 }, budget)).toThrow();
    expect(() => checkBudget({ gameUsd: Number.NaN, batchUsd: 0 }, budget)).toThrow();
  });
});

describe("the call guard", () => {
  it("allows calls up to the cap and refuses the one past it", () => {
    expect(checkCallBudget(599, limits).ok).toBe(true);
    expect(checkCallBudget(600, limits).ok).toBe(false);
    expect(checkCallBudget(600, limits).runStatus).toBe("paused_call_limit");
  });
});

describe("checkpoints", () => {
  it("carry the reason and the numbers", () => {
    const where = { runId: "r", gameId: "g", seed: 1, seat: 4, sequence: 77 };
    const stop = checkBudget({ gameUsd: 999, batchUsd: 999 }, budget);
    expect(budgetCheckpoint(stop, where)).toEqual({
      ...where,
      runStatus: "paused_cost_limit",
      detail: { spentThisGameUsd: 999, spentThisBatchUsd: 999 },
    });
    expect(callCheckpoint(checkCallBudget(601, limits), where).runStatus).toBe(
      "paused_call_limit",
    );
  });

  it("refuse to be built from a verdict that did not stop anything", () => {
    const where = { runId: "r", gameId: "g", seed: 1, seat: 4, sequence: 77 };
    expect(() => budgetCheckpoint(checkBudget({ gameUsd: 0, batchUsd: 0 }, budget), where)).toThrow();
    expect(() => callCheckpoint(checkCallBudget(0, limits), where)).toThrow();
  });

  it("are recognisable as pauses", () => {
    expect(isPaused("paused_cost_limit")).toBe(true);
    expect(isPaused("paused_call_limit")).toBe(true);
    expect(isPaused("paused_input_limit")).toBe(true);
    expect(isPaused("completed")).toBe(false);
    expect(isPaused("running")).toBe(false);
  });
});

describe("no request is made in this milestone", () => {
  it("never touches fetch", () => {
    const spy = vi.fn(() => {
      throw new Error("the budget guard must not call fetch");
    });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      checkBudget({ gameUsd: 5, batchUsd: 5 }, budget);
      checkBudget({ gameUsd: 500, batchUsd: 500 }, budget);
      checkCallBudget(1, limits);
      checkCallBudget(10_000, limits);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
