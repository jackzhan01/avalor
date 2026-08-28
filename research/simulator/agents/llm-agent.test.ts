import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type SimConfig } from "../config/load";
import { checkInvariants } from "../fixtures/invariants";
import { CallLedger, ModelCallError, cached, type ModelClient } from "../model/client";
import { usageOf } from "../model/pricing";
import { answeringClient, counting, transcriptClient } from "../model/scripted-client";
import { assignPersonas } from "../prompts/personas";
import { makeCustomStrategy, strategyById } from "../prompts/strategies";
import {
  buildPrivateResearchTrace,
  buildPublicReplay,
  serialisePublicReplay,
  type SeatConfigurations,
} from "../run/artifacts";
import { fingerprint, runGame, UnrecoverableAgentError } from "../run/runner";
import { SEATS, type Seat } from "../core/types";
import { llmAgent, PausedError, type ModelAttempt } from "./llm-agent";
import type { AgentTable } from "./agent";

/**
 * Ten language-model seats playing a whole game — with no language model.
 *
 * Everything real is in the path: the prompt builder, the strict JSON schema,
 * the parser, the referee, the repair loop. The only thing swapped out is the
 * provider, which is the piece that costs money and cannot be run in a unit
 * test. `globalThis.fetch` is failed for the whole file, so "offline" is an
 * assertion rather than an intention.
 */

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    fetchCalls += 1;
    throw new Error("the offline suite must not make network calls");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Built {
  readonly agents: AgentTable;
  readonly ledger: CallLedger;
  readonly calls: ModelAttempt[];
  readonly seats: SeatConfigurations;
}

function buildTable(
  client: ModelClient,
  config: SimConfig = loadConfig(),
  seed = 7,
  strategy = strategyById("baseline"),
): Built {
  const personas = assignPersonas(seed);
  const ledger = new CallLedger(config);
  const calls: ModelAttempt[] = [];
  const seats: SeatConfigurations = {};
  const table = {} as Record<Seat, ReturnType<typeof llmAgent>>;

  for (const seat of SEATS) {
    seats[seat] = {
      persona: personas[seat].id,
      strategy: strategy.id,
      ...(strategy.customText ? { customStrategyText: strategy.customText } : {}),
    };
    table[seat] = llmAgent(seat, {
      client,
      persona: personas[seat],
      strategy,
      config,
      onSend: () => ledger.beginAttempt(),
      onAttempt: (record) => {
        calls.push(record);
        // What a batch runner does: the agent reports, the ledger counts. A
        // failed attempt has no usage — unknown, not zero.
        if (record.usage === null) ledger.failAttempt();
        else {
          ledger.settleAttempt({
            usage: record.usage,
            latencyMs: record.latencyMs,
            cached: record.cached,
          });
          if (record.outcome === "invalid") ledger.recordRetry();
        }
      },
      mayCall: (next) => ledger.mayCall(next),
    });
  }
  return { agents: table, ledger, calls, seats };
}

