import { describe, expect, it } from "vitest";
import { enumerateHypotheses } from "@/lib/inference/hypotheses";
import { applyRules, collectRules } from "@/lib/inference/constraints";
import { weighHypotheses } from "@/lib/inference/soft";
import { evilCount } from "@/lib/rules/avalon";
import { loadCorpus } from "./corpus-load";
import type { GameEvent } from "@/lib/types/events";

/**
 * The same question, asked at the moment the user is actually asking it.
 *
 * The whole-game ablation says votes contribute almost nothing — but it scores
 * the FINISHED game, by which point three to five mission results are in and
 * they dominate everything. Nobody uses this feature after the game; they use
 * it in round two, deciding whether to approve a car.
 *
 * So: truncate to the end of each round and re-ask. If votes matter early and
 * are merely redundant late, the whole-game number is an artefact of asking
 * too late, and the UI advice that falls out of it is the opposite.
 */

function truncateAfterMission(events: GameEvent[], missionNumber: number) {
  let seen = 0;
  const out: GameEvent[] = [];
  for (const event of events) {
    out.push(event);
    if (event.type === "mission") {
      seen += 1;
      if (seen >= missionNumber) break;
    }
  }
  return out;
}

function stripVotes(events: GameEvent[]): GameEvent[] {
  return events.map((e) => (e.type === "vote" ? { ...e, votes: {} } : e));
}

describe("when do votes actually matter", () => {
  const corpus = loadCorpus().filter((_, i) => i % 2 === 1);

  it("scores with and without votes at the end of each round", () => {
    console.log("\n打到第几轮   有记票    没记票    票带来的改善   还剩多少不确定");
    console.log("─".repeat(66));

    for (const round of [1, 2, 3, 4, 5]) {
      let withVotes = 0;
      let without = 0;
      let baseline = 0;
      let n = 0;
      let worlds = 0;
      let games = 0;

      for (const { game, events, evil } of corpus) {
        const cut = truncateAfterMission(events, round);
        // Only count games that actually reached this round.
        const missions = cut.filter((e) => e.type === "mission").length;
        if (missions < round) continue;

        const truth = new Set(evil);
        const base = evilCount(game.playerCount) / game.playerCount;

        for (const variant of [cut, stripVotes(cut)] as const) {
          const all = enumerateHypotheses(game);
          const { surviving } = applyRules(all, collectRules(variant, game));
          if (!surviving.length) continue;
          const weights = weighHypotheses(surviving, variant, game);
          for (const player of game.players) {
            let p = 0;
            for (let i = 0; i < surviving.length; i++) {
              if (surviving[i].isEvil(player.id)) p += weights[i];
            }
            const err = (p - (truth.has(player.id) ? 1 : 0)) ** 2;
            if (variant === cut) withVotes += err;
            else without += err;
          }
          if (variant === cut) {
            worlds += surviving.length;
            games += 1;
          }
        }

        for (const player of game.players) {
          baseline += (base - (truth.has(player.id) ? 1 : 0)) ** 2;
          n += 1;
        }
      }

      if (!n) continue;
      const a = withVotes / n;
      const b = without / n;
      const gain = ((b - a) / b) * 100;
      console.log(
        `${String(round).padStart(8)}     ${a.toFixed(4)}    ${b.toFixed(4)}    ` +
          `${(gain >= 0 ? "+" : "") + gain.toFixed(1)}%`.padStart(10) +
          `${(worlds / games).toFixed(1)} 种`.padStart(14),
      );
    }

    expect(true).toBe(true);
  }, 900000);
});
