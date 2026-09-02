/**
 * What a two-stage game costs, per arm.
 *
 * PURE. It takes measured sizes and a price list and returns numbers; it opens
 * no file, sends nothing, and knows nothing about which model is which beyond
 * the rates it is handed. The measuring — replaying a real game and building
 * both stages' prompts at every one of its decisions — lives in the scripts
 * that need it, because that part needs the filesystem.
 *
 * TWO COSTS, NOT ONE. The spokesperson stage has never run, so its reasoning
 * token use is unmeasured. A single "projected cost" would silently pick one
 * assumption and present it as a number:
 *
 *   LIKELY       the visible sentence plus modest reasoning. What the stage
 *                should do given a 220-character answer and `medium` effort.
 *   PESSIMISTIC  every spokesperson call spends its ENTIRE output ceiling.
 *                Impossible to exceed, and the number a budget gate should be
 *                argued against.
 *
 * The gap between them IS the uncertainty, and reporting both is the honest
 * way to say "we have not measured this yet" in a table of dollars.
 */

import type { PriceList } from "../model/price-lists";

export interface StageSizes {
  /** Estimated input tokens per planner request, already bias-corrected. */
  readonly plannerInputTokens: number;
  /** Same, for the spokesperson leg. */
  readonly spokespersonInputTokens: number;
  readonly plannerRequests: number;
  readonly spokespersonRequests: number;
  /** Output tokens the planner is expected to spend, from a measured game. */
  readonly plannerOutputTokens: number;
  /** Visible + modest reasoning for one spokesperson answer. */
  readonly spokespersonOutputTokensLikely: number;
  /** The stage's configured ceiling. Cannot be exceeded by definition. */
  readonly spokespersonMaxOutputTokens: number;
  /**
   * Share of input the provider reported as CACHED in the measured game.
   *
   * Applied to both stages. The spokesperson's prompt has its own long stable
   * prefix — the brief and the persona — so assuming the same share is a
   * reasonable first pass and is flagged as an assumption rather than a
   * measurement wherever it is printed.
   */
  readonly cachedInputShare: number;
}

export interface ArmCost {
  readonly label: string;
  readonly plannerModel: string;
  readonly spokespersonModel: string;
  readonly plannerInputUsd: number;
  readonly spokespersonInputUsd: number;
  readonly plannerOutputUsd: number;
  readonly spokespersonOutputUsdLikely: number;
  readonly spokespersonOutputUsdPessimistic: number;
  readonly likelyUsd: number;
  readonly pessimisticUsd: number;
}

function inputUsd(tokens: number, cachedShare: number, price: PriceList): number {
  const cached = tokens * cachedShare;
  const uncached = tokens - cached;
  return (
    (uncached / 1e6) * price.uncachedInputUsdPerMTok +
    (cached / 1e6) * price.cachedInputUsdPerMTok
  );
}

/**
 * One arm's cost, with a separate price list per stage.
 *
 * Two price lists rather than one, because the hybrid arm exists: a Terra
 * planner with a Luna spokesperson is a real configuration somebody may want,
 * and a function that took a single rate table could not express it.
 */
export function projectArm(
  label: string,
  sizes: StageSizes,
  plannerPrice: PriceList,
  spokespersonPrice: PriceList,
): ArmCost {
  const plannerInput = inputUsd(sizes.plannerInputTokens, sizes.cachedInputShare, plannerPrice);
  const sayInput = inputUsd(
    sizes.spokespersonInputTokens,
    sizes.cachedInputShare,
    spokespersonPrice,
  );
  const plannerOutput = (sizes.plannerOutputTokens / 1e6) * plannerPrice.outputUsdPerMTok;
  const sayOutputLikely =
    ((sizes.spokespersonOutputTokensLikely * sizes.spokespersonRequests) / 1e6) *
    spokespersonPrice.outputUsdPerMTok;
  const sayOutputWorst =
    ((sizes.spokespersonMaxOutputTokens * sizes.spokespersonRequests) / 1e6) *
    spokespersonPrice.outputUsdPerMTok;

  return {
    label,
    plannerModel: plannerPrice.modelId,
    spokespersonModel: spokespersonPrice.modelId,
    plannerInputUsd: plannerInput,
    spokespersonInputUsd: sayInput,
    plannerOutputUsd: plannerOutput,
    spokespersonOutputUsdLikely: sayOutputLikely,
    spokespersonOutputUsdPessimistic: sayOutputWorst,
    likelyUsd: plannerInput + sayInput + plannerOutput + sayOutputLikely,
    pessimisticUsd: plannerInput + sayInput + plannerOutput + sayOutputWorst,
  };
}

export interface BudgetVerdict {
  readonly crossesWarning: boolean;
  readonly crossesGameLimit: boolean;
  readonly crossesBatchCeiling: boolean;
  readonly cumulativeAfterUsd: number;
  readonly batchRemainingUsd: number;
}

/**
 * Where a projected arm sits against the three ceilings.
 *
 * Checked against the PESSIMISTIC figure, not the likely one. A budget gate
 * that only holds under the optimistic assumption is not a gate — and the
 * pessimistic figure here is a real bound, since a request cannot spend more
 * than its configured output ceiling.
 */
export function checkBudget(
  arm: ArmCost,
  options: {
    readonly alreadySpentUsd: number;
    readonly warnPerGameUsd: number;
    readonly hardPerGameUsd: number;
    readonly hardBatchUsd: number;
  },
): BudgetVerdict {
  const after = options.alreadySpentUsd + arm.pessimisticUsd;
  return {
    crossesWarning: arm.pessimisticUsd >= options.warnPerGameUsd,
    crossesGameLimit: arm.pessimisticUsd >= options.hardPerGameUsd,
    crossesBatchCeiling: after >= options.hardBatchUsd,
    cumulativeAfterUsd: after,
    batchRemainingUsd: options.hardBatchUsd - after,
  };
}
