/**
 * The official price lists, one per model, each separately versioned.
 *
 * WHY A CATALOG RATHER THAN A NUMBER IN EACH PROFILE. Two paired arms that
 * differ only in the model have to differ in pricing too, and the moment the
 * same rate is typed into two files one of them is going to be edited alone.
 * A profile still carries its own `pricing` block — `loadConfig` validates that
 * block against `model.id`, and a config that could not be read off its own
 * file would defeat the point of profiles being reviewable. So the catalog is
 * the SOURCE and a test asserts each profile matches it exactly.
 *
 * EVERY ENTRY CARRIES ITS PROVENANCE. A cost figure in a research trace is only
 * checkable if the reader can see which price list produced it and when it was
 * read; prices change, and a run costed against last quarter's table is a run
 * whose dollar figures quietly mean something else. `pricingVersion` is
 * `<model>@<date>` so two runs of the same model at different times are
 * distinguishable in an artifact without anyone diffing rates by hand.
 *
 * TERRA IS FROZEN. Its numbers are recorded in the manifests of two completed
 * live games and in every cost figure ever reported from them. `price-lists`
 * exists to ADD Luna, not to restate Terra — a test pins the Terra entry to the
 * bytes `default.json` has always carried.
 */

export interface PriceList {
  /** The model these rates are for. Checked against `model.id` at load. */
  readonly modelId: string;
  readonly sourceUrl: string;
  /** ISO date the price list was read. */
  readonly verifiedOn: string;
  /** `<model>@<date>`. Stamped into every artifact that costs anything. */
  readonly pricingVersion: string;
  readonly uncachedInputUsdPerMTok: number;
  readonly cachedInputUsdPerMTok: number;
  /** Output, INCLUDING reasoning tokens. */
  readonly outputUsdPerMTok: number;
}

/**
 * `gpt-5.6-terra`. FROZEN — these are the rates two completed games were
 * costed against, and every dollar figure in their reports.
 */
export const TERRA_PRICING: PriceList = {
  modelId: "gpt-5.6-terra",
  sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  verifiedOn: "2026-08-23",
  pricingVersion: "gpt-5.6-terra@2026-08-23",
  uncachedInputUsdPerMTok: 2.0,
  cachedInputUsdPerMTok: 0.2,
  outputUsdPerMTok: 12.0,
};

/**
 * `gpt-5.6-luna`. New, and never yet used for a paid request.
 *
 * An order of magnitude cheaper than Terra on every axis: 1/10 the input,
 * 1/10 the cached input, 1/10 the output. That ratio is the whole reason the
 * paired experiment is worth running — but it says nothing about whether the
 * two models PLAY the same, which is the question, and which no price list can
 * answer.
 */
export const LUNA_PRICING: PriceList = {
  modelId: "gpt-5.6-luna",
  sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  verifiedOn: "2026-08-27",
  pricingVersion: "gpt-5.6-luna@2026-08-27",
  uncachedInputUsdPerMTok: 0.2,
  cachedInputUsdPerMTok: 0.02,
  outputUsdPerMTok: 1.2,
};

export const PRICE_LISTS: Readonly<Record<string, PriceList>> = Object.freeze({
  [TERRA_PRICING.modelId]: TERRA_PRICING,
  [LUNA_PRICING.modelId]: LUNA_PRICING,
});

/**
 * The list for one model, or null.
 *
 * NULL, not a throw and not a default. A model with no configured price list
 * has to make `estimateCostUsd` return null so a budget built on it is visibly
 * absent rather than confidently wrong — the same rule `pricing.configured`
 * already encodes.
 */
export function priceListFor(modelId: string): PriceList | null {
  return PRICE_LISTS[modelId] ?? null;
}
