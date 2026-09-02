/**
 * The M5.3 human review package.
 *
 * OFFLINE, and every number in it is MEASURED rather than estimated where a
 * measurement is possible. The interesting part is how: it replays the
 * completed `prompt-0.4.0` game, and at each of that game's decisions it
 * rebuilds what the `prompt-0.5.0` stack WOULD have sent — both legs. So the
 * size and call-count projections come from the real positions of a real game
 * rather than from a guess about how long a prompt gets.
 *
 * WHAT IT REFUSES TO ESTIMATE. Dollars for any model whose price list is not
 * configured, and reasoning tokens for a stage that has never run. Both are
 * reported as unknown, with the formula and the one measurement that would
 * settle them. The repo's own rule: 算不出花了多少钱的预算不叫预算.
 *
 * Makes no request and constructs no client.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-3-review.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadProfile, resolveStage, type SimConfig } from "../config/load";
import { applyAction, createGame } from "../core/referee";
import { observationFor, type Observation } from "../core/observation";
import { dealFromAssignment, type Deal } from "../core/deal";
import type { Seat } from "../core/types";
import { SEATS } from "../core/types";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { claimContestFrom } from "../cognition/claim-contest";
import { buildFactRegistry } from "../cognition/fact-ids";
import { limitsFor } from "../cognition/limits";
import { applyFusedUpdate, parseCognition } from "../cognition/response";
import { CognitionStore } from "../cognition/store";
import {
  ALL_SECRET_CLASSES,
  CHANNEL_LABELS,
  SECRET_LABELS,
  classifyEntry,
} from "../cognition/classification";
import {
  channelForTask,
  renderAudit,
  sanitiseIntent,
  taskHasPublicMessage,
  validatePublicMessage,
} from "../cognition/firewall";
import { PRIVATE_IDS } from "../cognition/fact-ids";
import type { CommunicationIntent } from "../cognition/intent";
import {
  SPOKESPERSON_BRIEF_VERSION,
  buildSpokespersonPrompt,
  publicTableViewFor,
} from "../cognition/spokesperson";
import { findDisclosures, protectedSecretsFor } from "../cognition/secrets";
import { extractJson } from "../model/structured";
import { pessimisticTokenEstimate } from "../model/pricing";
import type { ModelAttempt } from "../model/attempt";
import { personaById } from "../prompts/personas";
import { strategyById, strategyFingerprint } from "../prompts/strategies";
import { PROMPT_VERSION_DISCLOSURE } from "../prompts/version";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";

const say = (...parts: unknown[]) => console.log(...parts);

const PILOT = "g-6ebccca0-5978-4b1f-a0cf-1c99af014c08";
const OUT = join(process.cwd(), "research", "simulator", "out");
const REVIEW = join(OUT, "private", "m5-3-review");
mkdirSync(REVIEW, { recursive: true });

/* ── The M5.2 trace, as the measurement base ────────────────────────────── */

const tracePath = join(OUT, "private", `${PILOT}.private-trace.jsonl`);
if (!existsSync(tracePath)) {
  say(`找不到 M5.2 的私有轨迹：${tracePath}`);
  say("这个脚本用那一局的真实位置做投影，没有它就只能靠猜 —— 猜的数字不写。");
  process.exit(1);
}
const lines = parseJsonl<PrivateTraceLine>(readFileSync(tracePath, "utf8"));
const manifestLine = lines.find((l) => l.t === "private-manifest");
if (!manifestLine || manifestLine.t !== "private-manifest") throw new Error("no manifest");
const manifest = manifestLine.data;
const actions = lines.flatMap((l) => (l.t === "action" ? [l.data] : []));
const calls = lines.flatMap((l) => (l.t === "model-call" ? [l.data] : []));

/** The 0.4.0 config the pilot actually ran. */
const config042: SimConfig = loadConfig({
  simulatorVersion: manifest.simulatorVersion,
  promptVersion: manifest.promptVersion,
  model: manifest.config.model,
  limits: manifest.config.limits,
  cognition: manifest.config.cognition,
  experiment: manifest.config.experiment,
});

/** The 0.5.0 config the same positions would run under. */
const config050 = loadProfile("m5-3-pilot");

/* ── Replay, measuring both stacks at every decision ────────────────────── */

interface Measured {
  readonly seat: Seat;
  readonly taskId: string;
  readonly speaks: boolean;
  /** What the pilot actually sent, from the trace. */
  readonly actual042: number;
  /** What 0.5.0's planner would send at the same position. */
  readonly planner050: number;
  /** What 0.5.0's spokesperson would send. Zero for a silent task. */
  readonly spokesperson050: number;
}

const measured: Measured[] = [];
const store042 = new CognitionStore();
const state = createGame({
  seed: manifest.seed,
  config: config042,
  runId: manifest.runId,
  gameId: manifest.gameId,
});

