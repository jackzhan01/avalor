import { describe, it } from "vitest";
import { enumerateHypotheses } from "@/lib/inference/hypotheses";
import { applyRules, collectRules } from "@/lib/inference/constraints";
import {
  weighHypotheses,
  DEFAULT_PARAMS,
  type BehaviourParams,
} from "@/lib/inference/soft";
import { loadCorpus } from "./corpus-load";

/**
 * Old vs new fail-card model, scored at every round rather than at the end.
 *
 * A posterior that only sharpens after the last quest is nearly worthless to
 * someone still playing, so the question is not "is it better" but "is it
 * better EARLY". Same fixed split, same games, one parameter changed.
 */

const CONSTANT: BehaviourParams = { ...DEFAULT_PARAMS, failModel: "constant" };
const TABLE: BehaviourParams = { ...DEFAULT_PARAMS, failModel: "table" };

/** Events up to and including the nth recorded mission result. */
function prefixAfterMission(events: ReturnType<typeof loadCorpus>[number]["events"], n: number) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "mission") {
      seen += 1;
      if (seen === n) return events.slice(0, i + 1);
    }
  }
  return null; // that game never reached this mission
}

interface Cell {
  brier: number;
  logLoss: number;
  n: number;
  games: number;
}

function score(
  corpus: ReturnType<typeof loadCorpus>,
  round: number,
  params: BehaviourParams,
): Cell | null {
  let brier = 0;
  let logLoss = 0;
  let n = 0;
  let games = 0;

  for (const { game, events, evil } of corpus) {
    const prefix = prefixAfterMission(events, round);
    if (!prefix) continue;

    const all = enumerateHypotheses(game);
    const { surviving } = applyRules(all, collectRules(prefix, game));
    if (surviving.length === 0) continue;

    const weights = weighHypotheses(surviving, prefix, game, params);
    const truth = new Set(evil);
    games += 1;

    for (const player of game.players) {
      let p = 0;
      for (let i = 0; i < surviving.length; i++) {
        if (surviving[i].isEvil(player.id)) p += weights[i];
      }
      const y = truth.has(player.id) ? 1 : 0;
      brier += (p - y) ** 2;
      logLoss -= y
        ? Math.log(Math.max(p, 1e-9))
        : Math.log(Math.max(1 - p, 1e-9));
      n += 1;
    }
  }

  return n ? { brier: brier / n, logLoss: logLoss / n, n, games } : null;
}

describe("fail-card model, round by round", () => {
  const corpus = loadCorpus().filter(
    (c) => c.game.playerCount >= 7 && c.game.playerCount <= 10,
  );
  // Split by GAME. Two seats from one game share nearly all their evidence.
  const test = corpus.filter((_, i) => i % 2 === 1);

  it("compares constant against the measured table at each round", () => {
    console.log(`\n测试集 ${test.length} 局（7–10 人，按局切分）\n`);
    console.log("轮次   局数    常数 Brier   实测表 Brier    改善     常数 LogLoss  实测表 LogLoss");
    for (const round of [1, 2, 3, 4, 5]) {
      const a = score(test, round, CONSTANT);
      const b = score(test, round, TABLE);
      if (!a || !b) continue;
      const delta = ((a.brier - b.brier) / a.brier) * 100;
      console.log(
        `第 ${round} 轮  ${String(a.games).padStart(5)}` +
          `     ${a.brier.toFixed(4)}      ${b.brier.toFixed(4)}` +
          `     ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%` +
          `       ${a.logLoss.toFixed(4)}       ${b.logLoss.toFixed(4)}`,
      );
    }
  });

  it("breaks the same comparison down by table size", () => {
    console.log("\n按人数拆开（仍是同一个算法，人数只是参数）\n");
    console.log("人数  轮次   局数   常数 Brier   实测表 Brier   改善");
    for (const count of [7, 8, 9, 10]) {
      const subset = test.filter((c) => c.game.playerCount === count);
      if (!subset.length) continue;
      for (const round of [2, 3, 5]) {
        const a = score(subset, round, CONSTANT);
        const b = score(subset, round, TABLE);
        if (!a || !b) continue;
        const delta = ((a.brier - b.brier) / a.brier) * 100;
        console.log(
          `${String(count).padStart(3)}   第 ${round} 轮  ${String(a.games).padStart(5)}` +
            `    ${a.brier.toFixed(4)}      ${b.brier.toFixed(4)}` +
            `     ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
        );
      }
    }
  });
});
