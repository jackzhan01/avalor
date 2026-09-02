/**
 * The offline preflight for the M5.3 paired experiment.
 *
 * OFFLINE, and it sends nothing. It replays the completed `prompt-0.4.0` game
 * and, at every one of that game's decisions, builds BOTH legs of what the
 * `prompt-0.5.0` stack would send — so the size and call-count numbers are
 * measured at real positions rather than guessed from a shape.
 *
 * WHAT IT WILL NOT DO. Collapse the spokesperson's unmeasured reasoning use
 * into one number. That stage has never run; its output cost is reported as a
 * likely figure AND as a pessimistic bound, and the budget check is made
 * against the bound. A projection that only holds under the optimistic
 * assumption is not a projection anybody can authorise a run from.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-3-preflight.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadProfile, resolveStage, type SimConfig } from "../config/load";
import { pairedArmDiff, pairedArmVariables } from "../config/paired-arms";
import { applyAction, createGame } from "../core/referee";
import { observationFor } from "../core/observation";
import type { Seat } from "../core/types";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { claimContestFrom } from "../cognition/claim-contest";
import { buildFactRegistry } from "../cognition/fact-ids";
import { limitsFor } from "../cognition/limits";
import { applyFusedUpdate, parseCognition } from "../cognition/response";
import { CognitionStore } from "../cognition/store";
import { channelForTask, sanitiseIntent, taskHasPublicMessage } from "../cognition/firewall";
import { buildSpokespersonPrompt, publicTableViewFor } from "../cognition/spokesperson";
import type { CommunicationIntent } from "../cognition/intent";
import { extractJson } from "../model/structured";
import { pessimisticTokenEstimate } from "../model/pricing";
import { LUNA_PRICING, TERRA_PRICING } from "../model/price-lists";
import type { ModelAttempt } from "../model/attempt";
import { personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { checkBudget, projectArm, type StageSizes } from "../run/arm-projection";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";

const say = (...parts: unknown[]) => console.log(...parts);
const usd = (n: number) => `$${n.toFixed(4)}`;

const PILOT = "g-6ebccca0-5978-4b1f-a0cf-1c99af014c08";
const OUT = join(process.cwd(), "research", "simulator", "out");

/** Cumulative research spend before this experiment. Stated by the operator. */
const ALREADY_SPENT_USD = 30.5825;

/* ── Measure, by replaying the completed game ───────────────────────────── */

const tracePath = join(OUT, "private", `${PILOT}.private-trace.jsonl`);
if (!existsSync(tracePath)) {
  say(`找不到 M5.2 的私有轨迹：${tracePath}`);
  say("这个脚本用那一局的真实位置做投影。没有它就只能靠猜，而猜的数字不写。");
  process.exit(1);
}

const lines = parseJsonl<PrivateTraceLine>(readFileSync(tracePath, "utf8"));
const manifestLine = lines.find((l) => l.t === "private-manifest");
if (!manifestLine || manifestLine.t !== "private-manifest") throw new Error("no manifest");
const manifest = manifestLine.data;
const actions = lines.flatMap((l) => (l.t === "action" ? [l.data] : []));
const calls = lines.flatMap((l) => (l.t === "model-call" ? [l.data] : []));

const config042: SimConfig = loadConfig({
  simulatorVersion: manifest.simulatorVersion,
  promptVersion: manifest.promptVersion,
  model: manifest.config.model,
  limits: manifest.config.limits,
  cognition: manifest.config.cognition,
  experiment: manifest.config.experiment,
});
const TERRA = loadProfile("m5-3-terra-pilot");
const LUNA = loadProfile("m5-3-luna-pilot");

function sampleIntent(seat: Seat): CommunicationIntent {
  return {
    channel: "table-public",
    publicGoal: "把这一轮的比较标准定下来，并且让牌桌按它投票",
    targetSeats: [],
    selectedClaimAction: "compare-claimants",
    requestedTeam: null,
    requestedVote: "reject",
    publicBasisIds: [],
    publicProposition: `${seat}号 现在能公开核对的依据只有挂掉的那辆车`,
    desiredTableEffect: "这一票投反对，下一辆车按这条约束组",
  };
}

const plannerChars: number[] = [];
const sayChars: number[] = [];
const store = new CognitionStore();
const state = createGame({
  seed: manifest.seed,
  config: config042,
  runId: manifest.runId,
  gameId: manifest.gameId,
});

const bySeat = new Map<Seat, ModelAttempt[]>();
for (const call of calls) {
  const list = bySeat.get(call.seat) ?? [];
  list.push(call);
  bySeat.set(call.seat, list);
}
const cursor = new Map<Seat, number>();

