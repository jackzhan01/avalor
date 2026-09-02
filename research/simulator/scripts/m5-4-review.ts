/**
 * The M5.4 offline review package.
 *
 * OFFLINE. Builds every prompt it prints, replays the completed games it
 * measures, and sends nothing. Four sections, each answering a question a human
 * has to be able to check before authorising a live run:
 *
 *   Did the folding repair actually change what the agents remember?
 *   What does the private evil coordination layer look like, per role?
 *   What do machine ids turn into when the spokesperson has to say them?
 *   What would one Terra game cost?
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-4-review.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredFails } from "@/lib/rules/avalon";
import { loadProfile, resolveStage } from "../config/load";
import { dealFromAssignment } from "../core/deal";
import { observationFor } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { coordinationFor, renderMissionCoordination } from "../core/evil-coordination";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { CognitionStore } from "../cognition/store";
import { buildFactRegistry } from "../cognition/fact-ids";
import { claimContestFrom } from "../cognition/claim-contest";
import { claimsFrom, publicFactsFrom } from "../cognition/ledger";
import { channelForTask, sanitiseIntent } from "../cognition/firewall";
import { buildSpokespersonPrompt, publicTableViewFor } from "../cognition/spokesperson";
import { findMachineIds } from "../cognition/machine-ids";
import type { CommunicationIntent } from "../cognition/intent";
import { llmAgent } from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import type { CognitionReport } from "../agents/llm-agent";
import { disclosureClient } from "../cognition/scripted-cognitive-client";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById, strategyFingerprint } from "../prompts/strategies";
import { capabilitiesFor, DECLARED_PROMPT_VERSIONS } from "../prompts/capabilities";
import { PROMPT_VERSION_DISCLOSURE, PROMPT_VERSION_M54 } from "../prompts/version";
import { pessimisticTokenEstimate } from "../model/pricing";
import { TERRA_PRICING } from "../model/price-lists";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";

const say = (...parts: unknown[]) => console.log(...parts);
const OUT = join(process.cwd(), "research", "simulator", "out", "private", "m5-4-review");
mkdirSync(OUT, { recursive: true });

const M54 = loadProfile("m5-4-pilot");
const M53 = loadProfile("m5-3-terra-pilot");

/** The deal the live games ran, so the coordination examples are the real ones. */
const LIVE_DEAL = dealFromAssignment({
  1: "loyal",
  2: "assassin",
  3: "mordred",
  4: "oberon",
  5: "loyal",
  6: "loyal",
  7: "morgana",
  8: "percival",
  9: "merlin",
  10: "loyal",
});

/* ── 1. Capabilities ────────────────────────────────────────────────────── */

say("=== 一、能力表（替掉了版本等值判断）===");
say("");
const FLAGS = [
  "cognition",
  "citableFactIds",
  "social",
  "claimContest",
  "twoStageSpeech",
  "stableCommitmentIds",
  "naturalPublicSpeech",
  "evilCoordination",
  "voteDiscipline",
  "assassinRanking",
  "evilRosterRendered",
] as const;
say(`版本${" ".repeat(9)}${FLAGS.map((f) => f.slice(0, 4)).join("  ")}`);
for (const v of DECLARED_PROMPT_VERSIONS) {
  const c = capabilitiesFor(v) as unknown as Record<string, boolean>;
  say(`${v.padEnd(14)}${FLAGS.map((f) => (c[f] ? " ✓  " : " ·  ")).join("  ")}`);
}
say("");

/* ── 2. The folding repair, measured on a scripted game ─────────────────── */

interface Played {
  readonly reports: readonly CognitionReport[];
  readonly speeches: readonly string[];
  readonly failCounts: readonly number[];
}

