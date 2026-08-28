import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/load";
import { capturePrompts } from "../fixtures/prompt-fixtures";
import {
  BatchAccount,
  CallLedger,
  ModelCallError,
  cached,
  requestKey,
  safeMessage,
  type ModelRequest,
} from "./client";
import { jsonSchemaFor, schemaNameFor, fragmentFor } from "./json-schema";
import { answeringClient, counting, transcriptClient } from "./scripted-client";
import {
  addUsage,
  emptyUsage,
  estimateCostUsd,
  pessimisticActualUsd,
  pessimisticTokenEstimate,
  projectedRequestUsd,
  usageOf,
  worstCaseCostUsd,
} from "./pricing";

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    fetchCalls += 1;
    throw new Error("nothing in the offline model layer may call fetch");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function sampleRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    system: "系统",
    user: "用户",
    maxOutputTokens: 100,
    format: { name: "avalon_vote", schema: { type: "object" }, strict: true },
    ...overrides,
  };
}

describe("the request key", () => {
  it("is stable for the same request", () => {
    expect(requestKey(sampleRequest())).toBe(requestKey(sampleRequest()));
  });

  /**
   * Two runs at different reasoning effort are two different experiments. A key
   * that ignored it would serve one run's answers to the other and the
   * comparison would silently be a comparison of nothing.
   */
  it("separates two runs that differ only in reasoning effort", () => {
    expect(requestKey(sampleRequest({ reasoningEffort: "low" }))).not.toBe(
      requestKey(sampleRequest({ reasoningEffort: "high" })),
    );
  });

  it("separates two runs that differ only in the model", () => {
    expect(requestKey(sampleRequest({ model: "other" }))).not.toBe(
      requestKey(sampleRequest()),
    );
  });

  it("separates two requests that differ only in the schema", () => {
    expect(
      requestKey(
        sampleRequest({
          format: { name: "avalon_vote", schema: { type: "string" }, strict: true },
        }),
      ),
    ).not.toBe(requestKey(sampleRequest()));
  });

  it("separates two prompts", () => {
    expect(requestKey(sampleRequest({ user: "别的" }))).not.toBe(requestKey(sampleRequest()));
  });
});

describe("caching", () => {
  it("answers an identical request without calling through", async () => {
    const inner = counting(answeringClient());
    const client = cached(inner);
    const request = sampleRequest({
      format: { name: "avalon_vote", schema: {}, strict: true },
    });

    const first = await client.complete(request);
    const second = await client.complete(request);

    expect(inner.calls()).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.text).toBe(first.text);
    // A cache hit costs no wall clock, and saying so keeps latency stats honest.
    expect(second.latencyMs).toBe(0);
  });

  it("calls again for a different request", async () => {
    const inner = counting(answeringClient());
    const client = cached(inner);
    await client.complete(sampleRequest({ format: { name: "avalon_vote", schema: {}, strict: true } }));
    await client.complete(
      sampleRequest({
        user: "别的",
        format: { name: "avalon_vote", schema: {}, strict: true },
      }),
    );
    expect(inner.calls()).toBe(2);
  });

  /**
   * A refusal or a malformed answer is cached too. Re-rolling until something
   * parses would report a distribution the model does not actually have — the
   * lesson `research/llm-client.ts` already wrote down.
   */
  it("caches a malformed answer rather than re-rolling it", async () => {
    const inner = counting(transcriptClient({ inOrder: ["not json", "not json either"] }));
    const client = cached(inner);
    const request = sampleRequest();
    const a = await client.complete(request);
    const b = await client.complete(request);
    expect(inner.calls()).toBe(1);
    expect(b.text).toBe(a.text);
  });
});

