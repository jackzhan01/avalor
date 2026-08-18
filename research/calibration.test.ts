import { describe, expect, it } from "vitest";
import { enumerateHypotheses } from "@/lib/inference/hypotheses";
import { applyRules, collectRules } from "@/lib/inference/constraints";
import { weighHypotheses, DEFAULT_PARAMS, type BehaviourParams } from "@/lib/inference/soft";
import { evilCount } from "@/lib/rules/avalon";
import { loadCorpus } from "./corpus-load";

// TEMPORARY — measures calibration, the metric that matters when the number
// is shown to a human who will bet on it.

/** The old hand-set values, mapped onto the current parameter shape. */
const HAND_SET: BehaviourParams = {
  goodApprovesAboard: 0.5,
  goodApprovesOffTainted: 0.5,
  goodApprovesOffClean: 0.5,
  evilApprovesAboard: 0.85,
  evilApprovesOffTeammate: 0.7,
  evilApprovesOffClean: 0.35,
  evilPlaysFail: 0.7,
  damping: 0.5,
};

interface Scored {
  brier: number;
  logLoss: number;
  n: number;
  buckets: { lo: number; predicted: number; actual: number; n: number }[];
}

function score(
  corpus: ReturnType<typeof loadCorpus>,
  params: BehaviourParams | null,
): Scored {
  let brier = 0;
  let logLoss = 0;
  let n = 0;
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10,
    sum: 0,
    hits: 0,
    n: 0,
  }));

  for (const { game, events, evil } of corpus) {
    const all = enumerateHypotheses(game);
    const { surviving } = applyRules(all, collectRules(events, game));
    if (surviving.length === 0) continue;

    const weights = params
      ? weighHypotheses(surviving, events, game, params)
      : surviving.map(() => 1 / surviving.length);
    const truth = new Set(evil);

    for (const player of game.players) {
      let p = 0;
      for (let i = 0; i < surviving.length; i++) {
        if (surviving[i].isEvil(player.id)) p += weights[i];
      }
      const y = truth.has(player.id) ? 1 : 0;
      brier += (p - y) ** 2;
      logLoss -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
      n += 1;
      const b = buckets[Math.min(9, Math.floor(p * 10))];
      b.sum += p;
      b.hits += y;
      b.n += 1;
    }
  }

  return {
    brier: brier / n,
    logLoss: logLoss / n,
    n,
    buckets: buckets
      .filter((b) => b.n > 0)
      .map((b) => ({
        lo: b.lo,
        predicted: b.sum / b.n,
        actual: b.hits / b.n,
        n: b.n,
      })),
  };
}

describe("calibration on real games", () => {
  const corpus = loadCorpus();
  // Split by GAME, not by position — two seats from the same game share almost
  // all their evidence, so a positional split would leak.
  const test = corpus.filter((_, i) => i % 2 === 1);

  it("measured parameters beat hand-set ones, and both beat counting alone", () => {
    // The always-baseline predictor: what you would score by ignoring the
    // record entirely and quoting the table's evil share.
    let baselineBrier = 0;
    let seats = 0;
    for (const { game, evil } of test) {
      const base = evilCount(game.playerCount) / game.playerCount;
      for (const player of game.players) {
        baselineBrier += (base - (evil.includes(player.id) ? 1 : 0)) ** 2;
        seats += 1;
      }
    }
    baselineBrier /= seats;

    const counting = score(test, null);
    const handSet = score(test, HAND_SET);
    const measured = score(test, DEFAULT_PARAMS);

    console.log(`\n测试集 ${test.length} 局 / ${counting.n} 个座位判断`);
    console.log("（Brier 越低越好，0.25 = 全猜基准线）\n");
    console.log("方案                          Brier    LogLoss");
    console.log("─".repeat(48));
    console.log(`只报基线（完全不看记录）      ${baselineBrier.toFixed(4)}    —`);
    console.log(`只数可能性（硬约束）          ${counting.brier.toFixed(4)}    ${counting.logLoss.toFixed(4)}`);
    console.log(`硬约束 + 手调参数             ${handSet.brier.toFixed(4)}    ${handSet.logLoss.toFixed(4)}`);
    console.log(`硬约束 + 实测参数             ${measured.brier.toFixed(4)}    ${measured.logLoss.toFixed(4)}`);

    console.log("\n可靠性曲线（说 X% 的时候，实际有多少是坏人）");
    console.log("预测区间     说了      实际      样本");
    console.log("─".repeat(46));
    for (const b of measured.buckets) {
      const flag = Math.abs(b.predicted - b.actual) > 0.05 ? "  ← 偏" : "";
      console.log(
        `${(b.lo * 100).toFixed(0).padStart(3)}-${((b.lo + 0.1) * 100).toFixed(0).padStart(3)}%  ` +
          `${b.predicted.toFixed(3).padStart(8)}  ${b.actual.toFixed(3).padStart(8)}  ${String(b.n).padStart(8)}${flag}`,
      );
    }

    // The measured parameters must at least not be worse than the guesses.
    expect(measured.brier).toBeLessThanOrEqual(handSet.brier);
    // And using the record at all must beat ignoring it.
    expect(measured.brier).toBeLessThan(baselineBrier);
  });

  it("finds the damping that actually minimises calibration error", () => {
    // `damping` was introduced as an admitted fudge against the naive
    // independence assumption. With a held-out set it stops being a fudge and
    // becomes a measurement.
    console.log("\ndamping    Brier    LogLoss");
    console.log("─".repeat(34));
    let best = { damping: 0, brier: Infinity };
    for (const damping of [0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0]) {
      const s = score(test, { ...DEFAULT_PARAMS, damping });
      const mark = s.brier < best.brier ? "  ←" : "";
      if (s.brier < best.brier) best = { damping, brier: s.brier };
      console.log(
        `${damping.toFixed(1).padStart(5)}    ${s.brier.toFixed(4)}    ${s.logLoss.toFixed(4)}${mark}`,
      );
    }
    console.log(`\n最优 damping = ${best.damping}（Brier ${best.brier.toFixed(4)}）`);
    expect(best.brier).toBeLessThanOrEqual(0.18);
  }, 300000);
});
