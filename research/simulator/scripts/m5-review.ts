/**
 * The M5B human-review package, generated rather than hand-written.
 *
 * Renders the actual prompts the pilot would send — same builder, same schema,
 * same strategy — for one seat of each role, plus a size and cost estimate
 * derived from the three completed games' own traces.
 *
 * Makes no network request and constructs no live client. Writes nothing
 * unless `--out <dir>` is given.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-review.ts -- [--out <dir>]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadProfile } from "../config/load";
import { observationFor } from "../core/observation";
import type { Observation } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { pessimisticTokenEstimate } from "../model/pricing";
import { assignPersonas } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { buildPlayerPrompt } from "../prompts/build";
import { PROMPT_VERSION_COGNITIVE, PROMPT_VERSION_LEGACY } from "../prompts/version";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { COGNITION_LIMITS, CONTEXT_BUDGET } from "../cognition/limits";
import { DECISION_PROTOCOL_LAYER } from "../cognition/protocol";
import { CognitionStore } from "../cognition/store";
import { COGNITION_FRAGMENT } from "../cognition/response";
import { COGNITION_INSTRUCTION } from "../cognition/build-cognitive";

const say = (...parts: unknown[]) => console.log(...parts);
const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const outDir = outIndex >= 0 ? argv[outIndex + 1] : null;

// The pilot's own profile, so this package describes the run that would
// actually happen rather than something assembled to look like it.
const COG = loadProfile("m5-pilot");
const LEGACY = loadConfig();

/** A real mid-game position, so the prompts are the ones a pilot would send. */
function positionWithRole(role: string): { observation: Observation; seat: Seat; seed: number } {
  for (let seed = 1; seed < 200; seed += 1) {
    const state = createGame({ seed, config: COG });
    const pending = state.pending!.seat;
    const observation = observationFor(state, pending);
    if (observation.role === role) return { observation, seat: pending, seed };
  }
  throw new Error(`no pending seat with role ${role} in 200 seeds`);
}

function renderFor(role: string): { text: string; seed: number; seat: Seat; tokens: number } {
  const { observation, seat, seed } = positionWithRole(role);
  const built = buildCognitivePrompt({
    observation,
    persona: assignPersonas(seed, "heterogeneous-rotated")[seat],
    strategy: strategyById("expert-cognitive"),
    ledger: new CognitionStore().for(observation),
    config: COG,
  });
  const text = `===== SYSTEM =====\n${built.system}\n\n===== USER =====\n${built.user}`;
  return { text, seed, seat, tokens: pessimisticTokenEstimate(text) };
}

/* ── 1. The new layers ──────────────────────────────────────────────────── */

say("# M5B 审阅包");
say("");
say("## 一、新增的提示层（中文原文）");
say("");
say("### 层 2：思考流程（系统层，全局唯一一份，可缓存）");
say("");
say("```");
say(DECISION_PROTOCOL_LAYER);
say("```");
say("");
say("### 输出格式里新增的说明（用户层尾部）");
say("");
say("```");
say(COGNITION_INSTRUCTION);
say("```");

/* ── 2. Rendered prompts ────────────────────────────────────────────────── */

say("");
say("## 二、五个身份的真实渲染提示");
say("");
const ROLES = ["percival", "merlin", "loyal", "assassin", "morgana"] as const;
const rendered = new Map<string, ReturnType<typeof renderFor>>();
for (const role of ROLES) {
  const r = renderFor(role);
  rendered.set(role, r);
  say(`- **${role}**：seed ${r.seed}，${r.seat}号，估算 ${r.tokens.toLocaleString()} token`);
}
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [role, r] of rendered) {
    writeFileSync(join(outDir, `prompt-${role}.txt`), r.text, "utf8");
  }
  say("");
  say(`完整原文已写入 ${outDir}/prompt-<role>.txt`);
}

/* ── 3. A sample payload ────────────────────────────────────────────────── */