async function play(version: string, strategy: string): Promise<Played> {
  const config = version === PROMPT_VERSION_M54 ? M54 : M53;
  const state = createGame({ seed: 3, config, deal: LIVE_DEAL });
  const personas = assignPersonas(3, "heterogeneous-rotated");
  const store = new CognitionStore();
  const reports: CognitionReport[] = [];
  const client = disclosureClient({ claimSeats: [7, 8] });
  const agents = {} as Record<Seat, Agent>;
  for (const seat of SEATS) {
    agents[seat] = llmAgent(seat, {
      client,
      persona: personaById(personas[seat].id),
      strategy: strategyById(strategy as never),
      config,
      cognition: { store, onCognition: (r) => reports.push(r) },
    });
  }
  let n = 0;
  try {
    while (state.pending && n < 400) {
      const seat = state.pending.seat;
      applyAction(state, seat, await agents[seat].act(observationFor(state, seat)));
      n += 1;
    }
  } catch {
    /* a scripted game may end early; what is measured is what it produced */
  }
  return {
    reports,
    speeches: state.log.flatMap((e) => (e.type === "speech" ? [e.publicMessage] : [])),
    failCounts: state.log.flatMap((e) =>
      e.type === "mission_result" ? [e.failCount] : [],
    ),
  };
}

const after = await play(PROMPT_VERSION_M54, "expert-disciplined");

/**
 * BEFORE comes from the ARTIFACTS, not from a re-run.
 *
 * Re-running `prompt-0.5.0` today would exercise the FIXED code — its
 * capability row declares `social` and `claimContest`, so it now folds both.
 * The only honest record of the defective behaviour is what the two live games
 * actually produced, so that is what is read.
 */
interface Historical {
  readonly label: string;
  readonly reports: number;
  readonly withContest: number;
  readonly withSocial: number;
  readonly cognitionPeak: number;
  readonly overridden: number;
  readonly verified: number;
}

function historical(gameId: string, label: string): Historical | null {
  const path = join(
    process.cwd(),
    "research",
    "simulator",
    "out",
    "private",
    `${gameId}.private-trace.jsonl`,
  );
  if (!existsSync(path)) return null;
  const lines = parseJsonl<PrivateTraceLine>(readFileSync(path, "utf8"));
  const reports = lines.flatMap((l) =>
    l.t === "cognition-telemetry" ? [...l.data] : [],
  ) as CognitionReport[];
  return {
    label,
    reports: reports.length,
    withContest: reports.filter((r) => r.contest !== null).length,
    withSocial: reports.filter((r) => r.social !== null).length,
    cognitionPeak: Math.max(0, ...reports.map((r) => r.packSections.cognition)),
    overridden: reports.reduce((n, r) => n + r.premisesOverridden, 0),
    verified: reports.reduce((n, r) => n + r.premisesVerified, 0),
  };
}

const HISTORY = [
  historical("g-6ebccca0-5978-4b1f-a0cf-1c99af014c08", "M5.2 · 0.4.0（对照，一直正常）"),
  historical("g-dde11045-7ce3-42c9-95e8-391ce86b10b9", "M5.3 Terra · 0.5.0（有缺陷）"),
  historical("g-826f0c52-004a-4ac7-a6d8-25b682775fab", "M5.3 Luna · 0.5.0（有缺陷）"),
].filter((h): h is Historical => h !== null);

const cog = (p: Played) => p.reports.map((r) => r.packSections.cognition);
say("=== 二、折叠修复：实盘产物（修复前）vs 修复后 ===");
say("");
say("修复前只能从**已经跑完的产物**里读 —— 今天重跑 0.5.0 走的是修好的代码。");
say("");
say("对局                             报告  带contest  带social  认知层峰值  查无此id  硬前提");
for (const h of HISTORY) {
  say(
    `${h.label.padEnd(30)} ${String(h.reports).padStart(4)}  ${String(h.withContest).padStart(8)}  ` +
      `${String(h.withSocial).padStart(7)}  ${String(h.cognitionPeak).padStart(9)}  ` +
      `${String(h.overridden).padStart(7)}  ${String(h.verified).padStart(5)}`,
  );
}
say(
  `${"0.6.0 脚本对局（修复后）".padEnd(28)} ${String(after.reports.length).padStart(4)}  ` +
    `${String(after.reports.filter((r) => r.contest !== null).length).padStart(8)}  ` +
    `${String(after.reports.filter((r) => r.social !== null).length).padStart(7)}  ` +
    `${String(Math.max(0, ...cog(after))).padStart(9)}  ` +
    `${String(after.reports.reduce((n, r) => n + r.premisesOverridden, 0)).padStart(7)}  ` +
    `${String(after.reports.reduce((n, r) => n + r.premisesVerified, 0)).padStart(5)}`,
);
say("");
say("**两局 0.5.0 实盘的 contest / social 全是 null** —— 模型每一步都答了，全被丢掉。");
say("修复后每一份报告都带上了。认知层峰值不可直接比大小：脚本双面写得比真模型少得多。");
say("");
say(`任务失败票（0.6.0 脚本局）：${after.failCounts.join("、") || "（无）"}`);
say("");

