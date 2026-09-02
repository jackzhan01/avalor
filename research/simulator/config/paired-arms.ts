/**
 * What two arms of a paired experiment are allowed to differ in.
 *
 * A PAIRED EXPERIMENT IS A CLAIM ABOUT A DIFFERENCE, and the claim is only
 * worth anything if everything else is the same. "Everything else" is a big
 * surface here — prompt version, strategy, persona mapping, cognition limits,
 * disclosure rules, schemas, referee rules, repair limits, input limits,
 * concurrency, budget policy — and reading two JSON files side by side is not
 * how anybody catches a field that quietly moved.
 *
 * So: flatten both resolved configs, drop the fields a paired arm is ALLOWED to
 * differ in, and require the remainder to be identical. The allow-list is
 * short, explicit, and every entry is justified below. Anything not on it that
 * differs is a broken experiment, and the test says which field.
 *
 * WHY IT COMPARES THE RESOLVED CONFIG, not the profile JSON. A profile may say
 * `null` and mean "inherit"; two profiles that inherit differently would look
 * identical on paper and behave differently at runtime. The resolved config is
 * what the run actually uses.
 */

import type { SimConfig } from "./load";

/**
 * Fields a paired arm may legitimately differ in.
 *
 * FOUR CATEGORIES, and nothing else:
 *
 *   the model id itself — that IS the independent variable;
 *   the per-stage model id — the same variable, resolved per stage;
 *   the price list — a model-specific accounting fact, not a behaviour;
 *   nothing else. There is deliberately no entry here for effort, for a
 *   ceiling, for a limit, or for a strategy.
 *
 * `pricing.*` is worth a sentence. It changes what a run COSTS and what the
 * budget gate projects — but it cannot change a single token the model sees,
 * because nothing in the prompt stack reads it. That is why it is allowed and
 * why it is listed field by field rather than as a wildcard: a future
 * `pricing.somethingBehavioural` should fail this test, not slip through.
 */
export const PAIRED_ARM_ALLOWED_DIFFS: readonly string[] = [
  "model.id",
  "stages.planner.model",
  "stages.spokesperson.model",
  "pricing.modelId",
  "pricing.sourceUrl",
  "pricing.verifiedOn",
  "pricing.pricingVersion",
  "pricing.uncachedInputUsdPerMTok",
  "pricing.cachedInputUsdPerMTok",
  "pricing.outputUsdPerMTok",
];

export interface ConfigDiff {
  readonly path: string;
  readonly left: string;
  readonly right: string;
}

/** Every leaf of a resolved config, as `dotted.path` → JSON string. */
export function flattenConfig(config: SimConfig): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    out[path] = JSON.stringify(value);
  };
  walk(config, "");
  return out;
}

/**
 * Differences that are NOT on the allow-list.
 *
 * Returns them rather than throwing, so a test can name every offender at once
 * and a script can print them. An empty array is the property the paired
 * experiment rests on.
 */
export function pairedArmDiff(left: SimConfig, right: SimConfig): readonly ConfigDiff[] {
  const a = flattenConfig(left);
  const b = flattenConfig(right);
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: ConfigDiff[] = [];
  for (const path of [...paths].sort()) {
    if (PAIRED_ARM_ALLOWED_DIFFS.includes(path)) continue;
    const l = a[path] ?? "(absent)";
    const r = b[path] ?? "(absent)";
    if (l !== r) out.push({ path, left: l, right: r });
  }
  return out;
}

/** The allowed differences that ACTUALLY differ. Used to prove the arms are two. */
export function pairedArmVariables(
  left: SimConfig,
  right: SimConfig,
): readonly ConfigDiff[] {
  const a = flattenConfig(left);
  const b = flattenConfig(right);
  const out: ConfigDiff[] = [];
  for (const path of PAIRED_ARM_ALLOWED_DIFFS) {
    const l = a[path] ?? "(absent)";
    const r = b[path] ?? "(absent)";
    if (l !== r) out.push({ path, left: l, right: r });
  }
  return out;
}
