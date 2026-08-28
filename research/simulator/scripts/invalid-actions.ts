/**
 * Why did the referee refuse an answer the parser accepted?
 *
 * The M5 pilot recorded five attempts whose JSON parsed into a legal-looking
 * action and which the referee then rejected — and the trace does NOT say why,
 * because `live-game.ts` discarded the feedback it was handed. This script
 * recovers the reason the only way that is left: replay the game to the exact
 * decision, re-submit the recorded raw answer, and read the error.
 *
 * Offline, read-only, no client. Reads one private trace.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/invalid-actions.ts -- <gameId>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfile } from "../config/load";
import { applyAction } from "../core/referee";
import { parseAction } from "../model/structured";
import { parseJsonl, type PrivateTraceLine, type RecordedAction } from "../run/artifacts";
import { replayPrefix } from "../run/runner";

const say = (...p: unknown[]) => console.log(...p);
const gameId = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!gameId) {
  say("用法: ... invalid-actions.ts -- <gameId>");
  process.exit(2);
}

const text = readFileSync(
  join(process.cwd(), "research", "simulator", "out", "private", `${gameId}.private-trace.jsonl`),
  "utf8",
);
const lines = parseJsonl<PrivateTraceLine>(text) as unknown as { t: string; data: unknown }[];
const pick = <T,>(t: string): T[] => lines.filter((l) => l.t === t).map((l) => l.data as T);

const manifest = pick<Record<string, unknown>>("private-manifest")[0];
const actions = pick<RecordedAction>("action");
type Call = {
  seat: number;
  taskId: string;
  attempt: number;
  outcome: string;
  appliedLegalAction: boolean;
  raw: string | null;
};
const calls = pick<Call>("model-call");

const seed = Number(manifest.seed);
const config = loadProfile("m5-pilot");

say(`# 被裁判判非法的动作 —— ${gameId}`);
say("");

let applied = 0;
let found = 0;
for (const call of calls) {
  if (call.outcome === "valid" && !call.appliedLegalAction) {
    found += 1;
    // The referee left the state untouched when it refused, so the prefix is
    // exactly the actions that DID land before this decision.
    const state = replayPrefix(seed, actions.slice(0, applied), {
      config,
      gameId,
      runId: "live",
    });
    if (!state.pending) throw new Error("replay ended before the rejected decision");
    const parsed = parseAction(call.raw ?? "", state.pending);
    say(`## ${call.seat}号 · ${call.taskId} · 第 ${applied} 个动作处`);
    say("");
    if (!parsed.ok) {
      say(`解析就失败了：${parsed.error}`);
      say("");
      continue;
    }
    try {
      applyAction(state, state.pending.seat, parsed.action);
      say("⚠ 重放时**没有**被拒 —— 说明拒绝依赖了当时的状态，重放没能复现。");
    } catch (error) {
      const e = error as { code?: string; message?: string };
      say(`- 裁判代码：\`${e.code ?? "(无)"}\``);
      say(`- 裁判说：${e.message ?? String(error)}`);
    }
    say("");
    continue;
  }
  if (call.appliedLegalAction) applied += 1;
}

say(`合计 ${found} 次。`);
