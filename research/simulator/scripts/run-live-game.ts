/**
 * The live-game CLI. DISABLED BY DEFAULT, and not yet executed.
 *
 *     npx vite-node -c research/simulator/vitest.config.ts \
 *       research/simulator/scripts/run-live-game.ts -- --dry-run
 *
 *     ... --live --yes --seed 1 --persona-mode heterogeneous-rotated
 *
 * Without `--live` it performs every preflight check, prints the projected
 * maximum spend, and stops without making a request or creating a directory.
 * With `--live` but without `--yes` it prints the same and asks — a run that
 * can spend tens of dollars should require somebody to have read the number.
 *
 * THIS SHELL DOES FOUR THINGS and nothing else: parse arguments, read ONE
 * environment variable, print, and confirm. Every decision that could cost
 * money lives in `run/live-game.ts`, where it is unit-tested offline with an
 * injected `fetch` that is never called.
 *
 * SECRETS. `OPENAI_API_KEY_DEV` is read from `.env.local` here and handed to
 * the client as a string. It is never printed, never written to an artifact,
 * and no other variable in that file is parsed. `.env.local` being git-ignored
 * is checked before the key is read.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isProfileName,
  loadConfig,
  loadProfile,
  resolveProfileForResume,
  resolveStage,
  PROFILE_NAMES,
} from "../config/load";
import { capabilitiesFor } from "../prompts/capabilities";
import { BatchAccount } from "../model/client";
import { openAiResponsesClient, type FetchLike } from "../model/openai-responses";
import { PERSONA_MODES, type PersonaMode } from "../prompts/personas";
import { CATALOG_IDS, type CatalogStrategyId } from "../prompts/strategies";
import { preflight, PreflightError, runLiveGame } from "../run/live-game";
import { parseCheckpoint, CheckpointError, type PrivateCheckpoint } from "../run/checkpoint";
import { reportCosts } from "../run/cost-report";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const ENV_PATH = join(REPO, ".env.local");
const ENV_VAR = "OPENAI_API_KEY_DEV";

const say = (...parts: unknown[]) => console.log(...parts);
const die = (message: string, code = 1): never => {
  console.error(`✗ ${message}`);
  process.exit(code);
};

/* ── Arguments ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
function value(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const live = has("--live");
const resumePath = value("--resume");
const dryRun = has("--dry-run") || !live;
const preApproved = has("--yes");
const seed = Number(value("--seed") ?? 1);
const gameId = value("--game-id");
const outDir = value("--out") ?? join(HERE, "..", "out");
const personaMode = (value("--persona-mode") ?? undefined) as PersonaMode | undefined;
const strategyProfile = (value("--strategy") ?? undefined) as CatalogStrategyId | undefined;
const customStrategyText = value("--custom-strategy");
// One game, concurrency one. A batch runner is a later milestone; the flag
// exists so a wrong assumption fails loudly instead of silently fanning out.
const games = Number(value("--games") ?? 1);
const concurrency = Number(value("--concurrency") ?? 1);

if (personaMode && !PERSONA_MODES.includes(personaMode)) {
  die(`--persona-mode 只能是 ${PERSONA_MODES.join(" 或 ")}`);
}
if (strategyProfile && !CATALOG_IDS.includes(strategyProfile)) {
  die(`--strategy 只能是 ${CATALOG_IDS.join(" 或 ")}（custom 用 --custom-strategy）`);
}
if (games !== 1 || concurrency !== 1) {
  die("这个里程碑只支持 --games 1 --concurrency 1。批量运行还没有做。");
}

/* ── Resume ────────────────────────────────────────────────────────────── */

let resumeFrom: PrivateCheckpoint | undefined;
if (resumePath) {
  if (!existsSync(resumePath)) die(`找不到检查点 ${resumePath}`, 2);
  try {
    resumeFrom = parseCheckpoint(readFileSync(resumePath, "utf8"));
  } catch (error) {
    // A checkpoint that will not parse is not a checkpoint. Refuse here rather
    // than discovering it after the confirmation prompt.
    if (error instanceof CheckpointError) die(`${error.code}: ${error.message}`, 2);
    throw error;
  }
}

/* ── Preflight ─────────────────────────────────────────────────────────── */

/**
 * Named profile, or the legacy default.
 *
 * On a FRESH run, no `--profile` means `default.json` and therefore the
 * seven-layer `prompt-0.2.0` path — every command that worked before this flag
 * existed still resolves to exactly what it resolved to then.
 *
 * ON A RESUME IT IS DIFFERENT, and this is the defect the M5.2 pilot exposed.
 * A resume without `--profile` used to fall silently back to `default.json`;
 * that game survived only because its checkpoint was cognitive and the version
 * gate refused it before a request left. A `prompt-0.2.0` checkpoint resumed
 * the same way would have MATCHED, and half a game would have continued under
 * an arm nobody chose. So a resume now either derives the profile from the
 * checkpoint or refuses. It never guesses.
 */
