/**
 * Rebuild the EXACT prompt one seat was given for one decision, and prove it.
 *
 * READ-ONLY AND OFFLINE. It opens a private trace, replays the recorded
 * actions through the deterministic referee, re-folds each recorded cognition
 * block into the seat's ledger, and rebuilds the prompt the agent would have
 * built. It makes no request, constructs no client, and writes nothing except
 * the four files it is asked for.
 *
 * WHY VERIFICATION IS THE POINT. A reconstruction nobody checked is a
 * plausible story about a prompt. This one recomputes `requestKey` over the
 * rebuilt system and user messages and compares it with the `promptKey` the
 * run recorded at send time — same hash, same bytes. It also compares the
 * character counts, the prompt version, the task id, the persona, the role and
 * the strategy fingerprint. If any of them disagrees the report says EXACTLY
 * WHICH, and does not present the output as the historical prompt.
 *
 * WHAT IT REFUSES TO DO. It never invents a missing value. If the trace does
 * not carry something the rebuild needs, the provenance report names the field
 * and stops claiming exactness — see `MISSING FIELDS` below, which is written
 * from the actual comparison rather than from an assumption about what is
 * stored.
 *
 * THE OUTPUT IS PRIVATE. A reconstructed prompt contains the deal-dependent
 * layer: the seat's role, its Percival pair or Merlin vision, its Lady results
 * and its entire ledger. Every file written carries the warning header, the
 * tool refuses to write into `out/public/`, and nothing here can reach a public
 * artifact — `publicReplayLines` has no branch that could emit it.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/render-turn-prompt.ts -- \
 *     --game-id g-… --seat 8 --sequence 45 --out research/simulator/out/private/seq45
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadConfig, type SimConfig } from "../config/load";
import { applyAction, createGame } from "../core/referee";
import { observationFor, type Observation } from "../core/observation";
import type { GameState } from "../core/state";
import type { Seat } from "../core/types";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { claimContestFrom } from "../cognition/claim-contest";
import { buildFactRegistry } from "../cognition/fact-ids";
import { limitsFor } from "../cognition/limits";
import { applyFusedUpdate, parseCognition } from "../cognition/response";
import { CognitionStore } from "../cognition/store";
import type { EpistemicLedger } from "../cognition/ledger";
import { requestKey, type ModelRequest } from "../model/client";
import { extractJson } from "../model/structured";
import { jsonSchemaFor, schemaNameFor } from "../model/json-schema";
import type { ModelAttempt } from "../model/attempt";
import { buildPlayerPrompt } from "../prompts/build";
import { personaById } from "../prompts/personas";
import { strategyById, strategyFingerprint, type CatalogStrategyId } from "../prompts/strategies";
import { capabilitiesFor } from "../prompts/capabilities";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";

const say = (...parts: unknown[]) => console.log(...parts);

/* ── Arguments ──────────────────────────────────────────────────────────── */

