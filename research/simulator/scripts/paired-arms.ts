/**
 * Print the resolved difference between two profiles.
 *
 * OFFLINE. Loads both configs, normalises away the fields a paired experiment
 * is ALLOWED to differ in, and prints whatever is left. What is left should be
 * the model id, its price list, and nothing else — `config/paired-arms.test.ts`
 * asserts exactly that; this script is the same comparison in a form a human
 * can read before authorising a run.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/paired-arms.ts -- m5-3-terra-pilot m5-3-luna-pilot
 */

import { loadProfile, resolveStage, type ProfileName } from "../config/load";
import { flattenConfig, pairedArmDiff } from "../config/paired-arms";

const say = (...parts: unknown[]) => console.log(...parts);
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const [a, b] = args.length >= 2 ? args : ["m5-3-terra-pilot", "m5-3-luna-pilot"];

const left = loadProfile(a as ProfileName);
const right = loadProfile(b as ProfileName);

say(`${a}  vs  ${b}`);
say("");
for (const [name, config] of [
  [a, left],
  [b, right],
] as const) {
  say(
    `${name.padEnd(20)} planner ${JSON.stringify(resolveStage(config, "planner"))}`,
  );
  say(`${"".padEnd(20)} say     ${JSON.stringify(resolveStage(config, "spokesperson"))}`);
  say(`${"".padEnd(20)} pricing ${config.pricing.pricingVersion}`);
}
say("");

const diff = pairedArmDiff(left, right);
say(`归一化之后仍然不同的字段：${diff.length}`);
for (const d of diff) say(`  ${d.path}\n    ${a}: ${d.left}\n    ${b}: ${d.right}`);
say("");
say(`两边打平的字段数：${Object.keys(flattenConfig(left)).length - diff.length}`);