describe("the ledger", () => {
  const config = loadConfig();

  it("counts live calls, cache hits, tokens and latency", () => {
    const ledger = new CallLedger(config);
    const usage = usageOf({ inputTokens: 100, outputTokens: 20 });
    ledger.record({ usage, latencyMs: 50, cached: false });
    ledger.record({ usage, latencyMs: 0, cached: true });
    const snapshot = ledger.snapshot();
    expect(snapshot.calls).toBe(1);
    expect(snapshot.cached).toBe(1);
    expect(snapshot.usage.inputTokens).toBe(200);
    expect(snapshot.totalLatencyMs).toBe(50);
  });

  it("counts a failed attempt as spent, because it was", () => {
    const ledger = new CallLedger(config);
    ledger.recordFailure();
    expect(ledger.snapshot().calls).toBe(1);
    expect(ledger.snapshot().failures).toBe(1);
  });

  it("reports no cost when a run turns pricing off", () => {
    // Null, not zero. A `?? 0` here would make every budget check pass forever.
    const blind = loadConfig({ pricing: { configured: false } });
    const ledger = new CallLedger(blind);
    ledger.recordFailure();
    expect(ledger.snapshot().costUsd).toBeNull();
  });

  it("prices cached input separately from uncached input", () => {
    // 1M input of which 600k was cached, plus 1M output, at 2 / 0.2 / 12:
    // (0.4M x 2 + 0.6M x 0.2 + 1M x 12) / 1M = 0.8 + 0.12 + 12 = 12.92
    const ledger = new CallLedger(config);
    ledger.record({
      usage: usageOf({
        inputTokens: 1_000_000,
        cachedInputTokens: 600_000,
        outputTokens: 1_000_000,
      }),
      latencyMs: 1,
      cached: false,
    });
    expect(ledger.snapshot().costUsd).toBeCloseTo(12.92, 6);
  });

  it("stops at the call ceiling with a reason a checkpoint can use", () => {
    const tiny = loadConfig({ limits: { maxLiveCallsPerGame: 2 } });
    const ledger = new CallLedger(tiny);
    const response = { usage: emptyUsage(), latencyMs: 1, cached: false };
    const next = { estimatedInputTokens: 10, maxOutputTokens: 10 };
    expect(ledger.mayCall(next).ok).toBe(true);
    ledger.record(response);
    expect(ledger.mayCall(next).ok).toBe(true);
    ledger.record(response);
    const verdict = ledger.mayCall(next);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("paused_call_limit");
  });
});

/**
 * The wiring that was missing. `checkBudget` existed and was tested, but
 * nothing on the call path ever invoked it, so the $12/$25/$100 ceilings were
 * decoration. These are the boundaries, exactly.
 */
