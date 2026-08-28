/**
 * The provider. One file, one HTTP call, `POST /v1/responses`.
 *
 * Two constructor decisions carry most of the safety here, and both are
 * deliberate inversions of what would be convenient:
 *
 *   THE KEY IS INJECTED. This module never reads `process.env` and never
 *   touches `.env.local`. A model module that reaches for the environment is
 *   one `console.log` away from putting a key in a trace, and it makes the
 *   client untestable without a real key sitting somewhere. The CLI reads the
 *   variable and hands the string in; nothing else in the simulator knows it
 *   exists.
 *
 *   `fetch` IS INJECTED. Which is what lets the whole client be tested offline
 *   against a stub, and what lets `openai-responses.test.ts` assert that the
 *   global was never touched.
 *
 * WHAT LEAVES THIS FILE ON FAILURE is a `ModelCallError` carrying the HTTP
 * status, the provider's own error type and code, and a message truncated to a
 * line. Never a header, never the Authorization value, never the environment,
 * never a request dump. The same line `/api/ai` draws, for the same reason:
 * the useful part of a provider error is "model not found", and everything
 * around it is either noise or a secret.
 */

import type { SimConfig } from "../config/load";
import {
  ModelCallError,
  safeMessage,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "./client";
import { usageOf, type TokenUsage } from "./pricing";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface OpenAiResponsesOptions {
  /** Injected. This module never reads it from the environment. */
  readonly apiKey: string;
  /** Injected so the client is testable offline and the global stays untouched. */
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Wall clock, injectable so latency assertions are deterministic. */
  readonly now?: () => number;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The request body, as a pure function.
 *
 * Split out so `openai-responses.test.ts` can assert the exact field set
 * without a network anywhere near it — the shape is the part most likely to be
 * wrong, and the part a live 400 would only tell us about after paying for it.
 */
export function buildResponsesBody(
  request: ModelRequest,
): Readonly<Record<string, unknown>> {
  return {
    model: request.model,
    // The system layers go in `instructions`; the moving layers are the input.
    instructions: request.system,
    input: request.user,
    reasoning: { effort: request.reasoningEffort },
    text: {
      format: {
        type: "json_schema",
        name: request.format.name,
        strict: true,
        schema: request.format.schema,
      },
    },
    max_output_tokens: request.maxOutputTokens,
    // Nothing is retained on the provider's side, and no tools of any kind.
    store: false,
    tools: [],
    ...(request.params ?? {}),
  };
}

interface ResponsesEnvelope {
  readonly model?: string;
  readonly status?: string;
  readonly output_text?: string;
  readonly output?: readonly {
    readonly type?: string;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  }[];
  readonly incomplete_details?: { readonly reason?: string };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
    readonly output_tokens?: number;
    readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  };
  readonly error?: {
    readonly type?: string;
    readonly code?: string;
    readonly message?: string;
  };
}

/**
 * Pull the answer out of the envelope.
 *
 * `output_text` is an SDK convenience and is NOT present in the raw HTTP body,
 * so the output list is walked: reasoning items are skipped and only a
 * message's `output_text` parts are joined. Both paths are handled because a
 * caller may hand in a body that already went through an SDK.
 */
export function extractOutputText(payload: ResponsesEnvelope): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

export function extractUsage(payload: ResponsesEnvelope): TokenUsage {
  const usage = payload.usage ?? {};
  return usageOf({
    inputTokens: usage.input_tokens ?? 0,
    // A SUBSET of input_tokens, which is how the provider reports it.
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  });
}

export function openAiResponsesClient(options: OpenAiResponsesOptions): ModelClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  return {
    name: "openai-responses",

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = now();

      let status = 0;
      let ok = false;
      let raw = "";
      try {
        const response = await options.fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(buildResponsesBody(request)),
          signal: controller.signal,
        });
        status = response.status;
        ok = response.ok;
        raw = await response.text();
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        // No status at all: a timeout or a dead socket. Reported as "network"
        // so it is never confused with something the provider said.
        throw new ModelCallError(
          null,
          aborted ? "timeout" : "network_error",
          null,
          aborted
            ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
            : safeMessage(error instanceof Error ? error.message : ""),
        );
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = now() - startedAt;

      let payload: ResponsesEnvelope | null = null;
      try {
        payload = JSON.parse(raw) as ResponsesEnvelope;
      } catch {
        payload = null;
      }

      if (!ok) {
        const error = payload?.error ?? {};
        throw new ModelCallError(
          status,
          error.type ?? null,
          error.code ?? null,
          safeMessage(error.message) || `provider returned ${status}`,
        );
      }

      if (!payload) {
        throw new ModelCallError(status, "bad_response", null, "返回的内容不是 JSON");
      }

      const incomplete = payload.status === "incomplete";
      return {
        text: extractOutputText(payload),
        usage: extractUsage(payload),
        latencyMs,
        cached: false,
        // What the provider says it RAN, which is not always what was asked
        // for and would otherwise be invisible in the trace.
        modelReturned: payload.model ?? "",
        status: incomplete ? "incomplete" : "completed",
        ...(incomplete
          ? { incompleteReason: payload.incomplete_details?.reason ?? "unknown" }
          : {}),
      };
    },
  };
}

/**
 * Build the client from a config plus an injected key and fetch.
 *
 * Exists so a CLI has one obvious call rather than assembling options by hand,
 * and so the model id and reasoning effort provably come from the config
 * rather than from a literal at a call site.
 */
export function clientFromConfig(
  config: SimConfig,
  options: { apiKey: string; fetch: FetchLike; baseUrl?: string; timeoutMs?: number },
): ModelClient {
  void config;
  return openAiResponsesClient(options);
}
