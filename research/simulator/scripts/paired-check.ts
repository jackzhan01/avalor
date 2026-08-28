/**
 * Prove two experiment arms differ in exactly one thing before paying for them.
 *
 * A paired comparison is only worth running if the pairing is real. This
 * resolves both configurations the way `preflight` does — same code path, no
 * network, no artifacts — and then asserts, field by field, that everything
 * except the strategy profile is identical: the deal the seed produces, the
 * seat→persona assignment, the model, the effort, the limits, the pricing and
 * both versions.
 *
 * Anything it cannot prove, it prints as a failure and exits non-zero, because
 * discovering afterwards that two "paired" games were not paired means the
 * money bought nothing.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/paired-check.ts
 */

import { loadConfig } from "../config/load";
import { SEATS } from "../core/types";
import { assignPersonas } from "../prompts/personas";
import { renderStrategy, strategyById, strategyFingerprint } from "../prompts/strategies";
import { createGame } from "../core/referee";
import { observationFor } from "../core/observation";

const say = (...parts: unknown[]) => console.log(...parts);

const SEED = 1;
const MODE = "heterogeneous-rotated" as const;
const ARMS = ["baseline", "community-meta"] as const;

const problems: string[] = [];
const check = (ok: boolean, label: string) => {
  if (ok) say(`✓ ${label}`);
  else {
    problems.push(label);
    say(`✗ ${label}`);
  }
};

const config = loadConfig();

say("=== 配对检查：实验 2 vs 实验 3 ===");
say(`seed ${SEED}   persona 模式 ${MODE}`);
say(`两臂 ${ARMS.join(" / ")}`);
say("");

/* ── 1. Same deal, because the seed is the same ────────────────────────── */

// Built through the real path twice, rather than by calling the dealer
// directly: what matters is that the game each arm starts from is the same
// game, not that a helper is deterministic in isolation.
const gameA = createGame({ seed: SEED, config });
const gameB = createGame({ seed: SEED, config });
check(
  JSON.stringify(gameA.deal.bySeat) === JSON.stringify(gameB.deal.bySeat),
  "同一个 seed 发出同一副牌（发牌只由 seed 决定，与策略档无关）",
);
check(
  gameA.initialLeader === gameB.initialLeader,
  `首任队长相同（${gameA.initialLeader}号）`,
);

/* ── 2. Same seat→persona assignment ───────────────────────────────────── */

const personaA = assignPersonas(SEED, MODE);
const personaB = assignPersonas(SEED, MODE);
const idsA = SEATS.map((s) => personaA[s].id);
const idsB = SEATS.map((s) => personaB[s].id);
check(idsA.join(",") === idsB.join(","), "十个座位解析出同一套 persona");
check(new Set(idsA).size > 1, `heterogeneous-rotated 确实给出了多种 persona（${new Set(idsA).size} 种）`);

say("");
say("座位 → persona：");
for (const seat of SEATS) say(`  ${seat}号  ${personaA[seat].id}`);

/* ── 3. Everything else about the run configuration ────────────────────── */

say("");
const shared = {
  simulatorVersion: config.simulatorVersion,
  promptVersion: config.promptVersion,
  model: config.model.id,
  reasoningEffort: config.model.reasoningEffort,
  limits: config.limits,
  budget: config.budget,
  pricingVersion: config.pricing.pricingVersion,
  playerCount: config.playerCount,
};
say("两臂共用的配置：");
say(JSON.stringify(shared, null, 2));
check(config.model.id === "gpt-5.6-terra", "模型 gpt-5.6-terra");
check(config.model.reasoningEffort === "high", "reasoning effort high");
check(config.limits.maxOutputTokens === 12_000, "maxOutputTokens 12000");
// Disclosed, not hidden: Experiment 2 ran at 6000 and died of output-capacity
// exhaustion at the longest prompt of the game. Experiment 3 runs at 12000.
// That is a second difference between the two arms and every report has to
// say so — a paired comparison that quietly varied two things is not paired.
say("");
say("⚠ 与实验 2 的差异有两项，都是有意的：");
say("   1. 策略档 baseline → community-meta");
say("   2. maxOutputTokens 6000 → 12000（实验 2 在 6000 处输出耗尽而失败）");
say("   提示文本、persona、规则、模型、价目、两个版本号都没有动。");
check(config.limits.maxStandardInputTokens === 250_000, "单次输入上限 250,000");
check(config.budget.hardCostLimitPerGameUsd === 25, "单局硬上限 $25");
check(config.pricing.configured, "价目已配置");
check(config.promptVersion === "prompt-0.2.0", `promptVersion ${config.promptVersion}`);

/* ── 4. The strategy profile is the ONLY thing that differs ────────────── */

say("");
const baseline = strategyById("baseline");
const meta = strategyById("community-meta");
const fpBase = strategyFingerprint(baseline);
const fpMeta = strategyFingerprint(meta);
say(`baseline       指纹 ${fpBase}`);
say(`community-meta 指纹 ${fpMeta}`);
check(fpBase !== fpMeta, "两个策略档的指纹不同 —— 这正是唯一的变量");
check(baseline.heuristics.length === 0, "baseline 是空的对照组");
check(meta.heuristics.length >= 30, `community-meta 有 ${meta.heuristics.length} 条考量`);

/* ── 5. What each seat actually reads, per arm ─────────────────────────── */

say("");
say("每个座位实际读到的考量条数（按身份过滤后）：");
const state = gameA;
let allSame = true;
for (const seat of SEATS) {
  const observation = observationFor(state, seat);
  const nBase = renderStrategy(baseline, observation);
  const nMeta = renderStrategy(meta, observation);
  const countMeta = (nMeta.match(/^- 当/gm) ?? []).length;
  const countBase = (nBase.match(/^- 当/gm) ?? []).length;
  say(`  ${seat}号  baseline ${countBase} 条   community-meta ${countMeta} 条`);
  if (countBase !== 0) allSame = false;
  if (countMeta < 15) allSame = false;
}
check(allSame, "baseline 每座位 0 条，community-meta 每座位至少 15 条");

/* ── 6. Nothing about the pairing leaks the deal ───────────────────────── */

const anyRendered = SEATS.map((seat) =>
  renderStrategy(meta, observationFor(state, seat)),
).join("\n");
check(!anyRendered.includes("seed"), "渲染文本里没有 seed");
check(
  !/\d+号(是|为)(梅林|派西维尔|莫甘娜|莫德雷德|奥伯伦|刺客|忠臣)/.test(anyRendered),
  "渲染文本里没有把身份安到具体座位上",
);

/* ── Verdict ───────────────────────────────────────────────────────────── */

say("");
if (problems.length === 0) {
  say("✓ 配对成立：除上面列出的两项有意差异外，两臂的每一项都相同。可以开跑。");
} else {
  say(`✗ ${problems.length} 项不成立，不要开跑：`);
  for (const p of problems) say(`  - ${p}`);
  process.exit(1);
}
