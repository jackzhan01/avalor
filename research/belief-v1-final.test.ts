import { it } from "vitest";
import { computeRolesWith, type RoleOptions } from "@/lib/inference/roles";
import { deriveSideInference } from "@/lib/inference/side";
import { evilCount } from "@/lib/rules/avalon";
import { EVIL_ROLES, type RoleType } from "@/lib/types/game";
import { bootstrap, corpusSplit, untilMission } from "./splits";

/**
 * Belief Engine V1, scored once on the held-out half.
 *
 * Lambda was fixed on validation before this ran. Nothing here feeds back.
 * Intervals are a percentile bootstrap over GAMES, because seats inside one
 * game share nearly all their evidence and resampling seats would report an
 * interval several times too narrow.
 */
const EVIL = new Set<RoleType>(EVIL_ROLES);
const ROLES: RoleType[] = ["merlin", "percival", "morgana", "mordred", "oberon", "assassin"];
const MODELS: { label: string; opts: RoleOptions | null }[] = [
  { label: "只有阵营（基线）", opts: null },
  { label: "联合 λ=1", opts: { roleTemperature: 1 } },
  { label: "联合 λ=0.4", opts: { roleTemperature: 0.4 } },
];

interface Acc {
  brierPerGame: number[];
  logLossPerGame: number[];
  hitPerGame: number[];
}
const blank = (): Acc => ({ brierPerGame: [], logLossPerGame: [], hitPerGame: [] });

function evaluate(
  corpus: ReturnType<typeof corpusSplit>,
  round: number,
  opts: RoleOptions | null,
) {
  const acc = new Map<string, Acc>();
  const of = (k: string) => {
    let a = acc.get(k);
    if (!a) acc.set(k, (a = blank()));
    return a;
  };

  for (const { game, events, evil, truth } of corpus) {
    const pre = untilMission(events, round);
    if (!pre) continue;
    const side = deriveSideInference(pre, game);
    const roles = opts ? computeRolesWith(pre, game, opts) : null;
    if (roles?.contradictory) continue;

    const truthEvil = new Set(evil);
    const f = of("faction");
    let b = 0, l = 0;
    const ranked: { id: string; p: number }[] = [];
    for (const player of game.players) {
      let p: number;
      if (roles) {
        p = 0;
        for (const r of EVIL) p += roles.byPlayer.get(player.id)?.get(r) ?? 0;
      } else {
        p = side.evilProbability.get(player.id) ?? evilCount(game.playerCount) / game.playerCount;
      }
      const y = truthEvil.has(player.id) ? 1 : 0;
      b += (p - y) ** 2;
      l -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
      ranked.push({ id: player.id, p });
    }
    f.brierPerGame.push(b / game.players.length);
    f.logLossPerGame.push(l / game.players.length);
    ranked.sort((x, y) => y.p - x.p);
    const k = evilCount(game.playerCount);
    let caught = 0;
    for (const r of ranked.slice(0, k)) if (truthEvil.has(r.id)) caught += 1;
    f.hitPerGame.push(caught / k);

    if (!roles) continue;
    for (const role of ROLES) {
      const seat = truth.roles.get(role);
      if (!seat) continue;
      const a = of(role);
      let rb = 0, rl = 0, best = "", bestP = -1;
      for (const player of game.players) {
        const p = roles.byPlayer.get(player.id)?.get(role) ?? 0;
        const y = player.id === seat ? 1 : 0;
        rb += (p - y) ** 2;
        rl -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
        if (p > bestP) { bestP = p; best = player.id; }
      }
      a.brierPerGame.push(rb / game.players.length);
      a.logLossPerGame.push(rl / game.players.length);
      a.hitPerGame.push(best === seat ? 1 : 0);
    }
  }
  return acc;
}

it("scores Belief Engine V1 on the test split, once", () => {
  const test = corpusSplit("test", { limit: 320 });
  const ROUNDS = [1, 2, 3, 4, 5];
  console.log("");
  console.log(`留出集 ${test.length} 局（7–10 人）— 唯一一次评估`);

  const grid = MODELS.map((m) => ROUNDS.map((r) => evaluate(test, r, m.opts)));

  const NAME: Record<string, string> = {
    faction: "阵营", merlin: "梅林", percival: "派西维尔", morgana: "莫甘娜",
    mordred: "莫德雷德", oberon: "奥伯伦", assassin: "刺客",
  };

  for (const key of ["faction", ...ROLES]) {
    console.log("");
    console.log(`【${NAME[key]}】`);
    console.log("模型             指标        R1       R2       R3       R4       R5");
    MODELS.forEach((m, i) => {
      const cells = grid[i].map((g) => g.get(key));
      if (cells.every((c) => !c || !c.brierPerGame.length)) return;
      const row = (name: string, pick: (a: Acc) => number[]) =>
        console.log(
          m.label.padEnd(16) + name.padEnd(11) +
            cells.map((c) => {
              if (!c || !pick(c).length) return "       —";
              const arr = pick(c);
              return (arr.reduce((x, y) => x + y, 0) / arr.length).toFixed(4).padStart(8);
            }).join(" "),
        );
      row("Brier ↓", (a) => a.brierPerGame);
      row("LogLoss ↓", (a) => a.logLossPerGame);
      row("Top-1 ↑", (a) => a.hitPerGame);
    });
    // 95% interval on the metric most exposed to a small sample.
    const last = grid[2][4]?.get(key);
    if (last?.hitPerGame.length) {
      const ci = bootstrap(last.hitPerGame);
      console.log(
        `λ=0.4 的 R5 Top-1 95% 区间   [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]   n=${last.hitPerGame.length} 局`,
      );
    }
  }

  console.log("");
  console.log("【按人数：阵营 Brier，λ=0.4，带 95% 区间】");
  console.log("人数   局数     R3 Brier [区间]              R5 Brier [区间]");
  for (const count of [7, 8, 9, 10]) {
    const subset = corpusSplit("test", { limit: 320, playerCount: count });
    if (subset.length < 10) { console.log(`${count} 人   样本不足 (${subset.length})`); continue; }
    const cells = [3, 5].map((r) => {
      const a = evaluate(subset, r, { roleTemperature: 0.4 }).get("faction");
      if (!a?.brierPerGame.length) return "—";
      const ci = bootstrap(a.brierPerGame);
      return `${ci.mean.toFixed(4)} [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]`;
    });
    console.log(`${String(count).padStart(2)} 人  ${String(subset.length).padStart(5)}    ${cells[0].padEnd(28)} ${cells[1]}`);
  }
}, 5_400_000);
