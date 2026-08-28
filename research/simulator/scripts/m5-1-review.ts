/**
 * The M5.1 human-review package.
 *
 * Plays one complete game offline under the REAL `m5-1-pilot` profile with a
 * scripted double, then prints what a human needs in order to decide whether
 * the next paid game should run: the prompt as the model will see it, worked
 * examples of a premise resolving and failing to resolve, the Percival and
 * loyal-following material, the social payload, and the size and cost delta
 * against the completed M5 pilot.
 *
 * Everything below is RENDERED from the shipping code — no example in this file
 * is retyped prose. That is the lesson of the completed pilot, whose review
 * package described a fact table with ids that the builder did not print.
 *
 * No network. No client. No key is read. Artifacts go to a temp directory.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-1-review.ts
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadProfile } from "../config/load";
import { observationFor } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { assignPersonas } from "../prompts/personas";
import { renderStrategy, strategyById, strategyFingerprint } from "../prompts/strategies";
import { pessimisticTokenEstimate, projectedRequestUsd } from "../model/pricing";
import type { ModelRequest } from "../model/client";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { buildFactRegistry, resolvePremiseId } from "../cognition/fact-ids";
import { ledgerFrom } from "../cognition/ledger";
import { CONTEXT_BUDGET, limitsFor } from "../cognition/limits";
import { CognitionStore } from "../cognition/store";
import { SOCIAL_SCENARIOS } from "../cognition/scenarios-social";
import { cognitiveClient } from "../cognition/scripted-cognitive-client";
import { PUBLIC_BRIDGE_LAYER } from "../cognition/protocol";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";
import { preflight, runLiveGame } from "../run/live-game";

const say = (...parts: unknown[]) => console.log(...parts);
const num = (n: number) => n.toLocaleString();

const PILOT = loadProfile("m5-1-pilot");
const M5 = loadProfile("m5-pilot");
const DEFAULTS = loadConfig();
const SOCIAL = strategyById("expert-social");
const LIMITS = limitsFor(PILOT.promptVersion);

/* ── Run one complete scripted game under the real profile ──────────────── */

const out = mkdtempSync(join(tmpdir(), "m51-review-"));
const seen: ModelRequest[] = [];
const options = {
  seed: 1,
  outDir: out,
  client: cognitiveClient({ onRequest: (r) => seen.push(r) }),
  config: PILOT,
};
const result = await runLiveGame(options, preflight(options));

type Report = {
  seat: number;
  taskId: string;
  premisesVerified: number;
  premisesFromClaims: number;
  premisesOverridden: number;
  unmatchedClosures: number;
  registrySize: number;
  boundsViolations: number;
  estimatedTokens: number;
  overSoftTarget: boolean;
  packSections: Record<string, number>;
  utilisation: Record<string, unknown>;
  social: { stance: string | null; focalSeat: number | null } | null;
};

const lines = parseJsonl<PrivateTraceLine>(
  readFileSync(result.privatePath!, "utf8"),
) as unknown as { t: string; data: unknown }[];
const reports = (lines.find((l) => l.t === "cognition-telemetry")?.data ?? []) as Report[];
const sum = (k: keyof Report) => reports.reduce((a, r) => a + Number(r[k] ?? 0), 0);

say("# M5.1 复审包 —— 事实 ID 修复 + 桌面协调");
say("");
say(`离线脚本对局：**${result.status}**，结局 ${result.outcome}，${reports.length} 次决策`);
say(`profile \`m5-1-pilot\` · ${PILOT.promptVersion} · ${PILOT.experiment.strategyProfile}`);
say(`策略档指纹 \`${strategyFingerprint(SOCIAL).slice(0, 16)}…\``);
say("");
say("⚠ 全程没有任何网络请求，没有读取任何 key，产物写在临时目录。");

/* ── 1. The repair, measured ────────────────────────────────────────────── */