function flag(name: string): string | null {
  const argv = process.argv;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const gameId = flag("game-id");
const seatArg = flag("seat");
const sequenceArg = flag("sequence");
const outArg = flag("out");

if (!gameId || !seatArg || !sequenceArg || !outArg) {
  say("用法：--game-id <id> --seat <座位> --sequence <公开事件 sequence> --out <私有目录>");
  say("");
  say("输出四个文件：system-prompt.md / user-prompt.md / layer-index.json / provenance-report.md");
  say("全部是私有产物 —— 含发牌相关的那一层，不要放进任何公开目录。");
  process.exit(1);
}

const seat = Number(seatArg) as Seat;
const targetSequence = Number(sequenceArg);
const outDir = resolve(outArg);

// A reconstructed prompt carries the deal-dependent layer. Refusing the public
// directory outright is cheaper than trusting every future caller to remember.
if (outDir.split(sep).includes("public")) {
  say(`拒绝写入 ${outDir} —— 路径里有 "public"，而重建出来的提示是私有产物。`);
  process.exit(1);
}

/* ── The trace ──────────────────────────────────────────────────────────── */

const tracePath = join(
  process.cwd(),
  "research",
  "simulator",
  "out",
  "private",
  `${gameId}.private-trace.jsonl`,
);
const lines = parseJsonl<PrivateTraceLine>(readFileSync(tracePath, "utf8"));

const manifestLine = lines.find((l) => l.t === "private-manifest");
if (!manifestLine || manifestLine.t !== "private-manifest") {
  say("这份轨迹里没有 private-manifest，无法重建。");
  process.exit(1);
}
const manifest = manifestLine.data;
const actions = lines.flatMap((l) => (l.t === "action" ? [l.data] : []));
const modelCalls = lines.flatMap((l) => (l.t === "model-call" ? [l.data] : []));

const config: SimConfig = loadConfig({
  simulatorVersion: manifest.simulatorVersion,
  promptVersion: manifest.promptVersion,
  model: manifest.config.model,
  limits: manifest.config.limits,
  cognition: manifest.config.cognition,
  experiment: manifest.config.experiment,
});

const seatEntry = manifest.seats.find((s) => s.seat === seat);
if (!seatEntry) {
  say(`轨迹里没有 ${seat}号 的配置。`);
  process.exit(1);
}
const persona = personaById(seatEntry.persona ?? "neutral");
const strategy = strategyById(
  (seatEntry.strategy ?? manifest.strategyId) as CatalogStrategyId,
);

/* ── Replay, folding cognition as we go ─────────────────────────────────── */

/**
 * Which recorded attempts folded a cognition block into the ledger.
 *
 * `outcome === "valid"` means the ACTION parsed. The cognition block is
 * validated afterwards, and a failure there is recorded on the same attempt as
 * `rejectedBy: "cognition"` — so a valid-looking attempt whose cognition was
 * refused never reached `applyFusedUpdate` and must not be folded here. A
 * REFEREE rejection is different: the fold had already happened by the time the
 * referee saw the move, so those do fold.
 */
function folded(attempt: ModelAttempt): boolean {
  return (
    attempt.outcome === "valid" &&
    attempt.rejectedBy !== "cognition" &&
    attempt.rejectedBy !== "action-format"
  );
}

/**
 * Did this game run under the prompt-0.5.0 folding defect?
 *
 * EVIDENCE, not a version check. A game whose stack DECLARES the contest and
 * whose telemetry records `contest: null` on every single decision can only be
 * one thing: the answers were discarded. Detecting it from the artifact means
 * the tool stays correct for a future 0.5.0 game replayed after the fix, and
 * for the two that ran before it, without anybody passing a flag.
 */
const telemetry = lines.flatMap((l) =>
  l.t === "cognition-telemetry" ? [...l.data] : [],
);
const ranWithFoldingDefect =
  capabilitiesFor(manifest.promptVersion).claimContest &&
  telemetry.length > 0 &&
  telemetry.every((r) => r.contest === null && r.social === null);

// PLANNER legs only. Under `prompt-0.5.0` a speaking turn also records a
// `…#say` call for the public spokesperson, and counting those as decisions
// shifts every later pairing — which silently compared the assassination
// against a vote fifteen decisions earlier.
const seatCalls = modelCalls.filter(
  (c) => c.seat === seat && !c.taskId.endsWith("#say"),
);
const store = new CognitionStore();
const state: GameState = createGame({
  seed: manifest.seed,
  config,
  runId: manifest.runId,
  gameId: manifest.gameId,
});

interface Rebuilt {
  readonly observation: Observation;
  /**
   * The ledger AS IT STOOD when this decision was asked.
   *
   * Captured here rather than read after the loop, and that is not a
   * micro-optimisation: the replay keeps folding later decisions, so a ledger
   * fetched at the end is the seat's mind at the END OF THE GAME. Reading it
   * that way rebuilt seq 45's prompt 484 characters too long — four later
   * folds' worth — and the `promptKey` check is what caught it.
   */
  readonly ledger: EpistemicLedger;
  /** The attempt whose prompt this is: the LAST one for the decision. */
  readonly attempt: ModelAttempt;
  /** Every attempt at this decision, in order. */
  readonly attempts: readonly ModelAttempt[];
  readonly actionIndex: number;
}

interface DecisionAudit {
  decision: number;
  taskId: string;
  attempts: number;
  recordedEvents: number;
  rebuiltEvents: number;
  /** The FIRST attempt at this decision — the one with no repair note. */
  recordedUserChars: number;
  rebuiltUserChars: number;
  recordedCognitionChars: number | null;
  rebuiltCognitionChars: number;
}

const audit: DecisionAudit[] = [];
let callCursor = 0;
let found: Rebuilt | null = null;

for (const [index, entry] of actions.entries()) {
  if (!state.pending) break;
  const acting = state.pending.seat;
  const observation = observationFor(state, acting);
  const before = state.log.length > 0 ? state.log[state.log.length - 1].sequence : 0;

  // Every attempt this decision consumed, in send order. A decision ends when
  // one of its attempts settles, which is exactly the recorded action.
  const mine: ModelAttempt[] = [];
  if (acting === seat) {
    while (callCursor < seatCalls.length) {
      mine.push(seatCalls[callCursor]);
      callCursor += 1;
      const last = mine[mine.length - 1];
      if (last.outcome === "valid" && last.appliedLegalAction) break;
      // A provider error or a capacity retry is the same decision continuing.
      if (mine.length > 8) break;
    }
  }

  applyAction(state, entry.seat, entry.action);

  if (acting === seat) {
    // Per-decision verification, collected on the way past. `--audit-seat`
    // prints it, and it is what turns "the rebuild is 484 characters long"
    // into "the divergence starts at decision 5" without a manual bisect.
    const last = mine[mine.length - 1];
    if (last) {
      const rebuiltPrompt = config.cognition.enabled
        ? buildCognitivePrompt({ observation, persona, strategy, ledger: store.for(observation), config })
        : null;
      audit.push({
        decision: audit.length + 1,
        taskId: last.taskId,
        attempts: mine.length,
        recordedEvents: last.publicEventCount,
        rebuiltEvents: observation.publicLog.length,
        recordedUserChars: mine[0].userChars,
        rebuiltUserChars: rebuiltPrompt ? [...rebuiltPrompt.user].length : 0,
        recordedCognitionChars: null,
        rebuiltCognitionChars: rebuiltPrompt ? rebuiltPrompt.pack.cognition.length : 0,
      });
    }

    // The action that PRODUCED the target sequence, whoever the event names.
    // Matching on `speaker` alone missed `assassination_target` (which names an
    // `assassin`), `vote` and `mission_result` (which name nobody) — and then
    // silently matched an earlier decision instead of failing.
    const produced =
      before < targetSequence &&
      state.log.some((e) => e.sequence === targetSequence);
    if (found === null && produced) {
      found = {
        observation,
        ledger: store.for(observation),
        attempt: mine[mine.length - 1] ?? seatCalls[Math.max(0, callCursor - 1)],
        attempts: mine,
        actionIndex: index,
      };
    }
    // Fold this decision's cognition so the NEXT decision starts from the same
    // ledger the live run had. Done after the search so the found observation
    // is the pre-decision one.
    for (const attempt of mine) {
      if (!folded(attempt) || !attempt.raw) continue;
      foldOne(observation, attempt.raw);
    }
  }
}

function foldOne(observation: Observation, raw: string): void {
  let block: unknown;
  try {
    block = (JSON.parse(extractJson(raw)) as Record<string, unknown>).cognition;
  } catch {
    return;
  }
  const caps = capabilitiesFor(config.promptVersion);
  // AS EXECUTED, not as declared. The two M5.3 games ran with the folding
  // defect: their prompts rendered an EMPTY social and contest record every
  // turn, because the answers to both were parsed away. Folding them now would
  // rebuild a prompt that game never saw — and `promptKey` would say so. So the
  // rebuild reproduces what ran, detected from the trace itself rather than
  // from a flag somebody has to remember.
  const wantsContest = caps.claimContest && !ranWithFoldingDefect;
  const wantsSocial = caps.social && !ranWithFoldingDefect;
  const limits = caps.limits;
  const parsed = parseCognition(block, {
    limits,
    withSocial: wantsSocial,
    ...(wantsContest ? { withContest: true } : {}),
    ...(caps.stableCommitmentIds && !ranWithFoldingDefect ? { withCommitmentIds: true } : {}),
  });
  if (!parsed.ok) return;

  const ledger = store.for(observation);
  const claimContest = claimContestFrom(observation.publicLog);
  const registry = buildFactRegistry(
    ledger.publicFacts,
    ledger.claims,
    observation,
    wantsContest ? claimContest : undefined,
  );
  const result = applyFusedUpdate(
    ledger,
    observation,
    parsed.cognition,
    observation.publicLog.length,
    { registry, limits, ...(wantsContest ? { claimContest } : {}) },
  );
  store.put(result.ledger);
}

if (!found) {
  say(`在这局里找不到 ${seat}号 在 sequence ${targetSequence} 的决策。`);
  process.exit(1);
}

/* ── Rebuild the prompt ─────────────────────────────────────────────────── */

const target: Rebuilt = found;
const observation = target.observation;

/**
 * The repair note the live run would have appended, if this was a retry.
 *
 * Reconstructed from the PREVIOUS attempt's recorded `rejectionReason` — the
 * same string the runner handed the agent. If an earlier attempt was rejected
 * and its reason was not recorded, that is a missing value and is reported as
 * one rather than guessed at.
 */
const attemptNumber = target.attempt?.attempt ?? 1;
const previous = target.attempts.filter((a) => a.attempt < attemptNumber).at(-1);
const missing: string[] = [];
let repairNote: string | undefined;
if (attemptNumber > 1) {
  if (previous?.rejectionReason) {
    repairNote = [
      "",
      "## ⚠ 上一次的回答被裁判打回了",
      "",
      `第 ${attemptNumber - 1} 次重试。裁判给的理由是：**${previous.rejectionReason}**`,
      "",
      "请重新给出这一次任务要求的 JSON。只改需要改的地方，格式和上面的说明完全一致。",
    ].join("\n");
  } else {
    missing.push(
      `attempt ${attemptNumber} 是一次重试，但轨迹里没有上一次的 rejectionReason —— ` +
        `修复说明那一段无法逐字重建`,
    );
  }
}

const ledger = target.ledger;
const cognitive = config.cognition.enabled
  ? buildCognitivePrompt({
      observation,
      persona,
      strategy,
      ledger,
      config,
      ...(repairNote ? { repairNote } : {}),
    })
  : null;

const legacy = cognitive
  ? null
  : buildPlayerPrompt({
      observation,
      persona,
      strategy,
      speechCharLimit: config.limits.speechCharLimit,
    });

const system = cognitive ? cognitive.system : legacy!.system;
const user = cognitive
  ? cognitive.user
  : repairNote
    ? `${legacy!.user}\n${repairNote}`
    : legacy!.user;
const taskId = cognitive ? cognitive.taskId : legacy!.taskId;

const request: ModelRequest = {
  model: config.model.id,
  reasoningEffort: config.model.reasoningEffort,
  system,
  user,
  maxOutputTokens: manifest.maxOutputTokens,
  format: cognitive
    ? { name: cognitive.schemaName, schema: cognitive.jsonSchema, strict: true }
    : {
        name: schemaNameFor(legacy!.schema),
        schema: jsonSchemaFor(legacy!.schema),
        strict: true,
      },
  params: config.model.params,
};

/* ── Verify ─────────────────────────────────────────────────────────────── */

interface Check {
  readonly field: string;
  readonly recorded: string;
  readonly rebuilt: string;
  readonly match: boolean;
}

const recorded = target.attempt;
const checks: Check[] = [
  check("promptKey", recorded?.promptKey ?? "(未记录)", requestKey(request)),
  check("systemChars", String(recorded?.systemChars ?? "(未记录)"), String([...system].length)),
  check("userChars", String(recorded?.userChars ?? "(未记录)"), String([...user].length)),
  check(
    "totalInputChars",
    String(recorded?.totalInputChars ?? "(未记录)"),
    String([...system].length + [...user].length),
  ),
  check("taskId", recorded?.taskId ?? "(未记录)", taskId),
  check(
    "publicEventCount",
    String(recorded?.publicEventCount ?? "(未记录)"),
    String(observation.publicLog.length),
  ),
  check("promptVersion", manifest.promptVersion, cognitive?.promptVersion ?? "prompt-0.2.0"),
  check("persona", seatEntry.persona ?? "(未记录)", persona.id),
  check("role", seatEntry.role, observation.role),
  check(
    "strategyFingerprint",
    manifest.strategyFingerprint,
    strategyFingerprint(strategy),
  ),
];

function check(field: string, recordedValue: string, rebuilt: string): Check {
  return { field, recorded: recordedValue, rebuilt, match: recordedValue === rebuilt };
}

const exact = checks.every((c) => c.match) && missing.length === 0;

/* ── Layer classification ───────────────────────────────────────────────── */

/**
 * What kind of information each layer carries.
 *
 * Assigned from the layer's ORIGIN, not from reading its text: the role layer
 * is role-private because `renderRoleLayer(role)` takes a role, the private
 * facts layer is seat-private because `renderOwnPrivateFacts(observation)`
 * reads `knowledge` and `ladyResults`. A classification derived from the text
 * would be a judgement; this one is derivable from the call graph.
 */
type LayerClass =
  | "public"
  | "seat-private"
  | "role-private"
  | "model-owned-private-cognition"
  | "output-instructions";

const LAYER_CLASS: Readonly<Record<string, LayerClass>> = {
  共同规则: "public",
  思考流程: "public",
  说话风格: "public",
  身份与合法信息类型: "role-private",
  硬事实与挂车约束: "public",
  身份声称与派权争夺: "public",
  只有你知道的硬信息: "seat-private",
  你自己的推理记录: "model-owned-private-cognition",
  策略档: "role-private",
  最近的发言与本次任务: "public",
  输出格式: "output-instructions",
  你实际看到的东西: "seat-private",
  位置与公开局面: "public",
  本次任务与输出格式: "output-instructions",
};

/**
 * The pack's own section sizes, which the live run recorded per request.
 *
 * This is what turns "the rebuild is 484 characters longer" into "the
 * cognition section is 484 characters longer" without a bisect. The trace's
 * `cognition-telemetry` carries the same six numbers for the request that was
 * actually sent, so the two are directly comparable.
 */
const packSections = cognitive
  ? {
      factTables: cognitive.pack.factTables.length,
      ownPrivateFacts: cognitive.pack.ownPrivateFacts.length,
      claimContest: cognitive.pack.claimContest.length,
      cognition: cognitive.pack.cognition.length,
      currentCycle: cognitive.pack.currentCycle.length,
      olderArguments: cognitive.pack.olderArguments.length,
    }
  : null;

const layers = (cognitive?.layers ?? legacy!.layers).map((l) => ({
  index: l.index,
  title: l.title,
  classification: LAYER_CLASS[l.title] ?? "public",
  chars: [...l.text].length,
  message: l.index <= (cognitive ? 4 : 3) ? "system" : "user",
}));

/* ── Which sentences let the pair out ───────────────────────────────────── */

/**
 * Prompt lines that pushed toward, or failed to stop, a pair disclosure.
 *
 * Matched literally against the rebuilt text. Each entry names the file the
 * sentence lives in, so a reader can go and check it rather than trusting the
 * list — and the `verdict` says whether it ENCOURAGED the disclosure or merely
 * failed to prevent it, because those need different fixes.
 */
const IMPLICATED: readonly {
  readonly needle: string;
  readonly source: string;
  readonly verdict: "encouraged" | "failed-to-prevent";
  readonly note: string;
}[] = [
  {
    needle: "把候选对变成公开的组织依据",
    source: "prompts/strategies.ts · ecc.percival-claim-tradeoff",
    verdict: "encouraged",
    note: "把「公开候选对」直接写成跳派换到的好处之一，而且这一条带 obligation:true（必须看到）",
  },
  {
    needle: "带上可执行的东西：候选对怎么处理",
    source: "prompts/strategies.ts · ecc.percival-claim-must-be-actionable",
    verdict: "encouraged",
    note: "要求跳派时说明「候选对怎么处理」，在公开发言的语境里几乎只能靠说出那一对来满足",
  },
  {
    needle: "打他的候选对故事",
    source: "prompts/strategies.ts · ecc.percival-fight-the-rival",
    verdict: "encouraged",
    note: "打对手的候选对故事，最自然的下一步就是把自己的那一对拿出来对比",
  },
  {
    needle: "反对得越明确、越等于自报身份并点出候选对",
    source: "prompts/strategies.ts · ec.percival-pair-same-team",
    verdict: "failed-to-prevent",
    note: "把「点出候选对」写成明确反对的自然后果，而不是一个可以单独避免的动作",
  },
  {
    needle: "沉默地投反对既救不了这一轮、也不会有人接住",
    source: "prompts/strategies.ts · es.percival-pair-same-team-crosses-a-line",
    verdict: "encouraged",
    note: "把沉默反对说成无效，把说出那条只有候选对支持的推论说成唯一有效的选择",
  },
  {
    needle: "不要在没有明确回报的情况下透露你觉得哪一个更像梅林",
    source: "prompts/strategies.ts · ec.percival-do-not-rank-the-pair-publicly",
    verdict: "failed-to-prevent",
    note: "唯一一条保护性条目，但它是条件性的（「没有明确回报」），而且只管排序不管报出那一对",
  },
  {
    needle: "candidatePairStory",
    source: "cognition/build-cognitive.ts · COGNITION_INSTRUCTION_V3",
    verdict: "failed-to-prevent",
    note: "要求填一个「打算在公开场合讲的候选对说法」，没有区分真派（说了就是泄露）和别人（编的）",
  },
  {
    needle: "公开发言里只放你真正想在牌桌上说的话，认知内容一个字都不要写进去",
    source: "cognition/build-cognitive.ts · COGNITION_INSTRUCTION_V2",
    verdict: "failed-to-prevent",
    note: "只禁止把「认知内容」抄进发言，没有禁止把私有事实作为公开理由说出来 —— 而那一对是事实不是认知",
  },
  {
    needle: "informationToConceal",
    source: "cognition/build-cognitive.ts · COGNITION_INSTRUCTION_V3",
    verdict: "failed-to-prevent",
    note: "让模型自己声明「这一步绝对不能漏出去的东西」。M5.2 实盘里 8号 每一步都填对了，然后照样说了出去",
  },
];

const fullText = `${system}\n${user}`;
const implicated = IMPLICATED.filter((i) => fullText.includes(i.needle));

/* ── Write ──────────────────────────────────────────────────────────────── */

const WARNING = [
  "> # ⚠ containsPrivateInformation: true",
  ">",
  "> **这份文件是重建出来的私有提示。** 它包含发牌相关的那一层：",
  `> ${seat}号 的真实身份、规则私下给它的东西、它自己验到的结果、以及它完整的推理记录。`,
  ">",
  "> **不要放进任何公开产物、不要交给任何还在这局里的智能体、不要用它做盲评测。**",
  "> 读过它的人再去评价这一局，等于看过答案再做题。",
].join("\n");

mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, "system-prompt.md"),
  [
    WARNING,
    "",
    `# system 消息 —— ${gameId} · ${seat}号 · sequence ${targetSequence}`,
    "",
    `重建是否逐位一致：**${exact ? "是" : "否（见 provenance-report.md）"}**`,
    "",
    "```text",
    system,
    "```",
    "",
  ].join("\n"),
  "utf8",
);

