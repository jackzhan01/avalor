/**
 * Turning token counts into dollars — and refusing to when nobody has said
 * what a token costs.
 *
 * `pricing.configured` may be false, and `estimateCostUsd` then returns null.
 * That is a legitimate answer callers must handle: inventing a plausible rate
 * would make `checkBudget` produce confident numbers that mean nothing, and a
 * budget computed from a made-up price is not a budget. The app's own
 * `.env.example` reached the same conclusion out loud.
 *
 * CACHED INPUT IS PRICED SEPARATELY, and at this table it matters a great
 * deal. Every request re-sends the same long static prefix — the rules, the
 * persona, the role — so a provider that caches it charges an order of
 * magnitude less for most of the input. Pricing all input as uncached would
 * over-state the bill enough to trip a ceiling nobody reached; pricing it all
 * as cached would under-state one that was sailed past. `cachedInputTokens` is
 * a SUBSET of `inputTokens`, which is how the provider reports it, and the
 * arithmetic below depends on that.
 *
 * The smoke test's separate, deliberately PESSIMISTIC rates are still here.
 * They are not a price list, are not a claim about what anything costs, and
 * exist only so a one-off connectivity check can bound itself before the real
 * table has been read.
 */

import type { PricingConfig, SmokeConfig } from "../config/load";

export interface TokenUsage {
  /** Total input, INCLUDING whatever part of it was served from cache. */
  readonly inputTokens: number;
  /** The cached SUBSET of `inputTokens`. Never additional to it. */
  readonly cachedInputTokens: number;
  /** Output, including reasoning tokens. */
  readonly outputTokens: number;
  /**
   * Part of `outputTokens`, not additional to it. Recorded separately because
   * reasoning effort is a knob we intend to vary, and "how much of the output
   * was thinking" is the measurement that says whether it did anything.
   */
  readonly reasoningTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** Fill in the fields a partial usage object left out. For parsing providers. */
export function usageOf(partial: Partial<TokenUsage>): TokenUsage {
  const inputTokens = partial.inputTokens ?? 0;
  // Clamped: a provider reporting more cached than total would otherwise make
  // the uncached portion negative and quietly reduce the bill.
  const cachedInputTokens = Math.min(partial.cachedInputTokens ?? 0, inputTokens);
  const outputTokens = partial.outputTokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens: Math.min(partial.reasoningTokens ?? 0, outputTokens),
  };
}

/**
 * What this usage cost, or null when nobody has configured a price.
 *
 * A `?? 0` at a call site here would make every budget check pass forever,
 * which is precisely the failure a budget exists to prevent.
 */
export function estimateCostUsd(usage: TokenUsage, pricing: PricingConfig): number | null {
  if (!pricing.configured) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return (
    (uncached * pricing.uncachedInputUsdPerMTok) / 1_000_000 +
    (cached * pricing.cachedInputUsdPerMTok) / 1_000_000 +
    (usage.outputTokens * pricing.outputUsdPerMTok) / 1_000_000
  );
}

/**
 * The most one more request could add, priced conservatively.
 *
 * Input is priced as fully UNCACHED even though most of it probably will be
 * cached, and output is priced at its cap even though it will usually come
 * back shorter. Both errors point the same way on purpose: the projection is
 * used to decide whether to send at all, so it must never under-state.
 */
export function projectedRequestUsd(
  estimatedInputTokens: number,
  maxOutputTokens: number,
  pricing: PricingConfig,
): number | null {
  if (!pricing.configured) return null;
  return (
    (estimatedInputTokens * pricing.uncachedInputUsdPerMTok) / 1_000_000 +
    (maxOutputTokens * pricing.outputUsdPerMTok) / 1_000_000
  );
}

/** Where a cost figure came from, for the trace. */
export interface PricingProvenance {
  readonly modelId: string;
  readonly sourceUrl: string;
  readonly verifiedOn: string;
  readonly pricingVersion: string;
  readonly uncachedInputUsdPerMTok: number;
  readonly cachedInputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

export function pricingProvenance(pricing: PricingConfig): PricingProvenance {
  return {
    modelId: pricing.modelId,
    sourceUrl: pricing.sourceUrl,
    verifiedOn: pricing.verifiedOn,
    pricingVersion: pricing.pricingVersion,
    uncachedInputUsdPerMTok: pricing.uncachedInputUsdPerMTok,
    cachedInputUsdPerMTok: pricing.cachedInputUsdPerMTok,
    outputUsdPerMTok: pricing.outputUsdPerMTok,
  };
}

/* ── The smoke test's own bound ────────────────────────────────────────── */

export interface WorstCase {
  readonly usd: number;
  readonly assumedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

export function worstCaseCostUsd(smoke: SmokeConfig): WorstCase {
  return {
    usd:
      (smoke.assumedInputTokens * smoke.pessimisticInputUsdPerMTok) / 1_000_000 +
      (smoke.maxOutputTokens * smoke.pessimisticOutputUsdPerMTok) / 1_000_000,
    assumedInputTokens: smoke.assumedInputTokens,
    maxOutputTokens: smoke.maxOutputTokens,
    inputUsdPerMTok: smoke.pessimisticInputUsdPerMTok,
    outputUsdPerMTok: smoke.pessimisticOutputUsdPerMTok,
  };
}

export function pessimisticActualUsd(usage: TokenUsage, smoke: SmokeConfig): number {
  return (
    (usage.inputTokens * smoke.pessimisticInputUsdPerMTok) / 1_000_000 +
    (usage.outputTokens * smoke.pessimisticOutputUsdPerMTok) / 1_000_000
  );
}

/**
 * NOT A TOKENISER, and deliberately not one.
 *
 * No tokeniser is bundled and none is guessed: the real count arrives with a
 * verified counting mechanism for the configured model, and a guessed one that
 * UNDER-counts would leave the 250,000 gate green while oversized requests
 * went out. This is the placeholder that keeps the gate wired up in the
 * meantime, and it only ever errs upward — over-counting pauses a run that
 * could have continued, which is the harmless direction. It is also what the
 * budget projection uses, for the same reason.
 *
 * The 1.5 factor is a crude allowance for rare CJK characters that encode as
 * more than one token; the flat addition covers request scaffolding. Neither
 * is a measurement and both should be deleted, not tuned, once a real counter
 * exists.
 */
export function pessimisticTokenEstimate(text: string): number {
  return Math.ceil([...text].length * 1.5) + 1_000;
}
