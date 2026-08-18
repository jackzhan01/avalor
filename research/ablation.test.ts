import { describe, expect, it } from "vitest";
import { enumerateHypotheses } from "@/lib/inference/hypotheses";
import { applyRules, collectRules } from "@/lib/inference/constraints";
import { weighHypotheses } from "@/lib/inference/soft";
import { evilCount } from "@/lib/rules/avalon";
import { loadCorpus } from "./corpus-load";
import type { GameEvent } from "@/lib/types/events";
import type { VoteChoice } from "@/lib/types/game";

/**
 * 记多少票才回本 — how much does an incomplete record cost you?
 *
 * A question only this product has to ask. Published datasets are complete
 * games; this app accepts a half-remembered log from the first day, so the
 * honest thing is to measure what that half-remembering costs.
 *
 * The answer drives a real UI decision. If accuracy degrades gently, the app
 * should tell users to relax and stop missing the conversation while they
 * type. If it falls off a cliff, recording density IS the product and the
 * interface should push much harder for it.
 *
 * Method: drop a fraction of the recorded votes at random (replicating the
 * "never recorded" state, not the "recorded as unclear" one — the app keeps
 * those distinct and so does this), re-derive, and score against the truth.
 */

/** Deterministic, so a surprising number can be re-run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Remove `dropRate` of the seat-level votes, as if they were never noted. */
function thin(events: GameEvent[], dropRate: number, seed: number): GameEvent[] {
  if (dropRate <= 0) return events;
  const random = rng(seed);
  return events.map((event) => {
    if (event.type !== "vote") return event;
    const kept: Record<string, VoteChoice> = {};
    for (const [playerId, choice] of Object.entries(event.votes)) {
      if (random() >= dropRate) kept[playerId] = choice;
    }
    return { ...event, votes: kept };
  });
}

describe("what incomplete records cost", () => {
  const corpus = loadCorpus().filter((_, i) => i % 2 === 1);

  it("measures accuracy against how much of the vote record survives", () => {
    const rates = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1];
    console.log("\n丢掉的票   Brier ↓   相对完整记录的损失   每保留 10% 票的收益");
    console.log("─".repeat(64));

    let previous: number | null = null;
    let full = 0;
    const results: { drop: number; brier: number }[] = [];

    for (const drop of rates) {
      let brier = 0;
      let n = 0;
      for (const [index, { game, events, evil }] of corpus.entries()) {
        const thinned = thin(events, drop, index + 1);
        const all = enumerateHypotheses(game);
        const { surviving } = applyRules(all, collectRules(thinned, game));
        if (!surviving.length) continue;
        const weights = weighHypotheses(surviving, thinned, game);
        const truth = new Set(evil);
        for (const player of game.players) {
          let p = 0;
          for (let i = 0; i < surviving.length; i++) {
            if (surviving[i].isEvil(player.id)) p += weights[i];
          }
          brier += (p - (truth.has(player.id) ? 1 : 0)) ** 2;
          n += 1;
        }
      }
      brier /= n;
      if (drop === 0) full = brier;
      results.push({ drop, brier });
      const loss = ((brier - full) / full) * 100;
      const marginal = previous === null ? "" : (brier - previous).toFixed(4);
      console.log(
        `${(drop * 100).toFixed(0).padStart(6)}%   ${brier.toFixed(4)}   ${(loss >= 0 ? "+" : "") + loss.toFixed(1)}%`.padEnd(44) +
          marginal.padStart(10),
      );
      previous = brier;
    }

    // The headline: half a record versus none, and versus all of it.
    const at = (d: number) => results.find((r) => r.drop === d)!.brier;
    let baseline = 0;
    let seats = 0;
    for (const { game, evil } of corpus) {
      const base = evilCount(game.playerCount) / game.playerCount;
      for (const player of game.players) {
        baseline += (base - (evil.includes(player.id) ? 1 : 0)) ** 2;
        seats += 1;
      }
    }
    baseline /= seats;

    const recovered = (d: number) =>
      (((baseline - at(d)) / (baseline - at(0))) * 100).toFixed(0);
    console.log(`\n完全不记票的 Brier：${at(1).toFixed(4)}（只剩任务结果和硬约束）`);
    console.log(`什么都不看的 Brier：${baseline.toFixed(4)}`);
    console.log("\n记多少票，拿回多少价值（以完整记录为 100%）：");
    for (const d of [0.9, 0.7, 0.5, 0.3, 0.1]) {
      console.log(`  记了 ${((1 - d) * 100).toFixed(0).padStart(3)}% 的票 → 拿回 ${recovered(d).padStart(3)}%`);
    }

    // Dropping votes must never help.
    expect(at(1)).toBeGreaterThan(at(0));
  }, 600000);
});
