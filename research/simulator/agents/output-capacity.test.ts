import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/load";
import { createGame } from "../core/referee";
import { observationFor } from "../core/observation";
import type { ModelClient, ModelRequest, ModelResponse } from "../model/client";
import { PausedError } from "./llm-agent";
import { assignPersonas } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import type { ModelAttempt } from "../model/attempt";
import { llmAgent, OutputCapacityExhausted, UnparseableAnswer } from "./llm-agent";
import { answeringClient } from "../model/scripted-client";

/**
 * An answer that never arrived is not an answer that came out wrong.
 *
 * The first paid game died here. Nine responses came back with
 * `status: "incomplete"`, `incompleteReason: "max_output_tokens"` and the
 * entire 2000-token budget spent on reasoning — four of them with zero visible
 * characters. The agent treated each as malformed JSON and retried with a
 * repair note appended, which gave the model MORE to think about, so the
 * retries returned even less than the originals. Three strikes and the run
 * was over.
 *
 * The policy these tests pin down: recognise capacity exhaustion as its own
 * thing, never parse it, never append a repair note, resend the identical
 * prompt exactly once, and then stop permanently.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("this suite must not make network calls");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = loadConfig();

/** A response that ran out of budget, with an optional truncated prefix. */
function exhausted(text = ""): ModelResponse {
  return {
    text,
    usage: {
      inputTokens: 13_000,
      cachedInputTokens: 1_900,
      outputTokens: CONFIG.limits.maxOutputTokens,
      reasoningTokens: CONFIG.limits.maxOutputTokens,
    },
    latencyMs: 24_000,
    cached: false,
    modelReturned: "offline-double",
    status: "incomplete",
    incompleteReason: "max_output_tokens",
  };
}

interface Harness {
  readonly client: ModelClient;
  readonly sent: ModelRequest[];
}

/** Answers exhausted for the first `n` sends, then defers to a legal answer. */
function exhaustingClient(n: number, prefix = ""): Harness {
  const legal = answeringClient();
  const sent: ModelRequest[] = [];
  let count = 0;
  return {
    sent,
    client: {
      name: "exhausting",
      async complete(request: ModelRequest): Promise<ModelResponse> {
        sent.push(request);
        count += 1;
        if (count <= n) return exhausted(prefix);
        return legal.complete(request);
      },
    },
  };
}

function firstObservation() {
  const state = createGame({ seed: 5, config: CONFIG });
  return observationFor(state, state.pending!.seat);
}

function agentFor(client: ModelClient, calls: ModelAttempt[], capacity: string[] = []) {
  const observation = firstObservation();
  const seat = observation.seat;
  return {
    observation,
    agent: llmAgent(seat, {
      client,
      persona: assignPersonas(5)[seat],
      strategy: strategyById("baseline"),
      config: CONFIG,
      onAttempt: (record) => calls.push(record),
      onCapacityRetry: (s, taskId) => capacity.push(`${s}:${taskId}`),
    }),
  };
}

