import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/load";
import { ModelCallError, type ModelRequest } from "./client";
import {
  buildResponsesBody,
  extractOutputText,
  extractUsage,
  openAiResponsesClient,
  type FetchLike,
} from "./openai-responses";

/**
 * The live client, tested entirely offline.
 *
 * `fetch` is injected, so every path through this module runs against a stub —
 * including the ones a real request would only reveal by failing and charging
 * for it. The global `fetch` is failed for the whole file as well, so "offline"
 * is an assertion about this code rather than a property of the test setup.
 */

const realFetch = globalThis.fetch;
let globalFetchCalls = 0;

beforeEach(() => {
  globalFetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    globalFetchCalls += 1;
    throw new Error("the client must use its injected fetch, never the global");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const request: ModelRequest = {
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  system: "系统层",
  user: "用户层",
  maxOutputTokens: 2_000,
  format: {
    name: "avalon_vote",
    schema: { type: "object", additionalProperties: false, required: [], properties: {} },
    strict: true,
  },
};

interface Captured {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function stubFetch(
  respondWith: { status: number; ok: boolean; body: unknown },
  captured: Captured[] = [],
): FetchLike {
  return async (url, init) => {
    captured.push({ url, init });
    return {
      ok: respondWith.ok,
      status: respondWith.status,
      async text() {
        return typeof respondWith.body === "string"
          ? respondWith.body
          : JSON.stringify(respondWith.body);
      },
    };
  };
}

const okEnvelope = {
  id: "resp_should_not_be_logged",
  model: "gpt-5.6-terra",
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: '{"choice":"approve"}' }] },
  ],
  usage: {
    input_tokens: 5_000,
    input_tokens_details: { cached_tokens: 4_200 },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 250 },
  },
};

describe("the request body", () => {
  const body = buildResponsesBody(request) as Record<string, unknown>;

  it("names the model and the reasoning effort from the request", () => {
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("sends store: false and no tools", () => {
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([]);
  });

  it("sends the strict JSON schema in the Responses shape", () => {
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "avalon_vote",
        strict: true,
        schema: request.format.schema,
      },
    });
  });

  it("puts the static layers in instructions and the moving ones in input", () => {
    expect(body.instructions).toBe("系统层");
    expect(body.input).toBe("用户层");
  });

  it("caps the output", () => {
    expect(body.max_output_tokens).toBe(2_000);
  });

  it("passes configured provider params through untouched", () => {
    const withParams = buildResponsesBody({
      ...request,
      params: { service_tier: "flex" },
    }) as Record<string, unknown>;
    expect(withParams.service_tier).toBe("flex");
  });
});

describe("parsing the envelope", () => {
  it("walks the output list, because output_text is an SDK convenience", () => {
    expect(extractOutputText(okEnvelope)).toBe('{"choice":"approve"}');
  });

  it("accepts output_text when a caller already has it", () => {
    expect(extractOutputText({ output_text: "hi" })).toBe("hi");
  });

  it("skips reasoning items", () => {
    const text = extractOutputText({
      output: [
        { type: "reasoning", content: [{ type: "output_text", text: "SHOULD NOT APPEAR" }] },
        { type: "message", content: [{ type: "output_text", text: "yes" }] },
      ],
    });
    expect(text).toBe("yes");
  });

  it("reads cached input as a subset of input, and reasoning as a subset of output", () => {
    const usage = extractUsage(okEnvelope);
    expect(usage).toEqual({
      inputTokens: 5_000,
      cachedInputTokens: 4_200,
      outputTokens: 300,
      reasoningTokens: 250,
    });
    expect(usage.cachedInputTokens).toBeLessThanOrEqual(usage.inputTokens);
    expect(usage.reasoningTokens).toBeLessThanOrEqual(usage.outputTokens);
  });

  it("copes with a provider that omits the usage details", () => {
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: 2 } })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
    });
  });
});