for (const entry of actions) {
  if (!state.pending) break;
  const acting = state.pending.seat;
  const observation = observationFor(state, acting);
  const ledger = store.for(observation);
  const persona = personaById(
    manifest.seats.find((s) => s.seat === acting)?.persona ?? "neutral",
  );
  const strategy = strategyById("expert-disclosure-safe");

  const planner = buildCognitivePrompt({
    observation,
    persona,
    strategy,
    ledger,
    config: TERRA,
  });
  plannerChars.push([...planner.system].length + [...planner.user].length);

  if (taskHasPublicMessage(planner.taskId)) {
    const registry = buildFactRegistry(
      ledger.publicFacts,
      ledger.claims,
      observation,
      claimContestFrom(observation.publicLog),
    );
    const { intent } = sanitiseIntent({
      intent: sampleIntent(acting),
      observation,
      registry,
      persona,
      taskId: planner.taskId,
      taskChannel: channelForTask(planner.taskId),
    });
    const built = buildSpokespersonPrompt({
      view: publicTableViewFor(observation),
      intent,
      persona,
      taskId: planner.taskId,
      speechCharLimit: TERRA.limits.speechCharLimit,
      selectedAction: "",
    });
    sayChars.push([...built.system].length + [...built.user].length);
  }

  // Advance the ledger exactly as the live run did, so the next position's
  // prompt is built against the same memory.
  const list = bySeat.get(acting) ?? [];
  const index = cursor.get(acting) ?? 0;
  let end = index;
  while (end < list.length) {
    const a = list[end];
    end += 1;
    if (a.outcome === "valid" && a.appliedLegalAction) break;
    if (end - index > 8) break;
  }
  cursor.set(acting, end);
  for (const a of list.slice(index, end)) {
    if (a.outcome !== "valid" || a.rejectedBy === "cognition" || !a.raw) continue;
    let block: unknown;
    try {
      block = (JSON.parse(extractJson(a.raw)) as Record<string, unknown>).cognition;
    } catch {
      continue;
    }
    const limits = limitsFor(config042.promptVersion);
    const parsed = parseCognition(block, { limits, withSocial: true, withContest: true });
    if (!parsed.ok) continue;
    const claimContest = claimContestFrom(observation.publicLog);
    store.put(
      applyFusedUpdate(ledger, observation, parsed.cognition, observation.publicLog.length, {
        registry: buildFactRegistry(ledger.publicFacts, ledger.claims, observation, claimContest),
        limits,
        claimContest,
      }).ledger,
    );
  }

  applyAction(state, entry.seat, entry.action);
}

/* ── Turn measurements into projected sizes ─────────────────────────────── */

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);
const tokensOf = (chars: readonly number[]) =>
  sum(chars.map((c) => pessimisticTokenEstimate("x".repeat(c))));

/**
 * The estimator's measured bias.
 *
 * `pessimisticTokenEstimate` deliberately over-counts. The completed game
 * recorded both its own estimate and the provider's reported total, so this
 * ratio is a measurement rather than a fudge factor somebody chose.
 */
const ESTIMATED = sum(calls.map((c) => c.estimatedInputTokens));
const REPORTED = sum(calls.map((c) => c.usage?.inputTokens ?? 0));
const BIAS = REPORTED / ESTIMATED;

const CACHED_SHARE =
  sum(calls.map((c) => c.usage?.cachedInputTokens ?? 0)) / Math.max(1, REPORTED);

/* ── Call counts ────────────────────────────────────────────────────────── */

const decisions = plannerChars.length;
const speakingDecisions = sayChars.length;
/** Planner requests the completed game actually needed, retries included. */
const PLANNER_REQUESTS = calls.length;
const PLANNER_RETRIES = PLANNER_REQUESTS - decisions;
const REPAIR_ALLOWANCE = TERRA.stages.maxPublicMessageRepairs;
/** Worst case: every speaking turn uses its whole repair allowance. */
const SAY_REQUESTS_WORST = speakingDecisions * (1 + REPAIR_ALLOWANCE);

const plannerInputTokens = tokensOf(plannerChars) * BIAS * (PLANNER_REQUESTS / decisions);
const sayInputTokens = tokensOf(sayChars) * BIAS;

const PILOT_OUTPUT = sum(calls.map((c) => c.usage?.outputTokens ?? 0));
const PILOT_REASONING = sum(calls.map((c) => c.usage?.reasoningTokens ?? 0));

