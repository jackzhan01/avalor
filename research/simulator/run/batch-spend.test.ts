import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { fixedGameId } from "../core/game-id";
import { answeringClient } from "../model/scripted-client";
import {
  BatchAccount,
  CallLedger,
  ModelCallError,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../model/client";
import { usageOf } from "../model/pricing";
import { parseCheckpoint, type PrivateCheckpoint } from "./checkpoint";
import { preflight, runLiveGame } from "./live-game";

/**
 * Batch spend must survive a resume.
 *
 * The bug this file exists for: `runLiveGame` restored the batch total only
 * when nobody supplied an account — `options.batch ?? new BatchAccount(history)`
 * — and the CLI supplied a fresh empty one unconditionally. So every resume
 * silently reset the batch total to zero, and the $100 ceiling was escapable
 * by pausing and resuming. Both boundaries are now defensive.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("batch accounting must not reach the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const GAME_ID = fixedGameId("batch");
const SEED = 77;

function tempOut(): string {
  return mkdtempSync(join(tmpdir(), "avalon-batch-"));
}

/** Answers normally for `budget` requests, then throws a recoverable error. */
function limitedClient(budget: number): ModelClient {
  const inner = answeringClient();
  let sent = 0;
  return {
    name: "limited",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (sent >= budget) {
        throw new ModelCallError(503, "server_error", "overloaded", "stand-in");
      }
      sent += 1;
      return inner.complete(request);
    },
  };
}

function options(out: string, client: ModelClient, extra: Record<string, unknown> = {}) {
  return { seed: SEED, gameId: GAME_ID, outDir: out, client, ...extra };
}

/** Pause a game and return its checkpoint, which has real batch spend in it. */
async function pausedCheckpoint(out: string, budget = 25): Promise<PrivateCheckpoint> {
  const opts = options(out, limitedClient(budget));
  const paused = await runLiveGame(opts, preflight(opts));
  return parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
}

describe("BatchAccount.ensureAtLeast", () => {
  it("tops an empty account up to the historical figure", () => {
    const batch = new BatchAccount();
    batch.ensureAtLeast(5);
    expect(batch.spentUsd()).toBeCloseTo(5, 9);
  });

  /**
   * The property `add()` cannot give. Restoring the same checkpoint twice —
   * or restoring into an account that already knows about that spend — must
   * not inflate the total.
   */
  it("is idempotent, so repeated restoration cannot double-count", () => {
    const batch = new BatchAccount();
    batch.ensureAtLeast(5);
    batch.ensureAtLeast(5);
    batch.ensureAtLeast(5);
    expect(batch.spentUsd()).toBeCloseTo(5, 9);
  });

  it("never lowers an account that already holds more", () => {
    // Several games share one batch. The others' spend is not this game's to
    // erase just because its own checkpoint knows nothing about it.
    const batch = new BatchAccount(30);
    batch.ensureAtLeast(5);
    expect(batch.spentUsd()).toBeCloseTo(30, 9);
  });

  it("ignores nonsense", () => {
    const batch = new BatchAccount(4);
    batch.ensureAtLeast(0);
    batch.ensureAtLeast(-10);
    batch.ensureAtLeast(Number.NaN);
    expect(batch.spentUsd()).toBeCloseTo(4, 9);
  });
});

describe("a resume restores the batch total", () => {
  it("writes a nonzero batchUsd into the checkpoint in the first place", async () => {
    const checkpoint = await pausedCheckpoint(tempOut());
    expect(checkpoint.ledger.batchUsd).toBeGreaterThan(0);
  });

  it("restores that amount when the caller supplies nothing", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const batch = new BatchAccount();
    const opts = options(out, answeringClient(), { resumeFrom: checkpoint, batch });

    await runLiveGame(opts, preflight(opts));
    // The restored history plus whatever the resumed run spent on top.
    expect(batch.spentUsd()).toBeGreaterThan(checkpoint.ledger.batchUsd);
  });

  /**
   * The exact regression. The CLI used to hand in a fresh empty account, which
   * overrode restoration and zeroed the batch total.
   */
  it("cannot be erased by an empty caller-supplied account", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const empty = new BatchAccount();
    expect(empty.spentUsd()).toBe(0);

    const opts = options(out, limitedClient(0), { resumeFrom: checkpoint, batch: empty });
    await runLiveGame(opts, preflight(opts));

    // Even though the resumed run spent nothing (its first request threw), the
    // account knows about the history it was handed.
    expect(empty.spentUsd()).toBeGreaterThanOrEqual(checkpoint.ledger.batchUsd);
  });

  it("preserves a caller-supplied total that is already higher", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const shared = new BatchAccount(40);

    const opts = options(out, limitedClient(0), { resumeFrom: checkpoint, batch: shared });
    await runLiveGame(opts, preflight(opts));

    expect(checkpoint.ledger.batchUsd).toBeLessThan(40);
    expect(shared.spentUsd()).toBeCloseTo(40, 6);
  });

  it("does not double-count when the same checkpoint is resumed twice", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const shared = new BatchAccount();

    // Two resumes onto the SAME account, each spending nothing of its own.
    const a = options(out, limitedClient(0), { resumeFrom: checkpoint, batch: shared });
    await runLiveGame(a, preflight(a));
    const afterFirst = shared.spentUsd();

    const b = options(out, limitedClient(0), { resumeFrom: checkpoint, batch: shared });
    await runLiveGame(b, preflight(b));

    expect(shared.spentUsd()).toBeCloseTo(afterFirst, 9);
    expect(shared.spentUsd()).toBeCloseTo(checkpoint.ledger.batchUsd, 6);
  });
});

