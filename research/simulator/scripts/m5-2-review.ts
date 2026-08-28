/**
 * The M5.2 human-review package — 派权争夺.
 *
 * Plays one complete contested game offline under the REAL `m5-2-pilot`
 * profile, then prints what a human needs in order to decide whether the next
 * paid game should run: the protocol, the role-by-role trade-offs, the rendered
 * prompt for every one of the seven roles, worked claim / counterclaim /
 * retraction examples, the schema, the size and cost projection, and the
 * leakage checks.
 *
 * Everything below is RENDERED from the shipping code. No example here is
 * retyped prose — that is the lesson of the completed M5 pilot, whose review
 * package described a fact table with ids the builder did not print.
 *
 * No network. No client. No key is read. Artifacts go to a temp directory.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-2-review.ts
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
import { claimContestFrom, renderClaimContest } from "../cognition/claim-contest";
import { contestFragment } from "../cognition/contest";
import { buildFactRegistry, resolvePremiseId } from "../cognition/fact-ids";
import { ledgerFrom } from "../cognition/ledger";
import { CONTEXT_BUDGET, limitsFor } from "../cognition/limits";
import { CognitionStore } from "../cognition/store";
import { CONTEST_SCENARIOS } from "../cognition/scenarios-contest";
import { contestingClient } from "../cognition/scripted-cognitive-client";
import { CLAIM_CONTEST_LAYER } from "../cognition/protocol";
import { claimTimeline, contestReport } from "../cognition/metrics-contest";
import { parseJsonl, type PrivateTraceLine, type PublicReplayLine } from "../run/artifacts";
import { preflight, runLiveGame } from "../run/live-game";

const say = (...parts: unknown[]) => console.log(...parts);
const num = (n: number) => n.toLocaleString();

const PILOT = loadProfile("m5-2-pilot");
const M51 = loadProfile("m5-1-pilot");
const M5 = loadProfile("m5-pilot");
const DEFAULTS = loadConfig();
const ARM = strategyById("expert-claim-contest");
const LIMITS = limitsFor(PILOT.promptVersion);

const ROLES = [
  "percival",
  "merlin",
  "loyal",
  "morgana",
  "assassin",
  "mordred",
  "oberon",
] as const;

/* ── One complete contested game ────────────────────────────────────────── */

const out = mkdtempSync(join(tmpdir(), "m52-review-"));
const seen: ModelRequest[] = [];
const options = {
  seed: 1,
  outDir: out,
  client: contestingClient({
    claimSeats: [2, 5, 8],
    retractSeats: [5],
    attackSeats: [2],
    onRequest: (r) => seen.push(r),
  }),
  config: PILOT,
};
const result = await runLiveGame(options, preflight(options));

type Report = {
  seat: number;
  taskId: string;
  premisesVerified: number;
  premisesFromClaims: number;
  premisesOverridden: number;
  registrySize: number;
  boundsViolations: number;
  estimatedTokens: number;
  overSoftTarget: boolean;
  packSections: Record<string, number>;
  contest: Record<string, unknown> | null;
};

const privateText = readFileSync(result.privatePath!, "utf8");
const publicText = readFileSync(result.publicPath!, "utf8");
const lines = parseJsonl<PrivateTraceLine>(privateText) as unknown as {
  t: string;
  data: unknown;
}[];
const reports = (lines.find((l) => l.t === "cognition-telemetry")?.data ?? []) as Report[];
const publicEvents = (parseJsonl<PublicReplayLine>(publicText) as unknown as {
  t: string;
  data: unknown;
}[])
  .filter((l) => l.t === "event")
  .map((l) => l.data);
const CONTEST = claimContestFrom(publicEvents as never);
const sum = (k: keyof Report) => reports.reduce((a, r) => a + Number(r[k] ?? 0), 0);

