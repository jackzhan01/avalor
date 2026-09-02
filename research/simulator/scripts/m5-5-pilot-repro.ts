/**
 * Replay the terminated M5.5 pilot's own prefix and re-submit seat 7's answer.
 *
 * READ-ONLY AND OFFLINE. It opens the recorded private trace, replays the two
 * applied actions through the deterministic referee to reach the exact decision
 * the run died on, and re-runs the contest checks against the block the model
 * actually wrote — byte for byte, from the artifact.
 *
 * WHY THIS RATHER THAN A SYNTHETIC PREFIX. A hand-built state proves the fix
 * works on a state I chose. This proves it works on the state that happened.
 *
 * It makes no request, writes nothing, and modifies no artifact.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimContestFrom } from "../cognition/claim-contest";
import { contestProblems } from "../cognition/contest";
import { parseAction } from "../model/structured";
import type { Seat, SpeechAction } from "../core/types";

const GAME = process.argv.includes("--game")
  ? process.argv[process.argv.indexOf("--game") + 1]
  : "g-35f98393-cbae-429c-8b3e-96fa9b1b4f46";

const TRACE = join(
  process.cwd(),
  "research/simulator/out/private",
  `${GAME}.private-trace.jsonl`,
);

const rows = readFileSync(TRACE, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as { t: string; data: Record<string, unknown> });

const say = (line: string) => process.stdout.write(`${line}\n`);

/* ── The public log as the run left it ──────────────────────────────────── */

const events = rows
  .filter((r) => r.t === "event")
  .map((r) => r.data as never as { sequence: number; type: string });
const contest = claimContestFrom(events as never);

say("=== 实盘终止时的公开状态 ===");
say(`公开事件 ${events.length} 条，最后一条 sequence ${events.at(-1)?.sequence}`);
say(`站着派西维尔的：${contest.activePercivalClaimants.join("、") || "（无）"}`);

const failure = rows.find((r) => r.t === "private-header")?.data.failureReason;
say(`失败原因：${String(failure).slice(0, 120)}…`);

/* ── Seat 7's three refused answers, from the trace ─────────────────────── */

const attempts = rows
  .filter((r) => r.t === "model-call")
  .map((r) => r.data as never as {
    seat: Seat;
    taskId: string;
    attempt: number;
    raw: string;
  })
  .filter((d) => d.seat === 7 && d.taskId === "speech-regular");

say("");
say(`=== 7 号被拒的 ${attempts.length} 次回答，逐条重跑检查 ===`);

let allClean = true;
for (const attempt of attempts) {
  const answer = JSON.parse(attempt.raw) as Record<string, unknown>;
  const block = (answer.cognition as Record<string, unknown>).contest;

  // MERGE THE SPOKESPERSON LEG, the way `runPublicStage` does. Under two-stage
  // speech the planner answer carries no `publicMessage` at all — the public
  // sentence is written by the second stage and merged in before the action is
  // parsed. Parsing the planner leg alone would fail for a reason that has
  // nothing to do with either fix.
  const spoken = rows
    .filter((r) => r.t === "model-call")
    .map((r) => r.data as never as { seat: Seat; taskId: string; attempt: number; raw: string })
    .find((d) => d.seat === 7 && d.taskId === "speech-regular#say" && d.attempt === attempt.attempt);
  const merged = {
    ...answer,
    publicMessage: JSON.parse(spoken?.raw ?? '{}').publicMessage ?? "",
  };

  // Through the CANONICAL parser, so the second fix is exercised too.
  const parsed = parseAction(JSON.stringify(merged), {
    kind: "speech",
    seat: 7,
    slot: "regular",
  } as never);
  if (!parsed.ok) {
    say(`  attempt ${attempt.attempt}: 动作解析失败 —— ${parsed.error}`);
    allClean = false;
    continue;
  }
  const action = parsed.action as SpeechAction;

  const problems = contestProblems(block as never, {
    seat: 7,
    contest,
    teamSize: null,
    speech: {
      claim: action.claim ?? null,
      retractClaim: action.retractClaim === true,
      stances: action.stances ?? [],
    },
  });

  say(
    `  attempt ${attempt.attempt}: claim=${String(action.claim)} ` +
      `claimPurpose=${String(action.claimPurpose)} ` +
      `act=${String((block as never as { publicClaimMove: { act: string } }).publicClaimMove.act)} ` +
      `rivalPlans=[${(block as never as { rivalPlans: { rivalSeat: number }[] }).rivalPlans
        .map((r) => r.rivalSeat)
        .join(",")}]`,
  );
  say(`             检查结果：${problems.length === 0 ? "✓ 零问题" : `✗ ${problems.join(" / ")}`}`);
  if (problems.length > 0) allClean = false;
}

say("");
say(
  allClean
    ? "✓ 三次回答现在全部一次通过 —— 那一步不会再产生任何认知重问。"
    : "✗ 仍然有问题，见上。",
);
process.exit(allClean ? 0 : 1);
