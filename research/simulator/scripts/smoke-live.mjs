#!/usr/bin/env node
/**
 * ONE live request. Nothing else.
 *
 *     node research/simulator/scripts/smoke-live.mjs --live-smoke
 *
 * Without the flag it explains what it would do and exits without touching the
 * network. That is the point: this is the only file in the repository that can
 * spend money, so running it has to be something somebody typed on purpose.
 *
 * WHAT IT CHECKS, and only this:
 *   - the configured model id is accepted by the provider
 *   - `reasoning.effort: "high"` is accepted
 *   - strict structured output comes back in the requested shape
 *
 * It does NOT play a game, does not touch ten agents, and does not retry. If
 * the model is rejected it stops and says so — it will not quietly try a
 * different one, because a run that changed models has no single model id to
 * report and every number from it would be unattributable.
 *
 * SECRETS. The key is read from `.env.local` under `OPENAI_API_KEY_DEV`, is
 * never printed, never logged, and never written anywhere. Errors report the
 * HTTP status, the provider's own error type and code, and a truncated
 * message — never headers, never authorization data, never the environment,
 * never a request dump. Nothing is written to disk at all, so there is no
 * artifact that could carry a provider-generated identifier.
 *
 * THE CEILING IS REAL. The worst case is computed BEFORE sending, from the
 * output cap and a deliberately pessimistic rate (see
 * `research/simulator/model/pricing.ts`, which is the source of truth for the
 * same arithmetic and is unit-tested against this config). If it exceeds
 * `smoke.ceilingUsd`, nothing is sent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CONFIG_PATH = join(HERE, "..", "config", "default.json");
const ENV_PATH = join(REPO, ".env.local");
const ENV_VAR = "OPENAI_API_KEY_DEV";
const TIMEOUT_MS = 180_000;

const say = (...parts) => console.log(...parts);
const die = (message, code = 1) => {
  console.error(`✗ ${message}`);
  process.exit(code);
};

/* ── 0. Opt-in ─────────────────────────────────────────────────────────── */

const live = process.argv.includes("--live-smoke");

/* ── 1. Config ─────────────────────────────────────────────────────────── */

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const model = config.model.id;
const effort = config.model.reasoningEffort;
const smoke = config.smoke;

// Same formula as `worstCaseCostUsd` in model/pricing.ts, over the same values.
const worstCaseUsd =
  (smoke.assumedInputTokens * smoke.pessimisticInputUsdPerMTok) / 1_000_000 +
  (smoke.maxOutputTokens * smoke.pessimisticOutputUsdPerMTok) / 1_000_000;

say("");
say("=== 连通性冒烟测试（一次请求）===");
say(`模型         ${model}`);
say(`reasoning    effort=${effort}`);
say(`输出上限     ${smoke.maxOutputTokens} token`);
say(`预算天花板   $${smoke.ceilingUsd.toFixed(2)}`);
say(
  `最坏情况     $${worstCaseUsd.toFixed(4)}  ` +
    `（按 $${smoke.pessimisticInputUsdPerMTok}/$${smoke.pessimisticOutputUsdPerMTok} 每百万 token 的悲观估价，` +
    `不是真实价目表）`,
);

if (worstCaseUsd > smoke.ceilingUsd) {
  die(
    `最坏情况 $${worstCaseUsd.toFixed(4)} 超过天花板 $${smoke.ceilingUsd.toFixed(2)}，不发请求。`,
  );
}
say(`✓ 最坏情况在天花板之内`);

/* ── 2. The key file must be ignored by git ────────────────────────────── */

if (!existsSync(ENV_PATH)) die(`找不到 ${ENV_PATH}`);

try {
  // Non-zero exit means "not ignored". Checked BEFORE anything is read.
  execFileSync("git", ["check-ignore", "-q", ".env.local"], { cwd: REPO, stdio: "ignore" });
  say("✓ .env.local 被 git 忽略");
} catch {
  die(".env.local 没有被 git 忽略 —— 在解决这个之前不发任何请求。");
}

/* ── 3. The key, and only the key ──────────────────────────────────────── */

/**
 * Reads exactly one variable out of `.env.local`.
 *
 * Deliberately not a general dotenv loader: nothing else from that file is
 * parsed, kept, or put on `process.env`, so there is no path by which another
 * secret in it could end up somewhere it should not be.
 */