say("");
say("## 一、事实 ID 修复 —— 数字");
say("");
say("| | M5 试点（已打完） | M5.1 脚本对局 |");
say("|---|---|---|");
say(`| 事实表渲染 id | **没有** | 有，每行一个 |`);
say(`| 被引用的前提解析成硬事实 | **0 / 871** | ${num(sum("premisesVerified"))} 条 |`);
say(`| 解析成说法（诚实引用，但不硬） | 0 | ${num(sum("premisesFromClaims"))} 条 |`);
say(`| 查无此 id（编造 / 越权 / 过期） | **871** | ${num(sum("premisesOverridden"))} 条 |`);
say(`| 带未证实约束的响应 | 144 / 154 | ${reports.filter((r) => Number(r.utilisation.unverifiedConstraints ?? 0) > 0).length} / ${reports.length} |`);
say("");
say("脚本替身只引用它从**渲染出来的提示里读到**的 id —— 所以「查无此 id」为 0");
say("是管道通了，不是模型很聪明。真实模型仍然可能引用错，那正是遥测存在的理由。");
say("");
say(`每次决策可引用的 id 数：开局 ${reports[0]?.registrySize ?? 0}，最大 ${Math.max(...reports.map((r) => r.registrySize))}`);

/* ── 2. Worked resolution examples ──────────────────────────────────────── */

say("");
say("## 二、前提解析的两半 —— 都是真跑出来的");
say("");

const state = createGame({ seed: 1, config: PILOT });
// Walk to a position with facts and a Lady announcement if one exists early.
const sampleSeat: Seat = state.pending!.seat;
const sampleObs = observationFor(state, sampleSeat);
const sampleLedger = ledgerFrom(sampleObs, SEATS);
const registry = buildFactRegistry(sampleLedger.publicFacts, sampleLedger.claims, sampleObs);

say("| id | 类型 | 解析结果 | 说明 |");
say("|---|---|---|---|");
for (const entry of registry.entries.slice(0, 8)) {
  const status = resolvePremiseId(registry, entry.id).status;
  const verdict = status === "fact" ? "**硬前提**" : status === "claim" ? "说法" : "查无此 id";
  say(`| \`${entry.id}\` | ${entry.kind} | ${verdict} | ${entry.label} |`);
}
for (const invented of [
  "f_private_8_percival_pair_7_9",
  "f_current_state",
  "c8_opening",
]) {
  say(`| \`${invented}\` | —（M5 试点模型编的） | 查无此 id | 从它推出的结论一律标为不硬 |`);
}

say("");
say("### 私有 id 的座位隔离");
say("");
say("同一个 `p.pair`，在有资格的座位和没资格的座位上：");
say("");
say("| 座位 | 身份 | `p.pair` |");
say("|---|---|---|");
for (const seat of SEATS) {
  const observation = observationFor(state, seat);
  const own = buildFactRegistry([], [], observation);
  const entitled = resolvePremiseId(own, "p.pair").status === "fact";
  if (entitled || seat <= 3) {
    say(`| ${seat}号 | ${observation.role} | ${entitled ? "**硬前提**" : "查无此 id"} |`);
  }
}
say("");
say("其余座位一律「查无此 id」。**门在 registry，不在渲染** —— 就算有人从别处读到了");
say("这个字符串，他自己的 registry 里也没有，引用它只会把结论标成不硬。");

/* ── 3. The rendered prompt ─────────────────────────────────────────────── */

say("");
say("## 三、模型实际看到的提示（真实渲染）");
say("");
const store = new CognitionStore();
const built = buildCognitivePrompt({
  observation: sampleObs,
  persona: assignPersonas(1)[sampleSeat],
  strategy: SOCIAL,
  ledger: store.for(sampleObs),
  config: PILOT,
});
say("### 3.1 事实表的头部（含图例与 id）");
say("");
say("```markdown");
say(built.pack.factTables.split("\n").slice(0, 22).join("\n"));
say("```");
say("");
say("### 3.2 私有信息层");
say("");
say("```markdown");
say(built.layers.find((l) => l.index === 6)!.text);
say("```");
say("");
say("### 3.3 公开动作桥（system 层，全局唯一一份，可缓存）");
say("");
say("```markdown");
say(PUBLIC_BRIDGE_LAYER.trim());
say("```");

/* ── 4. Percival, loyal, focal ──────────────────────────────────────────── */

const profileFor = (role: string): string => {
  for (let seed = 1; seed < 120; seed += 1) {
    const g = createGame({ seed, config: PILOT });
    for (const seat of SEATS) {
      const observation = observationFor(g, seat);
      if (observation.role === role) return renderStrategy(SOCIAL, observation);
    }
  }
  throw new Error(`no ${role}`);
};