writeFileSync(
  join(outDir, "user-prompt.md"),
  [
    WARNING,
    "",
    `# user 消息 —— ${gameId} · ${seat}号 · sequence ${targetSequence}`,
    "",
    `重建是否逐位一致：**${exact ? "是" : "否（见 provenance-report.md）"}**`,
    "",
    "```text",
    user,
    "```",
    "",
  ].join("\n"),
  "utf8",
);

writeFileSync(
  join(outDir, "layer-index.json"),
  `${JSON.stringify(
    {
      containsPrivateInformation: true,
      warning:
        "重建出来的私有提示的分层索引。字符数本身不含内容，但它和另外两个文件是一套的。",
      gameId,
      seat,
      sequence: targetSequence,
      taskId,
      promptVersion: cognitive?.promptVersion ?? "prompt-0.2.0",
      attempt: attemptNumber,
      exactReconstruction: exact,
      packSections,
      layers,
      classificationLegend: {
        public: "牌桌上任何人都有的东西",
        "seat-private": "只有这个座位有的硬信息（身份值、候选对、视野、验人结果）",
        "role-private": "由身份决定、但不含具体值的文本（身份说明、按身份过滤的策略条目）",
        "model-owned-private-cognition": "模型自己写进去的推理记录",
        "output-instructions": "输出格式与 schema",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const report = [
  WARNING,
  "",
  `# 重建溯源报告 —— ${gameId} · ${seat}号 · sequence ${targetSequence}`,
  "",
  `- 任务：\`${taskId}\`　第 ${attemptNumber} 次尝试`,
  `- 提示版本：\`${manifest.promptVersion}\`　策略档：\`${strategy.id}\`　persona：\`${persona.id}\``,
  `- 这一步之前公开日志有 ${observation.publicLog.length} 条事件`,
  "",
  "## 一、逐项校验",
  "",
  "| 字段 | 轨迹记录的 | 重建出来的 | 一致 |",
  "|---|---|---|---|",
  ...checks.map(
    (c) =>
      `| \`${c.field}\` | ${short(c.recorded)} | ${short(c.rebuilt)} | ${c.match ? "✅" : "❌"} |`,
  ),
  "",
  exact
    ? "**结论：逐位一致。** `promptKey` 是对 system + user + 模型 + 强度 + schema 一起做的哈希，" +
      "两边相同意味着重建出来的这两条消息和当时发出去的**一个字节都不差**。"
    : "**结论：不是逐位一致。** 下面列出对不上的地方；本工具不会为了让它对上而编造任何值。",
  "",
  ...(exact
    ? []
    : [
        "### 对不上的字段",
        "",
        ...checks.filter((c) => !c.match).map((c) => `- \`${c.field}\`：记录 ${short(c.recorded)}，重建 ${short(c.rebuilt)}`),
        "",
      ]),
  ...(missing.length > 0
    ? ["### 轨迹里缺失的值（不编造）", "", ...missing.map((m) => `- ${m}`), ""]
    : []),
  "## 二、分层",
  "",
  "| # | 层 | 消息 | 信息类别 | 字符 |",
  "|---|---|---|---|---|",
  ...layers.map(
    (l) => `| ${l.index} | ${l.title} | ${l.message} | ${l.classification} | ${l.chars} |`,
  ),
  "",
  `座位私有层合计 ${layers.filter((l) => l.classification === "seat-private").reduce((n, l) => n + l.chars, 0)} 字符，` +
    `模型自有认知层 ${layers.filter((l) => l.classification === "model-owned-private-cognition").reduce((n, l) => n + l.chars, 0)} 字符。`,
  "",
  "## 三、这份提示里哪些句子促成了泄露",
  "",
  implicated.length === 0
    ? "（这份提示里没有命中任何一条已知的危险措辞。）"
    : [
        "| 出处 | 判定 | 原文片段 | 说明 |",
        "|---|---|---|---|",
        ...implicated.map(
          (i) =>
            `| ${i.source} | ${i.verdict === "encouraged" ? "**促成**" : "未能阻止"} | 「${i.needle}」 | ${i.note} |`,
        ),
      ].join("\n"),
  "",
  "## 四、为未来的精确重建补的东西",
  "",
  "这一次能逐位重建，靠的是轨迹里已经有 `promptKey` / `systemChars` / `userChars`，",
  "以及每一次尝试的原始回答 `raw`（认知块要靠它重放才能重建当时的账本）。",
  "",
  "**仍然缺的**：轨迹不存提示原文（这是对的 —— 那会让私有文件体积翻几倍，",
  "而且把发牌那一层复制一份），也不存**逐层摘要**。所以「哪一层变了」目前只能靠重建后再比。",
  "M5.3 起，`layer-index.json` 里的逐层字符数和分类由这个工具产生并留档，",
  "重跑同一条命令得到同样的索引，就是「那一层没有变过」的证据。",
  "",
].join("\n");