say("# M5.2 复审包 —— 派权争夺（public Percival-claim competition）");
say("");
say(`离线脚本对局：**${result.status}**，结局 ${result.outcome}，${reports.length} 次决策`);
say(`profile \`m5-2-pilot\` · ${PILOT.promptVersion} · ${PILOT.experiment.strategyProfile}`);
say(`策略档指纹 \`${strategyFingerprint(ARM).slice(0, 16)}…\``);
say("");
say("⚠ 全程零网络请求，没有读取任何 key，产物写在临时目录。");
say("");
say("这一局里 2、5、8 号都跳了派西维尔，5 号中途退水，2 号打了留在场上的竞争者。");
say("**脚本替身打得很差**（论证全是占位），它检验的是机制：裁判规则、派权注册表、");
say("id 铸造、以及 `contestProblems` 里的每一条结构检查。");

/* ── 1. The protocol ────────────────────────────────────────────────────── */

say("");
say("## 一、派权争夺协议（system 层，全局唯一一份，可缓存）");
say("");
say("```markdown");
say(CLAIM_CONTEST_LAYER.trim());
say("```");

/* ── 2. Role by role ────────────────────────────────────────────────────── */

const quote = (role: string, id: string) => {
  const h = ARM.heuristics.find((x) => x.id === id);
  if (!h) throw new Error(`missing heuristic ${id}`);
  const rendered = renderStrategy(ARM, findSeat(role).observation);
  if (!rendered.includes(h.consider)) throw new Error(`${id} not rendered to ${role}`);
  return `> 当${h.when}时${h.obligation ? "（**必须看到**）" : "，可以考虑"}${h.consider}。${
    h.disputed ? "（有争议）" : ""
  }`;
};

function findSeat(role: string): { observation: ReturnType<typeof observationFor>; seat: Seat } {
  for (let seed = 1; seed < 160; seed += 1) {
    const state = createGame({ seed, config: PILOT });
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      if (observation.role === role) return { observation, seat };
    }
  }
  throw new Error(`no ${role}`);
}

say("");
say("## 二、七种身份跳派西维尔，各自的收益与代价");
say("");
say("**任何身份都可以声称任何身份。** 下面每一条都同时写了「换到的」和「付出的」——");
say("只有收益没有代价的条目就是一条指令，不是一个考量。");
say("");
const TRADEOFFS: [string, string, string][] = [
  ["2.1 真派西维尔", "percival", "ecc.percival-claim-tradeoff"],
  ["2.2 莫甘娜", "morgana", "ecc.morgana-claim-tradeoff"],
  ["2.3 梅林", "merlin", "ecc.merlin-claim-tradeoff"],
  ["2.4 忠臣", "loyal", "ecc.loyal-claim-tradeoff"],
  ["2.5 刺客", "assassin", "ecc.assassin-claim-tradeoff"],
  ["2.6 莫德雷德", "mordred", "ecc.mordred-claim-tradeoff"],
  ["2.7 奥伯伦", "oberon", "ecc.oberon-claim-tradeoff"],
];
for (const [title, role, id] of TRADEOFFS) {
  say(`### ${title}`);
  say("");
  say(quote(role, id));
  say("");
}

say("### 2.8 真派西维尔必须处理竞争者");
say("");
say(quote("percival", "ecc.percival-fight-the-rival"));
say("");
say(quote("percival", "ecc.percival-delay-needs-a-recovery-plan"));
say("");
say("### 2.9 打声称 ≠ 指认坏人（全员）");
say("");
say(quote("loyal", "ecc.attack-is-not-an-accusation"));
say("");
say("### 2.10 退水（全员）");
say("");
say(quote("loyal", "ecc.retraction-is-a-move"));
say("");
say("### 2.11 位置进入决策（全员）");
say("");
say(quote("loyal", "ecc.claim-timing-and-position"));
say("");
say("### 2.12 奥伯伦：跳这一下不会给他任何队友信息");
say("");
say(quote("oberon", "ecc.oberon-claim-does-not-buy-information"));

