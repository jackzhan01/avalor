import { describe, it } from "vitest";
import { enumerateHypotheses } from "@/lib/inference/hypotheses";
import { applyRules, collectRules } from "@/lib/inference/constraints";
import {
  weighHypotheses,
  DEFAULT_PARAMS,
  type BehaviourParams,
} from "@/lib/inference/soft";
import { evilCount } from "@/lib/rules/avalon";
import { loadCorpus } from "./corpus-load";

/**
 * Which evidence is actually earning its keep, round by round.
 *
 * The terms are switched off in the LIKELIHOOD, not deleted from the events.
 * Deleting a vote would also change what the hard layer sees and what the
 * timeline derives, so it measures the data rather than the model.
 */

const OFF = { useVotes: false, useMissions: false, useProposals: false };
const VARIANTS: { label: string; params: BehaviourParams | null }[] = [
  { label: "只有硬约束", params: null },
  { label: "+ 任务", params: { ...DEFAULT_PARAMS, ...OFF, useMissions: true } },
  { label: "+ 投票", params: { ...DEFAULT_PARAMS, ...OFF, useVotes: true } },
  { label: "+ 提案", params: { ...DEFAULT_PARAMS, ...OFF, useProposals: true } },
  { label: "全部", params: DEFAULT_PARAMS },
];

function prefix(events: ReturnType<typeof loadCorpus>[number]["events"], n: number) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "mission" && ++seen === n) return events.slice(0, i + 1);
  }
  return null;
}

interface Cell {
  brier: number;
  logLoss: number;
  /** Share of true evils landing in the top-k most suspected seats. */
  factionAcc: number;
  /** Largest gap between a bucket's mean prediction and its actual rate. */
  reliability: number;
  games: number;
}

function score(
  corpus: ReturnType<typeof loadCorpus>,
  round: number,
  params: BehaviourParams | null,
): Cell | null {
  let brier = 0, logLoss = 0, seats = 0;
  let caught = 0, evils = 0, games = 0;
  const buckets = Array.from({ length: 10 }, () => ({ sum: 0, hits: 0, n: 0 }));

  for (const { game, events, evil } of corpus) {
    const cut = prefix(events, round);
    if (!cut) continue;
    const { surviving } = applyRules(
      enumerateHypotheses(game),
      collectRules(cut, game),
    );
    if (!surviving.length) continue;

    const weights = params
      ? weighHypotheses(surviving, cut, game, params)
      : surviving.map(() => 1 / surviving.length);
    const truth = new Set(evil);
    games += 1;

    const ranked: { id: string; p: number }[] = [];
    for (const player of game.players) {
      let p = 0;
      for (let i = 0; i < surviving.length; i++) {
        if (surviving[i].isEvil(player.id)) p += weights[i];
      }
      const y = truth.has(player.id) ? 1 : 0;
      brier += (p - y) ** 2;
      logLoss -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
      seats += 1;
      const b = buckets[Math.min(9, Math.floor(p * 10))];
      b.sum += p;
      b.hits += y;
      b.n += 1;
      ranked.push({ id: player.id, p });
    }

    const k = evilCount(game.playerCount);
    ranked.sort((a, b) => b.p - a.p);
    for (const r of ranked.slice(0, k)) if (truth.has(r.id)) caught += 1;
    evils += k;
  }

  // Only buckets with enough seats to mean anything; a 3-seat bucket's
  // "actual rate" is 0, 1/3, 2/3 or 1 and says nothing.
  const reliability = Math.max(
    0,
    ...buckets
      .filter((b) => b.n >= 200)
      .map((b) => Math.abs(b.sum / b.n - b.hits / b.n)),
  );

  return seats
    ? {
        brier: brier / seats,
        logLoss: logLoss / seats,
        factionAcc: caught / evils,
        reliability,
        games,
      }
    : null;
}

describe("likelihood ablation", () => {
  const corpus = loadCorpus().filter(
    (c) => c.game.playerCount >= 7 && c.game.playerCount <= 10,
  );
  const test = corpus.filter((_, i) => i % 2 === 1);

  it("reports Brier, LogLoss and faction accuracy for each variant by round", () => {
    console.log(`\n测试集 ${test.length} 局（7–10 人，按局切分）`);
    for (const metric of ["brier", "logLoss", "factionAcc", "reliability"] as const) {
      const name =
        metric === "brier"
          ? "Brier ↓"
          : metric === "logLoss"
            ? "LogLoss ↓"
            : metric === "factionAcc"
              ? "阵营命中率 ↑"
              : "最大标定偏差 ↓";
      console.log(`\n【${name}】`);
      console.log("变体           R1       R2       R3       R4       R5");
      for (const v of VARIANTS) {
        const cells = [1, 2, 3, 4, 5].map((r) => score(test, r, v.params));
        console.log(
          v.label.padEnd(12) +
            cells
              .map((c) => (c ? c[metric].toFixed(4).padStart(8) : "       —"))
              .join(" "),
        );
      }
    }

    console.log("\n【投票项的净效果：+两者 相对 +任务】（正 = 投票有帮助）");
    console.log("轮次      Brier 改善");
    for (const r of [1, 2, 3, 4, 5]) {
      const withoutVotes = score(test, r, VARIANTS[1].params);
      const both = score(test, r, VARIANTS[3].params);
      if (!withoutVotes || !both) continue;
      const d = ((withoutVotes.brier - both.brier) / withoutVotes.brier) * 100;
      console.log(`第 ${r} 轮   ${d >= 0 ? "+" : ""}${d.toFixed(2)}%`);
    }
  });


  it("checks the unified model does not harm any table size", () => {
    console.log("");
    console.log("【按人数：+两者 相对 只有硬约束的 Brier 改善】");
    console.log("人数   局数     R1       R2       R3       R4       R5");
    for (const count of [7, 8, 9, 10]) {
      const subset = test.filter((c) => c.game.playerCount === count);
      if (!subset.length) continue;
      const cells = [1, 2, 3, 4, 5].map((r) => {
        const hard = score(subset, r, null);
        const both = score(subset, r, DEFAULT_PARAMS);
        if (!hard || !both) return "—";
        const gain = ((hard.brier - both.brier) / hard.brier) * 100;
        return gain.toFixed(1) + "%";
      });
      console.log(
        String(count).padStart(3) +
          String(subset.length).padStart(7) +
          "  " +
          cells.map((c) => c.padStart(8)).join(" "),
      );
    }
  });
});