/**
 * One spokesperson answer, if the stage behaves as designed.
 *
 * 220 non-whitespace Chinese characters is roughly 220 tokens of visible text.
 * The rest is an allowance for `medium`-effort reasoning on a task whose whole
 * input is a public record and a nine-field envelope. UNMEASURED, and every
 * table that uses it says so.
 */
const SAY_OUTPUT_LIKELY = 700;

const sizes: StageSizes = {
  plannerInputTokens,
  spokespersonInputTokens: sayInputTokens,
  plannerRequests: PLANNER_REQUESTS,
  spokespersonRequests: speakingDecisions,
  plannerOutputTokens: PILOT_OUTPUT,
  spokespersonOutputTokensLikely: SAY_OUTPUT_LIKELY,
  spokespersonMaxOutputTokens: resolveStage(TERRA, "spokesperson").maxOutputTokens,
  cachedInputShare: CACHED_SHARE,
};

/** The pessimistic bound also assumes every repair is used. */
const worstSizes: StageSizes = {
  ...sizes,
  spokespersonRequests: SAY_REQUESTS_WORST,
  spokespersonInputTokens: sayInputTokens * (1 + REPAIR_ALLOWANCE),
};

const arms = [
  { arm: projectArm("① Terra 规划 + Terra 发言", sizes, TERRA_PRICING, TERRA_PRICING), worst: projectArm("①", worstSizes, TERRA_PRICING, TERRA_PRICING) },
  { arm: projectArm("② Terra 规划 + Luna 发言（仅供参考）", sizes, TERRA_PRICING, LUNA_PRICING), worst: projectArm("②", worstSizes, TERRA_PRICING, LUNA_PRICING) },
  { arm: projectArm("③ Luna 规划 + Luna 发言", sizes, LUNA_PRICING, LUNA_PRICING), worst: projectArm("③", worstSizes, LUNA_PRICING, LUNA_PRICING) },
];

/* ── Report ─────────────────────────────────────────────────────────────── */

say("=== M5.3 配对实验 · 离线预检 ===");
say("");
say("不发任何请求。下面每一个体量数字都是在 M5.2 那一局的真实位置上实测的。");
say("");

say("--- 一、两条臂的解析后差异 ---");
const unexpected = pairedArmDiff(TERRA, LUNA);
say(`计划外的差异：${unexpected.length} 个${unexpected.length === 0 ? "  ✅" : "  ❌"}`);
for (const d of unexpected) say(`  ❌ ${d.path}: ${d.left} vs ${d.right}`);
say("允许并且确实存在的差异：");
for (const d of pairedArmVariables(TERRA, LUNA)) {
  say(`  ${d.path.padEnd(34)} ${d.left}  →  ${d.right}`);
}
say("");
for (const [name, config] of [["Terra", TERRA], ["Luna", LUNA]] as const) {
  const p = resolveStage(config, "planner");
  const s = resolveStage(config, "spokesperson");
  say(
    `${name.padEnd(6)} 规划者 ${p.model} / ${p.reasoningEffort} / ${p.maxOutputTokens}` +
      `　发言者 ${s.model} / ${s.reasoningEffort} / ${s.maxOutputTokens}` +
      `　重发上限 ${config.stages.maxPublicMessageRepairs}`,
  );
}
say("");

say("--- 二、调用次数 ---");
say(`决策 ${decisions} 个，其中要说话的 ${speakingDecisions} 个`);
say(`规划者请求  ${PLANNER_REQUESTS}（M5.2 实测，含 ${PLANNER_RETRIES} 次重试）`);
say(`发言者请求  ${speakingDecisions}（每个说话回合一次）`);
say(`重发额度    ${REPAIR_ALLOWANCE} 次/回合 → 最坏 ${SAY_REQUESTS_WORST} 次发言者请求`);
say(
  `合计        ${PLANNER_REQUESTS + speakingDecisions} 次（最坏 ${PLANNER_REQUESTS + SAY_REQUESTS_WORST}）` +
    `，单局上限 ${TERRA.limits.maxLiveCallsPerGame}，占 ` +
    `${Math.round(((PLANNER_REQUESTS + SAY_REQUESTS_WORST) / TERRA.limits.maxLiveCallsPerGame) * 100)}%`,
);
say("");

