import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { fixedGameId } from "../core/game-id";
import { answeringClient, counting } from "../model/scripted-client";
import { ModelCallError, type ModelClient } from "../model/client";
import { preflight, PreflightError, projectMaximumSpend, runLiveGame } from "./live-game";
import { summariseCosts } from "./cost-report";

/**
 * The live-game entry point, exercised entirely offline.
 *
 * The client is a double, `fetch` is failed for the whole file, and artifacts
 * are written into a temp directory. Everything that could cost money is a
 * decision made in `live-game.ts`, so all of it is testable here — which is the
 * reason the CLI shell holds only argument parsing and printing.
 */

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    fetchCalls += 1;
    throw new Error("the live-game module must not reach the network in tests");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function tempOut(): string {
  return mkdtempSync(join(tmpdir(), "avalon-sim-"));
}

function options(overrides: Partial<Parameters<typeof preflight>[0]> = {}) {
  return {
    seed: 7,
    gameId: fixedGameId("live-test"),
    outDir: tempOut(),
    client: answeringClient(),
    ...overrides,
  };
}

describe("preflight refuses before it spends", () => {
  it("refuses to start when pricing is unconfigured", () => {
    // Nothing would be overspent — the guard simply cannot see, and running
    // behind a blind gate is worse than stopping in front of a visible one.
    expect(() =>
      preflight(options({ config: loadConfig({ pricing: { configured: false } }) })),
    ).toThrow(PreflightError);
    try {
      preflight(options({ config: loadConfig({ pricing: { configured: false } }) }));
    } catch (error) {
      expect((error as PreflightError).code).toBe("pricing_unconfigured");
    }
  });

  it("refuses a price table written for a different model", () => {
    // `loadConfig` already blocks the mismatch, so the same guard is checked
    // here against a config assembled by hand — a caller could build one.
    const config = { ...loadConfig() };
    const wrong = {
      ...config,
      pricing: { ...config.pricing, modelId: "some-other-model" },
    };
    expect(() => preflight(options({ config: wrong }))).toThrow(/价目表是给/);
  });

  it("refuses a bad seed", () => {
    expect(() => preflight(options({ seed: -1 }))).toThrow(/seed/);
    expect(() => preflight(options({ seed: 1.5 }))).toThrow(/seed/);
  });

  it("refuses a strategy nobody defined", () => {
    expect(() =>
      preflight(options({ strategyProfile: "claim-forward" as "baseline" })),
    ).toThrow(/unknown strategy/);
  });

  it("creates nothing while checking", () => {
    const out = tempOut();
    preflight(options({ outDir: out }));
    // A refused or dry run must leave no empty folders behind.
    expect(readdirSync(out)).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it("separates the public and private artifact paths", () => {
    const ready = preflight(options());
    expect(ready.publicPath).toContain(join("public", ""));
    expect(ready.privatePath).toContain(join("private", ""));
    expect(ready.publicPath).not.toBe(ready.privatePath);
  });

  it("uses the supplied game id, and a fresh random one otherwise", () => {
    expect(preflight(options()).gameId).toBe("g-fixed-live-test");
    const a = preflight(options({ gameId: undefined })).gameId;
    const b = preflight(options({ gameId: undefined })).gameId;
    expect(a).not.toBe(b);
  });

  it("defaults the arms from config and lets flags override them", () => {
    expect(preflight(options()).personaMode).toBe("heterogeneous-rotated");
    expect(preflight(options({ personaMode: "homogeneous-neutral" })).personaMode).toBe(
      "homogeneous-neutral",
    );
    expect(preflight(options({ strategyProfile: "community-meta" })).strategy.id).toBe(
      "community-meta",
    );
    expect(preflight(options({ customStrategyText: "自己写的" })).strategy.customText).toBe(
      "自己写的",
    );
  });
});

describe("the number a human is asked to approve", () => {
  const config = loadConfig();

  it("is the worst case, not an expectation", () => {
    // Every request priced as if none of its input were cached and all of its
    // output were used, times the call ceiling.
    const projection = projectMaximumSpend(config, 2_000, 10_000);
    expect(projection.perRequestUsd).toBeCloseTo(0.044, 9);
    expect(projection.maxGameUsd).toBeCloseTo(0.044 * config.limits.maxLiveCallsPerGame, 6);
  });

  it("reports whichever ceiling bites first", () => {
    const projection = projectMaximumSpend(config, 2_000, 10_000);
    expect(projection.effectiveCeilingUsd).toBe(
      Math.min(projection.maxGameUsd, config.budget.hardCostLimitPerGameUsd),
    );
    expect(projection.effectiveCeilingUsd).toBeLessThanOrEqual(25);
  });

  it("assumes a LATE-game prompt, because those are the expensive ones", () => {
    const ready = preflight(options());
    // Cumulative input is roughly quadratic in turns, so the last requests
    // dominate; projecting from an opening prompt would understate the bill.
    expect(ready.projection.assumedInputTokens).toBeGreaterThan(20_000);
  });
});

describe("a completed run", () => {
  it("writes both artifacts and no checkpoint", async () => {
    const out = tempOut();
    const client = counting(answeringClient());
    const opts = options({ outDir: out, client });
    const ready = preflight(opts);
    const result = await runLiveGame(opts, ready);

    expect(result.status).toBe("completed");
    expect(existsSync(result.publicPath!)).toBe(true);
    expect(existsSync(result.privatePath!)).toBe(true);
    expect(result.checkpointPath).toBeNull();
    expect(client.calls()).toBeGreaterThan(50);
    expect(fetchCalls).toBe(0);
  });

  it("keeps secrets and the seed out of the public artifact", async () => {
    const out = tempOut();
    const opts = options({ outDir: out, seed: 987_654 });
    const ready = preflight(opts);
    const result = await runLiveGame(opts, ready);

    const publicText = readFileSync(result.publicPath!, "utf8");
    expect(publicText).not.toContain("987654");
    expect(publicText).not.toContain('"seed"');
    expect(publicText).not.toContain("sk-");
    expect(publicText).not.toContain("Authorization");

    // The private trace does carry the seed, on purpose, and says so.
    const privateText = readFileSync(result.privatePath!, "utf8");
    expect(privateText).toContain("987654");
    expect(privateText).toContain("containsPrivateInformation");
  });

  it("records the persona arm and the strategy in both artifacts", async () => {
    const out = tempOut();
    const opts = options({
      outDir: out,
      personaMode: "homogeneous-neutral",
      customStrategyText: "跟票流，第四轮再表态。",
    });
    const ready = preflight(opts);
    const result = await runLiveGame(opts, ready);

    const publicText = readFileSync(result.publicPath!, "utf8");
    const privateText = readFileSync(result.privatePath!, "utf8");
    expect(publicText).toContain("homogeneous-neutral");
    expect(privateText).toContain("homogeneous-neutral");
    // Custom strategy TEXT is configuration and belongs only to the private one.
    expect(privateText).toContain("跟票流，第四轮再表态。");
    expect(publicText).not.toContain("跟票流，第四轮再表态。");
  });

  it("gives the same game id to both artifacts", async () => {
    const out = tempOut();
    const opts = options({ outDir: out });
    const ready = preflight(opts);
    const result = await runLiveGame(opts, ready);
    expect(readFileSync(result.publicPath!, "utf8")).toContain(ready.gameId);
    expect(readFileSync(result.privatePath!, "utf8")).toContain(ready.gameId);
  });
});

describe("an interrupted run", () => {
  it("checkpoints at the budget ceiling instead of finishing", async () => {
    const out = tempOut();
    // A ceiling low enough that the very first projection exceeds it.
    const config = loadConfig({
      budget: {
        costWarningPerGameUsd: 0.0001,
        hardCostLimitPerGameUsd: 0.001,
        hardBatchCostLimitUsd: 0.002,
      },
    });
    const client = counting(answeringClient());
    const opts = options({ outDir: out, config, client });
    const result = await runLiveGame(opts, preflight(opts));

    expect(result.status).toBe("paused_cost_limit");
    expect(result.checkpointPath).not.toBeNull();
    const checkpoint = JSON.parse(readFileSync(result.checkpointPath!, "utf8"));
    expect(checkpoint.pauseReason).toBe("paused_cost_limit");
    expect(checkpoint.gameId).toBe("g-fixed-live-test");
    expect(checkpoint.containsPrivateInformation).toBe(true);
    // A partial public replay and private trace are written too, marked paused.
    expect(existsSync(result.publicPath!)).toBe(true);
    expect(existsSync(result.privatePath!)).toBe(true);
    expect(readFileSync(result.publicPath!, "utf8")).toContain("paused_cost_limit");
    // Nothing was sent: the projection stopped it before the first request.
    expect(client.calls()).toBe(0);
  });

  it("checkpoints at the input ceiling", async () => {
    const out = tempOut();
    const config = loadConfig({ limits: { maxStandardInputTokens: 10 } });
    const opts = options({ outDir: out, config });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("paused_input_limit");
    expect(result.checkpointPath).not.toBeNull();
  });

  /**
   * A transient provider problem is not a lost game.
   *
   * It is checkpointed rather than retried, deliberately: a request that was
   * rate-limited or timed out may or may not have been billed, and an
   * automatic retry would double a cost nobody can see.
   */
  it("pauses and checkpoints on a recoverable provider interruption", async () => {
    for (const [status, type, code] of [
      [429, "rate_limit_error", "rate_limit_exceeded"],
      [503, "server_error", "overloaded"],
      [408, "timeout", "request_timeout"],
    ] as const) {
      const out = tempOut();
      const failing: ModelClient = {
        name: "failing",
        async complete() {
          throw new ModelCallError(status, type, code, "transient");
        },
      };
      const opts = options({ outDir: out, client: failing });
      const result = await runLiveGame(opts, preflight(opts));
      expect(result.status, String(status)).toBe("paused_provider_interruption");
      expect(result.checkpointPath).not.toBeNull();
      expect(result.outcome).toContain(`HTTP ${status}`);
      expect(result.outcome).not.toContain("Authorization");
    }
  });

  it("pauses on a network interruption, which has no status at all", async () => {
    const out = tempOut();
    const failing: ModelClient = {
      name: "dead-socket",
      async complete() {
        throw new ModelCallError(null, "network_error", null, "ECONNRESET");
      },
    };
    const opts = options({ outDir: out, client: failing });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("paused_provider_interruption");
    expect(result.checkpointPath).not.toBeNull();
  });

  /**
   * A permanent request error will fail again the same way. Writing a
   * checkpoint for it would send somebody back to a resume point that cannot
   * move, which is worse than admitting the game is lost.
   */
  it("marks a permanent provider error failed, with NO checkpoint", async () => {
    for (const status of [400, 401, 404] as const) {
      const out = tempOut();
      const failing: ModelClient = {
        name: "permanent",
        async complete() {
          throw new ModelCallError(status, "invalid_request_error", "bad", "permanent");
        },
      };
      const opts = options({ outDir: out, client: failing });
      const result = await runLiveGame(opts, preflight(opts));
      expect(result.status, String(status)).toBe("failed");
      expect(result.checkpointPath).toBeNull();
      // Partial artifacts are still written, marked failed, with the
      // sanitised reason recorded privately and not publicly.
      expect(existsSync(result.publicPath!)).toBe(true);
      expect(existsSync(result.privatePath!)).toBe(true);
      expect(readFileSync(result.privatePath!, "utf8")).toContain("failureReason");
      expect(readFileSync(result.publicPath!, "utf8")).not.toContain("failureReason");
    }
  });

  it("never substitutes a scripted action when the model will not comply", async () => {
    const out = tempOut();
    const stubborn: ModelClient = {
      name: "stubborn",
      async complete() {
        return {
          text: "我不打算回答。",
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
          latencyMs: 0,
          cached: false,
          modelReturned: "double",
          status: "completed" as const,
        };
      },
    };
    const opts = options({ outDir: out, client: stubborn });
    const result = await runLiveGame(opts, preflight(opts));
    // The game FAILS. A substituted turn would belong to neither arm.
    expect(result.status).toBe("failed");
    expect(result.outcome).toContain("仍未给出合法动作");
  });
});

describe("the cost report separates every figure", () => {
  it("never conflates per-request size with the game total", async () => {
    const out = tempOut();
    const opts = options({ outDir: out });
    const result = await runLiveGame(opts, preflight(opts));
    const report = summariseCosts(result);

    expect(report.apiCalls).toBeGreaterThan(50);
    expect(report.inputTokens).toBeGreaterThan(0);
    expect(report.cachedInputTokens).toBeGreaterThan(0);
    expect(report.uncachedInputTokens).toBe(
      report.inputTokens - report.cachedInputTokens,
    );
    expect(report.outputTokens).toBeGreaterThan(0);
    expect(report.reasoningTokens).toBeGreaterThan(0);
    expect(report.actualUsd).not.toBeNull();

    // The shape that the old "linear" claim hid: the last request carries far
    // more history than the first, which is why cumulative input is quadratic.
    expect(report.maxInputChars).toBeGreaterThan(0);
    expect(report.totalInputChars).toBeGreaterThan(report.maxInputChars);
    expect(report.inputCharGrowthRatio).toBeGreaterThan(1);
  });

  /**
   * The regression that would have caught the last defect.
   *
   * `promptChars` used to be fed `observation.publicLog.length` — an event
   * count under a name that said characters, wrong by roughly three orders of
   * magnitude. Characters and events are now separate fields, and this asserts
   * they are separate VALUES too.
   */
  it("never reports an event count as a character count", async () => {
    const out = tempOut();
    const opts = options({ outDir: out });
    const result = await runLiveGame(opts, preflight(opts));
    const report = summariseCosts(result);

    // A prompt is thousands of characters and carries tens of events. If one
    // were ever passed as the other these would be equal, or the same order.
    expect(report.maxInputChars).toBeGreaterThan(1_000);
    expect(report.maxPublicEvents).toBeLessThan(500);
    expect(report.maxInputChars).toBeGreaterThan(report.maxPublicEvents * 10);
    expect(report.totalInputChars).toBeGreaterThan(report.totalPublicEvents * 10);

    // And the system/user split really is a split of the total.
    for (const attempt of result.attempts) {
      expect(attempt.systemChars + attempt.userChars).toBe(attempt.totalInputChars);
      expect(attempt.systemChars).toBeGreaterThan(0);
      expect(attempt.userChars).toBeGreaterThan(0);
    }
  });

  it("records one metric row per SENT request, including failures", async () => {
    const out = tempOut();
    const opts = options({ outDir: out });
    const result = await runLiveGame(opts, preflight(opts));
    const report = summariseCosts(result);
    // Every attempt is either a live call or a cache hit; none goes unrecorded.
    expect(report.recordedAttempts).toBe(report.apiCalls + report.cacheHits);
    expect(result.attempts).toHaveLength(report.recordedAttempts);
  });
});