describe("a successful call", () => {
  it("returns the text, the usage, and the model the provider actually ran", async () => {
    const captured: Captured[] = [];
    const client = openAiResponsesClient({
      apiKey: "sk-test-not-real",
      fetch: stubFetch({ ok: true, status: 200, body: okEnvelope }, captured),
      now: (() => {
        let t = 1_000;
        return () => (t += 25);
      })(),
    });

    const response = await client.complete(request);

    expect(response.text).toBe('{"choice":"approve"}');
    expect(response.modelReturned).toBe("gpt-5.6-terra");
    expect(response.status).toBe("completed");
    expect(response.usage.cachedInputTokens).toBe(4_200);
    expect(response.latencyMs).toBeGreaterThan(0);
    expect(response.cached).toBe(false);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.openai.com/v1/responses");
    expect(captured[0].init.method).toBe("POST");
    expect(globalFetchCalls).toBe(0);
  });

  it("reports an incomplete response rather than pretending it finished", async () => {
    const client = openAiResponsesClient({
      apiKey: "sk-test-not-real",
      fetch: stubFetch({
        ok: true,
        status: 200,
        body: {
          ...okEnvelope,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      }),
    });
    const response = await client.complete(request);
    expect(response.status).toBe("incomplete");
    expect(response.incompleteReason).toBe("max_output_tokens");
  });
});

describe("failures are sanitised", () => {
  it("keeps the status, the provider type and the code — the useful part", async () => {
    const client = openAiResponsesClient({
      apiKey: "sk-test-not-real",
      fetch: stubFetch({
        ok: false,
        status: 404,
        body: {
          error: {
            type: "invalid_request_error",
            code: "model_not_found",
            message: "The model 'gpt-5.6-terra' does not exist",
          },
        },
      }),
    });

    // "model not found" is the single most useful thing a provider can say
    // while a model name is being tried out.
    await expect(client.complete(request)).rejects.toMatchObject({
      name: "ModelCallError",
      httpStatus: 404,
      providerType: "invalid_request_error",
      providerCode: "model_not_found",
    });
  });

  it("never lets a header, a key or a request dump out", async () => {
    const client = openAiResponsesClient({
      apiKey: "sk-SECRET-must-never-appear",
      fetch: stubFetch({
        ok: false,
        status: 401,
        body: { error: { type: "authentication_error", message: "Incorrect API key" } },
      }),
    });

    let caught: ModelCallError | null = null;
    try {
      await client.complete(request);
    } catch (error) {
      caught = error as ModelCallError;
    }

    const everything = `${caught?.message} ${caught?.describe()} ${caught?.stack ?? ""}`;
    expect(everything).not.toContain("sk-SECRET-must-never-appear");
    expect(everything).not.toContain("Authorization");
    expect(everything).not.toContain("Bearer");
    expect(everything).not.toContain("系统层");
    expect(caught?.describe()).toContain("HTTP 401");
  });

  it("flattens a multi-line provider message to one line", async () => {
    const client = openAiResponsesClient({
      apiKey: "k",
      fetch: stubFetch({
        ok: false,
        status: 400,
        body: { error: { message: "line one\n\nline two", type: "invalid_request_error" } },
      }),
    });
    await expect(client.complete(request)).rejects.toMatchObject({
      message: "line one line two",
    });
  });

  it("calls a timeout a timeout, with no status", async () => {
    const client = openAiResponsesClient({
      apiKey: "k",
      fetch: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    await expect(client.complete(request)).rejects.toMatchObject({
      httpStatus: null,
      providerType: "timeout",
    });
  });

  it("calls a dead socket a network error, and says nothing else", async () => {
    const client = openAiResponsesClient({
      apiKey: "k",
      fetch: async () => {
        throw new Error("ECONNREFUSED 1.2.3.4:443");
      },
    });
    await expect(client.complete(request)).rejects.toMatchObject({
      httpStatus: null,
      providerType: "network_error",
    });
  });

  it("refuses a 200 that is not JSON", async () => {
    const client = openAiResponsesClient({
      apiKey: "k",
      fetch: stubFetch({ ok: true, status: 200, body: "<html>gateway</html>" }),
    });
    await expect(client.complete(request)).rejects.toMatchObject({
      providerType: "bad_response",
    });
  });
});

describe("the key never comes from the environment", () => {
  it("is taken from the options and nowhere else", async () => {
    // A model module that reaches for process.env is one console.log away from
    // putting a key in a trace, and cannot be tested without a real one.
    const before = process.env.OPENAI_API_KEY_DEV;
    process.env.OPENAI_API_KEY_DEV = "sk-env-must-not-be-used";
    try {
      const captured: Captured[] = [];
      const client = openAiResponsesClient({
        apiKey: "sk-injected",
        fetch: stubFetch({ ok: true, status: 200, body: okEnvelope }, captured),
      });
      await client.complete(request);
      expect(captured[0].init.headers.Authorization).toBe("Bearer sk-injected");
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY_DEV;
      else process.env.OPENAI_API_KEY_DEV = before;
    }
  });

  it("uses the configured model id rather than a literal", async () => {
    const captured: Captured[] = [];
    const client = openAiResponsesClient({
      apiKey: "k",
      fetch: stubFetch({ ok: true, status: 200, body: okEnvelope }, captured),
    });
    await client.complete({ ...request, model: loadConfig().model.id });
    expect(JSON.parse(captured[0].init.body).model).toBe("gpt-5.6-terra");
    expect(globalFetchCalls).toBe(0);
  });
});