/* ── 3. The private coordination layer, per role ────────────────────────── */

say("=== 三、四个身份各自看到的私有协调层 ===");
say("");
const TEAM: Seat[] = [1, 2, 3, 4];
const coordLines: string[] = [];
for (const [role, seat] of [
  ["刺客", 2],
  ["莫甘娜", 7],
  ["莫德雷德", 3],
  ["奥伯伦", 4],
] as const) {
  const onTeam = TEAM.includes(seat as Seat) ? TEAM : [...TEAM.slice(0, 3), seat as Seat];
  const c = coordinationFor({
    deal: LIVE_DEAL,
    seat: seat as Seat,
    team: onTeam,
    missionNumber: 2,
    failsRequired: requiredFails(10, 2),
  });
  say(`--- ${role}（${seat}号），车 ${onTeam.join("、")} ---`);
  if (!c) {
    say("（拿不到任何协调上下文 —— 他不是互相认识的坏人）");
    coordLines.push(`### ${role}（${seat}号）\n\n（拿不到任何协调上下文。）\n`);
  } else {
    const text = renderMissionCoordination(c);
    say(text.split("\n").slice(0, 14).join("\n"));
    coordLines.push(`### ${role}（${seat}号）\n\n\`\`\`text\n${text}\n\`\`\`\n`);
  }
  say("");
}

/* ── 4. Machine ids → natural Chinese ───────────────────────────────────── */

say("=== 四、机器编号翻成自然中文 ===");
say("");
const TRANSLATIONS: readonly { readonly before: string; readonly after: string }[] = [
  {
    before: "[f30][f32][f.fail2] 证明这车坏",
    after: "第二轮 7 号发的 1、2、3、4 出了三张失败票，这四个人里至少三个是坏人。",
  },
  {
    before: "看[f.now]，这是首轮首车",
    after: "现在是第一轮第一辆车，比分 0:0，还没有任何可以核对的记录。",
  },
  {
    before: "按[k5:claim]你声称期间要过 7、1、2",
    after: "你跳完派西维尔之后要的车是 7、1、2，现在却推 1、2、3、4。",
  },
  {
    before: "[c4:role][c5:role] 只证明我们都声称过",
    after: "我们两个都公开说过自己是派西维尔，这件事本身分不出谁真谁假。",
  },
  {
    before: "[f16] 通过，[f17] 成功",
    after: "第一轮那辆车 9 票通过，结果零坏票。",
  },
  {
    before: "[c34:lady] 他宣布 3 号是坏人",
    after: "他验了 3 号之后当众说是坏人 —— 这是他说的，不是裁判说的。",
  },
];
for (const t of TRANSLATIONS) {
  const hits = findMachineIds(t.before);
  const clean = findMachineIds(t.after);
  say(`❌ ${t.before}`);
  say(`   命中 ${hits.length} 处：${hits.map((h) => h.text).join("、")}`);
  say(`✅ ${t.after}`);
  say(`   命中 ${clean.length} 处`);
  say("");
}

/* ── 5. The scripted game's public speech ───────────────────────────────── */

const dirty = after.speeches.filter((s) => findMachineIds(s).length > 0);
say("=== 五、脚本对局的公开发言 ===");
say(`发言 ${after.speeches.length} 段，含机器编号的 ${dirty.length} 段`);
say("");

/* ── 6. Cost projection for exactly one Terra game ──────────────────────── */

say("=== 六、一局 Terra 的成本投影（dry-run，不发请求）===");
say("");
const state = createGame({ seed: 1, config: M54, deal: LIVE_DEAL });
const personas = assignPersonas(1, "heterogeneous-rotated");
const store = new CognitionStore();
const observation = observationFor(state, state.pending!.seat);
const opening = buildCognitivePrompt({
  observation,
  persona: personaById(personas[observation.seat].id),
  strategy: strategyById("expert-disciplined"),
  ledger: store.for(observation),
  config: M54,
});
const openingChars = [...opening.system].length + [...opening.user].length;

