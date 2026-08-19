import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { deriveSideInference } from "@/lib/inference";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";

/**
 * Fitting the social cue.
 *
 * The target is the round-one Evil loading of good leaders: 0.896 of chance in
 * the corpus. That is the quantity a flat posterior cannot produce, so it is
 * the one the cue exists to explain. Win rate and mission failure are NOT fit
 * to — they are the check afterwards.
 */
it("profiles the simulator with the social cue", () => {
  console.log("");
  console.log("目标：R1 好人车主的坏人载荷 / 随机 = 0.896（语料）");
  console.log("");
  console.log("δ      人数  R1好人载荷  全局载荷  过车率  连否5  任务失败率  好人胜率");

  for (const delta of [0, 0.6])
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
    let wins = 0, proposals = 0, approvals = 0, quests = 0, failed = 0, hit = 0;
    let lo = 0, le = 0, r1o = 0, r1e = 0;
    const bro = [0,0,0,0,0], bre = [0,0,0,0,0];
    for (let i = 0; i < worlds.length; i += 1) {
      const t = traceOne(state, worlds[i], read, makeRng(1000 + i), delta);
      if (t.goodWon) wins += 1;
      proposals += t.proposals;
      approvals += t.approvals;
      quests += t.failCards.length;
      for (const f of t.failCards) if (f > 0) failed += 1;
      if (t.hitRejectionLimit) hit += 1;
      lo += t.loadingObserved; le += t.loadingExpected;
      r1o += t.r1GoodObserved; r1e += t.r1GoodExpected;
      for (let r=0;r<5;r++){ bro[r]+=t.byRoundObserved[r]; bre[r]+=t.byRoundExpected[r]; }
    }
    const n = worlds.length;
    console.log(
      `${String(delta).padEnd(6)} ${String(count).padStart(2)} 人    ${(r1e ? r1o / r1e : NaN).toFixed(3)}     ${(lo / le).toFixed(3)}` +
        `   ${(approvals / proposals).toFixed(3)}   ${(hit / n).toFixed(3)}    ${(failed / Math.max(quests, 1)).toFixed(3)}` +
        `     ${(wins / n).toFixed(3)}   载荷/轮 ${bro.map((o,r)=>(bre[r]?o/bre[r]:NaN).toFixed(2)).join(" ")}`,
    );
  }
}, 1_800_000);
