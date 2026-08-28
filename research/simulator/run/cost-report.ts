/**
 * What a run actually cost, itemised — with every figure in the unit its name
 * claims.
 *
 * TWO CORRECTIONS ARE RECORDED HERE, both because the wrong versions shipped.
 *
 * FIRST, the units. The previous version pushed `observation.publicLog.length`
 * into a field called `promptChars`. That is an EVENT COUNT, not a character
 * count — the two differ by roughly three orders of magnitude, so every
 * "prompt size" figure in the last report was wrong by that factor. Event
 * count and character count are now separate fields with separate names, and
 * `cost-report.test.ts` fails if one is ever passed as the other.
 *
 * SECOND, the growth claim. It said stateless full-history prompting kept
 * cumulative game input LINEAR. It does not:
 *
 *   Per REQUEST, input is bounded by the history that request carries. Request
 *   number k contains roughly k events, so per-request input grows linearly in
 *   the turn count. That is what keeps any single request under the 250,000
 *   ceiling, and it is the only thing "bounded" ever meant.
 *
 *   CUMULATIVELY, a game sends 1 + 2 + ... + N events' worth of history across
 *   N turns, which is O(N²). Statelessness does not change that and was never
 *   going to: the total is the sum of the parts and the parts are growing.
 *
 * What statelessness buys is that each request is self-contained — auditable
 * alone, resumable at any decision, reproducible without replaying a thread —
 * and that it avoids a SECOND growth term a chat thread would add by also
 * accumulating every earlier observation snapshot alongside the history.
 *
 * The practical consequence: the last requests of a long game are the
 * expensive ones. So the report separates max-per-request from the total and
 * reports the last/first ratio, rather than quoting an average, which would
 * hide exactly this shape.
 */

import type { SimConfig } from "../config/load";
import type { ModelAttempt } from "../model/attempt";
import type { Ledger } from "../model/client";

export interface CostReportInput {
  readonly ledger: Ledger;
  /** One entry per SENT request, including repair retries and failures. */
  readonly attempts: readonly ModelAttempt[];
  /** Ordinary repair retries only — capacity retries are derived separately. */
  readonly retries: number;
  /** The cap every request in this run was sent under. */
  readonly maxOutputTokens?: number;
}

export interface CostReport {
  /* ── Calls ───────────────────────────────────────────────────────────── */
  readonly apiCalls: number;
  readonly cacheHits: number;
  readonly retries: number;
  readonly failures: number;
  /** Sent requests, from the attempt records. Must equal calls + cache hits. */
  readonly recordedAttempts: number;

  /* ── Tokens, provider-reported ───────────────────────────────────────── */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Attempts whose token cost the provider never told us. Unknown, not zero. */
  readonly attemptsWithUnknownUsage: number;
  /**
   * Identical-prompt resends after an exhausted output budget.
   *
   * Kept apart from `retries` on purpose. A repair retry says the model
   * answered and got it wrong; a capacity retry says it never finished. Adding
   * them together would have made the first paid game's nine capacity failures
   * look like ordinary schema noise.
   */
  readonly capacityRetries: number;
  /** Requests that ran out of output budget, capacity retries included. */
  readonly outputLimitAttempts: number;
  /** Did anything actually reach the cap? The question the cap exists to answer. */
  readonly reachedOutputCap: boolean;
  readonly maxOutputTokensUsed: number;
  readonly maxOutputTokensConfigured: number | null;

  readonly actualUsd: number | null;
  readonly totalLatencyMs: number;

  /* ── Prompt size: CHARACTERS ─────────────────────────────────────────── */
  readonly maxInputChars: number;
  readonly totalInputChars: number;
  readonly meanInputChars: number;
  readonly maxSystemChars: number;
  readonly maxUserChars: number;

  /* ── Prompt size: EVENTS. A different unit, kept separate. ───────────── */
  readonly maxPublicEvents: number;
  readonly totalPublicEvents: number;

  /* ── Estimated vs actual, so the estimator can be calibrated ─────────── */
  readonly totalEstimatedInputTokens: number;