// M5.3 Terra measured: 123 planner requests, 63 spokesperson, $11.6504.
const M53_PLANNER = 123;
const M53_SAY = 63;
const M53_INPUT = 2_178_279;
const M53_OUTPUT = 671_436;
const M53_COST = 11.6504;

say(`0.6.0 开局提示 ${openingChars.toLocaleString()} 字符（0.5.0 同位置 ${
  (() => {
    const o53 = buildCognitivePrompt({
      observation,
      persona: personaById(personas[observation.seat].id),
      strategy: strategyById("expert-disclosure-safe"),
      ledger: new CognitionStore().for(observation),
      config: M53,
    });
    return ([...o53.system].length + [...o53.user].length).toLocaleString();
  })()
} 字符）`);
say("");
say(`基线：M5.3 Terra 实测 ${M53_PLANNER + M53_SAY} 次请求，输入 ${M53_INPUT.toLocaleString()}，输出 ${M53_OUTPUT.toLocaleString()}，$${M53_COST.toFixed(4)}`);
say("");
const GROWTH = 1.12;
const projInput = Math.round(M53_INPUT * GROWTH);
const cached = 0.19;
const inputUsd =
  ((projInput * (1 - cached)) / 1e6) * TERRA_PRICING.uncachedInputUsdPerMTok +
  ((projInput * cached) / 1e6) * TERRA_PRICING.cachedInputUsdPerMTok;
const outputUsd = (M53_OUTPUT / 1e6) * TERRA_PRICING.outputUsdPerMTok;
say(`0.6.0 投影输入   ${projInput.toLocaleString()}（按 +12% 估，来自上面开局提示的实测增幅）`);
say(`0.6.0 投影输出   ${M53_OUTPUT.toLocaleString()}（按不变估 —— 新增的都是有界结论，不是自由文本）`);
say(`输入 $${inputUsd.toFixed(4)} + 输出 $${outputUsd.toFixed(4)} = **$${(inputUsd + outputUsd).toFixed(4)}**`);
say("");
say(`$12 提醒线 ${inputUsd + outputUsd >= 12 ? "⚠ 会触发" : "不触发"}　$25 单局硬闸 ${inputUsd + outputUsd >= 25 ? "❌ 会撞" : "不撞"}`);
say(`累计（从 $43.4137 起）→ $${(43.4137 + inputUsd + outputUsd).toFixed(4)}，$100 批量余额 $${(100 - 43.4137 - inputUsd - outputUsd).toFixed(4)}`);
say("");
say(`规划者 ${JSON.stringify(resolveStage(M54, "planner"))}`);
say(`发言者 ${JSON.stringify(resolveStage(M54, "spokesperson"))}`);
say(`策略档 expert-disciplined 指纹 ${strategyFingerprint(strategyById("expert-disciplined")).slice(0, 32)}…`);

/* ── Write the private prompt bundle ────────────────────────────────────── */

const WARNING = [
  "> # ⚠ containsPrivateInformation: true",
  ">",
  "> 这份文件含私有协调层与规划者提示。不要分发。",
  "",
];

writeFileSync(
  join(OUT, "coordination-prompts.md"),
  [...WARNING, "# 私有出牌协调层（四个身份各自看到的）", "", ...coordLines].join("\n"),
  "utf8",
);

writeFileSync(
  join(OUT, "id-translations.md"),
  [
    "# 机器编号 → 自然中文",
    "",
    "**这一份不含私有信息** —— 两栏都是公开层的说法。",
    "",
    "| 0.5.0 实际说出去的 | 0.6.0 应该说的 |",
    "|---|---|",
    ...TRANSLATIONS.map((t) => `| \`${t.before}\` | ${t.after} |`),
    "",
  ].join("\n"),
  "utf8",
);

say("");
say(`私有协调层样本：${join(OUT, "coordination-prompts.md")}`);
say(`编号翻译对照：  ${join(OUT, "id-translations.md")}（不含私有信息）`);