describe("the money ceilings, checked before a request is sent", () => {
  const config = loadConfig();
  const next = { estimatedInputTokens: 10_000, maxOutputTokens: 2_000 };
  /** What one more request of that shape would add: 0.02 + 0.024 = 0.044. */
  const increment = 0.044;

  /**
   * Load the ledger with a known amount of already-spent usage.
   *
   * Amounts are given in TOKENS, not dollars, and only in multiples that price
   * exactly: uncached input is $2/M, so 500,000 tokens is exactly $1. Going
   * dollars → tokens → dollars would round-trip through a non-representable
   * value and leave the boundary assertions comparing 25.000004 against 25.
   *
   * The exact ordering semantics of the comparisons (at the limit is allowed,
   * above it stops) are pinned in `core/budget.test.ts`, which uses literal
   * dollar values and no round trip. What is tested HERE is the wiring: that
   * the projection reaches those comparisons at all.
   */
  const usdToInputTokens = (usd: number) =>
    Math.round((usd / config.pricing.uncachedInputUsdPerMTok) * 1_000_000);

  function ledgerAt(usd: number, batch?: BatchAccount): CallLedger {
    const ledger = new CallLedger(config, batch);
    ledger.record({
      usage: usageOf({ inputTokens: usdToInputTokens(usd) }),
      latencyMs: 0,
      cached: false,
    });
    return ledger;
  }

  it("is quiet well below the warning line", () => {
    const verdict = ledgerAt(1).mayCall(next);
    expect(verdict.level).toBe("ok");
    expect(verdict.ok).toBe(true);
    expect(verdict.projectedGameUsd).toBeCloseTo(1 + increment, 6);
  });

  it("warns once the PROJECTION crosses the warning line, not once spend does", () => {
    // 11.90 spent, projecting 11.944 — still under.
    expect(ledgerAt(11.9).mayCall(next).level).toBe("ok");
    // 11.96 spent, projecting 12.004 — over, and the warning fires on the
    // projection rather than waiting for the money to actually leave.
    expect(ledgerAt(11.96).mayCall(next).level).toBe("warn");
  });

  it("allows a projection under the per-game ceiling and stops one over it", () => {
    const under = ledgerAt(24.9).mayCall(next);
    expect(under.ok).toBe(true);
    expect(under.level).toBe("warn");

    const over = ledgerAt(25).mayCall(next);
    expect(over.ok).toBe(false);
    expect(over.level).toBe("stop");
    expect(over.reason).toBe("paused_cost_limit");
    expect(over.detail).toContain("单局上限");
  });

  it("stops on the batch ceiling first, because that is what was authorised", () => {
    const batch = new BatchAccount();
    batch.add(100);
    const verdict = new CallLedger(config, batch).mayCall(next);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("paused_cost_limit");
    expect(verdict.detail).toContain("批量上限");
  });

  it("carries a game's spend into the batch total", () => {
    const batch = new BatchAccount();
    ledgerAt(5, batch);
    expect(batch.spentUsd()).toBeCloseTo(5, 6);
    // A second game on the same batch sees the first one's spend.
    ledgerAt(5, batch);
    expect(batch.spentUsd()).toBeCloseTo(10, 6);
  });

  it("refuses to run at all when the price list is missing", () => {
    // Nothing was overspent — the guard simply cannot see, and running behind
    // a blind gate is worse than stopping in front of a visible one.
    const blind = new CallLedger(loadConfig({ pricing: { configured: false } }));
    const verdict = blind.mayCall(next);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("paused_pricing_unconfigured");
    expect(verdict.projectedGameUsd).toBeNull();
  });

  it("prices the projection as fully uncached, so it can only over-state", () => {
    // The next request's input is almost certainly mostly cached, and its
    // output almost certainly shorter than the cap. Both errors point the same
    // way on purpose: this decides whether to send at all.
    expect(projectedRequestUsd(10_000, 2_000, config.pricing)).toBeCloseTo(increment, 9);
    expect(
      estimateCostUsd(
        usageOf({ inputTokens: 10_000, cachedInputTokens: 10_000, outputTokens: 2_000 }),
        config.pricing,
      )!,
    ).toBeLessThan(increment);
  });
});

describe("errors carry the useful part and nothing else", () => {
  it("names status, provider type and code", () => {
    const error = new ModelCallError(404, "invalid_request_error", "model_not_found", "没有这个模型");
    expect(error.describe()).toBe(
      "HTTP 404 / invalid_request_error / model_not_found: 没有这个模型",
    );
  });

  it("says 'network' when there was no response at all", () => {
    expect(new ModelCallError(null, null, null, "连不上").describe()).toBe("network: 连不上");
  });

  it("flattens and truncates whatever the provider said", () => {
    const long = safeMessage(`a\n\nb   c${"x".repeat(500)}`);
    expect(long).not.toContain("\n");
    expect(long.length).toBeLessThanOrEqual(301);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns an empty string for a non-string", () => {
    expect(safeMessage({ secret: "x" })).toBe("");
    expect(safeMessage(undefined)).toBe("");
  });
});

