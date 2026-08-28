/**
 * Offline verification of a finished live game.
 *
 * Reads the two artifacts off disk and re-derives everything from them:
 * replays the recorded actions through the deterministic referee, checks the
 * invariants against the rebuilt state, scans the public file for anything
 * private, and confirms the private file is labelled as private.
 *
 * Makes no network request and constructs no model client. The referee is
 * pure and the artifacts are the only input, which is the point — a
 * verification that had to ask the provider anything would be verifying the
 * provider, not the run.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/verify-artifacts.ts -- <gameId>
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import type { PublicEvent } from "../core/events";
import { isPrivateType } from "../core/events";
import { checkInvariants } from "../fixtures/invariants";
import { FORBIDDEN_KEYS } from "../fixtures/leak-scan";
import type { ModelAttempt } from "../model/attempt";
import { addUsage, emptyUsage, estimateCostUsd, type TokenUsage } from "../model/pricing";
import {
  parseJsonl,
  type PrivateTraceLine,
  type PublicReplayLine,
  type RecordedAction,
} from "../run/artifacts";
import { summariseCosts } from "../run/cost-report";
import { fingerprintDigest, replayGame, replayPrefix } from "../run/runner";

const say = (...parts: unknown[]) => console.log(...parts);
const OUT = join(process.cwd(), "research", "simulator", "out");

const gameId = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!gameId) {
  say("用法: ... verify-artifacts.ts -- <gameId>");
  process.exit(2);
}

const publicPath = join(OUT, "public", `${gameId}.public-replay.jsonl`);
const privatePath = join(OUT, "private", `${gameId}.private-trace.jsonl`);

const problems: string[] = [];
const fail = (message: string) => problems.push(message);

/* ── 1. Both files exist ───────────────────────────────────────────────── */

say("=== 产物 ===");
for (const [label, path] of [
  ["公开回放", publicPath],
  ["私有轨迹", privatePath],
] as const) {
  if (!existsSync(path)) {
    fail(`${label}不存在: ${path}`);
    say(`✗ ${label}  缺失`);
  } else {
    say(`✓ ${label}  ${path}  ${statSync(path).size} bytes`);
  }
}
if (problems.length > 0) {
  say("\n产物缺失，无法继续验证。");
  process.exit(1);
}

/* ── 2. Parse ──────────────────────────────────────────────────────────── */

const publicText = readFileSync(publicPath, "utf8");
const privateText = readFileSync(privatePath, "utf8");
const publicLines = parseJsonl<PublicReplayLine>(publicText);
const privateLines = parseJsonl<PrivateTraceLine>(privateText);

type AnyLine = { readonly t: string; readonly data: unknown };
const pick = <T,>(lines: readonly AnyLine[], t: string): T[] =>
  lines.filter((line) => line.t === t).map((line) => line.data as T);

const pub = publicLines as unknown as AnyLine[];
const priv = privateLines as unknown as AnyLine[];

const publicMeta = pick<Record<string, unknown>>(pub, "public-metadata")[0];
const publicEvents = pick<PublicEvent>(pub, "event");
const publicOutcome = pick<Record<string, unknown>>(pub, "outcome")[0] ?? null;

const header = pick<Record<string, unknown>>(priv, "private-header")[0];
const manifest = pick<Record<string, unknown>>(priv, "private-manifest")[0];
const actions = pick<RecordedAction>(priv, "action");
const attempts = pick<ModelAttempt>(priv, "model-call");
const privateEvents = pick<Record<string, unknown>>(priv, "private-event");
// The trace serialises no `lady-result` line: the truth lives in the private
// EVENT stream, which is where the referee wrote it.
const ladyTruth = privateEvents.filter((e) => e.type === "lady_result");

/* ── 3. Deterministic replay ───────────────────────────────────────────── */


say("\n=== 确定性回放 ===");
const seed = manifest?.seed as number;
const config = loadConfig();
const gameId_ = String(publicMeta?.gameId ?? gameId);
const runId = String(publicMeta?.runId ?? "live");

// A run that stopped mid-game has no outcome, and `replayGame` refuses one on
// purpose — it verifies FINISHED games. `replayPrefix` is the partial-run
// counterpart: same referee, same actions, stops wherever the log stops.
const finished = publicOutcome !== null;
say(finished ? "这是一局打完的对局，用 replayGame 验证" : "这局没打完，用 replayPrefix 验证已定动作前缀");

