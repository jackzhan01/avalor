import { describe, expect, it, vi } from "vitest";
import {
  MAX_STANDARD_INPUT_TOKENS,
  checkInputTokens,
  checkpointFor,
  type InputOverLimit,
} from "./input-limit";
import { loadConfig } from "../config/load";

describe("the input ceiling", () => {
  it("is 250,000", () => {
    expect(MAX_STANDARD_INPUT_TOKENS).toBe(250_000);
  });

  it("permits exactly 250,000", () => {
    const verdict = checkInputTokens(250_000);
    expect(verdict.ok).toBe(true);
    expect(verdict.tokens).toBe(250_000);
    expect(verdict.limit).toBe(250_000);
  });

  it("rejects 250,001", () => {
    const verdict = checkInputTokens(250_001);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("input_limit_exceeded");
    expect(verdict.overBy).toBe(1);
  });

  /**
   * The guard is a decision, not a caller. It counts nothing, reads no
   * environment and — critically — sends nothing: the whole point is that an
   * oversized request never reaches a provider.
   */
  it("makes no request in either direction", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("the input guard must not call fetch");
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      expect(checkInputTokens(1).ok).toBe(true);
      expect(checkInputTokens(999_999).ok).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pauses the run rather than degrading it", () => {
    const verdict = checkInputTokens(300_000) as InputOverLimit;
    expect(verdict.runStatus).toBe("paused_input_limit");
    // Every remedy that would quietly change what the experiment measured is
    // named, so a future implementer has to argue with the list rather than
    // reinvent one of them under deadline.
    expect(verdict.forbiddenRemedies).toContain("truncate_public_history");
    expect(verdict.forbiddenRemedies).toContain("summarise_without_configured_policy");
    expect(verdict.forbiddenRemedies).toContain("switch_model");
    expect(verdict.forbiddenRemedies).toContain("scripted_fallback");
  });

  it("honours a lower configured limit", () => {
    expect(checkInputTokens(120_000, 100_000).ok).toBe(false);
    expect(checkInputTokens(90_000, 100_000).ok).toBe(true);
  });

  it("refuses nonsense counts loudly", () => {
    expect(() => checkInputTokens(-1)).toThrow();
    expect(() => checkInputTokens(Number.NaN)).toThrow();
    expect(() => checkInputTokens(10, 0)).toThrow();
  });

  it("produces a resumable checkpoint", () => {
    const verdict = checkInputTokens(400_000) as InputOverLimit;
    const checkpoint = checkpointFor(verdict, {
      runId: "run-1",
      gameId: "run-1:7",
      seed: 7,
      seat: 3,
      sequence: 128,
    });
    expect(checkpoint).toEqual({
      runId: "run-1",
      gameId: "run-1:7",
      seed: 7,
      seat: 3,
      sequence: 128,
      runStatus: "paused_input_limit",
      detail: { tokens: 400_000, limit: 250_000 },
    });
  });
});

describe("the configured limit", () => {
  it("defaults to the contract", () => {
    expect(loadConfig().limits.maxStandardInputTokens).toBe(MAX_STANDARD_INPUT_TOKENS);
  });

  it("may be lowered but never raised", () => {
    expect(loadConfig({ limits: { maxStandardInputTokens: 50_000 } }).limits
      .maxStandardInputTokens).toBe(50_000);
    expect(() =>
      loadConfig({ limits: { maxStandardInputTokens: 250_001 } }),
    ).toThrow(/between 1 and 250000/);
  });
});