say("");
say("## 三、一份合法的 CognitiveResponse");
say("");
say("```json");
say(
  JSON.stringify(
    {
      publicMessage: "我先说清楚我依据什么：第二轮挂了两张，这一条是裁判记录。",
      tentativeTeam: [1, 5, 7, 10],
      noTeamYet: false,
      stances: [{ seat: 6, valence: -0.4, confidence: 0.5 }],
      claim: null,
      memoryPatch: null,
      rationale: null,
      cognition: {
        factsUsed: ["f31", "f45"],
        claimsReliedOn: [],
        claimsQuestioned: ["c40:role"],
        alternativesConsidered: ["直接反对 6 号的切分", "先要求他解释前提再表态"],
        selectedActionSummary: "先把前提问题摆出来，不急着站队",
        intendedPublicSignal: "让全桌知道这套切分依赖两条没法验证的说法",
        updatedRolePlan: null,
        constraints: [
          {
            id: "k1",
            statement: "第二轮 2、3、5、6 里至少有两个坏人",
            premiseIds: ["f45"],
            premiseLabels: ["第二轮两张失败票"],
          },
          {
            id: "k2",
            statement: "如果 6 号说的是真的，2、3、5 里恰有两坏",
            premiseIds: ["f45", "c40:role"],
            premiseLabels: ["第二轮两张失败票", "6号自称忠臣"],
          },
        ],
        hypotheses: [
          {
            id: "h1",
            label: "6 号说的是真的",
            evilSeats: [2, 3],
            rationale: "他在车上且只能出成，那两坏就在 2、3、5",
            standing: "unresolved",
          },
          {
            id: "h2",
            label: "6 号在把自己切出去",
            evilSeats: [6, 3],
            rationale: "自称忠臣是最便宜的一句话",
            standing: "unresolved",
          },
        ],
        seatReads: [
          {
            seat: 6,
            standing: "unresolved",
            evidenceFor: ["二车约束算得对"],
            evidenceAgainst: ["前提是自己给的"],
            lastChangeReason: "他把自称当成了硬信息",
          },
        ],
        coverStory: "",
        claimPlan: "暂不跳；如果 7 和 9 同车再考虑",
        nextTurnPlan: "看第三轮的车里有没有 2、3、5",
        newCommitments: ["终单含 7、9 同车我必反"],
      },
    },
    null,
    2,
  ),
);
say("```");
say("");
say("注意 `k2`：前提里有一条 `c40:role`（说法）。");
say("系统会自己把它判成未证实，**模型没有声明这一点的字段**。");

/* ── 4. Before / after ──────────────────────────────────────────────────── */

say("");
say("## 四、和 prompt-0.2.0 的对比");
say("");
const cmp: string[] = [];
for (const role of ROLES) {
  const { observation, seat, seed } = positionWithRole(role);
  const legacy = buildPlayerPrompt({
    observation,
    persona: assignPersonas(seed, "heterogeneous-rotated")[seat],
    strategy: strategyById("community-meta"),
    speechCharLimit: LEGACY.limits.speechCharLimit,
  });
  const legacyTokens = pessimisticTokenEstimate(`${legacy.system}\n${legacy.user}`);
  const cog = rendered.get(role)!;
  cmp.push(
    `| ${role} | ${legacyTokens.toLocaleString()} | ${cog.tokens.toLocaleString()} | ` +
      `${(((cog.tokens - legacyTokens) / legacyTokens) * 100).toFixed(0)}% |`,
  );
}
say("| 身份 | 0.2.0 估算 token | 0.3.0 估算 token | 变化 |");
say("|---|---|---|---|");
for (const line of cmp) say(line);
say("");
say("（第一轮开局位置，历史最短 —— 这是差距最大的时候：认知层的固定开销全在，");
say("而事实表还没有内容可以替代散文。到中后期表格会开始省，见下一节。）");

/* ── 5. Cost estimate from real traces ──────────────────────────────────── */