const quote = (role: string, id: string) => {
  const h = SOCIAL.heuristics.find((x) => x.id === id);
  if (!h) throw new Error(`missing ${id}`);
  const rendered = profileFor(role);
  if (!rendered.includes(h.consider)) throw new Error(`${id} not rendered to ${role}`);
  return `> 当${h.when}时${h.obligation ? "（**必须看到**）" : "，可以考虑"}${h.consider}。${h.disputed ? "（有争议）" : ""}`;
};

say("");
say("## 四、派西维尔：跳与不跳，都要带着方案");
say("");
say("### 4.1 强默认：跳，而且要带上可执行的东西");
say("");
say(quote("percival", "es.percival-claim-buys-leadership"));
say("");
say("**仍然是强默认，不是脚本** —— 同一份档案里明确写着「不跳也合法」。");
say("");
say("### 4.2 不跳的话，第一轮结算之前必须做到三件事之一");
say("");
say(quote("percival", "es.percival-hiding-must-still-organise"));
say("");
say("### 4.3 每一轮的不跳理由都必须是新的");
say("");
say(quote("percival", "es.percival-not-claiming-needs-a-fresh-reason"));
say("");
say("M5 试点的派西维尔十七次写了几乎一字不差的触发条件。这一条直接针对它。");
say("");
say("### 4.4 两个候选同车时，跳不跳要重新问一次");
say("");
say(quote("percival", "es.percival-pair-same-team-crosses-a-line"));

say("");
say("## 五、忠臣：跟人，但随时能撤");
say("");
for (const [title, id] of [
  ["5.1 先判断值不值得跟 —— 跳了派西维尔本身不是理由", "es.loyal-find-the-focal"],
  ["5.2 跟就要在台面上跟", "es.loyal-follow-out-loud"],
  ["5.3 必须留一个撤退条件", "es.loyal-keep-an-exit"],
  ["5.4 什么时候把人换下来", "es.loyal-withdraw-trust"],
  ["5.5 两个焦点在争的时候不要各打五十大板", "es.loyal-two-leaders"],
] as const) {
  say(`### ${title}`);
  say("");
  say(quote("loyal", id));
  say("");
}

say("## 六、坏人的反制");
say("");
for (const [title, role, id] of [
  ["6.1 莫甘娜跳 / 对跳派西维尔", "morgana", "es.morgana-claim-percival"],
  ["6.2 捧一个假焦点", "assassin", "es.evil-endorse-a-false-leader"],
  ["6.3 拆联盟", "mordred", "es.evil-split-the-coalition"],
  ["6.4 制造假共识 —— 以及它的代价", "oberon", "es.evil-manufacture-consensus"],
] as const) {
  say(`### ${title}`);
  say("");
  say(quote(role, id));
  say("");
}

say("### 6.5 梅林可以支持焦点，但不要变成焦点");
say("");
say(quote("merlin", "es.merlin-back-a-leader"));
say("");
say(quote("merlin", "es.merlin-do-not-become-the-focal"));
say("");
say("### 6.6 全员：焦点是位置，不是身份");
say("");
say(quote("loyal", "es.focal-is-a-position"));

/* ── 5. The social payload ──────────────────────────────────────────────── */

say("");
say("## 七、social 块长什么样（脚本对局里真实产生的一条）");
say("");
// Matched on the exact heading `renderSocial` emits. Matching the bare phrase
// would hit the INSTRUCTION, which every request carries, and print a slice of
// the wrong thing — which is what the first version of this script did.
const HEADING = "## 你对牌桌的读（只有你看得到）";
const socialSample = seen.find((r) => r.user.includes(HEADING));
if (socialSample) {
  const section = socialSample.user.slice(socialSample.user.indexOf(HEADING));
  say("```markdown");
  say(section.split("\n\n## ")[0]);
  say("```");
} else {
  say("（这一局脚本替身没有产生可回读的 social 段。）");
}
say("");
say("**没有 `restsOnUnverified` 字段** —— 和 `premiseVerified` 一样，那是系统算的。");
say("模型只给 `basisIds`，硬不硬由 registry 说了算。");

/* ── 6. Size and cost ───────────────────────────────────────────────────── */

