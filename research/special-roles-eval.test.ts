import { describe, it } from "vitest";
import { computeRolesWith, type RoleOptions } from "@/lib/inference/roles";
import { deriveSideInference } from "@/lib/inference/side";
import { evilCount } from "@/lib/rules/avalon";
import type { RoleType } from "@/lib/types/game";
import { loadCorpus } from "./corpus-load";

/**
 * Special-role models, scored three ways at once.
 *
 * Top-1 alone is not enough and can move on its own: a model can find the right
 * seat more often while its probabilities drift further from the truth. These
 * numbers end up in front of a person who will bet on them, so Brier and log
 * loss are reported beside it, and faction Brier alongside all three to show
 * nothing was traded away for the roles.
 */

function prefix(events: ReturnType<typeof loadCorpus>[number]["events"], n: number) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "mission" && ++seen === n) return events.slice(0, i + 1);
  }
  return null;
}

interface Metrics {
  brier: number;
  logLoss: number;
  top1: number;
  games: number;
}

function blank(): Metrics {
  return { brier: 0, logLoss: 0, top1: 0, games: 0 };
}

function scoreRound(
  corpus: ReturnType<typeof loadCorpus>,
  round: number,
  opts: RoleOptions,
  roles: RoleType[],
) {
  const acc = new Map<RoleType, Metrics & { seats: number }>();
  for (const r of roles) acc.set(r, { ...blank(), seats: 0 });
  let factionBrier = 0, factionSeats = 0;

  for (const { game, events, evil, truth } of corpus) {
    const cut = prefix(events, round);
    if (!cut) continue;
    const inference = computeRolesWith(cut, game, opts);
    if (inference.contradictory) continue;

    for (const role of roles) {
      const seat = truth.roles.get(role);
      if (!seat) continue;
      const cell = acc.get(role)!;
      cell.games += 1;
      let best = "", bestP = -1;
      for (const player of game.players) {
        const p = inference.byPlayer.get(player.id)?.get(role) ?? 0;
        const y = player.id === seat ? 1 : 0;
        cell.brier += (p - y) ** 2;
        cell.logLoss -= y
          ? Math.log(Math.max(p, 1e-9))
          : Math.log(Math.max(1 - p, 1e-9));
        cell.seats += 1;
        if (p > bestP) { bestP = p; best = player.id; }
      }
      if (best === seat) cell.top1 += 1;
    }

    const side = deriveSideInference(cut, game);
    const truthEvil = new Set(evil);
    for (const player of game.players) {
      const p =
        side.evilProbability.get(player.id) ??
        evilCount(game.playerCount) / game.playerCount;
      factionBrier += (p - (truthEvil.has(player.id) ? 1 : 0)) ** 2;
      factionSeats += 1;
    }
  }

  const out = new Map<RoleType, Metrics>();
  for (const [role, cell] of acc) {
    out.set(role, {
      brier: cell.seats ? cell.brier / cell.seats : NaN,
      logLoss: cell.seats ? cell.logLoss / cell.seats : NaN,
      top1: cell.games ? cell.top1 / cell.games : NaN,
      games: cell.games,
    });
  }
  return { roles: out, factionBrier: factionSeats ? factionBrier / factionSeats : NaN };
}

describe("special roles: information set vs behaviour class", () => {
  const corpus = loadCorpus().filter(
    (c) => c.game.playerCount >= 7 && c.game.playerCount <= 10,
  );
  // Sub-sampled: the role layer enumerates every legal casting.
  const test = corpus.filter((_, i) => i % 2 === 1).slice(0, 350);
  const ROUNDS = [2, 3, 4, 5];
  const VARIANTS: { label: string; opts: RoleOptions }[] = [
    { label: "都用行为类", opts: { merlinModel: "class", percivalModel: "class" } },
    { label: "梅林信息集", opts: { merlinModel: "info", percivalModel: "class" } },
    { label: "两者信息集", opts: { merlinModel: "info", percivalModel: "info" } },
  ];

  it("reports Brier, LogLoss and Top-1 for Merlin and Percival", () => {
    console.log("");
    console.log(`测试集 ${test.length} 局`);
    // One pass per (variant, round); every metric comes out of the same pass.
    const grid = VARIANTS.map((v) =>
      ROUNDS.map((r) => scoreRound(test, r, v.opts, ["merlin", "percival"])),
    );

    for (const role of ["merlin", "percival"] as RoleType[]) {
      console.log("");
      console.log(`【${role === "merlin" ? "梅林" : "派西维尔"}】`);
      console.log("模型          指标          R2       R3       R4       R5");
      VARIANTS.forEach((v, i) => {
        const row = (name: string, pick: (m: Metrics) => number) =>
          console.log(
            v.label.padEnd(13) +
              name.padEnd(13) +
              grid[i]
                .map((c) => {
                  const m = c.roles.get(role)!;
                  const x = pick(m);
                  return Number.isNaN(x) ? "       —" : x.toFixed(4).padStart(8);
                })
                .join(" "),
          );
        row("Brier ↓", (m) => m.brier);
        row("LogLoss ↓", (m) => m.logLoss);
        row("Top-1 ↑", (m) => m.top1);
      });
      console.log(
        "局数".padEnd(15) + "             " +
          grid[0].map((c) => String(c.roles.get(role)!.games).padStart(8)).join(" "),
      );
    }

    console.log("");
    console.log("【阵营 Brier ↓（确认没有拿阵营换角色）】");
    VARIANTS.forEach((v, i) => {
      console.log(
        v.label.padEnd(13) + "             " +
          grid[i].map((c) => c.factionBrier.toFixed(4).padStart(8)).join(" "),
      );
    });
  }, 1_800_000);
});