say("");
say("## 五、用三局真实轨迹估算的规模与成本");
say("");
say("实测基准（实验 3，133 次调用，community-meta，prompt-0.2.0）：");
say("- 输入 1,323,919 token（缓存 175,680 = 13.3%），输出 157,939，成本 $4.2269");
say("- 单次最大输入 18,099 字符 / 实报 14,706 token");
say("");
const protocolTokens = pessimisticTokenEstimate(DECISION_PROTOCOL_LAYER);
const instructionTokens = pessimisticTokenEstimate(COGNITION_INSTRUCTION);
say(`认知层的固定开销：协议层约 ${protocolTokens} token（**在系统层，可缓存**），`);
say(`输出格式说明约 ${instructionTokens} token。`);
say("");
say("每次请求还会多出这一座位的账本。按当前上限，一份写满的账本大致是：");
const worstLedger =
  COGNITION_LIMITS.maxDerivedConstraints * COGNITION_LIMITS.constraintStatementChars +
  COGNITION_LIMITS.maxHypotheses * COGNITION_LIMITS.hypothesisRationaleChars +
  10 * (COGNITION_LIMITS.evidenceForPerSeat + COGNITION_LIMITS.evidenceAgainstPerSeat) *
    COGNITION_LIMITS.evidenceChars +
  COGNITION_LIMITS.rolePlanChars;
say(`- 最坏 ${worstLedger.toLocaleString()} 字符 ≈ ${pessimisticTokenEstimate("字".repeat(worstLedger)).toLocaleString()} token`);
say("- 实际会小得多：上限是护栏，不是预期值");
say("");
say("**输出侧**：认知块是新增的输出。按上限估算最坏约");
const worstOutput =
  COGNITION_LIMITS.maxDerivedConstraints * COGNITION_LIMITS.constraintStatementChars +
  COGNITION_LIMITS.maxHypotheses * COGNITION_LIMITS.hypothesisRationaleChars +
  COGNITION_LIMITS.maxAlternativesConsidered * COGNITION_LIMITS.alternativeChars +
  COGNITION_LIMITS.rolePlanChars;
say(`${pessimisticTokenEstimate("字".repeat(worstOutput)).toLocaleString()} token/次，`);
say(`当前输出上限 ${COG.limits.maxOutputTokens.toLocaleString()}，实验 3 峰值 6,562 —— 余量够，但会变紧。`);
say("");
say("**软目标**：" + CONTEXT_BUDGET.softTargetTokens.toLocaleString() + " token（保守估算）。");
say("**硬上限**：" + CONTEXT_BUDGET.hardCeilingTokens.toLocaleString() + " token（沿用既有契约）。");
say("");
say("⚠ 以上全部是**估算**，来自一局的形状加上未经校准的上限。");
say("真实数字要等第一局 pilot 的 `cognition-telemetry` 才有。");

/* ── 6. Risks ───────────────────────────────────────────────────────────── */

say("");
say("## 六、剩余的设计风险");
say("");
const risks = [
  ["字段上限没校准", "现在的数字是拍的。超限会被记录成 boundsViolations 而不是静默截断，但如果模型普遍写得比上限长，账本会持续标红", "跑一局看 telemetry"],
  ["输出侧变紧", "认知块是新增输出。实验 3 峰值 6,562 / 12,000；加上认知块之后余量未知", "pilot 会给出真实峰值；撞顶有容量重试兜底"],
  ["cognition_invalid 是新的终止路径", "动作合法但认知损坏会终止一局。离线测过四种损坏，真实模型的损坏方式未见过", "maxCognitionRepairs 默认 2；可调"],
  ["压缩路径未在长局中被真实触发", "离线最长的局也没超过软目标。COMPACT_ABOVE_EVENTS=60 的触发在真实长局里什么表现，未知", "pilot 会记录 compactionTrigger"],
  ["expert-cognitive 与 community-meta 不可比", "换了策略档、换了提示栈、加了认知层 —— 三个变量同时变", "pilot 只做可行性验证，不做效果对比"],
  ["persona 旋钮未启用", "按决定保持原样，所以 heterogeneous-rotated 的定义和指纹不变", "M5C 再议"],
];
say("| 风险 | 说明 | 现在的对策 |");
say("|---|---|---|");
for (const [a, b, c] of risks) say(`| ${a} | ${b} | ${c} |`);