const callsBySeat = new Map<Seat, ModelAttempt[]>();
for (const call of calls) {
  const list = callsBySeat.get(call.seat) ?? [];
  list.push(call);
  callsBySeat.set(call.seat, list);
}
const cursor = new Map<Seat, number>();

/** A synthetic envelope, used to measure the spokesperson leg's size. */
function sampleIntent(observation: Observation): CommunicationIntent {
  return {
    channel: "table-public",
    publicGoal: "把这一轮的比较标准定下来，并且让牌桌按它投票",
    targetSeats: observation.position.standingClaims.slice(0, 2).map((c) => c.seat),
    selectedClaimAction: "compare-claimants",
    requestedTeam: observation.position.proposedTeam ?? null,
    requestedVote: "reject",
    publicBasisIds: [],
    publicProposition:
      "现在唯一能公开核对的约束是挂掉那辆车，别的说法都还没有落到任务结果或票型上",
    desiredTableEffect: "这一票投反对，并且下一辆车按上面那条约束来组",
  };
}

let firstSpeakingSample: { planner: string; say: string; seat: Seat; taskId: string } | null = null;

for (const entry of actions) {
  if (!state.pending) break;
  const acting = state.pending.seat;
  const observation = observationFor(state, acting);
  const ledger = store042.for(observation);

  const list = callsBySeat.get(acting) ?? [];
  const index = cursor.get(acting) ?? 0;
  // Every attempt this decision consumed. A decision ends when one settles, so
  // a repaired turn owns two records and the next decision must not read one
  // of them — that would shift every later ledger by one fold.
  let end = index;
  while (end < list.length) {
    const a = list[end];
    end += 1;
    if (a.outcome === "valid" && a.appliedLegalAction) break;
    if (end - index > 8) break;
  }
  const forThisDecision = list.slice(index, end);
  const attempt = forThisDecision[0];

  // The 0.5.0 planner at this position.
  const planner = buildCognitivePrompt({
    observation,
    persona: personaById(
      manifest.seats.find((s) => s.seat === acting)?.persona ?? "neutral",
    ),
    strategy: strategyById("expert-disclosure-safe"),
    ledger,
    config: config050,
  });
  const plannerChars = [...planner.system].length + [...planner.user].length;

  let sayChars = 0;
  const speaks = taskHasPublicMessage(planner.taskId);
  if (speaks) {
    const registry = buildFactRegistry(
      ledger.publicFacts,
      ledger.claims,
      observation,
      claimContestFrom(observation.publicLog),
    );
    const { intent } = sanitiseIntent({
      intent: sampleIntent(observation),
      observation,
      registry,
      persona: personaById(
        manifest.seats.find((s) => s.seat === acting)?.persona ?? "neutral",
      ),
      taskId: planner.taskId,
      taskChannel: channelForTask(planner.taskId),
    });
    const built = buildSpokespersonPrompt({
      view: publicTableViewFor(observation),
      intent,
      persona: personaById(
        manifest.seats.find((s) => s.seat === acting)?.persona ?? "neutral",
      ),
      taskId: planner.taskId,
      speechCharLimit: config050.limits.speechCharLimit,
      selectedAction: "",
    });
    sayChars = [...built.system].length + [...built.user].length;
    // The seq-45 position specifically: seat 8's counterclaim, the decision
    // this whole milestone exists for. Sampling its first turn instead would
    // show a prompt with an empty ledger and a two-line fact table.
    if (firstSpeakingSample === null && acting === 8 && observation.publicLog.length === 43) {
      firstSpeakingSample = {
        planner: `${planner.system}\n\n${planner.user}`,
        say: `${built.system}\n\n${built.user}`,
        seat: acting,
        taskId: planner.taskId,
      };
    }
  }

  measured.push({
    seat: acting,
    taskId: planner.taskId,
    speaks,
    actual042: attempt ? attempt.totalInputChars : 0,
    planner050: plannerChars,
    spokesperson050: sayChars,
  });

  // Advance both the referee and the ledger, exactly as the live run did.
  cursor.set(acting, end);
  for (const a of forThisDecision) {
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
    const registry = buildFactRegistry(
      ledger.publicFacts,
      ledger.claims,
      observation,
      claimContest,
    );
    store042.put(
      applyFusedUpdate(ledger, observation, parsed.cognition, observation.publicLog.length, {
        registry,
        limits,
        claimContest,
      }).ledger,
    );
  }

  applyAction(state, entry.seat, entry.action);
}

/* ── Non-interference, run here so the package carries the result ───────── */

const REFERENCE: Readonly<Record<Seat, "merlin" | "percival" | "loyal" | "morgana" | "assassin" | "mordred" | "oberon">> = {
  1: "merlin",
  2: "percival",
  3: "loyal",
  4: "loyal",
  5: "loyal",
  6: "loyal",
  7: "morgana",
  8: "assassin",
  9: "mordred",
  10: "oberon",
};

function dealWith(overrides: Partial<Record<Seat, string>>): Deal {
  return dealFromAssignment({ ...REFERENCE, ...overrides } as never);
}