describe("a response that ran out of output budget", () => {
  it("is never handed to the parser, even when its prefix looks like JSON", async () => {
    const calls: ModelAttempt[] = [];
    // A truncated object. The old code parsed this, failed, and called it a
    // schema error — which it is not: the model never finished writing it.
    const harness = exhaustingClient(2, '{"kind":"speech","publicMessage":"我觉得');
    const { agent, observation } = agentFor(harness.client, calls);

    await expect(agent.act(observation)).rejects.toBeInstanceOf(OutputCapacityExhausted);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.outcome).toBe("output_limit");
      // Not "invalid": there is nothing wrong with it to describe.
      expect(call.outcome).not.toBe("invalid");
      expect(call.validationError).toMatch(/输出预算耗尽/);
      expect(call.appliedLegalAction).toBe(false);
    }
  });

  it("gets exactly one retry, and it is byte-identical to the first request", async () => {
    const calls: ModelAttempt[] = [];
    const harness = exhaustingClient(2);
    const { agent, observation } = agentFor(harness.client, calls);

    await expect(agent.act(observation)).rejects.toBeInstanceOf(OutputCapacityExhausted);

    expect(harness.sent).toHaveLength(2);
    const [first, second] = harness.sent;
    // The whole point: the request was not wrong, so nothing about it changes.
    expect(second.user).toBe(first.user);
    expect(second.system).toBe(first.system);
    expect(second.model).toBe(first.model);
    expect(second.reasoningEffort).toBe(first.reasoningEffort);
    expect(second.maxOutputTokens).toBe(first.maxOutputTokens);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("never receives the ordinary JSON repair note", async () => {
    const calls: ModelAttempt[] = [];
    const harness = exhaustingClient(2);
    const { agent, observation } = agentFor(harness.client, calls);

    await expect(agent.act(observation)).rejects.toBeInstanceOf(OutputCapacityExhausted);

    for (const request of harness.sent) {
      expect(request.user).not.toMatch(/上一次的回答被裁判打回了/);
      expect(request.user).not.toMatch(/第 \d+ 次重试/);
    }
  });

  it("stops permanently after the second exhaustion — no third send", async () => {
    const calls: ModelAttempt[] = [];
    const harness = exhaustingClient(99);
    const { agent, observation } = agentFor(harness.client, calls);

    await expect(agent.act(observation)).rejects.toBeInstanceOf(OutputCapacityExhausted);
    expect(harness.sent).toHaveLength(2);
  });

  it("succeeds when the single retry does come back complete", async () => {
    const calls: ModelAttempt[] = [];
    const harness = exhaustingClient(1);
    const { agent, observation } = agentFor(harness.client, calls);

    const action = await agent.act(observation);
    expect(action).toBeTruthy();
    expect(harness.sent).toHaveLength(2);
    expect(calls.map((c) => c.outcome)).toEqual(["output_limit", "valid"]);
  });

  it("marks the two sends apart with capacityAttempt, not with attempt", async () => {
    const calls: ModelAttempt[] = [];
    const harness = exhaustingClient(1);
    const { agent, observation } = agentFor(harness.client, calls);
    await agent.act(observation);

    expect(calls.map((c) => c.capacityAttempt)).toEqual([1, 2]);
    // `attempt` counts REPHRASINGS. Neither of these was a rephrasing.
    expect(calls.map((c) => c.attempt)).toEqual([1, 1]);
  });

  it("announces the capacity retry so a run can count it separately", async () => {
    const calls: ModelAttempt[] = [];
    const capacity: string[] = [];
    const harness = exhaustingClient(1);
    const { agent, observation } = agentFor(harness.client, calls, capacity);
    await agent.act(observation);

    expect(capacity).toHaveLength(1);
    expect(capacity[0]).toMatch(/^\d+:/);
  });

  it("records both sends, each with its own usage", async () => {
    const calls: ModelAttempt[] = [];
    const harness = exhaustingClient(1);
    const { agent, observation } = agentFor(harness.client, calls);
    await agent.act(observation);

    expect(calls).toHaveLength(2);
    // Both were billed. Recording only the successful one would under-count.
    expect(calls[0].usage).not.toBeNull();
    expect(calls[1].usage).not.toBeNull();
    expect(calls[0].incompleteReason).toBe("max_output_tokens");
    expect(calls[1].status).toBe("completed");
  });

  it("passes the budget gate again before the retry, because it is a real call", async () => {
    const calls: ModelAttempt[] = [];
    const observation = firstObservation();
    const seat = observation.seat;
    let gateChecks = 0;
    let sends = 0;

    const agent = llmAgent(seat, {
      client: {
        name: "always-exhausted",
        async complete() {
          sends += 1;
          return exhausted();
        },
      },
      persona: assignPersonas(5)[seat],
      strategy: strategyById("baseline"),
      config: CONFIG,
      onAttempt: (record) => calls.push(record),
      // Allows the first, refuses the second: a ceiling reached between the
      // two sends must stop the retry, not be projected once and sent twice.
      mayCall: () => {
        gateChecks += 1;
        return gateChecks === 1
          ? {
              ok: true,
              level: "ok" as const,
              reason: null,
              detail: "",
              projectedGameUsd: 1,
              projectedBatchUsd: 1,
            }
          : {
              ok: false,
              level: "stop" as const,
              reason: "paused_cost_limit" as const,
              detail: "撞到单局上限",
              projectedGameUsd: 26,
              projectedBatchUsd: 26,
            };
      },
    });

    await expect(agent.act(observation)).rejects.toBeInstanceOf(PausedError);
    expect(gateChecks).toBe(2);
    expect(sends).toBe(1);
  });
});