/* ── 7. The proposed command ────────────────────────────────────────────── */

say("");
say("## 七、建议的单局 pilot 命令（**不要现在执行**）");
say("");
say("```bash");
say("npx vite-node -c research/simulator/vitest.config.ts \\");
say("  research/simulator/scripts/run-live-game.ts -- \\");
say("  --live --yes --seed 1 \\");
say("  --strategy expert-cognitive \\");
say("  --persona-mode heterogeneous-rotated \\");
say("  --games 1 --concurrency 1");
say("```");
say("");
say("前提：`config/default.json` 里把 `cognition.enabled` 改成 `true`、");
say("`promptVersion` 改成 `prompt-0.3.0`。两者必须同时改 —— 只改一个会被配置校验拒绝。");
say("");
say("护栏不变：单局 $25 硬上限、$12 提醒线、单次输入 250,000 token、输出 12,000 token。");


/* ── 8. The specific decision cases the review gate asks for ────────────── */

say("");
say("## 八、被点名的几个决策位置");
say("");
say("每一条都渲染自真实的 `expert-cognitive`，不是复述。");
say("标了「必须看到」的约束的是**分析**，不是**动作** —— 怎么处理仍然自由。");
say("");

const expert = strategyById("expert-cognitive");
const byId = new Map(expert.heuristics.map((h) => [h.id, h]));
const show = (title: string, id: string, note: string) => {
  const h = byId.get(id);
  if (!h) throw new Error(`missing heuristic ${id}`);
  say(`### ${title}`);
  say("");
  say(`> 当${h.when}时${h.obligation ? "（**必须看到**）" : "，可以考虑"}${h.consider}。`);
  say("");
  say(note);
  say("");
};

show(
  "8.1 靠前发言位的派西维尔（强默认跳）",
  "ec.percival-early-claim-default",
  "**强默认，不是脚本。** 同一份档案里另有一条明确说不跳也合法 —— 见 8.2。",
);
show(
  "8.2 不跳时必须给出的替代计划",
  "ec.percival-not-claiming-needs-a-plan",
  "三样东西都点名了：怎么组织、怎么继续用候选对、什么条件会触发跳。\n" +
    "落点是 schema 里的 `claimPlan` / `updatedRolePlan` / `nextTurnPlan`。",
);
show(
  "8.3 靠后发言位的派西维尔",
  "ec.percival-pair-standing",
  "靠后的位置没有单独一条 —— 候选对的持续维护对所有位置都成立，\n" +
    "位置带来的差别由 `ec.speaking-position` 覆盖（全员可见）。",
);
show(
  "8.4 两个候选同车",
  "ec.percival-pair-same-team",
  "唯一一条**硬推论**：这不是猜测，是牌理。三种处置全部是专家线。",
);
show(
  "8.5 梅林：看得见的坏人 vs 莫德雷德盲区",
  "ec.merlin-two-sets",
  "私有信息层还会再说一遍具体的：「莫德雷德你看不见」。",
);
show(
  "8.6 梅林拿着女神",
  "ec.merlin-lady-searches",
  "验已知的人是允许的 —— 但必须说出换到了什么。",
);
show(
  "8.7 刺客维护有排序的梅林候选",
  "ec.assassin-ranked-list",
  "每次排序变化都要指出依据，否则到最后一刀时用不上。",
);
show(
  "8.8 多个坏人同车的任务牌",
  "ec.evil-double-fail-leaks",
  "**没有强制单踩约定** —— 明确写了「这不是说只能踩一张」。\n" +
    "另有 `ec.evil-compare-fail-and-success` 要求每次都把两边摆出来比。",
);

/* ── 9. Sample payloads per task family ─────────────────────────────────── */