function readKeyOnly() {
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${ENV_VAR}\\s*=\\s*(.*)$`).exec(line);
    if (!match) continue;
    const value = match[1].replace(/^["']|["']$/g, "").trim();
    if (value.length > 0) return value;
  }
  return null;
}

const apiKey = readKeyOnly();
if (!apiKey) {
  die(`${ENV_VAR} 不在 .env.local 里，或者是空的。干净退出，不发请求。`, 2);
}
say(`✓ ${ENV_VAR} 已读取（长度与内容都不会被打印）`);

if (!live) {
  say("");
  say("没有 --live-smoke，到此为止。上面所有检查都通过了，但没有发出任何请求。");
  say("要真的发一次请求：node research/simulator/scripts/smoke-live.mjs --live-smoke");
  process.exit(0);
}

/* ── 4. The one request ────────────────────────────────────────────────── */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "message"],
  properties: {
    ok: { type: "boolean" },
    message: { type: "string" },
  },
};

const body = {
  model,
  instructions: "你只输出 JSON，不要任何解释。",
  input: '请只回答这个 JSON：{"ok": true, "message": "连接成功"}',
  reasoning: { effort },
  text: {
    format: { type: "json_schema", name: "avalon_smoke", strict: true, schema: SCHEMA },
  },
  max_output_tokens: smoke.maxOutputTokens,
  // Not stored on the provider's side, and no tools of any kind.
  store: false,
  tools: [],
};

/** Flattens and truncates whatever the provider said. Never anything else. */
const safeMessage = (raw, limit = 300) => {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** Hard guard: this process may make one request, and the counter proves it. */
let requestsMade = 0;

async function callOnce() {
  if (requestsMade > 0) die("内部错误：试图发出第二次请求。");
  requestsMade += 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    return { status: response.status, ok: response.ok, text, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

say("");
say("发出请求…（reasoning effort=high，可能要等一会儿）");

let result;
try {
  result = await callOnce();
} catch (error) {
  const aborted = error && error.name === "AbortError";
  die(
    aborted
      ? `请求超时（${TIMEOUT_MS / 1000}s）。不重试，干净退出。`
      : `连不上模型服务：${safeMessage(error && error.message)}。不重试，干净退出。`,
    3,
  );
}

/* ── 5. Read it, sanitised ─────────────────────────────────────────────── */

let payload = null;
try {
  payload = JSON.parse(result.text);
} catch {
  payload = null;
}

if (!result.ok) {
  const error = payload && payload.error ? payload.error : {};
  say("");
  say("=== 请求被拒绝 ===");
  say(`HTTP         ${result.status}`);
  say(`error.type   ${error.type ?? "(未提供)"}`);
  say(`error.code   ${error.code ?? "(未提供)"}`);
  say(`error.param  ${error.param ?? "(未提供)"}`);
  say(`message      ${safeMessage(error.message) || "(未提供)"}`);
  say("");
  say("按规则停下：不重试、不换模型、不降级。");
  process.exit(4);
}

/**
 * Pull the text out of the Responses envelope.
 *
 * `output_text` is an SDK convenience and is not in the raw HTTP body, so the
 * output list is walked. Reasoning items are skipped; only the message's
 * `output_text` parts are joined.
 */
function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

const usage = payload.usage ?? {};
const inputTokens = usage.input_tokens ?? 0;
const outputTokens = usage.output_tokens ?? 0;
const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
const pessimisticUsd =
  (inputTokens * smoke.pessimisticInputUsdPerMTok) / 1_000_000 +
  (outputTokens * smoke.pessimisticOutputUsdPerMTok) / 1_000_000;

const raw = outputText(payload);
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = null;
}

say("");
say("=== 结果 ===");
say(`HTTP         ${result.status}`);
say(`status       ${payload.status ?? "(未提供)"}`);
if (payload.incomplete_details) {
  say(`incomplete   ${payload.incomplete_details.reason ?? "(未提供)"}`);
}
// The model the provider says it actually ran — not the one we asked for.
say(`model        ${payload.model ?? "(未提供)"}`);
say(`reasoning    effort=${payload.reasoning?.effort ?? "(未回显)"}`);
say(`store        ${payload.store === false ? "false ✓" : String(payload.store)}`);
say(`tools        ${Array.isArray(payload.tools) ? payload.tools.length : "?"} 个`);
say("");
say(`input        ${inputTokens} token`);
say(`output       ${outputTokens} token（其中 reasoning ${reasoningTokens}）`);
say(`latency      ${result.latencyMs} ms`);
say(
  `成本上界     $${pessimisticUsd.toFixed(4)}` +
    `（悲观估价，真实价目表未配置 —— 见 config/default.json 的 pricing）`,
);
say("");

if (parsed && parsed.ok === true && typeof parsed.message === "string") {
  say(`结构化输出   ok=${parsed.ok}  message=${JSON.stringify(parsed.message)}`);
  say("");
  say("✓ 连通、模型可用、reasoning effort 被接受、strict 结构化输出正确。");
  say("（没有写任何文件：结果里可能带 provider 生成的 id，不做成 fixture。）");
  process.exit(0);
}

say(`结构化输出   解析失败。收到 ${raw.length} 个字符。`);
say("");
die("请求成功但输出不符合要求的结构。不重试，干净退出。", 5);