describe("the restored total reaches the ceiling before the next request", () => {
  it("appears in the preflight projection", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const opts = options(out, answeringClient(), { resumeFrom: checkpoint });
    const ready = preflight(opts);

    expect(ready.projection.alreadySpentBatchUsd).toBeCloseTo(checkpoint.ledger.batchUsd, 9);
    expect(ready.projection.alreadySpentUsd).toBeGreaterThan(0);
  });

  it("is included in the projected batch spend of the very next request", () => {
    const config = loadConfig();
    const batch = new BatchAccount();
    batch.ensureAtLeast(60);
    const ledger = new CallLedger(config, batch);

    const verdict = ledger.mayCall({ estimatedInputTokens: 10_000, maxOutputTokens: 2_000 });
    // 60 restored + 0.044 for the request being considered.
    expect(verdict.projectedBatchUsd).toBeCloseTo(60.044, 6);
    expect(verdict.ok).toBe(true);
  });

  /**
   * The ceiling this bug made escapable. A resumed run whose restored batch
   * total is at the limit must stop BEFORE sending, not after.
   */
  it("still stops at the $100 batch ceiling after a resume", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const nearlyFull = new BatchAccount(100);

    const client = answeringClient();
    let sent = 0;
    const counting: ModelClient = {
      name: "counting",
      async complete(request) {
        sent += 1;
        return client.complete(request);
      },
    };

    const opts = options(out, counting, { resumeFrom: checkpoint, batch: nearlyFull });
    const result = await runLiveGame(opts, preflight(opts));

    expect(result.status).toBe("paused_cost_limit");
    // Nothing was sent: the projection stopped it in front of the gate.
    expect(sent).toBe(0);
    const written = parseCheckpoint(readFileSync(result.checkpointPath!, "utf8"));
    expect(written.pauseReason).toBe("paused_cost_limit");
  });

  it("would have let the run continue if the total had been reset", async () => {
    // The counterfactual, stated as a test so the regression is not abstract:
    // with an empty account the same position is allowed to send.
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const config = loadConfig();

    const reset = new CallLedger(config, new BatchAccount());
    const restored = new CallLedger(config, (() => {
      const b = new BatchAccount();
      b.ensureAtLeast(100);
      return b;
    })());
    const next = { estimatedInputTokens: 10_000, maxOutputTokens: 2_000 };

    expect(reset.mayCall(next).ok).toBe(true);
    expect(restored.mayCall(next).ok).toBe(false);
    expect(restored.mayCall(next).reason).toBe("paused_cost_limit");
    expect(checkpoint.ledger.batchUsd).toBeGreaterThan(0);
  });
});

describe("the per-game ceiling is restored, not reset", () => {
  /**
   * Resume handles a transient interruption. It does NOT hand a game a fresh
   * budget: the restored ledger carries the same cumulative per-game spend, so
   * a game that stopped at $25 stops again immediately unless a human raises
   * the limit on purpose.
   */
  it("re-stops a game that had already hit the per-game limit", async () => {
    const out = tempOut();
    // A ceiling low enough that the first projection exceeds it.
    const tight = loadConfig({
      budget: {
        costWarningPerGameUsd: 0.0001,
        hardCostLimitPerGameUsd: 0.001,
        hardBatchCostLimitUsd: 0.002,
      },
    });
    const first = options(out, answeringClient(), { config: tight });
    const paused = await runLiveGame(first, preflight(first));
    expect(paused.status).toBe("paused_cost_limit");

    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    const again = options(out, answeringClient(), { config: tight, resumeFrom: checkpoint });
    const resumed = await runLiveGame(again, preflight(again));

    // Same gate, same answer. Resuming restored the budget; it did not reset it.
    expect(resumed.status).toBe("paused_cost_limit");
  });

  it("only continues past it when a human raises the ceiling explicitly", async () => {
    const out = tempOut();
    const tight = loadConfig({
      budget: {
        costWarningPerGameUsd: 0.0001,
        hardCostLimitPerGameUsd: 0.001,
        hardBatchCostLimitUsd: 0.002,
      },
    });
    const first = options(out, answeringClient(), { config: tight });
    const paused = await runLiveGame(first, preflight(first));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    // The default config has the real $25/$100 ceilings and the same pricing
    // version, so the resume is compatible — the operator has simply decided
    // to allow more.
    const raised = options(out, answeringClient(), { resumeFrom: checkpoint });
    const resumed = await runLiveGame(raised, preflight(raised));
    expect(resumed.status).toBe("completed");
  });
});

describe("the ledger's own restoration", () => {
  it("carries the per-game spend, not just the batch figure", () => {
    const config = loadConfig();
    const ledger = new CallLedger(config, new BatchAccount());
    ledger.restore({
      calls: 12,
      cached: 3,
      failures: 1,
      retries: 2,
      usage: usageOf({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 }),
      totalLatencyMs: 5_000,
      batchUsd: 7,
    });
    const snapshot = ledger.snapshot();
    expect(snapshot.calls).toBe(12);
    expect(snapshot.retries).toBe(2);
    // 1M uncached input at $2 + 100k output at $12 = 2 + 1.2
    expect(snapshot.costUsd).toBeCloseTo(3.2, 6);
  });
});
