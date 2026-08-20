import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { publicView } from "@/lib/decision/public-view";
import { DEFAULT_PROPOSAL } from "@/lib/decision/proposal";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";

/**
 * Three ways to be an uninformed good leader, run through the same simulator.
 *
 *   moment   where his car lands in the risk ordering, and how often he rides
 *   mle      the same two terms, fitted to the choice itself
 *   history  plus what the table has already watched happen
 *
 * The question is not which predicts real proposals best — history does, by
 * 0.31 nats a proposal. It is whether that prediction buys back the late-round
 * loading decline the simulator has never had. A model can call the next car
 * better and still not reproduce the trajectory, if what it has learned is
 * habit rather than skill.
 *
 * Corpus, by table size:
 *   good win   .448 / .414 / .461 / .311
 *   quest fail .391 / .426 / .417 / .477
 *   loading    0.896 / 0.773 / 0.630 / 0.622 / 0.405
 */
it("runs the simulator under each good-leader model", () => {
  const modes = ["moment", "mle", "history"] as const;
  const original = DEFAULT_PROPOSAL.goodModel;

  for (const mode of modes) {
    // Research-only: the params object is a frozen default in production, and
    // this reaches past that to sweep it. Restored below.
    (DEFAULT_PROPOSAL as { goodModel: string }).goodModel = mode;

    console.log("");
    console.log(`好人车主模型 = ${mode}`);
    console.log("人数  好人胜率  过车率  连否5次  任务失败率   载荷/轮");

    for (const count of [7, 8, 9, 10] as const) {
      const built = game(count).build();
      const asLoyal: GameRecord = {
        ...built.game,
        viewerPlayerId: "p1",
        viewerRole: "loyal",
      };
      const state = buildDecisionState(built.events, asLoyal);
      const view = publicView(state.events, state.game);
      const publicWorlds = sampleAssignments(
        view.events,
        view.game,
        120,
        makeRng(77),
      );
      const worlds = sampleAssignments(state.events, state.game, 1200, makeRng(99));

      let wins = 0;
      let proposals = 0;
      let approvals = 0;
      let quests = 0;
      let failed = 0;
      let hit = 0;
      const observed = [0, 0, 0, 0, 0];
      const expected = [0, 0, 0, 0, 0];

      for (let i = 0; i < worlds.length; i += 1) {
        const t = traceOne(state, worlds[i], publicWorlds, makeRng(1000 + i));
        if (t.goodWon) wins += 1;
        proposals += t.proposals;
        approvals += t.approvals;
        quests += t.failCards.length;
        for (const f of t.failCards) if (f > 0) failed += 1;
        if (t.hitRejectionLimit) hit += 1;
        for (let r = 0; r < 5; r += 1) {
          observed[r] += t.byRoundObserved[r];
          expected[r] += t.byRoundExpected[r];
        }
      }

      const n = worlds.length;
      const load = observed
        .map((o, r) => (expected[r] ? (o / expected[r]).toFixed(2) : " — "))
        .join(" ");
      console.log(
        `${String(count).padStart(2)} 人   ${(wins / n).toFixed(3)}   ${(approvals / proposals).toFixed(3)}   ${(hit / n).toFixed(3)}    ${(failed / Math.max(quests, 1)).toFixed(3)}       ${load}`,
      );
    }
  }

  (DEFAULT_PROPOSAL as { goodModel: string }).goodModel = original;
}, 3_600_000);