say("");
say("## 九、各任务族的合法 CognitiveResponse（动作部分）");
say("");
say("认知块的形状每一族都一样（见第三节），下面只列动作字段的差异。");
say("");
const families: [string, Record<string, unknown>][] = [
  ["speech（发言）", { publicMessage: "…", tentativeTeam: [1, 5, 7, 10], noTeamYet: false, stances: [], claim: null }],
  ["leader-close-and-propose（收车定队伍）", { publicMessage: "…", team: [1, 5, 7, 10], stances: [], claim: null }],
  ["vote（投票）", { choice: "reject" }],
  ["mission（任务牌）", { card: "success" }],
  ["lady-select（女神选人）", { target: 6, publicMessage: "…" }],
  ["lady-announce（女神公布）", { announced: "good", publicMessage: "…" }],
  ["assassination（刺杀）", { target: 9, publicMessage: "…" }],
];
for (const [name, action] of families) {
  say(`- **${name}**：\`${JSON.stringify(action)}\` + \`cognition\`（必填）`);
}

/* ── 10. The exact strict schema ────────────────────────────────────────── */

say("");
say("## 十、cognition 块的严格 JSON Schema（原文）");
say("");
say("```json");
say(JSON.stringify(COGNITION_FRAGMENT, null, 2));
say("```");
say("");
say("**没有 `premiseVerified` 字段。** 模型只给 `premiseIds`，硬不硬由系统查裁判事实表决定。");
say("也没有 `reasoning` / `analysis` / `notes` —— 没有地方藏思维链。");

/* ── 11. Section-by-section layer comparison ────────────────────────────── */

say("");
say("## 十一、层结构逐节对比");
say("");
say("| # | prompt-0.2.0 | # | prompt-0.3.0 | 变化 |");
say("|---|---|---|---|---|");
const rows = [
  ["1", "共同规则（system）", "1", "共同规则（system）", "不变"],
  ["—", "—", "2", "**思考流程（system）**", "**新增**，全局唯一一份，可缓存"],
  ["2", "说话风格（system）", "3", "说话风格（system）", "不变（旋钮未启用）"],
  ["3", "身份与合法信息（system）", "4", "身份与合法信息（system）", "不变"],
  ["4", "你实际看到的东西（user）", "6", "只有你知道的硬信息（user）", "改写；按 side 门控"],
  ["5", "位置与公开局面（user，**全历史散文**）", "5", "**硬事实表 + 挂车约束**（user）", "**替换**：表格、无损、可机检"],
  ["—", "—", "7", "**你自己的推理记录**（user）", "**新增**，有界，未证实前提贴标"],
  ["6", "策略档（user）", "8", "策略档（user）", "换成 expert-cognitive"],
  ["—", "—", "9", "最近发言 + 压缩过的更早讨论", "**新增**：只压缩论证"],
  ["7", "本次任务与输出格式（user）", "10", "输出格式 + cognition 说明", "扩展"],
];
for (const r of rows) say(`| ${r.join(" | ")} |`);

/* ── 12. Private-only fields ────────────────────────────────────────────── */

say("");
say("## 十二、只进私有轨迹、绝不进公开回放的字段");
say("");
const privateOnly = [
  ["cognition.*", "整个认知块 —— 约束、假设、座位判断、掩护、计划、承诺"],
  ["cognition-telemetry", "每次请求的字段用量、pack 分节大小、越界计数"],
  ["strategyFingerprint", "整份策略档的 sha256（公开产物只记 strategyId）"],
  ["cognitionLimits", "本局生效的字段上限表"],
  ["manifest.seed", "种子"],
  ["manifest.deal", "发牌"],
  ["model-call.raw", "模型原始输出"],
  ["private-event: lady_result", "女神真实结果（公开只有宣称）"],
  ["private-event: evil_discussion", "坏人密谈"],
  ["lady-results", "按持有者汇总的女神真值"],
  ["action.memoryPatch", "旧的私有笔记"],
  ["customStrategyText", "自定义策略原文"],
];
say("| 字段 | 说明 |");
say("|---|---|");
for (const [f, d] of privateOnly) say(`| \`${f}\` | ${d} |`);
say("");
say("`cognition/pilot.test.ts` 逐个扫描公开回放，断言这些字段名一个都不出现。");

void SEATS;