say("--- 三、输入 token（按阶段拆分）---");
say(`估算器偏差系数 ${BIAS.toFixed(4)}（M5.2 实测：估算 ${ESTIMATED.toLocaleString()}，实报 ${REPORTED.toLocaleString()}）`);
say(`缓存命中比例   ${(CACHED_SHARE * 100).toFixed(1)}%（M5.2 实测，两段都按这个比例算 —— 这是假设）`);
say(`规划者  ${Math.round(plannerInputTokens).toLocaleString()} token`);
say(`发言者  ${Math.round(sayInputTokens).toLocaleString()} token`);
say(
  `合计    ${Math.round(plannerInputTokens + sayInputTokens).toLocaleString()} token` +
    `（M5.2 实测 ${REPORTED.toLocaleString()} 的 ${((plannerInputTokens + sayInputTokens) / REPORTED).toFixed(2)}×）`,
);
say("");

say("--- 四、输出 token（按阶段拆分）---");
say(`规划者  ${PILOT_OUTPUT.toLocaleString()}（M5.2 实测；其中 reasoning ${PILOT_REASONING.toLocaleString()}）`);
say(`        0.5.0 把 publicMessage 从规划者 schema 里拿掉换成更短的信封，所以只会更小。按不变估。`);
say(`发言者  可能 ${SAY_OUTPUT_LIKELY}/次 × ${speakingDecisions} = ${(SAY_OUTPUT_LIKELY * speakingDecisions).toLocaleString()}`);
say(`        最坏 ${sizes.spokespersonMaxOutputTokens}/次 × ${SAY_REQUESTS_WORST} = ${(sizes.spokespersonMaxOutputTokens * SAY_REQUESTS_WORST).toLocaleString()}（撞满上限）`);
say("        ⚠ 这一段一次都没跑过，reasoning 用量没有任何测量。「可能」是推的，「最坏」是硬界。");
say("");

say("--- 五、成本 ---");
say(`Terra ${TERRA_PRICING.pricingVersion}：输入 ${TERRA_PRICING.uncachedInputUsdPerMTok} / 缓存 ${TERRA_PRICING.cachedInputUsdPerMTok} / 输出 ${TERRA_PRICING.outputUsdPerMTok}（每百万）`);
say(`Luna  ${LUNA_PRICING.pricingVersion}：输入 ${LUNA_PRICING.uncachedInputUsdPerMTok} / 缓存 ${LUNA_PRICING.cachedInputUsdPerMTok} / 输出 ${LUNA_PRICING.outputUsdPerMTok}（每百万）`);
say("");
for (const { arm, worst } of arms) {
  say(arm.label);
  say(
    `  输入  规划 ${usd(arm.plannerInputUsd)} + 发言 ${usd(arm.spokespersonInputUsd)}` +
      `　输出  规划 ${usd(arm.plannerOutputUsd)} + 发言 ${usd(arm.spokespersonOutputUsdLikely)}`,
  );
  say(`  **可能 ${usd(arm.likelyUsd)}　最坏 ${usd(worst.pessimisticUsd)}**`);
  const verdict = checkBudget(worst, {
    alreadySpentUsd: ALREADY_SPENT_USD,
    warnPerGameUsd: TERRA.budget.costWarningPerGameUsd,
    hardPerGameUsd: TERRA.budget.hardCostLimitPerGameUsd,
    hardBatchUsd: TERRA.budget.hardBatchCostLimitUsd,
  });
  say(
    `  $${TERRA.budget.costWarningPerGameUsd} 提醒线 ${verdict.crossesWarning ? "⚠ 会触发" : "不触发"}` +
      `　$${TERRA.budget.hardCostLimitPerGameUsd} 单局硬闸 ${verdict.crossesGameLimit ? "❌ 会撞" : "不撞"}` +
      `　$${TERRA.budget.hardBatchCostLimitUsd} 批量硬闸 ${verdict.crossesBatchCeiling ? "❌ 会撞" : "不撞"}`,
  );
  say(
    `  累计（从 ${usd(ALREADY_SPENT_USD)} 起）最坏到 ${usd(verdict.cumulativeAfterUsd)}，` +
      `批量余额 ${usd(verdict.batchRemainingUsd)}`,
  );
  say("");
}

const both = arms[0].worst.pessimisticUsd + arms[2].worst.pessimisticUsd;
say("--- 六、把 ① 和 ③ 都跑一局 ---");
say(
  `最坏合计 ${usd(both)}，累计到 ${usd(ALREADY_SPENT_USD + both)}，` +
    `批量余额 ${usd(TERRA.budget.hardBatchCostLimitUsd - ALREADY_SPENT_USD - both)}`,
);
say("");
say("② 只作参考：混合模型是另一个需要人明确选择的对比，不是这一次的配对臂。");