say("");
say("### 2.13 关于跳派，一共有几条「有争议」");
say("");
const DISPUTED_CLAIM_IDS = [
  "ecc.morgana-many-lines",
  "ecc.merlin-claim-tradeoff",
  "ecc.loyal-claim-tradeoff",
  "ecc.assassin-claim-tradeoff",
  "ecc.mordred-claim-tradeoff",
  "ecc.oberon-claim-tradeoff",
];
const disputedEntries = DISPUTED_CLAIM_IDS.map(
  (id) => ARM.heuristics.find((h) => h.id === id)!,
);
say(`一共 **${disputedEntries.length} 条**，全部 \`disputed: true\`：`);
say("");
say("| # | id | 也是「必须看到」吗 |");
say("|---|---|---|");
for (const [i, h] of disputedEntries.entries()) {
  say(`| ${i + 1} | \`${h.id}\` | ${h.obligation ? "是（约束的是**看到什么**，不是做什么）" : "否"} |`);
}
say("");
say("**六条全部可选**，每条都同时写了收益和代价，没有一条是必须执行的动作。");
say("数目由 `scenarios-contest.test.ts` 钉死 —— 之前有一版报告在散文里写了「五条」然后列了六条。");

/* ── 3. Rendered prompts for all seven roles ────────────────────────────── */

