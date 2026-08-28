/**
 * Model clients that never touch a network.
 *
 * Every default test in this suite runs against one of these. That is not a
 * convenience: a test that needs a provider is a test nobody runs, and a suite
 * that costs money per invocation stops being run at all. The live client
 * exists in exactly one file and is imported by exactly one script.
 *
 * Two implementations:
 *
 *   `answeringClient`   builds a legal answer from the task the prompt is
 *                       asking for, so a whole ten-seat game can be played
 *                       through the real prompt builder, the real JSON schema
 *                       and the real parser, offline and instantly.
 *
 *   `transcriptClient`  replays recorded answers by request key, and returns a
 *                       chosen malformed string when the test wants to see the
 *                       repair path.
 */

import type { ModelClient, ModelRequest, ModelResponse } from "./client";
import { ModelCallError, requestKey } from "./client";

function respond(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    text,
    usage: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 40, reasoningTokens: 10 },
    latencyMs: 1,
    cached: false,
    modelReturned: "offline-double",
    status: "completed",
    ...overrides,
  };
}

/**
 * Which task a request is for, read off the schema name.
 *
 * The alternative — passing the task id alongside the request — would be a
 * back channel the real client does not have, and a double that receives more
 * than the real thing tests a path that will not exist.
 */
function taskOf(request: ModelRequest): string {
  // `avalon_cog_*` is the fused (M5) schema for the same task. The double
  // answers the action half identically either way, so the prefix is stripped
  // rather than branched on.
  return request.format.name
    .replace(/^avalon_cog_/, "")
    .replace(/^avalon_/, "")
    .replace(/_/g, "-");
}

/** Seats named in the prompt's own task block, so answers stay legal. */
function teamSizeFrom(request: ModelRequest): number {
  const match = request.user.match(/必须正好 (\d+) 个人/);
  return match ? Number(match[1]) : 3;
}

function eligibleFrom(request: ModelRequest): number[] {
  const match = request.user.match(/你现在可以验的是：([\d、]+)号/);
  if (!match) return [1];
  return match[1].split("、").map(Number).filter(Number.isFinite);
}

function seatOf(request: ModelRequest): number {
  const match = request.user.match(/你是 (\d+)号/);
  return match ? Number(match[1]) : 1;
}

/**
 * A client that plays legally.
 *
 * Answers are minimal and boring on purpose: the point is to exercise the
 * prompt → schema → parse → referee path end to end without a provider, not to
 * model how anybody plays. `scripted-agent.ts` is the deterministic opponent.
 */
export function answeringClient(): ModelClient {
  return {
    name: "answering-double",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const task = taskOf(request);
      const me = seatOf(request);
      const others = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((s) => s !== me);
      const memoryPatch = { beliefs: null, intentions: ["继续观察"], commitments: null };

      const body: Record<string, unknown> = { memoryPatch, rationale: "offline double" };
      switch (task) {
        case "opening-direction":
          Object.assign(body, { ladySide: "left", publicMessage: "女神给左手边。" });
          break;
        case "speech-opening":
        case "speech-regular":
          Object.assign(body, {
            publicMessage: `我是${me}号，先听听。`,
            tentativeTeam: null,
            noTeamYet: false,
            stances: null,
            claim: null,
          });
          break;
        case "leader-close-and-propose":
          Object.assign(body, {
            publicMessage: "就这辆车。",
            team: [me, ...others].slice(0, teamSizeFrom(request)),
          });
          break;
        case "vote":
          Object.assign(body, { choice: "approve" });
          break;
        case "mission-card":
          Object.assign(body, { card: "success" });
          break;
        case "lady-select":
          Object.assign(body, { target: eligibleFrom(request)[0] });
          break;
        case "lady-announce":
          Object.assign(body, { announced: "good", publicMessage: "他是好人。" });
          break;
        case "evil-discuss":
          Object.assign(body, { message: "我押发言最少的。" });
          break;
        case "assassinate":
          Object.assign(body, { target: others[0] });
          break;
        default:
          throw new ModelCallError(null, "double", "unknown_task", `不认识的任务 ${task}`);
      }
      return respond(JSON.stringify(body));
    },
  };
}

export interface TranscriptOptions {
  /** Raw answers keyed by `requestKey`. */
  readonly byKey?: Readonly<Record<string, string>>;
  /** Answers consumed in order, for tests that do not care about keys. */
  readonly inOrder?: readonly string[];
  /** Thrown instead of answering, to exercise the failure path. */
  readonly failWith?: ModelCallError;
  readonly fallback?: ModelClient;
}

/**
 * Replays recorded answers.
 *
 * Anything not recorded falls through to `fallback` (usually the answering
 * double), so a test can pin ONE turn's answer and let the rest of the game
 * play itself.
 */
export function transcriptClient(options: TranscriptOptions): ModelClient {
  const queue = [...(options.inOrder ?? [])];
  return {
    name: "transcript-double",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (options.failWith) throw options.failWith;
      const keyed = options.byKey?.[requestKey(request)];
      if (keyed !== undefined) return respond(keyed);
      if (queue.length > 0) return respond(queue.shift() as string);
      if (options.fallback) return options.fallback.complete(request);
      throw new ModelCallError(null, "double", "no_recording", "没有录到这条请求的回答");
    },
  };
}

/** Counts calls without changing behaviour. For cap and cache assertions. */
export function counting(inner: ModelClient): ModelClient & { readonly calls: () => number } {
  let n = 0;
  return {
    name: `counting(${inner.name})`,
    calls: () => n,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      n += 1;
      return inner.complete(request);
    },
  };
}
