/**
 * The only place in this app that talks to a model provider.
 *
 * It exists as a server route for one reason: the API key must never reach the
 * browser. A client-side `fetch` to OpenAI with a key in the bundle hands that
 * key to anyone who opens devtools, and it would be billed to us.
 *
 * The route is deliberately dumb. It does NOT read the event log, does not touch
 * IndexedDB (it can't — that lives in the browser), and does not derive anything.
 * The client sends a finished briefing string and gets a result back. That keeps
 * the derivation layer where it is testable, and keeps this file to one job:
 * hold the key, call the provider, come back with JSON or a usable error.
 */

import { NextResponse } from "next/server";
import {
  analysisSystemPrompt,
  analysisUserPrompt,
  speechSystemPrompt,
  speechUserPrompt,
} from "@/lib/ai/prompts";
import { parseAnalysis, parseSpeech } from "@/lib/ai/parse";
import { checkAccess, recordUsage } from "@/lib/auth/gate";
import type { AiResponse } from "@/lib/ai/types";
import type { RoleType } from "@/lib/types/game";

export const runtime = "nodejs";
/** Vercel's default is 10s on hobby; a reasoning model routinely wants more. */
export const maxDuration = 60;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.4-mini";

/** A full 10-player log renders well under this; the cap is for abuse, not use. */
const MAX_BRIEFING_CHARS = 60_000;
const REQUEST_TIMEOUT_MS = 55_000;

const VALID_ROLES: readonly string[] = [
  "merlin",
  "percival",
  "loyal",
  "morgana",
  "mordred",
  "assassin",
  "oberon",
  "minion",
];

function fail(message: string, status: number) {
  return NextResponse.json<AiResponse>({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  /*
   * Before anything else, and before reading the body: this route spends money
   * on a key we pay for, on a public URL. Signed-in-and-allowlisted is what
   * makes an anonymous request cost nothing. See lib/auth/gate.ts.
   */
  const access = await checkAccess();
  if (!access.ok) return fail(access.error, access.status);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fail(
      "服务端还没配置 API key（环境变量 OPENAI_API_KEY），AI 功能用不了。",
      503,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("请求格式不对。", 400);
  }

  const { task, briefing, role, extra } = (body ?? {}) as Record<string, unknown>;

  if (task !== "analysis" && task !== "speech") {
    return fail("不认识的任务类型。", 400);
  }
  if (typeof briefing !== "string" || briefing.trim().length === 0) {
    return fail("这局还没有任何记录，先记两笔再来分析。", 400);
  }
  if (briefing.length > MAX_BRIEFING_CHARS) {
    return fail("这局的记录太长了，超出了单次分析的上限。", 413);
  }

  const viewerRole =
    typeof role === "string" && VALID_ROLES.includes(role)
      ? (role as RoleType)
      : undefined;
  const steer = typeof extra === "string" ? extra.slice(0, 500) : undefined;

  const system =
    task === "analysis"
      ? analysisSystemPrompt(viewerRole)
      : speechSystemPrompt(viewerRole);
  const user =
    task === "analysis"
      ? analysisUserPrompt(briefing)
      : speechUserPrompt(briefing, steer);

  const baseUrl = (process.env.AI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      /*
       * `json_object` rather than a strict `json_schema`: the schema is already
       * spelled out in the prompt, and json_object is the mode every
       * OpenAI-compatible provider supports. Since the plan is to let users
       * point this at their own model later, the lowest common denominator is
       * the right call — and `parse.ts` is forgiving enough to cover the gap.
       *
       * Nothing else is sent. No temperature, no max_tokens: those parameters
       * are exactly where providers disagree, and a 400 from an unsupported
       * knob would break the feature for a setting nobody asked for.
       */
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return fail(aborted ? "模型响应超时了，再试一次。" : "连不上模型服务。", 504);
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Pass the provider's own message through — "model not found" is the single
    // most useful thing it can say while a model name is being tried out — but
    // truncate it, and never echo anything from our own headers.
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      /* provider returned non-JSON; the status code is all we have */
    }
    const suffix = detail ? `：${detail.slice(0, 200)}` : "";
    return fail(`模型服务返回了 ${response.status}${suffix}`, 502);
  }

  let content = "";
  try {
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    content = data.choices?.[0]?.message?.content ?? "";
    /*
     * Billed the moment the provider answered, so the ledger is written even
     * if parsing the content fails below. Charging only for results we could
     * read would under-count exactly the calls worth noticing.
     */
    await recordUsage(access.userId, task, data.usage);
  } catch {
    return fail("模型返回的内容读不出来。", 502);
  }

  try {
    if (task === "analysis") {
      return NextResponse.json<AiResponse>({
        ok: true,
        task: "analysis",
        result: parseAnalysis(content),
      });
    }
    return NextResponse.json<AiResponse>({
      ok: true,
      task: "speech",
      result: parseSpeech(content),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "解析模型输出失败。", 502);
  }
}
