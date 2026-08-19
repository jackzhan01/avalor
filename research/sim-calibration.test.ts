import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { deriveSideInference } from "@/lib/inference";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";

/**
 * What the simulator actually produces, against what real games do.
 *
 * A win rate alone cannot say WHERE a simulator went wrong. These are the
 * intermediate quantities: how often proposals pass, how many attempts a
 * mission takes, how often five rejections end it, how often quests fail.
 */
it("profiles simulated games against the corpus", () => {
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
    const read = new Map<string, number>();
    for (const p of state.game.players) {
      read.set(p.id, side.evilProbability.get(p.id) ?? 0);
    }

    const worlds = sampleAssignments(state.events, state.game, 1200, makeRng(99));
    let wins = 0, proposals = 0, approvals = 0, missions = 0, quests = 0;
    let hitLimit = 0, failed = 0;
    for (let i = 0; i < worlds.length; i += 1) {
      const t = traceOne(state, worlds[i], read, makeRng(1000 + i));
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
