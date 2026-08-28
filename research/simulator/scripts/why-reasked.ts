/**
 * Why was an answer re-asked, when the ACTION was fine?
 *
 * The pilot's five re-asks were reported as referee rejections. They were not:
 * `live-game.ts` marks the last attempt `appliedLegalAction = false` for every
 * repairable rejection, and a broken `cognition` block reaches that handler by
 * exactly the same path an `IllegalActionError` does. This script replays the
 * recorded answer through the real cognition parser and prints the real reason.
 *
 * Offline, read-only, no client.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../model/structured";
import { cognitionProblems, parseCognition } from "../cognition/response";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";

const say = (...p: unknown[]) => console.log(...p);
const gameId = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!gameId) process.exit(2);

const text = readFileSync(
  join(process.cwd(), "research", "simulator", "out", "private", `${gameId}.private-trace.jsonl`),
  "utf8",
);
const lines = parseJsonl<PrivateTraceLine>(text) as unknown as { t: string; data: unknown }[];
type Call = {
  seat: number;
  taskId: string;
  attempt: number;
  outcome: string;
  appliedLegalAction: boolean;
  raw: string | null;
};
const calls = lines.filter((l) => l.t === "model-call").map((l) => l.data as Call);

say(`# 被重问的五次 —— 真实原因（${gameId}）`);
say("");
for (const call of calls) {
  if (call.outcome !== "valid" || call.appliedLegalAction) continue;
  let raw: unknown = null;
  try {
    raw = (JSON.parse(extractJson(call.raw ?? "")) as Record<string, unknown>).cognition;
  } catch {
    raw = null;
  }
  const parsed = parseCognition(raw);
  say(`## ${call.seat}号 · ${call.taskId}`);
  if (!parsed.ok) {
    say(`- **cognition 解析失败**：${parsed.error}`);
  } else {
    const problems = cognitionProblems(parsed.cognition);
    if (problems.length > 0) {
      say(`- **cognition 跨字段不一致**：${problems.join("；")}`);
      const c = parsed.cognition;
      const both = c.claimsReliedOn.filter((id) => c.claimsQuestioned.includes(id));
      if (both.length > 0) {
        say(`  - 两边都出现的 id：${both.join("、")}`);
        say(`  - claimsReliedOn：${JSON.stringify(c.claimsReliedOn)}`);
        say(`  - claimsQuestioned：${JSON.stringify(c.claimsQuestioned)}`);
      }
      const dup = c.factsUsed.filter((id, i) => c.factsUsed.indexOf(id) !== i);
      if (dup.length > 0) say(`  - factsUsed 重复的 id：${[...new Set(dup)].join("、")}`);
    } else {
      say("- cognition 本身合法 —— 那这次重问确实来自裁判。");
    }
  }
  say("");
}