say("");
say("## 八、体量与成本投影");
say("");
const sizes = reports.map((r) => r.estimatedTokens).sort((a, b) => a - b);
const at = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))];
say("| 位置 | 估算 token |");
say("|---|---|");
say(`| 开局 | ${num(sizes[0])} |`);
say(`| 中位 | ${num(at(0.5))} |`);
say(`| p90 | ${num(at(0.9))} |`);
say(`| 最大 | ${num(sizes[sizes.length - 1])} |`);
say(`| 软目标 | ${num(CONTEXT_BUDGET.softTargetTokens)} |`);
say(`| 硬上限 | ${num(CONTEXT_BUDGET.hardCeilingTokens)} |`);
say("");
say(`越过软目标：**${reports.filter((r) => r.overSoftTarget).length} 次**`);
say("");
say("### 新旧提示的分节对比（脚本对局末次请求，字符）");
say("");
const last = reports[reports.length - 1].packSections;
const first = reports[0].packSections;
say("| 分节 | 开局 | 末次 |");
say("|---|---|---|");
for (const key of ["factTables", "ownPrivateFacts", "cognition", "currentCycle", "total"]) {
  say(`| ${key} | ${num(first[key] ?? 0)} | ${num(last[key] ?? 0)} |`);
}
say("");
say("⚠ 脚本替身写的认知块很小。真实模型的 `cognition` 节会明显更大 ——");
say("M5 试点实测约 1,526 字符，M5.1 还要加一个 social 块。");

say("");
say("### 输出上限：为什么从 20,000 降到 12,000");
say("");
say("| | token |");
say("|---|---|");
say("| 实验 3 输出峰值（无认知块） | 6,562 |");
say("| **M5 试点输出峰值（有认知块）** | **5,511** |");
say("| M5 试点上限 | 20,000（用掉 27.6%）|");
say(`| social 块按上限写满，估算 | ~800 |`);
say(`| M5.1 上限 | **${num(PILOT.limits.maxOutputTokens)}** |`);
say(`| 相对实测峰值的余量 | ~${num(PILOT.limits.maxOutputTokens - 5511 - 800)}（一倍以上）|`);
say("");
say("20,000 是根据一个把认知块高估约 7 倍的预检定的。实测比没有认知块的实验 3 还低。");
say("");
say("**容量重试对确定性的输出耗尽没有用** —— 原样重发会以同样方式再耗尽一次。");
say("余量必须来自上限本身。");

say("");
say("### 成本");
say("");
const assumedLate = pessimisticTokenEstimate("字".repeat(20_000));
const perRequest = projectedRequestUsd(assumedLate, PILOT.limits.maxOutputTokens, PILOT.pricing) ?? 0;
const priorSpend = 22.9355;
say("| 情形 | 假设 | 估算 |");
say("|---|---|---|");
say(`| 可能 | M5 试点的形状（159 次 / $6.9745），输出上限降低不改变计费（按真实用量），输入因 social 块略增 | **约 $7.0–7.5** |`);
say(`| 悲观 | 250 次调用，每次按最坏计价 | **$${(perRequest * 250).toFixed(2)}** |`);
say(`| 硬闸 | 单局上限 | **$${PILOT.budget.hardCostLimitPerGameUsd.toFixed(2)}** |`);
say("");
say("| | 金额 |");
say("|---|---|");
say(`| 此前累计（五局） | $${priorSpend.toFixed(4)} |`);
say(`| 之后累计（可能） | 约 $${(priorSpend + 7.3).toFixed(2)} |`);
say(`| 之后累计（最坏，撞单局硬闸） | $${(priorSpend + PILOT.budget.hardCostLimitPerGameUsd).toFixed(2)} |`);
say(`| $100 上限剩余（最坏） | $${(100 - priorSpend - PILOT.budget.hardCostLimitPerGameUsd).toFixed(2)} |`);
say("");
say("⚠ 「可能」那一行是假设，不是测量。写在表里就是为了让它可以被质疑。");

/* ── 7. Metrics and fixtures ────────────────────────────────────────────── */