const profileArg = value("--profile");
if (profileArg !== undefined && !isProfileName(profileArg)) {
  die(`--profile 只能是 ${PROFILE_NAMES.join(" 或 ")}`);
}
// `die` never returns, but its signature does not say so where the narrowing
// happens, so the name is re-derived here rather than asserted away.
const flagProfile = profileArg !== undefined && isProfileName(profileArg) ? profileArg : null;

const resolved = resolveProfileForResume({
  flag: flagProfile,
  checkpoint: resumeFrom ? { profile: resumeFrom.profile ?? null } : null,
  allowDefault: has("--profile-default"),
});
if (!resolved.ok) die(resolved.error, 2);
// `die` never returns, but its signature does not narrow the union here.
const profileName = resolved.ok ? resolved.profile : null;
const config = profileName ? loadProfile(profileName) : loadConfig();
if (resumeFrom && resolved.ok && resolved.derived) {
  say(`（--profile 没给；从检查点里读到 profile ${profileName}，按它续跑）`);
}

let ready;
try {
  ready = preflight({
    seed: resumeFrom ? resumeFrom.seed : seed,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(profileName ? { profile: profileName } : {}),
    ...(gameId ? { gameId } : {}),
    ...(personaMode ? { personaMode } : {}),
    ...(strategyProfile ? { strategyProfile } : {}),
    ...(customStrategyText ? { customStrategyText } : {}),
    config,
    outDir,
    // Not used during preflight; the real one is built only if we proceed.
    client: { name: "unbuilt", complete: async () => die("client not built") },
  });
} catch (error) {
  if (error instanceof PreflightError) die(`${error.code}: ${error.message}`, 2);
  throw error;
}

say("");
say("=== 十人局 · 真实对局 ===");
say(`模式         ${live ? "LIVE（会花钱）" : "dry-run（不发任何请求）"}${resumeFrom ? " · 续跑" : ""}`);
say(`配置         ${profileName ? `profile ${profileName}` : "default.json（旧路径）"}`);
say(`提示版本     ${config.promptVersion}`);
say(
  `认知层       ${
    config.cognition.enabled
      ? `开（${config.cognition.mode}，最多 ${config.cognition.maxCognitionRepairs} 次认知修复）`
      : "关"
  }`,
);
say(`模型         ${config.model.id}   reasoning effort=${config.model.reasoningEffort}`);
say(`输出上限     ${ready.projection.maxOutputTokens.toLocaleString()} token/次（含 reasoning，来自 limits.maxOutputTokens）`);
// 0.5.0 splits a speaking turn into two requests with independently
// configurable models. A banner that showed only the top-level model would
// hide half of what the operator is authorising.
if (capabilitiesFor(config.promptVersion).twoStageSpeech) {
  const planner = resolveStage(config, "planner");
  const spokesperson = resolveStage(config, "spokesperson");
  say(
    `私有规划者   ${planner.model} / effort=${planner.reasoningEffort} / ` +
      `${planner.maxOutputTokens.toLocaleString()} token`,
  );
  say(
    `公开发言者   ${spokesperson.model} / effort=${spokesperson.reasoningEffort} / ` +
      `${spokesperson.maxOutputTokens.toLocaleString()} token　` +
      `（拿不到身份、候选对、视野、名单、验人结果、推理记录）`,
  );
  say(`发言重发上限 ${config.stages.maxPublicMessageRepairs} 次，之后 disclosure_invalid 停下`);
}
say(`价目         输入 $${config.pricing.uncachedInputUsdPerMTok}/M（缓存 $${config.pricing.cachedInputUsdPerMTok}/M），输出 $${config.pricing.outputUsdPerMTok}/M`);
say(`             来源 ${config.pricing.sourceUrl}（${config.pricing.verifiedOn}，${config.pricing.pricingVersion}）`);
say(`seed         ${ready.seed}`);
say(`game id      ${ready.gameId}`);
say(`persona 模式 ${ready.personaMode}`);
say(`策略档       ${ready.strategy.id}（${ready.strategy.status}）`);
say(`产物         公开 ${ready.publicPath}`);
say(`             私有 ${ready.privatePath}`);
say("");
if (resumeFrom) {
  say("");
  say("--- 续跑 ---");
  say(`检查点       ${resumePath}`);
  say(`暂停原因     ${resumeFrom.pauseReason}`);
  say(`已应用动作   ${resumeFrom.actions.length} 个，续到 sequence ${resumeFrom.sequence}`);
  say(`待办         ${String(resumeFrom.pendingSeat)}号 · ${String(resumeFrom.pendingTask)}`);
  say(`本局已花费   $${ready.projection.alreadySpentUsd.toFixed(4)}（计入同一个 $${config.budget.hardCostLimitPerGameUsd} 单局上限）`);
  say(`本批已花费   $${ready.projection.alreadySpentBatchUsd.toFixed(4)}（计入同一个 $${config.budget.hardBatchCostLimitUsd} 批量上限）`);
  say("已经定下来的动作不会再问模型一次。");
  if (resumeFrom.pauseReason === "paused_cost_limit") {
    // Resuming does not reset the budget — it restores it. A game that hit the
    // ceiling will hit it again immediately unless a human raises the limit.
    say("");
    say("⚠ 这份检查点是因为撞到预算上限才停的。续跑不会重置预算，只会把它恢复回来，");
    say(`  所以它会立刻再次停在同一道闸上 —— 除非你先明确提高 hardCostLimitPerGameUsd。`);
  }
}