  /**
   * Last request's characters over the first request's.
   *
   * The number that makes the quadratic shape concrete: near 1 means the
   * history is not growing; large means late turns dominate the bill.
   */
  readonly inputCharGrowthRatio: number;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

export function summariseCosts(input: CostReportInput): CostReport {
  const usage = input.ledger.usage;
  const attempts = input.attempts;
  const chars = attempts.map((a) => a.totalInputChars);
  const events = attempts.map((a) => a.publicEventCount);

  return {
    apiCalls: input.ledger.calls,
    cacheHits: input.ledger.cached,
    retries: input.retries,
    failures: input.ledger.failures,
    recordedAttempts: attempts.length,

    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    uncachedInputTokens: usage.inputTokens - usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    attemptsWithUnknownUsage: attempts.filter((a) => a.usage === null).length,
    capacityRetries: attempts.filter((a) => a.capacityAttempt > 1).length,
    outputLimitAttempts: attempts.filter((a) => a.outcome === "output_limit").length,
    reachedOutputCap:
      input.maxOutputTokens !== undefined &&
      attempts.some((a) => (a.usage?.outputTokens ?? 0) >= input.maxOutputTokens!),
    maxOutputTokensUsed: Math.max(0, ...attempts.map((a) => a.usage?.outputTokens ?? 0)),
    maxOutputTokensConfigured: input.maxOutputTokens ?? null,

    actualUsd: input.ledger.costUsd,
    totalLatencyMs: input.ledger.totalLatencyMs,

    maxInputChars: chars.length > 0 ? Math.max(...chars) : 0,
    totalInputChars: sum(chars),
    meanInputChars: chars.length > 0 ? Math.round(sum(chars) / chars.length) : 0,
    maxSystemChars:
      attempts.length > 0 ? Math.max(...attempts.map((a) => a.systemChars)) : 0,
    maxUserChars: attempts.length > 0 ? Math.max(...attempts.map((a) => a.userChars)) : 0,

    maxPublicEvents: events.length > 0 ? Math.max(...events) : 0,
    totalPublicEvents: sum(events),

    totalEstimatedInputTokens: sum(attempts.map((a) => a.estimatedInputTokens)),

    inputCharGrowthRatio: chars.length > 0 && chars[0] > 0 ? chars[chars.length - 1] / chars[0] : 0,
  };
}

/** The report as printed lines. Every figure separate; nothing conflated. */
export function reportCosts(input: CostReportInput, config: SimConfig): string {
  const r = summariseCosts(input);
  const usd = r.actualUsd === null ? "（价格未配置，算不出来）" : `$${r.actualUsd.toFixed(4)}`;
  const unknown =
    r.attemptsWithUnknownUsage > 0
      ? `，另有 ${r.attemptsWithUnknownUsage} 次用量未知（provider 没返回）`
      : "";

  return [
    "--- 用量与成本 ---",
    `已发出请求    ${r.recordedAttempts} 次（其中真实调用 ${r.apiCalls}，缓存命中 ${r.cacheHits}）`,
    `修复重试      ${r.retries} 次（模型答完了但答错了）`,
    `容量重试      ${r.capacityRetries} 次（输出预算耗尽，原样重发一次）`,
    `provider 失败 ${r.failures} 次${unknown}`,
    `输入 token    ${r.inputTokens.toLocaleString()}（缓存 ${r.cachedInputTokens.toLocaleString()}，未缓存 ${r.uncachedInputTokens.toLocaleString()}）`,
    `输出 token    ${r.outputTokens.toLocaleString()}（其中 reasoning ${r.reasoningTokens.toLocaleString()}）`,
    `实际成本      ${usd}`,
    `总延迟        ${r.totalLatencyMs.toLocaleString()} ms`,
    "",
    "--- 输出预算 ---",
    `上限          ${(r.maxOutputTokensConfigured ?? config.limits.maxOutputTokens).toLocaleString()} token（含 reasoning）`,
    `单次最多用到  ${r.maxOutputTokensUsed.toLocaleString()} token`,
    r.outputLimitAttempts === 0
      ? "撞到上限      0 次"
      : `撞到上限      ${r.outputLimitAttempts} 次 —— 推理吃光了预算，回答没写出来`,
    "",
    "--- 每次请求的输入体量（字符）---",
    `单次最大      ${r.maxInputChars.toLocaleString()} 字符（system ${r.maxSystemChars.toLocaleString()} / user ${r.maxUserChars.toLocaleString()}）`,
    `累计          ${r.totalInputChars.toLocaleString()} 字符`,
    `单次平均      ${r.meanInputChars.toLocaleString()} 字符`,
    `末次 / 首次   ${r.inputCharGrowthRatio.toFixed(1)}×`,
    "",
    "--- 每次请求携带的公开事件数（另一个单位，不要和上面混）---",
    `单次最大      ${r.maxPublicEvents.toLocaleString()} 条`,
    `累计          ${r.totalPublicEvents.toLocaleString()} 条`,
    "",
    `估算输入 token 合计 ${r.totalEstimatedInputTokens.toLocaleString()}，`,
    `provider 实报 ${r.inputTokens.toLocaleString()} —— 估算器只会往多了算，差值用来校准它。`,
    "",
    "无状态全历史提示：每次请求都是自包含的、可单独审计、可从任意决策续跑。",
    "但它**不会**让一局的累计输入保持线性 —— 第 k 次请求携带约 k 条历史，",
    "所以单次输入随回合数线性增长，一局的累计输入约为 O(N²)。",
    `单次请求受 ${config.limits.maxStandardInputTokens.toLocaleString()} token 的闸门约束；`,
    "累计量不受，受约束的是每局 / 每批的美元上限。",
  ].join("\n");
}
