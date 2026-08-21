import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { deriveRoleInference } from "@/lib/inference";
import { analyzeGame } from "@/lib/decision/analyze";
import type { GameRecord, PlayerCount } from "@/lib/types/game";

/**
 * Performance, measured somewhere nothing else is running.
 *
 * This is deliberately not part of `npm test`. A wall-clock assertion inside a
 * parallel suite measures the suite, and two attempts to make one robust in
 * place both failed: an absolute budget went red under load, and a ratio
 * against the seven-player case went red because seven players are fast enough
 * that scheduler noise dominates. Run it on its own:
 *
 *   npx vitest run --config research/vitest.config.ts research/perf-benchmark
 *
 * It prints rather than asserts. A number that drifts is something for a human
 * to look at, not something to fail a merge on a busy afternoon.
 */
it("reports where the time goes", async () => {
  const fastest = (times: number, work: () => void) => {
    let best = Infinity;
    for (let i = 0; i < times; i += 1) {
      const start = performance.now();
      work();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  console.log("");
  console.log("身份枚举（每次换一份新数组，绕开按引用记忆化）");
  console.log("人数   最快一次");
  for (const count of [7, 8, 9, 10] as const) {
    const { game: g, events } = game(count).build();
    deriveRoleInference(events, g);
    const ms = fastest(4, () => deriveRoleInference([...events], g));
    console.log(`${String(count).padStart(2)} 人   ${ms.toFixed(1)} ms`);
  }

  console.log("");
  console.log("完整一次分析（含枚举 + 400 世界推演），界面上就是这个等待时长");
  console.log("人数   投票    点车");
  for (const count of [7, 10] as const) {
    const built = game(count).proposal(1, [1, 2]).build();
    const asLoyal: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "loyal",
    };
    const t0 = performance.now();
    await analyzeGame(built.events, asLoyal);
    const vote = performance.now() - t0;

    const lead = game(count as PlayerCount).build();
    const asLeader: GameRecord = {
      ...lead.game,
      viewerPlayerId: lead.game.players[0].id,
      viewerRole: "loyal",
    };
    const t1 = performance.now();
    await analyzeGame(lead.events, asLeader);
    const propose = performance.now() - t1;

    console.log(
      `${String(count).padStart(2)} 人   ${(vote / 1000).toFixed(1)} s   ${(propose / 1000).toFixed(1)} s`,
    );
  }
}, 600_000);