say("");
say("--- 预算 ---");
say(`单次请求最坏  $${ready.projection.perRequestUsd.toFixed(4)}（输入全按未缓存计价，输出按上限计）`);
say(`调用上限      ${ready.projection.maxLiveCalls} 次/局`);
say(`理论最大      $${ready.projection.maxGameUsd.toFixed(2)}`);
say(`实际会先撞    $${ready.projection.effectiveCeilingUsd.toFixed(2)}（单局硬上限 $${config.budget.hardCostLimitPerGameUsd}，提醒线 $${config.budget.costWarningPerGameUsd}）`);
say(`批量硬上限    $${config.budget.hardBatchCostLimitUsd}`);
say("");
say("撞到任何一道闸都会：存可续跑的检查点、标注精确原因、停下。");
say("不截断历史、不摘要、不换模型、不退回脚本策略。");

if (!existsSync(ENV_PATH)) die(`找不到 ${ENV_PATH}`);
try {
  execFileSync("git", ["check-ignore", "-q", ".env.local"], { cwd: REPO, stdio: "ignore" });
  say("");
  say("✓ .env.local 被 git 忽略");
} catch {
  die(".env.local 没有被 git 忽略 —— 在解决这个之前不发任何请求。");
}

/** Reads exactly one variable. Nothing else in that file is parsed or kept. */
function readKeyOnly(): string | null {
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${ENV_VAR}\\s*=\\s*(.*)$`).exec(line);
    if (!match) continue;
    const found = match[1].replace(/^["']|["']$/g, "").trim();
    if (found.length > 0) return found;
  }
  return null;
}

// `die` calls `process.exit`, but narrowing a `const` arrow's `never` return
// is not something the compiler will do for us, so the fallback is explicit.
const apiKey =
  readKeyOnly() ?? die(`${ENV_VAR} 不在 .env.local 里，或者是空的。干净退出。`, 3);
say(`✓ ${ENV_VAR} 已读取（长度与内容都不会被打印）`);

if (dryRun) {
  say("");
  say("dry-run 到此为止：所有前置检查都过了，没有发出请求，也没有创建任何目录。");
  say("要真的跑：加 --live（然后还会再问你一次，除非加 --yes）。");
  process.exit(0);
}

/* ── Confirmation ──────────────────────────────────────────────────────── */

if (!preApproved) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n${resumeFrom ? "续跑之后" : "这一局"}最多可能花到 ` +
      `$${ready.projection.effectiveCeilingUsd.toFixed(2)}` +
      `${resumeFrom ? `（其中已花 $${ready.projection.alreadySpentUsd.toFixed(4)}）` : ""}。` +
      `继续？输入 yes 确认：`,
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    say("没有确认，退出。什么都没有创建。");
    process.exit(0);
  }
}

/* ── Go ────────────────────────────────────────────────────────────────── */

const client = openAiResponsesClient({
  apiKey,
  fetch: globalThis.fetch as unknown as FetchLike,
});

const result = await runLiveGame(
  {
    seed: ready.seed,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(profileName ? { profile: profileName } : {}),
    ...(gameId ? { gameId } : {}),
    ...(personaMode ? { personaMode } : {}),
    ...(strategyProfile ? { strategyProfile } : {}),
    ...(customStrategyText ? { customStrategyText } : {}),
    config,
    outDir,
    client,
    /*
     * On a resume, do NOT hand in a fresh empty account.
     *
     * Passing one used to override `runLiveGame`'s restoration and silently
     * reset the batch total to zero, which made the $100 ceiling escapable by
     * pausing. Letting `runLiveGame` build it means the checkpoint's batch
     * spend is what the ceiling sees.
     */
    ...(resumeFrom ? {} : { batch: new BatchAccount() }),
    onWarning: (message) => say(`⚠ ${message}`),
  },
  ready,
);

say("");
say("=== 结果 ===");
say(`状态         ${result.status}`);
say(`结局         ${result.outcome}`);
say(reportCosts({ ...result, maxOutputTokens: result.maxOutputTokens }, config));
// Only paths that actually exist are printed. A run that stopped before
// anything was applied has no partial artifact, and naming one would send
// somebody looking for a file that is not there.
if (result.publicPath) say(`公开回放     ${result.publicPath}`);
if (result.privatePath) say(`私有轨迹     ${result.privatePath}（含发牌与种子，不要分发）`);
if (result.checkpointPath) {
  say(`检查点       ${result.checkpointPath}`);
  // The profile is named explicitly, because a resume without it is now
  // REFUSED rather than silently falling back to `default.json`.
  say(
    `续跑         ... -- --live${profileName ? ` --profile ${profileName}` : ""}` +
      ` --resume ${result.checkpointPath}`,
  );
} else if (result.status !== "completed") {
  say("这次中断不可续跑（永久性错误），没有写检查点。");
}

process.exit(result.status === "completed" ? 0 : 4);