function spokespersonBytes(deal: Deal, seat: Seat): string {
  const s = createGame({ seed: 11, config: config050, deal });
  let steps = 0;
  while (s.pending && steps < 12) {
    const seatNow = s.pending.seat;
    const observation = observationFor(s, seatNow);
    // A deal-blind default: everybody speaks the same and votes approve, so the
    // public state cannot diverge between the two games being compared.
    const request = observation.request;
    if (!request) break;
    let action;
    switch (request.kind) {
      case "choose_opening_direction":
        action = { kind: "choose_opening_direction", ladySide: "left", publicMessage: "左。" } as const;
        break;
      case "speech":
        action = { kind: "speech", publicMessage: "先听。", slot: request.slot } as const;
        break;
      case "leader_close_and_propose":
        action = {
          kind: "leader_close_and_propose",
          publicMessage: "就这车。",
          team: SEATS.slice(0, request.teamSize),
        } as const;
        break;
      case "vote":
        action = { kind: "vote", choice: "approve" } as const;
        break;
      default:
        return "";
    }
    applyAction(s, seatNow, action as never);
    steps += 1;
  }
  const observation = observationFor(s, seat);
  const registry = buildFactRegistry(
    [],
    [],
    observation,
    claimContestFrom(observation.publicLog),
  );
  const { intent } = sanitiseIntent({
    intent: sampleIntent(observation),
    observation,
    registry,
    persona: personaById("ledger"),
    taskId: "speech-regular",
    taskChannel: "table-public",
  });
  const built = buildSpokespersonPrompt({
    view: publicTableViewFor(observation),
    intent,
    persona: personaById("ledger"),
    taskId: "speech-regular",
    speechCharLimit: config050.limits.speechCharLimit,
    selectedAction: "",
  });
  return `${built.system}\n${built.user}`;
}

const pairA = spokespersonBytes(dealWith({}), 2);
const pairB = spokespersonBytes(dealWith({ 1: "loyal", 3: "merlin" }), 2);
const roleA = spokespersonBytes(dealWith({}), 5);
const roleB = spokespersonBytes(dealWith({ 1: "loyal", 5: "merlin" }), 5);

/* ── Adversarial ────────────────────────────────────────────────────────── */

const PAYLOADS = [
  "7、9一梅林一莫甘娜",
  "我的两个候选是7号和9号",
  "7、9中必有莫甘娜，所以这车必坏",
  "看 [p.pair]",
  "我的 hypotheses 写着 7号 是莫甘娜",
];

