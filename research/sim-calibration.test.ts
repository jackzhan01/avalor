import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { deriveSideInference } from "@/lib/inference";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * What the simulator actually produces, against what real games do.
 *
 * A win rate alone cannot say WHERE a simulator went wrong. These are the
 * intermediate quantities: how often proposals pass, how many attempts a
 * mission takes, how often five rejections end it, how often quests fail.
 */
it("profiles simulated games against the corpus", async () => {
  console.log("");
  console.log("模拟 1200 局/人数。真实值：好人胜率 0.40–0.43、首提通过 0.657、任务失败率约 0.42");
  console.log("");
  console.log("人数  好人胜率  过车率  每轮提案数  连否5次  任务数  任务失败率");

  for (const count of [7, 8, 9, 10] as const) {
    const built = game(count).build();
    const asLoyal: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "loyal",
    };
    const state = buildDecisionState(built.events, asLoyal);
    const view = publicView(state.events, state.game);
    const side = deriveSideInference(view.events, view.game);
    const publicWorlds = sampleAssignments(view.events, view.game, 120, makeRng(77));

    const worlds = sampleAssignments(state.events, state.game, 1200, makeRng(99));
    let wins = 0, proposals = 0, approvals = 0, missions = 0, quests = 0;
    let hitLimit = 0, failed = 0;
    for (let i = 0; i < worlds.length; i += 1) {
      const t = await traceOne(state, worlds[i], publicWorlds, makeRng(1000 + i));
      if (t.goodWon) wins += 1;
      proposals += t.proposals;
      approvals += t.approvals;
      missions += t.missionsPlayed;
      quests += t.failCards.length;
      if (t.hitRejectionLimit) hitLimit += 1;
      for (const f of t.failCards) if (f > 0) failed += 1;
    }
    const n = worlds.length;
    console.log(
      `${String(count).padStart(2)} 人   ${(wins / n).toFixed(3)}   ${(approvals / proposals).toFixed(3)}` +
        `    ${(proposals / Math.max(missions, 1)).toFixed(2)}       ${(hitLimit / n).toFixed(3)}` +
        `   ${(missions / n).toFixed(2)}    ${(failed / Math.max(quests, 1)).toFixed(3)}`,
    );
  }
}, 1_800_000);

/**
 * What the corpus actually does, by table size.
 *
 * The header above quotes pooled figures, which hides the thing that matters
 * for a majority rule: an eight-player table needs five of eight to pass a car
 * and a seven-player table needs four of seven. If the real approval rate is
 * flat across sizes and ours is not, the gap is in the vote policy.
 */
it("measures the corpus by table size", async () => {
  console.log("");
  console.log("语料真实值，按人数");
  console.log("人数  好人胜率  过车率  每轮提案数  连否5次  任务失败率  局数");
  for (const count of [7, 8, 9, 10] as const) {
    const games = corpusSplit("test", { playerCount: count });
    let wins = 0, proposals = 0, approvals = 0, quests = 0, failed = 0, hit = 0;
    let rounds = 0;
    for (const { game: g, events } of games) {
      if (g.winningSide === "good") wins += 1;
      let streak = 0;
      let sawFive = false;
      const seen = new Set<number>();
      for (const e of events) {
        if (e.type === "proposal") proposals += 1;
        else if (e.type === "vote") {
          if (e.finalResult === "passed") { approvals += 1; streak = 0; }
          else { streak += 1; if (streak >= 5) sawFive = true; }
        } else if (e.type === "mission") {
          quests += 1;
          if (e.result === "fail") failed += 1;
          seen.add(e.missionNumber);
        }
      }
      rounds += seen.size;
      if (sawFive) hit += 1;
    }
    const n = Math.max(1, games.length);
    console.log(
      `${String(count).padStart(2)} 人   ${(wins / n).toFixed(3)}   ${(approvals / Math.max(1, proposals)).toFixed(3)}    ${(proposals / Math.max(1, rounds)).toFixed(2)}       ${(hit / n).toFixed(3)}     ${(failed / Math.max(1, quests)).toFixed(3)}     ${games.length}`,
    );
  }
}, 600_000);