describe("a full game played by ten model seats", () => {
  it("finishes legally, offline, through the real prompt and parser", async () => {
    const client = counting(answeringClient());
    const { agents, calls } = buildTable(client);

    const result = await runGame({ seed: 7, agents, runId: "run-A" });

    expect(result.outcome).toBeDefined();
    expect(checkInvariants(result.state, result.actions)).toEqual([]);
    // Every decision went through a model call, and every call parsed.
    expect(client.calls()).toBe(result.actions.length);
    expect(calls.every((c) => c.outcome === "valid")).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it("records what every call cost, priced from the configured table", async () => {
    const { agents, ledger } = buildTable(counting(answeringClient()));
    await runGame({ seed: 8, agents });
    const snapshot = ledger.snapshot();
    expect(snapshot.calls).toBeGreaterThan(50);
    expect(snapshot.usage.inputTokens).toBeGreaterThan(0);
    expect(snapshot.usage.cachedInputTokens).toBeGreaterThan(0);
    expect(snapshot.usage.reasoningTokens).toBeGreaterThan(0);
    expect(snapshot.costUsd).not.toBeNull();
    expect(snapshot.costUsd!).toBeGreaterThan(0);
  });

  it("reaches every decision kind", async () => {
    const { agents, calls } = buildTable(counting(answeringClient()));
    await runGame({ seed: 7, agents });
    const seen = new Set(calls.map((c) => c.taskId));
    for (const taskId of [
      "opening-direction",
      "speech-opening",
      "speech-regular",
      "leader-close-and-propose",
      "vote",
      "lady-select",
      "lady-announce",
      "evil-discuss",
      "assassinate",
    ]) {
      expect(seen, taskId).toContain(taskId);
    }
  });

  it("is reproducible when the provider is", async () => {
    const a = await runGame({ seed: 11, agents: buildTable(answeringClient()).agents });
    const b = await runGame({ seed: 11, agents: buildTable(answeringClient()).agents });
    expect(fingerprint(b.state)).toBe(fingerprint(a.state));
  });

  it("saves calls when the same request comes round again", async () => {
    const inner = counting(answeringClient());
    const { agents, calls } = buildTable(cached(inner));
    await runGame({ seed: 12, agents });
    // Identical positions do recur — repeated votes on structurally identical
    // states — so the cache should have absorbed at least some of them.
    expect(inner.calls()).toBeLessThanOrEqual(calls.length);
    expect(fetchCalls).toBe(0);
  });
});

describe("repair, and where it stops", () => {
  it("asks again when the answer will not parse, and carries on", async () => {
    // One unparseable answer at the very first decision, then the double takes
    // over. The game must complete and the retry must be recorded.
    const client = transcriptClient({
      inOrder: ["抱歉，我不能参与。"],
      fallback: answeringClient(),
    });
    const { agents, calls } = buildTable(client);
    const rejections: string[] = [];

    const result = await runGame({
      seed: 13,
      agents,
      onRejection: (_seat, feedback) => rejections.push(feedback.error),
    });

    expect(result.outcome).toBeDefined();
    expect(rejections).toHaveLength(1);
    expect(calls.filter((c) => c.outcome !== "valid")).toHaveLength(1);
    expect(calls[0].validationError).toBeTruthy();
    // The second attempt is recorded as attempt 2 of the same decision.
    expect(calls[1].attempt).toBe(2);
  });

  it("puts the referee's own words in front of the model", async () => {
    // An illegal team: the right size test lives in the referee, and its
    // message is the most useful thing a model can be told.
    const badTeam = JSON.stringify({
      publicMessage: "就这两个。",
      team: [1, 2],
      memoryPatch: null,
      rationale: null,
    });
    const client = transcriptClient({ inOrder: [], fallback: answeringClient() });
    const wrapped: ModelClient = {
      name: "one-bad-team",
      complete: (() => {
        let sentBadTeam = false;
        return async (request) => {
          if (!sentBadTeam && request.format.name === "avalon_leader_close_and_propose") {
            sentBadTeam = true;
            return {
              text: badTeam,
              usage: usageOf({ inputTokens: 1, outputTokens: 1 }),
              latencyMs: 0,
              cached: false,
              modelReturned: "double",
              status: "completed" as const,
            };
          }
          return client.complete(request);
        };
      })(),
    };

    const { agents } = buildTable(wrapped);
    const rejections: string[] = [];
    const result = await runGame({
      seed: 14,
      agents,
      onRejection: (_seat, feedback) => rejections.push(feedback.error),
    });

    expect(result.outcome).toBeDefined();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain("要 3 个人上车");
    expect(checkInvariants(result.state, result.actions)).toEqual([]);
  });

  /**
   * The line that must not be crossed. When the retry budget runs out the game
   * FAILS. Substituting a scripted turn would produce a game belonging to
   * neither arm of any comparison, and calling the run "completed" would be
   * worse than a failure because nothing downstream could tell.
   */
  it("fails the game rather than substituting a scripted turn", async () => {
    const client = transcriptClient({ inOrder: [], fallback: undefined, byKey: {} });
    const alwaysBad: ModelClient = {
      name: "always-bad",
      async complete() {
        return {
          text: "我不打算回答。",
          usage: usageOf({ inputTokens: 1, outputTokens: 1 }),
          latencyMs: 0,
          cached: false,
          modelReturned: "double",
          status: "completed" as const,
        };
      },
    };
    void client;
    const { agents } = buildTable(alwaysBad);

    await expect(runGame({ seed: 15, agents })).rejects.toBeInstanceOf(
      UnrecoverableAgentError,
    );
  });

  it("tries exactly maxRetries + 1 times before giving up", async () => {
    const config = loadConfig({ run: { maxRetries: 2 } });
    let attempts = 0;
    const alwaysBad: ModelClient = {
      name: "always-bad",
      async complete() {
        attempts += 1;
        return {
          text: "nope",
          usage: usageOf({ inputTokens: 1, outputTokens: 1 }),
          latencyMs: 0,
          cached: false,
          modelReturned: "double",
          status: "completed" as const,
        };
      },
    };
    const { agents } = buildTable(alwaysBad, config);
    await expect(runGame({ seed: 16, agents, config })).rejects.toThrow(
      /连试 3 次仍未给出合法动作/,
    );
    expect(attempts).toBe(3);
  });

  it("lets a provider failure through untouched, sanitised", async () => {
    const failing: ModelClient = {
      name: "failing",
      async complete() {
        throw new ModelCallError(429, "rate_limit_error", "rate_limit_exceeded", "太快了");
      },
    };
    const { agents } = buildTable(failing);
    await expect(runGame({ seed: 17, agents })).rejects.toBeInstanceOf(ModelCallError);
  });
});

describe("the ceilings stop the run rather than degrading it", () => {
  it("pauses at the input limit without sending anything", async () => {
    // A limit low enough that even the opening prompt cannot fit.
    const config = loadConfig({ limits: { maxStandardInputTokens: 10 } });
    const client = counting(answeringClient());
    const { agents } = buildTable(client, config);

    await expect(runGame({ seed: 18, agents, config })).rejects.toBeInstanceOf(PausedError);
    // Nothing was sent: the ceiling is checked before the call is made.
    expect(client.calls()).toBe(0);
  });

  it("names the reason a checkpoint needs, and refuses the forbidden remedies", async () => {
    const config = loadConfig({ limits: { maxStandardInputTokens: 10 } });
    const { agents } = buildTable(answeringClient(), config);
    let caught: unknown;
    try {
      await runGame({ seed: 19, agents, config });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PausedError);
    const paused = caught as PausedError;
    expect(paused.reason).toBe("paused_input_limit");
    expect(paused.message).toContain("不截断、不摘要、不换模型、不退回脚本");
  });

  it("pauses at the call ceiling", async () => {
    const config = loadConfig({ limits: { maxLiveCallsPerGame: 5 } });
    const client = counting(answeringClient());
    const { agents } = buildTable(client, config);

    await expect(runGame({ seed: 20, agents, config })).rejects.toBeInstanceOf(PausedError);
    // Five calls made, and the sixth refused before it was sent.
    expect(client.calls()).toBe(5);
  });
});

describe("what a model run records", () => {
  it("puts persona and strategy in both artifacts, and custom text only in the private one", async () => {
    const strategy = makeCustomStrategy("先跟票，第四轮再表态。", "跟票流");
    const { agents, seats } = buildTable(answeringClient(), loadConfig(), 21, strategy);
    const result = await runGame({ seed: 21, agents, runId: "run-B" });

    const publicReplay = buildPublicReplay(result.state, agents, { seats });
    const trace = buildPrivateResearchTrace(result.state, agents, result.actions, { seats });

    for (const entry of publicReplay.metadata.seats) {
      expect(entry.persona).toBeTruthy();
      expect(entry.strategy).toBe("custom");
    }
    for (const entry of trace.manifest.seats) {
      expect(entry.customStrategyText).toBe("先跟票，第四轮再表态。");
    }
    // The experimenter's own words are configuration, not something the table saw.
    expect(serialisePublicReplay(publicReplay)).not.toContain("先跟票，第四轮再表态。");
  });

  it("keeps raw model answers out of the public replay", async () => {
    const { agents, seats } = buildTable(answeringClient());
    const result = await runGame({ seed: 22, agents, runId: "run-C" });
    const text = serialisePublicReplay(buildPublicReplay(result.state, agents, { seats }));
    for (const forbidden of ["rationale", "memoryPatch", "offline double", "promptKey"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