describe("ordinary malformed JSON is untouched by the new path", () => {
  it("still gets the repair note and the ordinary retry loop", async () => {
    const calls: ModelAttempt[] = [];
    const sent: ModelRequest[] = [];
    const observation = firstObservation();
    const seat = observation.seat;

    const agent = llmAgent(seat, {
      client: {
        name: "garbage",
        async complete(request) {
          sent.push(request);
          return {
            text: "这不是 JSON",
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              outputTokens: 40,
              reasoningTokens: 10,
            },
            latencyMs: 1,
            cached: false,
            modelReturned: "offline-double",
            // Completed. The model finished and got it wrong — a real schema
            // error, and the repair note is the right response to it.
            status: "completed",
          };
        },
      },
      persona: assignPersonas(5)[seat],
      strategy: strategyById("baseline"),
      config: CONFIG,
      onAttempt: (record) => calls.push(record),
    });

    await expect(agent.act(observation)).rejects.toBeInstanceOf(UnparseableAnswer);
    expect(sent).toHaveLength(1);
    expect(calls[0].outcome).toBe("invalid");
    expect(calls[0].capacityAttempt).toBe(1);

    // Second pass, now with feedback: the repair note IS appended here.
    await expect(
      agent.act(observation, { attempt: 1, error: "不是合法 JSON" }),
    ).rejects.toBeInstanceOf(UnparseableAnswer);
    expect(sent[1].user).toMatch(/上一次的回答被裁判打回了/);
  });

  it("does not treat other incomplete reasons as capacity exhaustion", async () => {
    const calls: ModelAttempt[] = [];
    const sent: ModelRequest[] = [];
    const observation = firstObservation();
    const seat = observation.seat;

    const agent = llmAgent(seat, {
      client: {
        name: "filtered",
        async complete(request) {
          sent.push(request);
          return { ...exhausted("{}"), incompleteReason: "content_filter" };
        },
      },
      persona: assignPersonas(5)[seat],
      strategy: strategyById("baseline"),
      config: CONFIG,
      onAttempt: (record) => calls.push(record),
    });

    // A filter is a different problem with a different fix. Silently resending
    // an identical prompt for it would be a retry policy nobody chose.
    await expect(agent.act(observation)).rejects.toBeInstanceOf(UnparseableAnswer);
    expect(sent).toHaveLength(1);
    expect(calls[0].outcome).toBe("invalid");
  });
});

describe("the cap itself", () => {
  it("comes from the configuration, with no hard-coded fallback", async () => {
    const calls: ModelAttempt[] = [];
    const sent: ModelRequest[] = [];
    const observation = firstObservation();
    const seat = observation.seat;
    const legal = answeringClient();

    const agent = llmAgent(seat, {
      client: {
        name: "recording",
        async complete(request) {
          sent.push(request);
          return legal.complete(request);
        },
      },
      persona: assignPersonas(5)[seat],
      strategy: strategyById("baseline"),
      config: CONFIG,
      onAttempt: (record) => calls.push(record),
    });
    await agent.act(observation);

    expect(sent[0].maxOutputTokens).toBe(CONFIG.limits.maxOutputTokens);
    expect(sent[0].maxOutputTokens).toBe(12000);
    // The number that killed the first game must not be reachable by default.
    expect(sent[0].maxOutputTokens).not.toBe(2000);
  });

  it("honours an explicit override without inventing one", async () => {
    const sent: ModelRequest[] = [];
    const observation = firstObservation();
    const seat = observation.seat;
    const legal = answeringClient();

    const agent = llmAgent(seat, {
      client: {
        name: "recording",
        async complete(request) {
          sent.push(request);
          return legal.complete(request);
        },
      },
      persona: assignPersonas(5)[seat],
      strategy: strategyById("baseline"),
      config: CONFIG,
      maxOutputTokens: 12_345,
      onAttempt: () => {},
    });
    await agent.act(observation);

    expect(sent[0].maxOutputTokens).toBe(12_345);
  });
});