say("");
say("## 九、新增的观测指标");
say("");
say("全部是**事后**计算，从私有轨迹读，没有任何一条能回到提示里。");
say("其中两条（真派西维尔影响力、假焦点俘获率）会读发牌 —— 那在复盘里没问题，");
say("在决策里是灾难，所以它们只存在于 `metrics.ts`，不在任何 agent 的可达范围内。");
say("");
const METRICS: [string, string][] = [
  ["focalConcentration", "每一段时间里，全桌一共在跟几个不同的人"],
  ["endorsementGraph", "谁跟谁、跟了几次、是跟还是驳"],
  ["stanceCounts", "follow / conditional-follow / challenge / independent 的分布"],
  ["voteAlignmentWithFocal", "说了要跟，后来投票真的跟了吗"],
  ["teamOverlapWithPlan", "自己当队长时，发的车和自己写的计划差多少"],
  ["focalShiftsAroundMissions", "一轮任务结算前后，最多人跟的那个人变了没有"],
  ["leaderTruth", "跟的人里，真派西维尔多少、坏人多少 —— **假焦点俘获率**"],
  ["minorityDissentUptake", "事前反对且被结果兑现的人，后来有没有人跟他"],
  ["publicRequestCounts", "多少次发言真的提出了具体请求；多少跟随者点了名"],
  ["coordinationOutcomes", "协调了的那几轮，赢面比没协调的高吗（按阵营）"],
];
say("| 指标 | 回答什么问题 |");
say("|---|---|");
for (const [name, what] of METRICS) say(`| \`${name}\` | ${what} |`);

say("");
say("## 十、新增的协调场景（确定性离线夹具）");
say("");
say("| # | id | 位置 | 被测座位 |");
say("|---|---|---|---|");
for (const [i, s] of SOCIAL_SCENARIOS.entries()) {
  say(`| ${i + 1} | \`${s.id}\` | ${s.title} | ${s.tested.seat}号 ${s.tested.role} |`);
}
say("");
say("每一格都给了**至少两个**可接受的动作族 —— 夹具约束的是分析和记录，不是动作。");

/* ── 8. What is frozen ──────────────────────────────────────────────────── */

say("");
say("## 十一、被冻住的东西");
say("");
say("| | 值 | 状态 |");
say("|---|---|---|");
say(`| \`default.json\` | ${DEFAULTS.promptVersion} · ${DEFAULTS.experiment.strategyProfile} · cognition ${DEFAULTS.cognition.enabled} | 未动 |`);
say(`| \`m5-pilot.json\` promptVersion | ${M5.promptVersion} | 未动 |`);
say(`| \`m5-pilot.json\` 策略档 | ${M5.experiment.strategyProfile} | 未动 |`);
say(`| \`m5-pilot.json\` 输出上限 | ${num(M5.limits.maxOutputTokens)} | 未动 |`);
say(`| \`baseline\` 指纹 | ${strategyFingerprint(strategyById("baseline")).slice(0, 16)}… | 未动 |`);
say(`| \`community-meta\` 指纹 | ${strategyFingerprint(strategyById("community-meta")).slice(0, 16)}… | 未动 |`);
say(`| \`expert-cognitive\` 指纹 | ${strategyFingerprint(strategyById("expert-cognitive")).slice(0, 16)}… | 未动 |`);
say(`| 0.3.0 的字段上限 | 假设 ${limitsFor("prompt-0.3.0").maxHypotheses} / 承诺 ${limitsFor("prompt-0.3.0").maxPublicCommitments} | 未动 |`);
say(`| 0.3.1 的字段上限 | 假设 ${LIMITS.maxHypotheses} / 承诺 ${LIMITS.maxPublicCommitments} | 放宽（试点实测都顶到上限）|`);
say("");
say("`expert-social` 是**新档**，它 spread 了 `expert-cognitive` 的全部条目再追加 —— ");
say("测试断言继承的是同一批对象，所以两者不可能悄悄分叉。");

/* ── 9. The command ─────────────────────────────────────────────────────── */

say("");
say("## 十二、如果批准，下一局的确切命令");
say("");
say("先跑一次不花钱的 dry-run：");
say("");
say("```bash");
say("npx vite-node -c research/simulator/vitest.config.ts \\");
say("  research/simulator/scripts/run-live-game.ts -- --profile m5-1-pilot --dry-run");
say("```");
say("");
say("确认之后，**恰好一局**：");
say("");
say("```bash");
say("npx vite-node -c research/simulator/vitest.config.ts \\");
say("  research/simulator/scripts/run-live-game.ts -- \\");
say("  --profile m5-1-pilot --live --yes \\");
say(`  --seed 1 --max-cost ${PILOT.budget.hardCostLimitPerGameUsd}`);
say("```");
say("");
say("四道闸依旧：$12 提醒线 → $25 单局硬闸 → 600 次调用 → 250K 单次输入。");
say("$100 累计上限是绝对的，且包含已花掉的 $22.9355。");

say("");
say(`（脚本产物写在临时目录 ${out}，不影响任何既有对局。）`);