say("");
say("## 三、七种身份实际拿到的提示（真实渲染，只取差异部分）");
say("");
say("公共部分（共同规则、协议层、事实表、图例）七个人完全一样，所以只列每个身份");
say("**独有**的两块：私有信息层，和策略档里只有他看得到的条目。");
say("");
for (const role of ROLES) {
  const { observation, seat } = findSeat(role);
  const store = new CognitionStore();
  const ledger = store.for(observation);
  const built = observation.request
    ? buildCognitivePrompt({
        observation,
        persona: assignPersonas(1)[seat],
        strategy: ARM,
        ledger,
        config: PILOT,
      })
    : null;
  say(`### ${role}`);
  say("");
  say("```markdown");
  say(
    built
      ? built.layers.find((l) => l.index === 6)!.text
      : "（这个座位这一刻没有待办动作）",
  );
  say("```");
  const roleOnly = ARM.heuristics.filter(
    (h) => h.scope?.kind === "roles" && h.scope.roles.includes(observation.role),
  );
  if (roleOnly.length > 0) {
    say("");
    say(`只有 ${role} 看得到的条目：${roleOnly.map((h) => `\`${h.id}\``).join("、")}`);
  }
  say("");
}

/* ── 4. Worked examples from the scripted game ──────────────────────────── */

say("");
say("## 四、真实产生的声称、对跳、攻击与退水");
say("");
const timeline = claimTimeline(CONTEST);
say(
  `这一局：**${timeline.percivalClaims} 次派西维尔声称**，其中 ${timeline.counterclaims} 次是对跳，` +
    `**${timeline.retractions} 次退水**。`,
);
say("");
say("### 4.1 公开的派权表（模型看到的原文）");
say("");
say("```markdown");
say(renderClaimContest(CONTEST));
say("```");

say("");
say("### 4.2 退水之后，被退掉的东西仍然在");
say("");
// Only the withdrawn claimant's block. The whole table is above in 4.1; what
// this section is for is the one property that section cannot show on its own.
const retraction = CONTEST.events.find((e) => e.kind === "retract");
if (retraction && retraction.kind === "retract") {
  const table = renderClaimContest(CONTEST).split("\n");
  const start = table.findIndex((line) => line.startsWith(`- ${retraction.seat}号`));
  const end = table.findIndex((line, i) => i > start && line.startsWith("- "));
  say("```markdown");
  say(table.slice(start, end > start ? end : start + 4).join("\n"));
  say("```");
} else {
  say("（这一局没有产生退水）");
}
say("");
say("**退水改变状态，不删除任何东西** —— 原来声称过什么、什么时候、推过什么车、");
say("踩过谁，全部留在公开记录里，别人才有东西可以判断这次退水是什么。");

say("");
say("### 4.3 私有的派权认知块（脚本对局里真实产生的一条）");
say("");
const withContest = seen.filter((r) => r.user.includes("你在派权争夺里的位置")).pop();
if (withContest) {
  const start = withContest.user.indexOf("## 你在派权争夺里的位置");
  say("```markdown");
  say(withContest.user.slice(start).split("\n\n## ")[0]);
  say("```");
} else {
  say("（这一局没有可回读的 contest 段）");
}

/* ── 5. Fact vs claim ───────────────────────────────────────────────────── */

say("");
say("## 五、裁判记录的事实 vs 未经证实的声称内容");
say("");
const sampleSeat = SEATS[0];
const sampleObs = observationFor(
  createGame({ seed: 1, config: PILOT }),
  createGame({ seed: 1, config: PILOT }).pending!.seat,
);
void sampleSeat;
const sampleLedger = ledgerFrom(sampleObs, SEATS);
const registry = buildFactRegistry(
  sampleLedger.publicFacts,
  sampleLedger.claims,
  sampleObs,
  CONTEST,
);
say("| id | 类型 | 解析结果 | 它到底说明了什么 |");
say("|---|---|---|---|");
for (const entry of registry.entries.filter((e) => e.kind === "contest-event").slice(0, 4)) {
  const status = resolvePremiseId(registry, entry.id).status;
  say(
    `| \`${entry.id}\` | contest-event | ${status === "fact" ? "**硬前提**" : status} | ` +
      `${entry.label} —— 只说明这件事**发生过** |`,
  );
}
for (const entry of registry.entries.filter((e) => e.kind === "claim").slice(0, 2)) {
  say(`| \`${entry.id}\` | claim | 说法 | ${entry.label} —— **内容不是事实** |`);
}
for (const invented of ["k999:claim", "他自己说他是派西维尔"]) {
  say(`| \`${invented}\` | —（编的） | 查无此 id | 从它推出的结论一律标为不硬 |`);
}
say("");
say("`[k…]` 是**事实**：裁判确实记录了「8 号在 seq 4 说了这句话」。");
say("`[c…]` 是**说法**：他说的内容没有任何裁判记录支持。两者永远不会互相转化。");

/* ── 6. Schema ──────────────────────────────────────────────────────────── */

say("");
say("## 六、contest 块的严格 JSON Schema（原文）");
say("");
say("```json");
say(JSON.stringify(contestFragment(LIMITS), null, 2));
say("```");
say("");
say("**没有 `publicClaimStatus`** —— 那一栏由裁判填。");
say("**没有 `restsOnUnverified` / `evidenceResolves`** —— 由 registry 算。");
say("**没有 `reasoning` / `analysis` / `notes`** —— 没有地方藏思维链。");
say("`currentAssessment` 的取值 leading / plausible / contested / weak / broken");
say("全部是在评价**那个声称**，没有一个取值能表达「这个人是坏人」。");

/* ── 7. Structural checks ───────────────────────────────────────────────── */

say("");
say("## 七、结构一致性检查（拒绝的是形状，不是论证质量）");
say("");
const CHECKS: [string, string][] = [
  ["attack-rival-claim / endorse-claimant / challenge-claimant", "必须点名一个真的声称过的人"],
  ["defend-own-claim", "需要你自己现在有成立的声称"],
  ["retract-claim", "需要你自己声称过"],
  ["counterclaim-percival", "需要桌上已经有别人在声称派西维尔"],
  ["claimedOrImpliedPair", "必须正好是两个**不同**的座位"],
  ["requestedTeam", "人数要符合这一轮的车，不能有重复座位"],
  ["premiseIds / evidenceIds", "必须通过 M5.1 的可见性 registry"],
  ["动作与 contest 的原子性", "说要跳就得在动作的 claim 里跳；说要退水就得填 retractClaim"],
  ["attack / endorse 的可见性", "动作的 stances 里要有对目标的对应表态，否则牌桌看不到"],
  ["竞争者必须全部被评估", "站在派西维尔上的人少评一个就打回"],
  ["不跳的理由不能照抄", "hidden→hidden 且理由一字不差就打回"],
];
say("| 检查 | 拒绝什么 |");
say("|---|---|");
for (const [what, why] of CHECKS) say(`| ${what} | ${why} |`);
say("");
say("**没有任何一条检查读公开发言的文字。** 用关键词判断一段自然语言论证好不好，");
say("会把用词不同的好打法一起拒掉 —— 上面每一条比对的都是结构化字段。");

/* ── 8. Size and cost ───────────────────────────────────────────────────── */

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
say(`越界字段：**${sum("boundsViolations")} 次**`);
say("");
say("### 分节（字符）");
say("");
const first = reports[0].packSections;
const last = reports[reports.length - 1].packSections;
say("| 分节 | 开局 | 末次 |");
say("|---|---|---|");
for (const key of ["factTables", "ownPrivateFacts", "claimContest", "cognition", "total"]) {
  say(`| ${key} | ${num(first[key] ?? 0)} | ${num(last[key] ?? 0)} |`);
}
say("");
say("`claimContest` 是新增的一节，而它的大小由**桌子吵得多凶**决定，不由对局长度决定 ——");
say("一局没人跳的对局这一节只有一行。这也是它单独成节、而不是并进事实表的原因。");
say("");
say("⚠ 脚本替身写的认知块很小。真实模型的 `cognition` + `social` + `contest`");
say("会明显更大：M5 试点实测认知块约 1,526 字符，0.3.1 加 social，0.4.0 再加 contest。");

say("");
say("### 输出上限");
say("");
say("| | token |");
say("|---|---|");
say("| 实验 3 输出峰值（无认知块） | 6,562 |");
say("| **M5 试点输出峰值（有认知块）** | **5,511** |");
say(`| social 块按上限写满，估算 | ~800 |`);
say(`| contest 块按上限写满，估算 | ~1,200 |`);
say(`| 合计最坏 | **~7,500** |`);
say(`| M5.2 上限 | **${num(PILOT.limits.maxOutputTokens)}** |`);
say("");
say("和 M5.1 一样是 12,000，没有再调高：20,000 就是根据一个高估约 7 倍的预检定的，");
say("而多给上限不省钱，只会在真的耗尽时晚一点发现。容量重试对确定性耗尽没有用。");

say("");
say("### 成本");
say("");
const assumedLate = pessimisticTokenEstimate("字".repeat(20_000));
const perRequest =
  projectedRequestUsd(assumedLate, PILOT.limits.maxOutputTokens, PILOT.pricing) ?? 0;
const priorSpend = 22.9355;
say("| 情形 | 假设 | 估算 |");
say("|---|---|---|");
say(
  "| 可能 | M5 试点的形状（159 次 / $6.9745），输入因 contest 表与块略增，输出因 contest 块略增 | **约 $7.5–8.5** |",
);
say(`| 悲观 | 250 次调用，每次按最坏计价 | **$${(perRequest * 250).toFixed(2)}** |`);
say(`| 硬闸 | 单局上限 | **$${PILOT.budget.hardCostLimitPerGameUsd.toFixed(2)}** |`);
say("");
say("| | 金额 |");
say("|---|---|");
say(`| 此前累计（五局，全部是 0.2.0 / 0.3.0） | $${priorSpend.toFixed(4)} |`);
say(`| 之后累计（可能） | 约 $${(priorSpend + 8).toFixed(2)} |`);
say(`| 之后累计（最坏，撞单局硬闸） | $${(priorSpend + PILOT.budget.hardCostLimitPerGameUsd).toFixed(2)} |`);
say(`| $100 上限剩余（最坏） | $${(100 - priorSpend - PILOT.budget.hardCostLimitPerGameUsd).toFixed(2)} |`);
say("");
say("⚠ 「可能」那一行是假设，不是测量。M5.1 也还没有跑过真实对局，");
say("所以这两个版本的真实成本都还没有任何实测数据。");

/* ── 9. Metrics and scenarios ───────────────────────────────────────────── */

say("");
say("## 九、新增的观测指标（全部事后计算，不可从提示到达）");
say("");
const METRICS: [string, string][] = [
  ["claimTimeline", "一共几次声称、几次对跳、几次退水，分别在什么时候"],
  ["claimantRoles", "**哪些身份真的跳了派西维尔**（读发牌，仅复盘）"],
  ["activeClaimantsByTurn", "每个时刻同时有几个人站在这个身份上"],
  ["counterclaimLatency", "第一个声称之后，多久有人来对跳"],
  ["attackGraph", "谁打了谁，其中几次是声称者之间的"],
  ["defenceResponseRate", "被打之后，下一次决策有没有回应"],
  ["actionableRequestRate", "声称者的动作里有多少带着能执行的车或票"],
  ["coalitionsByClaimant", "每个声称者最后聚拢了谁"],
  ["voteAlignmentByClaimant", "说了支持，后来投票真的跟了吗"],
  ["teamOverlapWithClaimant", "队长发的车和他支持的声称者要的车差多少"],
  ["followerSwitches", "谁在什么时候从一个声称者换到另一个"],
  ["credibilityAcrossMissions", "一轮任务结算前后，全桌对每个声称者的众数评价"],
  ["retractionOutcomes", "退水发生在投票前还是挂车后，前后各有几个支持者"],
  ["falseLeaderCapture", "**跟错人的比例**：莫甘娜多少、其他坏人多少（仅复盘）"],
  ["loyalAlignmentSplit", "忠臣最后分别站在真派、莫甘娜、别人、还是谁都不站（仅复盘）"],
  ["truePercivalInfluence", "真派跳没跳、拉到几个人、**明确处理了几个竞争者**（仅复盘）"],
  ["contestChangedTheGame", "**这一切到底有没有改变过任何一辆车或一张票**"],
];
say("| 指标 | 回答什么问题 |");
say("|---|---|");
for (const [name, what] of METRICS) say(`| \`${name}\` | ${what} |`);
say("");
say("最后一条是整套指标存在的理由：一场制造了大量发言、却没有改变任何车和票的");
say("派权争夺是表演。`contestChangedTheGame` 是合取的 —— 车动了票没动，或者反过来，");
say("都会报 false，然后让人去看为什么。");
say("");
const sample = contestReport([], CONTEST, {
  votes: [],
  proposals: [],
  missions: [],
  speeches: [],
});
say(
  `脚本对局的公开侧指标：声称 ${sample.timeline.percivalClaims} 次、` +
    `对跳 ${sample.timeline.counterclaims} 次、退水 ${sample.timeline.retractions} 次、` +
    `攻击边 ${sample.attacks.length} 条。`,
);

say("");
say("## 十、新增的确定性离线场景");
say("");
say("| # | id | 位置 | 被测座位 |");
say("|---|---|---|---|");
for (const [i, s] of CONTEST_SCENARIOS.entries()) {
  say(`| ${i + 1} | \`${s.id}\` | ${s.title} | ${s.tested.seat}号 ${s.tested.role} |`);
}
say("");
say("每一格都给了**至少两个**可接受的动作族。3–9 号格子把全部七种身份都走了一遍跳派，");
say("因为设计说任何身份都可以跳 —— 一套只演真派和莫甘娜的夹具会悄悄编码相反的意思。");

/* ── 10. Leakage ────────────────────────────────────────────────────────── */

say("");
say("## 十一、公开 / 私有隔离检查");
say("");
const PRIVATE_FIELDS = [
  "ownClaimStrategy",
  "situationSpecificBenefit",
  "triggerToClaim",
  "candidatePairStory",
  "claimantAssessments",
  "currentAssessment",
  "rivalPlans",
  "attackCase",
  "riskOfOverattacking",
  "distinctionTest",
  "publicClaimMove",
  "informationToConceal",
  "restsOnUnverified",
];
const leaked = PRIVATE_FIELDS.filter((f) => publicText.includes(f));
say(`私有 contest 字段出现在公开回放里的：**${leaked.length} 个**${leaked.length ? `（${leaked.join("、")}）` : ""}`);
say("");
say("同时确认公开的那一半**确实写进去了**，否则「什么都没漏」只意味着「什么都没写」：");
say(`- 公开回放里有 \`percival\` 声称：${publicText.includes("percival") ? "有" : "**没有**"}`);
say(`- 公开回放里有 \`retractClaim\`：${publicText.includes("retractClaim") ? "有" : "**没有**"}`);
say("");
say("派权表本身对每个座位**逐字节相同** —— 它只从公开日志推导，没有任何参数能让发牌进来。");
say(
  `每次决策可引用的 id 数：开局 ${reports[0]?.registrySize ?? 0}，最大 ${Math.max(...reports.map((r) => r.registrySize))}；` +
    `解析成硬事实 ${num(sum("premisesVerified"))} 条，查无此 id ${num(sum("premisesOverridden"))} 条。`,
);

/* ── 11. What is frozen ─────────────────────────────────────────────────── */

say("");
say("## 十二、被冻住的东西");
say("");
say("| | 值 | 状态 |");
say("|---|---|---|");
say(
  `| \`default.json\` | ${DEFAULTS.promptVersion} · ${DEFAULTS.experiment.strategyProfile} · cognition ${DEFAULTS.cognition.enabled} | 未动 |`,
);
say(`| \`m5-pilot.json\` | ${M5.promptVersion} · ${M5.experiment.strategyProfile} · ${num(M5.limits.maxOutputTokens)} | 未动 |`);
say(
  `| \`m5-1-pilot.json\` | ${M51.promptVersion} · ${M51.experiment.strategyProfile} · ${num(M51.limits.maxOutputTokens)} | 未动 |`,
);
for (const id of ["baseline", "community-meta", "expert-cognitive", "expert-social"] as const) {
  say(`| \`${id}\` 指纹 | ${strategyFingerprint(strategyById(id)).slice(0, 16)}… | 未动 |`);
}
say(`| \`expert-claim-contest\` 指纹 | ${strategyFingerprint(ARM).slice(0, 16)}… | **新增** |`);
say(`| 0.3.0 字段上限 | 假设 ${limitsFor("prompt-0.3.0").maxHypotheses} / 承诺 ${limitsFor("prompt-0.3.0").maxPublicCommitments} | 未动 |`);
say(`| 0.3.1 字段上限 | 假设 ${limitsFor("prompt-0.3.1").maxHypotheses} / 承诺 ${limitsFor("prompt-0.3.1").maxPublicCommitments} | 未动 |`);
say(`| 0.4.0 字段上限 | 同 0.3.1，另加 contest 的一组新上限 | 新增 |`);
say("");
say("`retractClaim` 是**可选**字段，而且**只在为 true 时**才写进事件 —— 所以");
say("0.2.0 / 0.3.0 / 0.3.1 的每一次发言重放仍然逐字节一致。");
say("speech 的 schema 也按版本门控：只有 0.4.0 会看到这个字段。");

/* ── 12. The command ────────────────────────────────────────────────────── */

say("");
say("## 十三、如果批准，下一局的确切命令");
say("");
say("先跑一次不花钱的 dry-run：");
say("");
say("```bash");
say("npx vite-node -c research/simulator/vitest.config.ts \\");
say("  research/simulator/scripts/run-live-game.ts -- --profile m5-2-pilot --dry-run");
say("```");
say("");
say("确认之后，**恰好一局**：");
say("");
say("```bash");
say("npx vite-node -c research/simulator/vitest.config.ts \\");
say("  research/simulator/scripts/run-live-game.ts -- \\");
say("  --profile m5-2-pilot --live --yes \\");
say(`  --seed 1 --max-cost ${PILOT.budget.hardCostLimitPerGameUsd}`);
say("```");
say("");
say("四道闸依旧：$12 提醒线 → $25 单局硬闸 → 600 次调用 → 250K 单次输入。");
say("$100 累计上限是绝对的，且包含已花掉的 $22.9355。");

say("");
say(`（脚本产物写在临时目录 ${out}，不影响任何既有对局。）`);