describe("pricing", () => {
  it("adds usage without losing the cached or reasoning breakdown", () => {
    const total = addUsage(
      usageOf({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningTokens: 1 }),
      usageOf({ inputTokens: 30, cachedInputTokens: 6, outputTokens: 4, reasoningTokens: 2 }),
    );
    expect(total).toEqual({
      inputTokens: 40,
      cachedInputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 3,
    });
  });

  it("clamps a provider that reports more cached than total", () => {
    // Otherwise the uncached portion goes negative and quietly reduces the bill.
    const usage = usageOf({ inputTokens: 100, cachedInputTokens: 999, outputTokens: 5 });
    expect(usage.cachedInputTokens).toBe(100);
    expect(estimateCostUsd(usage, loadConfig().pricing)!).toBeGreaterThan(0);
  });

  it("refuses to guess a price when none is configured", () => {
    const blind = loadConfig({ pricing: { configured: false } }).pricing;
    expect(estimateCostUsd(usageOf({ inputTokens: 1e6, outputTokens: 1e6 }), blind)).toBeNull();
    expect(projectedRequestUsd(1000, 1000, blind)).toBeNull();
  });

  it("carries where the price came from", () => {
    // A cost figure in a trace is only checkable if the reader can see which
    // price list produced it and when it was read.
    const pricing = loadConfig().pricing;
    expect(pricing.configured).toBe(true);
    expect(pricing.modelId).toBe("gpt-5.6-terra");
    expect(pricing.sourceUrl).toContain("developers.openai.com");
    expect(pricing.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pricing.pricingVersion).toBeTruthy();
    expect(pricing.uncachedInputUsdPerMTok).toBe(2);
    expect(pricing.cachedInputUsdPerMTok).toBe(0.2);
    expect(pricing.outputUsdPerMTok).toBe(12);
  });

  it("refuses a price table written for a different model", () => {
    expect(() => loadConfig({ pricing: { modelId: "some-other-model" } })).toThrow(
      /pricing.modelId/,
    );
  });

  it("bounds a smoke request below the configured ceiling", () => {
    const config = loadConfig();
    const worst = worstCaseCostUsd(config.smoke);
    // The whole point: the ceiling is checked BEFORE anything is sent, from
    // the output cap and a rate chosen to be higher than any real one.
    expect(worst.usd).toBeLessThanOrEqual(config.smoke.ceilingUsd);
    expect(worst.maxOutputTokens).toBe(config.smoke.maxOutputTokens);
  });

  it("bounds what actually happened at the same pessimistic rate", () => {
    const config = loadConfig();
    const actual = pessimisticActualUsd(usageOf({ inputTokens: 300, outputTokens: 200 }), config.smoke);
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThan(worstCaseCostUsd(config.smoke).usd);
  });

  it("estimates tokens upward, never downward", () => {
    // Over-counting pauses a run that could have continued. Under-counting
    // sends an oversized request while the gate reads green.
    expect(pessimisticTokenEstimate("")).toBeGreaterThan(0);
    expect(pessimisticTokenEstimate("阿瓦隆")).toBeGreaterThan(3);
    const long = pessimisticTokenEstimate("阿".repeat(1000));
    expect(long).toBeGreaterThan(1000);
  });
});

describe("the JSON schema that goes on the wire", () => {
  const { prompts } = capturePrompts();

  it("has a fragment for every field of every task", () => {
    for (const [taskId, prompt] of prompts) {
      for (const field of prompt.schema.fields) {
        expect(() => fragmentFor(field), `${taskId}.${field.name}`).not.toThrow();
      }
    }
  });

  it("complains loudly about a field nobody described", () => {
    expect(() =>
      fragmentFor({
        name: "somethingNew",
        type: "string",
        required: true,
        group: "action",
        description: "",
      }),
    ).toThrow(/no JSON Schema fragment/);
  });

  it("obeys strict mode: every property required, nothing extra allowed", () => {
    for (const [taskId, prompt] of prompts) {
      const schema = jsonSchemaFor(prompt.schema) as Record<string, unknown>;
      expect(schema.additionalProperties, taskId).toBe(false);
      const required = schema.required as string[];
      const properties = Object.keys(schema.properties as object);
      expect([...required].sort(), taskId).toEqual([...properties].sort());
      // Optionality is expressed by allowing null, never by omission.
      for (const field of prompt.schema.fields) {
        if (field.required) continue;
        const fragment = (schema.properties as Record<string, { type: unknown }>)[field.name];
        expect(fragment.type, `${taskId}.${field.name}`).toContain("null");
      }
    }
  });

  it("gives the provider a name it will accept", () => {
    for (const prompt of prompts.values()) {
      expect(schemaNameFor(prompt.schema)).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});

describe("the whole offline model layer", () => {
  it("never touches the network", () => {
    expect(fetchCalls).toBe(0);
  });
});
