import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { deriveSideInference } from "@/lib/inference";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import { evilCount } from "@/lib/rules/avalon";
import type { GameRecord, PlayerCount } from "@/lib/types/game";
import { corpusSplit, untilMission } from "./splits";

/**
 * Does the rollout's read sharpen the way the frozen engine's does?
 *
 * If the real posterior narrows hard through a game and the marginal filter
 * does not, the answer is not bigger coefficients. A failed quest is JOINT
 * evidence about a team — "at least one of these three" — and independent
 * per-seat updates cannot hold that, so no weight makes them equivalent.
 */

const bits = (q: number) =>
  q <= 0 || q >= 1 ? 0 : -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));

/** How far the top suspects stand above the rest. */
function separation(read: number[], k: number): number {
  const sorted = [...read].sort((a, b) => b - a);
  const top = sorted.slice(0, k);
  const rest = sorted.slice(k);
  if (!top.length || !rest.length) return 0;
  return (
    top.reduce((a, b) => a + b, 0) / top.length -
    rest.reduce((a, b) => a + b, 0) / rest.length
  );
}

it("compares real and simulated sharpening", async () => {
  console.log("");
  console.log("每座位熵（bit，越低越尖）与分离度（前 k 名均值 − 其余均值）");
  console.log("");

  // Real trajectory, from the frozen engine on held-out games.
  const real = corpusSplit("test", { limit: 300 });
  console.log("真实（冻结 Belief V1，公开视图）");
  console.log("轮次    平均熵    分离度    局数");
  for (const round of [1, 2, 3, 4, 5]) {
    let entropy = 0, sep = 0, seats = 0, games = 0;
    for (const { game: g, events } of real) {
      const pre = untilMission(events, round);
      if (!pre) continue;
      const view = publicView(pre, g);
      const side = deriveSideInference(view.events, view.game);
      const read = g.players.map((p) => side.evilProbability.get(p.id) ?? 0);
      for (const q of read) entropy += bits(q);
      seats += read.length;
      sep += separation(read, evilCount(g.playerCount as PlayerCount));
      games += 1;
    }
    if (!games) continue;
    console.log(
      `第 ${round} 轮  ${(entropy / seats).toFixed(4)}   ${(sep / games).toFixed(4)}   ${games}`,
    );
  }

  // Simulated trajectory, from the rollout filter.
  console.log("");
  console.log("模拟（rollout 边际滤波器）");
  console.log("轮次    平均熵    分离度    样本");
  const totals = [0,0,0,0,0].map(() => ({ entropy: 0, seats: 0, sep: 0, n: 0 }));
  const raws = [0,0,0,0,0].map(() => ({ entropy: 0, seats: 0, sep: 0, n: 0 }));
  for (const count of [7, 8, 9, 10] as const) {
    const built = game(count).build();
    const asLoyal: GameRecord = { ...built.game, viewerPlayerId: "p1", viewerRole: "loyal" };
    const state = buildDecisionState(built.events, asLoyal);
    const view = publicView(state.events, state.game);
    const side = deriveSideInference(view.events, view.game);
    const publicWorlds = sampleAssignments(view.events, view.game, 120, makeRng(77));
    const worlds = sampleAssignments(state.events, state.game, 400, makeRng(5));
    for (let i = 0; i < worlds.length; i += 1) {
      const t = await traceOne(state, worlds[i], publicWorlds, makeRng(3000 + i));
      t.rawByRound.forEach((read, r) => {
        if (!read?.length) return;
        for (const q of read) raws[r].entropy += bits(q);
        raws[r].seats += read.length;
        raws[r].sep += separation(read, evilCount(count));
        raws[r].n += 1;
      });
      t.readByRound.forEach((read, r) => {
        if (!read?.length) return;
        for (const q of read) totals[r].entropy += bits(q);
        totals[r].seats += read.length;
        totals[r].sep += separation(read, evilCount(count));
        totals[r].n += 1;
      });
    }
  }
  console.log("");
  console.log("模拟（纯粒子边际，未混合社会线索）");
  console.log("轮次    平均熵    分离度    样本");
  raws.forEach((t, r) => {
    if (!t.n) return;
    console.log(
      `第 ${r + 1} 轮  ${(t.entropy / t.seats).toFixed(4)}   ${(t.sep / t.n).toFixed(4)}   ${t.n}`,
    );
  });
  console.log("");
  console.log("模拟（粒子 + 社会线索，策略实际读到的）");
  console.log("轮次    平均熵    分离度    样本");
  totals.forEach((t, r) => {
    if (!t.n) return;
    console.log(
      `第 ${r + 1} 轮  ${(t.entropy / t.seats).toFixed(4)}   ${(t.sep / t.n).toFixed(4)}   ${t.n}`,
    );
  });
}, 3_600_000);
