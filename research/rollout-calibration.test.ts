import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { evaluateActions } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";

/**
 * Before any Q difference means anything, the simulator has to produce games
 * that look like real ones.
 *
 * The check: play from the opening position and compare the good win rate to
 * the corpus. If a rollout that starts from nothing does not land near the
 * base rate, every number it reports downstream is measuring the simulator
 * rather than the decision.
 */
it("plays opening positions at something like the real base rate", () => {
  console.log("");
  console.log("从开局模拟，好人胜率（语料真实值：7人 0.43 / 8人 0.42 / 9人 0.42 / 10人 0.40）");
  console.log("");
  console.log("人数   模拟好人胜率");

  for (const count of [7, 8, 9, 10] as const) {
    const built = game(count).proposal(1, [1, 2]).build();
    const asLoyal: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "loyal",
    };
    const state = buildDecisionState(built.events, asLoyal);
    const values = evaluateActions(
      state,
      [
        { kind: "vote", choice: "approve" },
        { kind: "vote", choice: "reject" },
      ],
      { worlds: 600, seed: 4242 },
    );
    const approve = values.find(
      (v) => v.action.kind === "vote" && v.action.choice === "approve",
    );
    const reject = values.find(
      (v) => v.action.kind === "vote" && v.action.choice === "reject",
    );
    console.log(
      `${count} 人    上票 ${approve?.q.toFixed(3)}   下票 ${reject?.q.toFixed(3)}   ΔQ ${(
        (approve?.q ?? 0) - (reject?.q ?? 0)
      ).toFixed(4)}`,
    );
  }
}, 1_800_000);