const adversarial = (() => {
  const deal = dealWith({ 1: "mordred", 9: "merlin" });
  const s = createGame({ seed: 11, config: config050, deal });
  const observation = observationFor(s, 2);
  const secrets = protectedSecretsFor(observation);
  const registry = buildFactRegistry([], [], observation, claimContestFrom(observation.publicLog));
  return PAYLOADS.map((payload) => {
    const { intent, audit } = sanitiseIntent({
      intent: {
        ...sampleIntent(observation),
        publicGoal: payload,
        publicProposition: payload,
        desiredTableEffect: payload,
        publicBasisIds: [PRIVATE_IDS.percivalPair, PRIVATE_IDS.self, "f_invented"],
      },
      observation,
      registry,
      persona: personaById("ledger"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    const built = buildSpokespersonPrompt({
      view: publicTableViewFor(observation),
      intent,
      persona: personaById("ledger"),
      taskId: "speech-regular",
      speechCharLimit: config050.limits.speechCharLimit,
      selectedAction: "",
    });
    return {
      payload,
      secrets,
      redacted: audit.redactedFields.length,
      rejectedIds: audit.rejectedBasisIds.length,
      reachedStageTwo: `${built.system}\n${built.user}`.includes(payload),
      audit,
    };
  });
})();

/* ── Projections ────────────────────────────────────────────────────────── */

const speaking = measured.filter((m) => m.speaks);
const silent = measured.filter((m) => !m.speaks);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const pct = (ns: number[], p: number) => {
  const sorted = [...ns].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

/**
 * The estimator's measured bias, from the pilot.
 *
 * `pessimisticTokenEstimate` deliberately over-counts. The pilot recorded both
 * its own estimate and the provider's reported total, so the ratio is a
 * measurement rather than a correction factor somebody chose.
 */
const ESTIMATED_042 = sum(calls.map((c) => c.estimatedInputTokens));
const PROVIDER_042 = sum(calls.map((c) => c.usage?.inputTokens ?? 0));
const BIAS = PROVIDER_042 / ESTIMATED_042;

const plannerTokens = sum(measured.map((m) => pessimisticTokenEstimate("x".repeat(m.planner050))));
const sayTokens = sum(speaking.map((m) => pessimisticTokenEstimate("x".repeat(m.spokesperson050))));
const actualTokens = sum(measured.map((m) => pessimisticTokenEstimate("x".repeat(m.actual042))));

const pricing = config050.pricing;
const inputUsd = (tokens: number) => (tokens / 1e6) * pricing.uncachedInputUsdPerMTok;

const PILOT_INPUT = PROVIDER_042;
const PILOT_OUTPUT = sum(calls.map((c) => c.usage?.outputTokens ?? 0));
const PILOT_COST = 7.647;

const projectedPlannerInput = plannerTokens * BIAS;
const projectedSayInput = sayTokens * BIAS;

/* ── Write ──────────────────────────────────────────────────────────────── */

const doc: string[] = [];
const push = (...ls: string[]) => doc.push(...ls);

push(
  "> # ⚠ containsPrivateInformation: true",
  ">",
  "> 这份评审包引用了重建出来的私有提示（含发牌相关的层），",
  "> 也引用了 M5.2 那一局的私有轨迹。**不要分发，不要给还要盲评这局的人看。**",
  "",
  "# M5.3 人类评审包",
  "",
  `生成自 M5.2 实盘 \`${PILOT}\`（\`${manifest.promptVersion}\`）的真实位置。`,
  "每一个体量数字都是**在那一局的每一个决策点上真的把 0.5.0 的两段提示建出来测的**，不是估的。",
  "",
  "---",
  "",
  "## 一、历史提示重建",
  "",
  "两个泄露点各自单独重建，并用 `promptKey` 校验：",
  "",
  "```",
  "npx vite-node -c research/simulator/vitest.config.ts \\",
  "  research/simulator/scripts/render-turn-prompt.ts -- \\",
  `  --game-id ${PILOT} --seat 8 --sequence 45 \\`,
  "  --out research/simulator/out/private/m5-3-review/seq45",
  "```",
  "",
  "| | seq 45 | seq 58 |",
  "|---|---|---|",
  "| 逐位一致 | ✅ | ✅ |",
  "| 任务 | `speech-regular`（第 2 次尝试） | `speech-regular`（第 1 次） |",
  "| 校验项 | promptKey / systemChars / userChars / totalInputChars / taskId / publicEventCount / promptVersion / persona / role / strategyFingerprint 十项全对 | 同上 |",
  "",
  "`promptKey` 是对 system + user + 模型 + 强度 + schema 一起做的哈希。两边相同，",
  "意味着重建出来的两条消息和当时发出去的**一个字节都不差** —— 下面的根因分析读的是真实历史提示，不是复原品。",
  "",
  "**重建过程中发现并修掉的一个自身缺陷**：第一版工具在重放完整局之后才去取账本，",
  "取到的是**局末**的账本，于是 seq 45 的提示多出 484 字符（正好是后面四次决策折叠进去的量）。",
  "`promptKey` 校验把它抓了出来。这也是为什么重建工具必须自带校验：",
  "一个没人核对过的重建，只是一个关于提示的可信故事。",
  "",
  "---",
  "",
  "## 二、泄露的确切根因（逐层）",
  "",
  "真实提示里同时命中了九条措辞。它们不是同一种错误：",
  "",
  "| 层 | 出处 | 判定 | 问题 |",
  "|---|---|---|---|",
  "| 8 策略档 | `ecc.percival-claim-tradeoff` | **促成** | 「换到的：**把候选对变成公开的组织依据**」—— 直接把公开那一对写成跳派的好处，而且标了「必须看到」 |",
  "| 8 策略档 | `ecc.percival-claim-must-be-actionable` | **促成** | 「带上可执行的东西：**候选对怎么处理**」—— 在公开发言的语境里几乎只能靠说出那一对来满足 |",
  "| 8 策略档 | `ecc.percival-fight-the-rival` | **促成** | 「打他的**候选对故事**」—— 下一步自然就是拿自己的那一对去对比 |",
  "| 8 策略档 | `es.percival-pair-same-team-crosses-a-line` | **促成** | 「沉默地投反对既救不了这一轮、也不会有人接住」—— 把沉默反对说成无效 |",
  "| 8 策略档 | `ec.percival-pair-same-team` | 未能阻止 | 「反对得越明确、越等于自报身份并**点出候选对**」—— 把泄露写成明确反对的自然后果 |",
  "| 8 策略档 | `ec.percival-do-not-rank-the-pair-publicly` | 未能阻止 | **唯一一条保护性条目**，但它是条件性的（「没有明确回报」），而且只管排序、不管报出那一对 |",
  "| 10 输出格式 | `candidatePairStory` | 未能阻止 | 要求填「打算在公开场合讲的候选对说法」，没有区分真派（说了就是泄露）和别人（编的） |",
  "| 10 输出格式 | `informationToConceal` | 未能阻止 | 让**模型自己**声明不能漏的东西。实盘里 8号 每一步都填对了，然后照样说了出去 |",
  "| 10 输出格式 | 「认知内容一个字都不要写进去」 | 未能阻止 | 只禁止「认知内容」，没有禁止把**私有事实**当公开理由 —— 而那一对是事实，不是认知 |",
  "",
  "**结论。** 这不是一句话写错了。九条里有四条在推它说、五条本该拦住而拦不住，",
  "而且唯一那条保护性条目**就在同一份提示里**，模型读了，照样说了。",
  "**这类失败不可能靠再加一条「不要说」来修** —— M5.2 已经加过了。",
  "",
  "---",
  "",
  "## 三、旧架构 vs 新架构",
  "",
  "```",
  "prompt-0.4.0（融合）                       prompt-0.5.0（分离）",
  "",
  "┌──────────────────────────┐             ┌──────────────────────────┐",
  "│ 一次请求                 │             │ ① 私有规划者             │",
  "│  身份层（真实身份）      │             │   身份层（真实身份）     │",
  "│  私有信息层（候选对）    │             │   私有信息层（候选对）   │",
  "│  推理记录（完整账本）    │   ──▶       │   推理记录（完整账本）   │",
  "│  公开记录 + 派权表       │             │   公开记录 + 派权表      │",
  "│  ↓                       │             │   ↓ 产出：动作 + 信封    │",
  "│  动作 **和** 公开发言    │             └───────────┬──────────────┘",
  "│  在同一次生成里          │                         │ 防泄露闸",
  "└──────────────────────────┘                         │ · 公开 id 才放行",
  "                                                     │ · 带秘密的字段整段抹掉",
  "         同一段文本                                   │ · 频道由任务决定",
  "         既看得到候选对                               ▼",
  "         又要写给牌桌听                  ┌──────────────────────────┐",
  "                                         │ ② 公开发言者             │",
  "                                         │   **没有**身份           │",
  "                                         │   **没有**候选对         │",
  "                                         │   **没有**账本           │",
  "                                         │   只有公开记录 + 信封    │",
  "                                         │   ↓ 产出：一句话         │",
  "                                         └───────────┬──────────────┘",
  "                                                     │ 成句后再查一次",
  "                                                     ▼ 进公开日志",
  "```",
  "",
  "**关键差别不是多了一道检查，是发言者手上根本没有那个值。**",
  "一个没拿到候选对的模型，不会因为被说服、被绕、或者自己想帮忙就把它说出来 —— 它没有可说的。",
  "",
  "---",
  "",
  "## 四、发言者拿不到身份和候选对的证明",
  "",
  "不是靠读代码，是靠**逐字节比较**：造两局只在隐藏信息上不同的对局，",
  "固定公开状态和已选动作，要求发言者的两条消息完全一样。",
  "",
  "| 换掉的东西 | system 一致 | user 一致 |",
  "|---|---|---|",
  `| 派西维尔候选对 | ${pairA === pairB ? "✅" : "❌"} | ${pairA === pairB ? "✅" : "❌"} |`,
  `| 座位的真实身份 | ${roleA === roleB ? "✅" : "❌"} | ${roleA === roleB ? "✅" : "❌"} |`,
  "",
  "另外两项（坏人名单、女神真实结果）在 `cognition/noninterference.test.ts` 里，同样是逐字节断言。",
  "",
  "**开发过程中这组测试抓到了一个真实缺陷**：第一版把「这个座位持有哪几类秘密」",
  "渲染进了发言者提示。那本身就是身份信号 ——「你持有梅林视野」等于报出身份。",
  "现在发言者拿到的是**恒定的七类清单**，每一局每一个座位都一样；",
  "座位真正持有什么只进私有审计。",
  "",
  "`PublicTableView` 只有三个字段：`seat` / `position` / `publicLog`。",
  "`assertPublicOnly` 在运行时再拒一次 —— 因为 `Observation` 结构上是它的超集，",
  "一个 `as` 就能骗过编译器。",
  "",
  "---",
  "",
  "## 五、信息分级（系统所有，模型改不了）",
  "",
  "| 秘密类别 | 频道 | 能否解密 | 通过什么动作 | 公开出去的是什么 |",
  "|---|---|---|---|---|",
);

for (const id of [
  PRIVATE_IDS.self,
  PRIVATE_IDS.percivalPair,
  PRIVATE_IDS.seesEvil,
  PRIVATE_IDS.teammates,
  "p.lady2",
]) {
  const c = classifyEntry(8, id, "private-fact");
  push(
    `| ${c.secretClass ? SECRET_LABELS[c.secretClass] : "—"}（\`${id}\`） | ${CHANNEL_LABELS[c.channel]} | ` +
      `${c.declassification.permitted ? "**可以**" : "永远不行"} | ` +
      `${c.declassification.viaAction ?? "—"} | ${c.declassification.publishes ?? "—"} |`,
  );
}

push(
  "",
  "公开事实 `f…`、推导事实 `f.now`/`f.fail…`、说法 `c…`、派权事件 `k…` 全部是牌桌公开。",
  "",
  "**推导结论继承前提里最强的那一条隐私。** 一条建立在 `f12` 和 `p.pair` 上的约束是 `p.pair` 级的，",
  "这是账本里「结论最多和最弱的前提一样硬」的镜像 —— 硬度和隐私沿着同一条边往相反方向走。",
  "",
  "---",
  "",
  "## 六、对抗性规划者",
  "",
  "让规划者把私有信息塞进信封的**每一个**文本字段，同时把 `p.pair` / `p.self` / 一个编造 id 塞进公开依据：",
  "",
  "| 载荷 | 被抹掉的字段 | 被剔除的 id | 有没有到达发言者 |",
  "|---|---|---|---|",
);
for (const a of adversarial) {
  push(
    `| 「${a.payload}」 | ${a.redacted} | ${a.rejectedIds} | ${a.reachedStageTwo ? "❌ **到了**" : "✅ 没有"} |`,
  );
}
push(
  "",
  "被抹掉的字段是**整段替换**，不是删掉一部分：把一句话里的候选对抠掉，",
  "剩下的那句话还是那个意思；整段换掉，发言者手上就什么都没有。",
  "",
  "一份审计记录长这样：",
  "",
  "```",
  renderAudit(adversarial[0].audit),
  "```",
  "",
  "---",
  "",
  "## 七、成句之后的最后一道闸",
  "",
  "M5.2 真的说出去的那两句，现在会被拦下；一句要求**同样动作**但只用公开记录的话，会放行：",
  "",
);

{
  const deal = dealWith({ 1: "mordred", 9: "merlin" });
  const s = createGame({ seed: 11, config: config050, deal });
  const observation = observationFor(s, 2);
  const cases: { text: string; label: string }[] = [
    { label: "实盘 seq 45 原文", text: "我跳派：7、9一梅林一莫甘娜，57910必有坏人；0:2不能赌。" },
    { label: "实盘 seq 58 原文", text: "我就是派西维尔：7、9一梅林一莫甘娜。57910必带莫甘娜。" },
    {
      label: "安全改写（同一个动作）",
      text:
        "7号一直用派身份推动自己进入关键车，却没有给出可以由任务和票型验证的候选逻辑。" +
        "现在0:2，57910缺少足够公开安全依据，我反对，建议16810。",
    },
    { label: "普通三人推论（必须放行）", text: "第二轮挂的车里 6、7、9 都在，这三个里至少一个坏人。" },
  ];
  push("| 句子 | 判定 | 命中的规则 |", "|---|---|---|");
  for (const c of cases) {
    const verdict = validatePublicMessage({
      message: c.text,
      observation,
      taskId: "speech-regular",
    });
    push(
      `| **${c.label}** | ${verdict.ok ? "✅ 放行" : "❌ **拦下**"} | ` +
        `${verdict.ok ? "—" : verdict.disclosures.map((d) => `\`${d.rule}\``).join("、")} |`,
    );
  }
}

push(
  "",
  "**被拦下之后：** 不进公开日志、不给任何别的智能体看、**不把那句话回喂给发言者当修复提示**",
  "（回喂等于把它刚要泄露的东西再递给它一次），用**一模一样**的提示重发，",
  `超过 \`stages.maxPublicMessageRepairs\`（现在是 ${config050.stages.maxPublicMessageRepairs}）就以 \`disclosure_invalid\` 停下。`,
  "",
  "**这道闸是纵深防御，不是主要机制。** 它是一个中文文本检测器，不可能完备。",
  "主要机制是第四节那件事：发言者手上没有那个值。",
  "",
  "---",
  "",
  "## 八、体量投影（在 M5.2 的真实位置上实测）",
  "",
  `M5.2 那一局有 **${measured.length}** 个决策，其中 **${speaking.length}** 个要说话、**${silent.length}** 个不用。`,
  "",
  "| 单次请求输入（字符） | 0.4.0 实测 | 0.5.0 规划者 | 0.5.0 发言者 |",
  "|---|---|---|---|",
  `| 中位 | ${pct(measured.map((m) => m.actual042), 0.5).toLocaleString()} | ${pct(measured.map((m) => m.planner050), 0.5).toLocaleString()} | ${pct(speaking.map((m) => m.spokesperson050), 0.5).toLocaleString()} |`,
  `| p90 | ${pct(measured.map((m) => m.actual042), 0.9).toLocaleString()} | ${pct(measured.map((m) => m.planner050), 0.9).toLocaleString()} | ${pct(speaking.map((m) => m.spokesperson050), 0.9).toLocaleString()} |`,
  `| 最大 | ${Math.max(...measured.map((m) => m.actual042)).toLocaleString()} | ${Math.max(...measured.map((m) => m.planner050)).toLocaleString()} | ${Math.max(...speaking.map((m) => m.spokesperson050)).toLocaleString()} |`,
  "",
  `**规划者比 0.4.0 大约多 ${Math.round(((sum(measured.map((m) => m.planner050)) / sum(measured.map((m) => m.actual042))) - 1) * 100)}%**，`,
  "多出来的是身份层追加的披露规则、协议层追加的分离规则、以及信封的填写说明。",
  "",
  `**发言者的提示是规划者的 ${Math.round((sum(speaking.map((m) => m.spokesperson050)) / sum(speaking.map((m) => m.planner050))) * 100)}%** ——`,
  "它拿不到身份层、私有信息层、推理记录、策略档和思考流程，所以显著更小。",
  "",
  "---",
  "",
  "## 九、调用次数、token 与成本投影",
  "",
  "### 调用次数",
  "",
  "| | M5.2 实测 | 0.5.0 投影 |",
  "|---|---|---|",
  `| 请求数 | ${calls.length} | **${calls.length + speaking.length}**（+${speaking.length}，每个说话回合多一次）|`,
  `| 单局调用上限 | ${config050.limits.maxLiveCallsPerGame} | 同 —— 投影值占 ${Math.round(((calls.length + speaking.length) / config050.limits.maxLiveCallsPerGame) * 100)}% |`,
  "",
  "### 输入 token",
  "",
  `估算器有系统性高估。M5.2 记了两边：估算 ${ESTIMATED_042.toLocaleString()}，provider 实报 ${PROVIDER_042.toLocaleString()}，`,
  `**实测偏差系数 ${BIAS.toFixed(4)}**。下面的投影已经乘过它 —— 这是测出来的，不是挑出来的。`,
  "",
  "| | token |",
  "|---|---|",
  `| M5.2 实测输入 | ${PILOT_INPUT.toLocaleString()} |`,
  `| 0.5.0 规划者投影 | ${Math.round(projectedPlannerInput).toLocaleString()} |`,
  `| 0.5.0 发言者投影 | ${Math.round(projectedSayInput).toLocaleString()} |`,
  `| **合计** | **${Math.round(projectedPlannerInput + projectedSayInput).toLocaleString()}**（约为 M5.2 的 ${((projectedPlannerInput + projectedSayInput) / PILOT_INPUT).toFixed(2)}×）|`,
  "",
  "### 输出 token —— 这里有一个**测不出来**的量",
  "",
  `M5.2 输出 ${PILOT_OUTPUT.toLocaleString()}，其中 reasoning ${sum(calls.map((c) => c.usage?.reasoningTokens ?? 0)).toLocaleString()}（38%）。`,
  "",
  "- **规划者**：0.5.0 把 `publicMessage` 从它的 schema 里拿掉了，换成更短的信封，所以只会更小，不会更大。按不变估。",
  "- **发言者**：可见输出被 220 个非空白字符卡死，大约 200-400 token。",
  `  但它的 **reasoning token 用量没有任何测量** —— 这一段一次都没跑过。`,
  `  profile 里给的是 \`reasoningEffort: "${config050.stages.spokesperson.reasoningEffort}"\` +`,
  `  \`maxOutputTokens: ${config050.stages.spokesperson.maxOutputTokens}\`，`,
  "  依据是「220 字的可见输出不需要继承规划者的 12,000」，**不是实测**。",
  "  第一局跑完就能校准；在那之前，这个数字应该被当成一个待验证的假设。",
  "",
  "**为什么不给发言者 12,000：** 给了不省钱，只会让真的耗尽时更晚发现；",
  `而 ${config050.stages.spokesperson.maxOutputTokens} 给 220 字的可见输出留了大约 4-8 倍余量。`,
  "**如果第一局出现容量耗尽，正确的反应是调高它并重跑，不是把上限一开始就设成天花板。**",
  "",
  "### 成本",
  "",
  `价目已配置的只有 \`${pricing.modelId}\`（${pricing.uncachedInputUsdPerMTok}/${pricing.cachedInputUsdPerMTok}/${pricing.outputUsdPerMTok} 美元每百万，来源 ${pricing.sourceUrl}，读于 ${pricing.verifiedOn}）。`,
  "",
  "| 配置 | 调用次数 | 输入 token | 成本 |",
  "|---|---|---|---|",
  `| **① Terra 规划 + Terra 发言** | ${calls.length + speaking.length} | ${Math.round(projectedPlannerInput + projectedSayInput).toLocaleString()} | ` +
    `输入 $${inputUsd(projectedPlannerInput + projectedSayInput).toFixed(4)} + 输出（见上，发言者 reasoning 未知）　**下界 $${(inputUsd(projectedPlannerInput + projectedSayInput) + (PILOT_OUTPUT / 1e6) * pricing.outputUsdPerMTok).toFixed(2)}** |`,
  `| ② Terra 规划 + Luna 发言 | ${calls.length + speaking.length} | 同上（拆分不因模型而变）| **算不出来** —— Luna 的价目没有配置 |`,
  `| ③ Luna 规划 + Luna 发言 | ${calls.length + speaking.length} | 同上 | **算不出来** —— 同上 |`,
  "",
  "**②③ 不给数字是故意的。** 仓库里没有 Luna 的价目、没有出处、没有读取日期。",
  "编一个出来会让整份预算变成一个自信的错误 —— `.env.example` 里那句话同样适用：**算不出花了多少钱的预算不叫预算**。",
  "要跑 ②③，先把 Luna 的价目连出处一起写进配置。",
  "",
  `M5.2 实测 $${PILOT_COST.toFixed(4)}。**①的下界约为它的 ${((inputUsd(projectedPlannerInput + projectedSayInput) + (PILOT_OUTPUT / 1e6) * pricing.outputUsdPerMTok) / PILOT_COST).toFixed(2)}×**，`,
  "上浮部分取决于发言者的 reasoning，而那个量目前没有测量。",
  "",
  "### 墙钟",
  "",
  `M5.2 总延迟 ${(sum(calls.map((c) => c.latencyMs)) / 60000).toFixed(1)} 分钟，串行。`,
  `多出来的 ${speaking.length} 次请求如果延迟与规划者同量级，会接近翻倍；`,
  "发言者的提示小得多、思考强度也低一档，所以更可能是 +40% 到 +70%。**这同样没有测量。**",
  "",
  "---",
  "",
  "## 十、还需要人来定的事",
  "",
  "1. ~~发言者的 `maxOutputTokens` 和 `reasoningEffort`~~ —— **已定**（2026-08-27）：medium / 3,000。",
  "   3,000 仍然是**推的不是测的**（这一段一次都没跑过），但给上限不花钱，只有真的用掉才计费；",
  "   第一局跑完就能校准。",
  "2. **要不要跑混合模型（②）** —— 建议第一局**两段同模型**：0.5.0 已经同时改了协议层、schema、",
  "   动作格式和一个回合的请求数；再换模型进来，任何差异都归因不到分离架构本身。",
  "3. ~~Luna 的价目~~ —— **已配置**（2026-08-27，官方价目，见 model/price-lists.ts）。",
  "4. **一个新的不对称**（这是设计的真实副作用，不是 bug）：",
  "   拦的是**真实**候选对，所以一个手上没有那一对的座位（比如莫甘娜）可以随便编一个公开讲，",
  "   而真派西维尔不能讲真的。于是「敢报一对」会变成「不是真派」的软线索。",
  "   `eds.pair-story-is-not-evidence` 在提示层点了这件事，但**要不要在机制层也禁止编造的候选对，",
  "   是一个改变游戏策略空间的决定，应该由人来做，不是由我来做。**",
  "5. **检测器的边界** —— 它是中文文本匹配，两层规则，不可能完备。",
  "   结构保证（发言者没拿到值）是主要机制；如果将来要把检测器当成主要机制用，需要另做评估。",
  "",
  "---",
  "",
  `策略档 \`expert-disclosure-safe\` 指纹 \`${strategyFingerprint(strategyById("expert-disclosure-safe")).slice(0, 32)}…\``,
  `　发言者简报版本 \`${SPOKESPERSON_BRIEF_VERSION}\`　秘密类别 ${ALL_SECRET_CLASSES.length} 类`,
  `　规划者 ${JSON.stringify(resolveStage(config050, "planner"))}`,
  `　发言者 ${JSON.stringify(resolveStage(config050, "spokesperson"))}`,
  "",
);

writeFileSync(join(REVIEW, "M5.3-review.md"), `${doc.join("\n")}\n`, "utf8");

if (firstSpeakingSample) {
  writeFileSync(
    join(REVIEW, "planner-prompt.md"),
    [
      "> # ⚠ containsPrivateInformation: true",
      ">",
      "> 私有规划者的完整提示，含身份层与私有信息层。不要分发。",
      "",
      `# 私有规划者提示（${PROMPT_VERSION_DISCLOSURE} · ${firstSpeakingSample.seat}号 · ${firstSpeakingSample.taskId}）`,
      "",
      "```text",
      firstSpeakingSample.planner,
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(REVIEW, "spokesperson-prompt.md"),
    [
      "# 公开发言者提示（完整）",
      "",
      "**这一份没有 `containsPrivateInformation` 警告，而且这正是重点。**",
      "它里面没有身份、没有候选对、没有视野、没有名单、没有验人结果、没有推理记录 ——",
      "把它交给任何人看，都不会泄露这一局的任何隐藏信息。",
      "",
      `位置：${firstSpeakingSample.seat}号 · \`${firstSpeakingSample.taskId}\``,
      "",
      "```text",
      firstSpeakingSample.say,
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
}

say(`评审包：${join(REVIEW, "M5.3-review.md")}`);
say(`  规划者提示：${join(REVIEW, "planner-prompt.md")}（私有）`);
say(`  发言者提示：${join(REVIEW, "spokesperson-prompt.md")}（不含私有信息）`);
say("");
say(`决策 ${measured.length}　说话 ${speaking.length}　投影请求数 ${calls.length + speaking.length}`);
say(`非干涉：候选对 ${pairA === pairB ? "✅" : "❌"}　身份 ${roleA === roleB ? "✅" : "❌"}`);
say(`对抗性载荷 ${adversarial.length} 个，到达发言者的 ${adversarial.filter((a) => a.reachedStageTwo).length} 个`);