writeFileSync(join(outDir, "provenance-report.md"), `${report}\n`, "utf8");

function short(value: string): string {
  return value.length > 40 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
}

if (process.argv.includes("--audit-seat")) {
  say("");
  say(`${seat}号 每一次决策的重建核对（第一次尝试，无修复说明）：`);
  for (const a of audit) {
    const ok = a.recordedUserChars === a.rebuiltUserChars;
    say(
      `  #${String(a.decision).padStart(2)} ${a.taskId.padEnd(24)} ` +
        `事件 ${a.recordedEvents}/${a.rebuiltEvents}　user ${a.recordedUserChars} vs ${a.rebuiltUserChars} ` +
        `(${a.rebuiltUserChars - a.recordedUserChars >= 0 ? "+" : ""}${a.rebuiltUserChars - a.recordedUserChars})　` +
        `认知层 ${a.rebuiltCognitionChars}　${ok ? "✅" : "❌"}`,
    );
  }
  say("");
}

say(`写好了：${outDir}`);
say(`  逐位一致：${exact ? "是" : "否"}`);
for (const c of checks) {
  if (!c.match) say(`  ✗ ${c.field}：记录 ${short(c.recorded)} ≠ 重建 ${short(c.rebuilt)}`);
}
if (packSections) say(`  pack 分节：${JSON.stringify(packSections)}`);
say(`  命中的危险措辞：${implicated.length} 条`);
say("");
say("⚠ 这四个文件都是私有产物，含发牌相关的层。不要分发。");
