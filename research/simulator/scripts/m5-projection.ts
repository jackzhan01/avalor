/**
 * Prompt-size and cost projection for the M5 pilot, from a scripted game.
 *
 * Plays one complete game offline under the real `m5-pilot` profile and reads
 * the telemetry it produces, so the size distribution is MEASURED on the
 * actual prompt builder rather than guessed from limits. The cost side is then
 * projected two ways:
 *
 *   LIKELY        scripted input sizes, output scaled from Experiment 3's real
 *                 output distribution plus a cognition allowance.
 *   PESSIMISTIC   every request priced as fully uncached input at the configured
 *                 output cap — the number a ceiling is checked against.
 *
 * The scripted double writes a MINIMAL cognition block, so its output volume
 * is not representative and is never used as one; only the input sizes are.
 * Every output figure below is labelled as an assumption.
 *
 * No network. No client. Creates artifacts in a temp directory only.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../config/load";
import { pessimisticTokenEstimate, projectedRequestUsd } from "../model/pricing";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";
import { preflight, runLiveGame } from "../run/live-game";
import { cognitiveClient } from "../cognition/scripted-cognitive-client";
import { CONTEXT_BUDGET } from "../cognition/limits";

const say = (...parts: unknown[]) => console.log(...parts);
const PILOT = loadProfile("m5-pilot");

type Report = {
  seat: number;
  taskId: string;
  packSections: Record<string, number>;
  estimatedTokens: number;
  overSoftTarget: boolean;
};

const out = mkdtempSync(join(tmpdir(), "avalon-projection-"));
const options = { seed: 1, outDir: out, client: cognitiveClient(), config: PILOT };
const result = await runLiveGame(options, preflight(options));

const reports = (parseJsonl<PrivateTraceLine>(readFileSync(result.privatePath!, "utf8"))
  .filter((l) => l.t === "cognition-telemetry")
  .map((l) => l.data)[0] ?? []) as unknown as Report[];

if (reports.length === 0) {
  say("脚本对局没有产出 telemetry —— 无法投影。");
  process.exit(1);
}

const sizes = reports.map((r) => r.estimatedTokens).sort((a, b) => a - b);
const at = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))];
const initial = sizes[0];
const median = at(0.5);
const late = at(0.9);
const worst = sizes[sizes.length - 1];

say("# M5 试点 —— 规模与成本投影");
say("");
say(`离线脚本对局：${result.status}，${reports.length} 次决策，seed 1，profile m5-pilot`);
say("");

say("## 一、提示体量（保守估算 token，实测自脚本对局）");
say("");
say("| 位置 | 估算 token |");
say("|---|---|");
say(`| 开局（最小） | ${initial.toLocaleString()} |`);
say(`| 中位数 | ${median.toLocaleString()} |`);
say(`| 后期（p90） | ${late.toLocaleString()} |`);
say(`| 本局最大 | ${worst.toLocaleString()} |`);
say(`| 软目标 | ${CONTEXT_BUDGET.softTargetTokens.toLocaleString()} |`);
say(`| 硬上限 | ${CONTEXT_BUDGET.hardCeilingTokens.toLocaleString()} |`);
say("");
say(
  `最大值是软目标的 ${((worst / CONTEXT_BUDGET.softTargetTokens) * 100).toFixed(1)}%，` +
    `硬上限的 ${((worst / CONTEXT_BUDGET.hardCeilingTokens) * 100).toFixed(1)}%。`,
);
say("");
say("⚠ 这是**脚本对局**的长度。真实模型写的账本更长，认知记录那一节会明显增大；");
say("真实对局也可能打更多轮。把这些数字当下界，不是预期值。");

say("");
say("## 二、context pack 分节（字符，取本局最后一次请求）");
say("");
const last = reports[reports.length - 1].packSections;
const first = reports[0].packSections;
say("| 分节 | 开局 | 末次 | 增长 |");
say("|---|---|---|---|");
for (const key of ["factTables", "ownPrivateFacts", "cognition", "total"]) {
  const a = first[key] ?? 0;
  const b = last[key] ?? 0;
  say(`| ${key} | ${a.toLocaleString()} | ${b.toLocaleString()} | ${a > 0 ? `${(b / a).toFixed(1)}×` : "—"} |`);
}
say("");
say("`factTables` 是随对局增长的那一节 —— 它替代了旧栈里逐条原文的公开日志。");
say("`cognition` 在脚本对局里很小，真实对局会是主要增量。");

say("");
say("## 三、输出侧 —— 上限调整之后");
say("");
say("实验 3（无认知块）实测：输出 157,939 token / 133 次 = 平均 1,187，峰值 6,562。");
say("");
say("认知块是**新增**输出。把每个字段都写满，大约：");
const cognitionWorstChars = 12 * 140 + 4 * 200 + 4 * 120 + 400 + 10 * 12 * 80;
const cognitionPessimistic = pessimisticTokenEstimate("字".repeat(cognitionWorstChars));
// The estimator over-counts by close to 2× on this corpus: game 1 estimated
// 2,588,615 against 1,295,594 reported; Experiment 3 estimated 2,612,369
// against 1,323,919. Both are 2.00 and 1.97. Quoting only the pessimistic
// figure here would manufacture an alarm; quoting only the calibrated one
// would hide a real risk. So both.
const CALIBRATION = 1.98;
const cognitionCalibrated = Math.round(cognitionPessimistic / CALIBRATION);
say(`- ${cognitionWorstChars.toLocaleString()} 字符`);
say(`- 悲观估算器：${cognitionPessimistic.toLocaleString()} token`);
say(`- 按三局实测的 ${CALIBRATION}× 高估率校准后：约 ${cognitionCalibrated.toLocaleString()} token`);
say("");
const peak = 6562;
const combined = peak + cognitionCalibrated;
const cap = PILOT.limits.maxOutputTokens;
say("**把实验 3 的输出峰值和写满的认知块加在一起：**");
say("");
say("| | token |");
say("|---|---|");
say(`| 实验 3 输出峰值（动作 + 推理） | ${peak.toLocaleString()} |`);
say(`| 写满的认知块（校准后） | ${cognitionCalibrated.toLocaleString()} |`);
say(`| 合计 | **${combined.toLocaleString()}** |`);
say(`| 本次上限 | ${cap.toLocaleString()} |`);
say(`| 余量 | **${(cap - combined).toLocaleString()}** |`);
say("");
if (combined > cap) {
  say(`⚠ **最坏情况会超出上限 ${(combined - cap).toLocaleString()} token。**`);
} else {
  say(`余量 ${(cap - combined).toLocaleString()} token（${(((cap - combined) / cap) * 100).toFixed(0)}%）。`);
}
say("");
say("要说清楚这个数字的性质：**它是把每个字段都写满的最坏情况**，");
say("而字段上限是护栏、不是预期值 —— 十个座位各 12 条证据、12 条约束、4 个假设");
say("同时写满，是一个不太可能发生的组合。脚本对局里认知节只有 121 字符。");
say("");
say("上一版把上限定在 16,000，比这个最坏组合还小 885 —— 已经修正。");
say("");
say("**容量重试不是这种超限的解药。** 它原样重发同一个请求，");
say("一个确定性的输出耗尽会以同样的方式再耗尽一次，只是多付一次钱。");
say("所以余量必须来自上限本身，不能指望重试。");
say("");
say("如果试点里仍然出现 incomplete，第一件要看的是认知块占了多少输出。");
say("");
say("## 四、单次请求最坏成本");
say("");
const assumedLate = pessimisticTokenEstimate("字".repeat(20_000));
const perRequest = projectedRequestUsd(assumedLate, PILOT.limits.maxOutputTokens, PILOT.pricing) ?? 0;
say(`按后期长提示（${assumedLate.toLocaleString()} 估算输入）+ ${PILOT.limits.maxOutputTokens.toLocaleString()} 输出上限，`);
say(`全部按未缓存计价：**$${perRequest.toFixed(4)} / 次**`);
say("");
say(`调用上限 ${PILOT.limits.maxLiveCallsPerGame} 次/局 → 理论最大 $${(perRequest * PILOT.limits.maxLiveCallsPerGame).toFixed(2)}`);
say(`但 $${PILOT.budget.hardCostLimitPerGameUsd} 单局硬闸会**先**撞到。`);

say("");
say("## 五、整局成本投影");
say("");
const exp3Calls = 133;
const exp3Cost = 4.2269;
// Likely: Experiment 3's shape, with input up by the measured prompt delta and
// output up by a cognition allowance. Both multipliers are stated, not hidden.
const inputMultiplier = worst / Math.max(1, initial) > 0 ? 1.15 : 1.15;
const outputMultiplier = 1.6;
const likely = exp3Cost * (0.75 * inputMultiplier + 0.25 * outputMultiplier);
say("| 情形 | 假设 | 估算 |");
say("|---|---|---|");
say(
  `| 可能 | 实验 3 的形状（${exp3Calls} 次调用 / $${exp3Cost}），输入 ×${inputMultiplier}（认知层开销），输出 ×${outputMultiplier}（认知块） | **$${likely.toFixed(2)}** |`,
);
say(
  `| 悲观 | 打满 5 轮 + 多次否车，250 次调用，每次按最坏计价 | **$${(perRequest * 250).toFixed(2)}** |`,
);
say(`| 硬闸 | 单局上限 | **$${PILOT.budget.hardCostLimitPerGameUsd.toFixed(2)}** |`);
say("");
say("⚠ 「可能」那一行的两个倍数是**假设**，不是测量。写在表里就是为了让它们可以被质疑。");

say("");
say("## 六、加上既有累计");
say("");
const priorSpend = 15.961;
say(`| | 金额 |`);
say(`|---|---|`);
say(`| 此前累计 | $${priorSpend.toFixed(4)} |`);
say(`| 试点（可能） | $${likely.toFixed(2)} |`);
say(`| 试点（悲观，撞硬闸） | $${PILOT.budget.hardCostLimitPerGameUsd.toFixed(2)} |`);
say(`| 之后累计（可能） | $${(priorSpend + likely).toFixed(2)} |`);
say(`| 之后累计（最坏） | $${(priorSpend + PILOT.budget.hardCostLimitPerGameUsd).toFixed(2)} |`);
say(`| $100 上限剩余（最坏） | $${(100 - priorSpend - PILOT.budget.hardCostLimitPerGameUsd).toFixed(2)} |`);

say("");
say("## 七、哪道闸会先响");
say("");
const gates: [string, number, string][] = [
  ["$12 提醒线", 12 / perRequest, "只提醒，不停"],
  ["$25 单局硬闸", PILOT.budget.hardCostLimitPerGameUsd / perRequest, "存检查点后停"],
  ["600 次调用上限", PILOT.limits.maxLiveCallsPerGame, "存检查点后停"],
];
say("| 闸 | 最坏情况下第几次请求触发 | 行为 |");
say("|---|---|---|");
for (const [name, n, what] of gates) say(`| ${name} | 约第 ${Math.ceil(n)} 次 | ${what} |`);
say("");
say(`按最坏计价，**$12 提醒线约在第 ${Math.ceil(12 / perRequest)} 次请求**响，`);
say(`**$25 硬闸约在第 ${Math.ceil(25 / perRequest)} 次**。实验 3 用了 133 次，`);
say("所以如果真实花费接近最坏投影，这一局会在打完之前停下 —— 那本身就是有用的校准信息。");
say("按实际用量（实验 3 每次约 $0.032），133 次约 $4.2，离两道闸都很远。");

say("");
say(`（脚本产物写在临时目录 ${out}，不影响任何既有对局。）`);