let replayed: ReturnType<typeof replayGame> | null = null;
let partial: ReturnType<typeof replayPrefix> | null = null;
try {
  if (finished) {
    replayed = replayGame(seed, actions, config);
    say(`✓ ${actions.length} 个动作全部重放成功`);
    say(`  结局 ${replayed.outcome.winner} / ${replayed.outcome.reason}`);
    say(`  指纹 ${fingerprintDigest(replayed.state)}`);
  } else {
    partial = replayPrefix(seed, actions, { config, gameId: gameId_, runId });
    const pending = partial.pending;
    say(`✓ ${actions.length} 个已定动作全部重放成功`);
    say(`  停在 sequence ${partial.sequence}，待办 ${pending ? `${pending.seat}号 · ${pending.kind}` : "(无)"}`);
    say(`  指纹 ${fingerprintDigest(partial)}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`重放失败: ${message}`);
  say(`✗ 重放失败: ${message}`);
}

const rebuiltState = replayed?.state ?? partial;
if (rebuiltState) {
  const rebuilt = rebuiltState.log;
  if (rebuilt.length !== publicEvents.length) {
    fail(`重放产生 ${rebuilt.length} 个公开事件，文件里有 ${publicEvents.length} 个`);
  } else {
    const mismatch = rebuilt.findIndex(
      (event, i) => JSON.stringify(event) !== JSON.stringify(publicEvents[i]),
    );
    if (mismatch >= 0) fail(`第 ${mismatch} 个公开事件与公开回放不一致`);
    else say(`✓ 重放的 ${rebuilt.length} 个公开事件与公开回放逐字节一致`);
  }
  if (replayed && publicOutcome && JSON.stringify(replayed.outcome) !== JSON.stringify(publicOutcome)) {
    fail("重放结局与公开回放记录的结局不一致");
  }
}

/* ── 4. Invariants ─────────────────────────────────────────────────────── */

say("\n=== 不变量 ===");
if (replayed) {
  const violations = checkInvariants(replayed.state, replayed.actions);
  if (violations.length === 0) say("✓ 全部通过，0 处违反");
  for (const violation of violations) {
    fail(`不变量: ${violation}`);
    say(`✗ ${violation}`);
  }
} else if (partial) {
  // `checkInvariants` asks a finished game's questions ("exactly one game_end",
  // "the final reveal matches the deal"). None are answerable here, and running
  // it anyway would report a dozen violations that all only mean "this game did
  // not finish". So check the subset that IS meaningful mid-game.
  say("这局没打完，只跑与「已打完」无关的那部分：");

  const sequences = [...partial.log, ...partial.privateLog].map((e) => e.sequence);
  if (new Set(sequences).size !== sequences.length) fail("有 sequence 被复用");
  else say(`✓ ${sequences.length} 个事件的 sequence 无重复`);

  const stateLeak = partial.log.filter((e) => isPrivateType(e.type));
  if (stateLeak.length > 0) fail(`重放出的公开日志里有 ${stateLeak.length} 个私有事件`);
  else say("✓ 重放出的公开日志无私有事件");

  if (partial.outcome !== null) fail("没打完的对局却有 outcome");
  else say("✓ 无 outcome（与 status=failed 一致）");
  if (partial.pending === null) fail("没打完的对局却没有待办请求");
  else say(`✓ 有待办请求（${partial.pending.seat}号 · ${partial.pending.kind}）`);

  const speeches = partial.log.filter((e) => e.type === "speech");
  const limit = config.limits.speechCharLimit;
  const tooLong = speeches.filter(
    (e) => [...(e as { publicMessage: string }).publicMessage].filter((c) => !/\s/.test(c)).length > limit,
  );
  if (tooLong.length > 0) fail(`${tooLong.length} 段发言超过 ${limit} 字上限`);
  else say(`✓ ${speeches.length} 段发言全部在 ${limit} 字以内`);
} else {
  say("- 跳过（重放没成功）");
}

/* ── 5. Public artifact leakage scan ───────────────────────────────────── */

say("\n=== 公开产物泄漏扫描 ===");

const keyHits: string[] = [];
const walk = (value: unknown, path: string): void => {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.includes(key)) keyHits.push(`${path}.${key}`);
      walk(child, path ? `${path}.${key}` : key);
    }
  }
};
walk(publicLines, "");
if (keyHits.length > 0) {
  for (const hit of keyHits) fail(`公开产物含禁止字段 ${hit}`);
  say(`✗ ${keyHits.length} 处禁止字段: ${keyHits.slice(0, 5).join(", ")}`);
} else {
  say(`✓ 无禁止字段（检查了 ${FORBIDDEN_KEYS.length} 个键名）`);
}

const leaked = publicEvents.filter((event) => isPrivateType(event.type));
if (leaked.length > 0) {
  fail(`公开产物含 ${leaked.length} 个私有事件`);
  say(`✗ 私有事件泄漏: ${leaked.map((e) => e.type).join(", ")}`);
} else {
  say("✓ 无私有事件类型");
}

for (const [what, present] of [
  ["seed", "seed" in (publicMeta ?? {})],
  ["raw 模型输出", publicText.includes('"raw"')],
  ["memoryPatch", publicText.includes("memoryPatch")],
  ["customStrategyText", publicText.includes("customStrategyText")],
  ["坏人密谈", publicText.includes("evil_discussion")],
  ["女神真实结果", publicText.includes("trueSide")],
  ["凭据样式串", /api[_-]?key|authorization|bearer |sk-[A-Za-z0-9]/i.test(publicText)],
] as const) {
  if (present) {
    fail(`公开产物含 ${what}`);
    say(`✗ 含 ${what}`);
  } else {
    say(`✓ 无 ${what}`);
  }
}

/* ── 6. Private artifact is labelled private ───────────────────────────── */

say("\n=== 私有产物标记 ===");
if (header?.containsPrivateInformation === true) {
  say("✓ containsPrivateInformation: true（第一行 private-header）");
} else {
  fail("私有轨迹的 containsPrivateInformation 不是 true");
  say("✗ containsPrivateInformation 缺失或不为 true");
}
if (typeof header?.warning === "string" && header.warning.length > 0) {
  say("✓ 带警告文字");
} else {
  fail("私有轨迹缺少警告文字");
}
say(`失败原因     ${header?.failureReason === null ? "(无)" : String(header?.failureReason)}`);

/* ── 7. The game, in public terms ──────────────────────────────────────── */

const of = <T extends PublicEvent["type"]>(type: T) =>
  publicEvents.filter((event) => event.type === type) as Extract<PublicEvent, { type: T }>[];

say("\n=== 对局 ===");
say(`状态         ${String(publicMeta?.status)}`);
say(`game id      ${String(publicMeta?.gameId)}`);
say(`首任队长     ${String(publicMeta?.initialLeader)}号`);
say(`行进方向     ${String(publicMeta?.playDirection)}   女神方向 ${String(publicMeta?.ladySide)}`);
say(`公开事件     ${publicEvents.length} 个，已定动作 ${actions.length} 个`);

say("\n--- 任务 ---");
for (const mission of of("mission_result")) {
  say(
    `第 ${mission.missionNumber} 轮  ${mission.result === "success" ? "成功" : "失败"}  ` +
      `公开失败票 ${mission.failCount}  上车 ${mission.team.join("/")}号`,
  );
}

const votes = of("vote");
say(
  `\n点车 ${of("proposal").length} 次，车过 ${votes.filter((v) => v.result === "passed").length} 次，` +
    `车被否 ${votes.filter((v) => v.result === "rejected").length} 次`,
);

say("\n--- 湖中女神 ---");
const announced = of("lady_announced");
if (announced.length === 0) say("（没有公开验人）");
for (const lady of announced) {
  say(`第 ${lady.missionNumber} 轮后  ${lady.holder}号 验 ${lady.target}号 → 公开宣称「${lady.announced}」`);
}

const ending = of("game_end")[0];
const assassination = of("assassination_target")[0];
say("\n--- 刺杀 ---");
if (!assassination) {
  say("（没有进入刺杀）");
} else {
  // Who was named is public; whether it hit is the game's ending reason.
  const hit = ending?.reason === "assassin_hit";
  say(`${assassination.assassin}号（刺客）指认 ${assassination.target}号 → ${hit ? "命中" : "落空"}`);
}
if (ending) say(`\n胜方 ${ending.winner}，原因 ${ending.reason}`);

/* ── 8. Cost and prompt shape ──────────────────────────────────────────── */

say("\n=== 调用与花费（由 model-call 记录重算）===");
// The trace serialises no ledger line, so rebuild one from the per-attempt
// records. Agreeing with what the CLI printed from the live ledger is itself
// part of the verification.
const usage: TokenUsage = attempts.reduce<TokenUsage>(
  (acc, a) => (a.usage ? addUsage(acc, a.usage) : acc),
  emptyUsage(),
);
const ledger = {
  calls: attempts.filter((a) => !a.cached).length,
  cached: attempts.filter((a) => a.cached).length,
  failures: attempts.filter((a) => a.outcome === "provider_error").length,
  retries: attempts.filter((a) => a.attempt > 1).length,
  usage,
  costUsd: estimateCostUsd(usage, config.pricing),
  totalLatencyMs: attempts.reduce((acc, a) => acc + a.latencyMs, 0),
};
const recordedCap = Number(publicMeta?.maxOutputTokens ?? 0);
const report = summariseCosts({
  ledger,
  attempts,
  retries: ledger.retries,
  maxOutputTokens: recordedCap || undefined,
});
say(JSON.stringify(report, null, 2));
say("");
say(`格式修复重试（invalid 后重问）  ${attempts.filter((a) => a.outcome === "invalid").length} 次`);
/*
 * "The referee refused it" used to be printed for every rejected answer, and it
 * was wrong for the M5 pilot: all five of that game's rejections were broken
 * cognition blocks, not illegal moves. The reason is recorded from M5.1 on;
 * older artifacts have no `rejectedBy`, so they are labelled as unknown rather
 * than guessed at.
 */
const refused = attempts.filter((a) => a.outcome === "valid" && !a.appliedLegalAction);
const by = (kind: string) => refused.filter((a) => a.rejectedBy === kind).length;
const unlabelled = refused.filter((a) => !a.rejectedBy).length;
say(`答案被打回（动作解析没问题）    ${refused.length} 次`);
if (refused.length > 0) {
  say(`  裁判判非法                   ${by("referee")} 次`);
  say(`  cognition 块不合法            ${by("cognition")} 次`);
  say(`  其他（动作层面）              ${by("action-format")} 次`);
  if (unlabelled > 0) {
    say(`  未记录原因                   ${unlabelled} 次（M5.1 之前的产物没有这个字段）`);
  }
}
say(`incomplete 状态                ${attempts.filter((a) => a.status === "incomplete").length} 次`);
const returned = new Set(attempts.map((a) => a.modelReturned));
say(`provider 实际返回的模型         ${[...returned].join(", ") || "(无)"}`);

/* ── 8b. The three checks this run's configuration change is about ─────── */

say("\n=== 输出预算与输入闸 ===");
if (recordedCap > 0) say(`✓ 产物记录的有效输出上限 ${recordedCap.toLocaleString()} token`);
else fail("产物里没有记录 maxOutputTokens");

const capacity = attempts.filter((a) => a.capacityAttempt > 1);
const exhausted = attempts.filter((a) => a.outcome === "output_limit");
const incomplete = attempts.filter((a) => a.status === "incomplete");
say(`撞到上限的请求  ${exhausted.length} 次`);
say(`容量重试        ${capacity.length} 次（原样重发，不带修复提示）`);
say(`incomplete 响应 ${incomplete.length} 次`);

// Every incomplete response must have gone down the capacity path, not the
// repair path: recorded as `output_limit`, never parsed, never rephrased.
for (const a of incomplete) {
  if (a.incompleteReason === "max_output_tokens" && a.outcome !== "output_limit") {
    fail(`${a.seat}号 ${a.taskId} 的 max_output_tokens 响应被当成了格式错误`);
  }
}
// At most one capacity retry per decision, and it must pair with an exhaustion.
if (capacity.length > exhausted.length) {
  fail(`容量重试 ${capacity.length} 次多于耗尽 ${exhausted.length} 次`);
}
for (const a of capacity) {
  if (a.capacityAttempt > 2) fail(`${a.seat}号 ${a.taskId} 的容量重试到了第 ${a.capacityAttempt} 次`);
}
if (incomplete.length === 0) {
  say("✓ 没有任何响应耗尽输出预算 —— 新策略这一局没有被触发到");
} else {
  say("✓ 每个 incomplete 响应都走了容量路径，且每个决策最多一次原样重发");
}

const limit = config.limits.maxStandardInputTokens;
const over = attempts.filter((a) => a.estimatedInputTokens > limit);
const overReal = attempts.filter((a) => (a.usage?.inputTokens ?? 0) > limit);
if (over.length > 0 || overReal.length > 0) {
  fail(`${over.length} 次估算 / ${overReal.length} 次实报输入超过 ${limit}`);
} else {
  const maxEst = Math.max(0, ...attempts.map((a) => a.estimatedInputTokens));
  const maxReal = Math.max(0, ...attempts.map((a) => a.usage?.inputTokens ?? 0));
  say(
    `✓ 没有请求超过 ${limit.toLocaleString()} 输入 token ` +
      `（估算最大 ${maxEst.toLocaleString()}，实报最大 ${maxReal.toLocaleString()}）`,
  );
}

/* ── 9. Verdict ────────────────────────────────────────────────────────── */

say("\n=== 结论 ===");
say(`私有事件 ${privateEvents.length} 个，其中女神真实结果 ${ladyTruth.length} 条（只在私有轨迹）`);
if (problems.length === 0) {
  say("✓ 全部验证通过");
} else {
  say(`✗ ${problems.length} 处问题:`);
  for (const problem of problems) say(`  - ${problem}`);
  process.exit(1);
}
