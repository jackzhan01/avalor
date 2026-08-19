import { describe, it } from "vitest";
import { computeRolesWith, type RoleOptions } from "@/lib/inference/roles";
import { deriveSideInference } from "@/lib/inference/side";
import { evilCount } from "@/lib/rules/avalon";
import { loadCorpus } from "./corpus-load";

/**
 * Does deriving Merlin's features from what he could SEE beat treating him as
 * a differently-behaving good player?
 *
 * Reported per round, because a posterior that only sharpens after the last
 * quest is worth little to someone still playing. Faction metrics are carried
 * alongside so a gain on roles cannot be bought with a loss on sides.
 */

function prefix(events: ReturnType<typeof loadCorpus>[number]["events"], n: number) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "mission" && ++seen === n) return events.slice(0, i + 1);
  }
  return null;
}

interface Cell {
  roleBrier: number;
  roleLogLoss: number;
  top1: number;
  factionBrier: number;
  games: number;
}

function score(
  corpus: ReturnType<typeof loadCorpus>,
  round: number,
  opts: RoleOptions,
): Cell | null {
  let roleBrier = 0, roleLogLoss = 0, seats = 0;
  let hits = 0, games = 0;
  let factionBrier = 0, factionSeats = 0;

  for (const { game, events, evil, truth } of corpus) {
    const cut = prefix(events, round);
    if (!cut) continue;
    const merlinSeat = truth.roles.get("merlin");
    if (!merlinSeat) continue;

    const roles = computeRolesWith(cut, game, opts);
    if (roles.contradictory) continue;
    games += 1;

    // Specific-role scoring on Merlin: the seat every table cares about.
    const perSeat = new Map<string, number>();
    for (const player of game.players) {
      const p = roles.byPlayer.get(player.id)?.get("merlin") ?? 0;
      perSeat.set(player.id, p);
      const y = player.id === merlinSeat ? 1 : 0;
      roleBrier += (p - y) ** 2;
      roleLogLoss -= y
        ? Math.log(Math.max(p, 1e-9))
        : Math.log(Math.max(1 - p, 1e-9));
      seats += 1;
    }
    let best = "", bestP = -1;
    for (const [id, p] of perSeat) if (p > bestP) { bestP = p; best = id; }
    if (best === merlinSeat) hits += 1;

    // Faction, from the same cut, to confirm nothing was traded away.
    const side = deriveSideInference(cut, game);
    const truthEvil = new Set(evil);
    for (const player of game.players) {
      const p = side.evilProbability.get(player.id) ?? evilCount(game.playerCount) / game.playerCount;
      factionBrier += (p - (truthEvil.has(player.id) ? 1 : 0)) ** 2;
      factionSeats += 1;
    }
  }

  return seats
    ? {
        roleBrier: roleBrier / seats,
        roleLogLoss: roleLogLoss / seats,
        top1: hits / games,
        factionBrier: factionBrier / factionSeats,
        games,
      }
    : null;
}

describe("Merlin: information set vs behaviour class", () => {
  const corpus = loadCorpus().filter(
    (c) => c.game.playerCount >= 7 && c.game.playerCount <= 10,
  );
  // Sub-sampled: the role layer enumerates every legal casting, which is
  // far heavier than the side layer. 500 games is ample to compare two models.
  const test = corpus.filter((_, i) => i % 2 === 1).slice(0, 500);

  it("scores both models round by round", () => {
    console.log("");
    console.log(`测试集 ${test.length} 局`);
    console.log("");
    console.log("模型        指标             R1       R2       R3       R4       R5");
    const variants: { label: string; opts: RoleOptions }[] = [
      { label: "行为类", opts: { merlinModel: "class" } },
      { label: "信息集", opts: { merlinModel: "info" } },
    ];
    for (const v of variants) {
      const cells = [1, 2, 3, 4, 5].map((r) => score(test, r, v.opts));
      const row = (name: string, pick: (c: Cell) => number, digits = 4) =>
        console.log(
          v.label.padEnd(10) +
            name.padEnd(16) +
            cells
              .map((c) => (c ? pick(c).toFixed(digits).padStart(8) : "       —"))
              .join(" "),
        );
      row("梅林 Brier ↓", (c) => c.roleBrier);
      row("梅林 LogLoss ↓", (c) => c.roleLogLoss);
      row("梅林 猜中率 ↑", (c) => c.top1);
      row("阵营 Brier ↓", (c) => c.factionBrier);
      console.log("");
    }
  });

  it("splits by whether Mordred is in the game — the mechanism under test", () => {
    const withM = test.filter((c) => c.truth.roles.has("mordred"));
    const without = test.filter((c) => !c.truth.roles.has("mordred"));
    console.log("");
    console.log(`有莫德雷德 ${withM.length} 局 · 无莫德雷德 ${without.length} 局`);
    console.log("");
    console.log("局型        模型      指标           R3       R4       R5");
    for (const [label, subset] of [["有莫德雷德", withM], ["无莫德雷德", without]] as const) {
      if (!subset.length) continue;
      for (const [name, opts] of [["行为类", { merlinModel: "class" }], ["信息集", { merlinModel: "info" }]] as const) {
        const cells = [3, 4, 5].map((r) => score(subset, r, opts as RoleOptions));
        console.log(
          label.padEnd(11) + name.padEnd(9) + "梅林猜中率 ↑ " +
            cells.map((c) => (c ? c.top1.toFixed(4).padStart(8) : "       —")).join(" "),
        );
      }
    }
  });
});
