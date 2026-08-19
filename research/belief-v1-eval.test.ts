import { describe, it } from "vitest";
import { computeRolesWith, type RoleOptions } from "@/lib/inference/roles";
import { deriveSideInference } from "@/lib/inference/side";
import { evilCount } from "@/lib/rules/avalon";
import { EVIL_ROLES, type RoleType } from "@/lib/types/game";
import { loadCorpus } from "./corpus-load";

/**
 * The belief engine, scored end to end on held-out games.
 *
 * Three models, one table. The joint role posterior is the canonical one and
 * its faction row is the Evil marginal of the same distribution, so every row
 * comes from one belief rather than from a bag of detectors. The faction-only
 * model is reported beside it as the specialised baseline it is.
 */

const EVIL_SET = new Set<RoleType>(EVIL_ROLES);
const ROLES: RoleType[] = [
  "merlin",
  "percival",
  "morgana",
  "mordred",
  "oberon",
  "assassin",
];

function cut(events: ReturnType<typeof loadCorpus>[number]["events"], n: number) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "mission" && ++seen === n) return events.slice(0, i + 1);
  }
  return null;
}

interface Row {
  brier: number;
  logLoss: number;
  top1: number;
  games: number;
}

/** `null` opts means the faction-only baseline: no role posterior at all. */
function evaluate(
  corpus: ReturnType<typeof loadCorpus>,
  round: number,
  opts: RoleOptions | null,
) {
  const acc = new Map<string, { brier: number; logLoss: number; hits: number; seats: number; games: number }>();
  const cell = (k: string) => {
    let c = acc.get(k);
    if (!c) acc.set(k, (c = { brier: 0, logLoss: 0, hits: 0, seats: 0, games: 0 }));
    return c;
  };

  for (const { game, events, evil, truth } of corpus) {
    const pre = cut(events, round);
    if (!pre) continue;
    const side = deriveSideInference(pre, game);
    const roles = opts ? computeRolesWith(pre, game, opts) : null;
    if (roles?.contradictory) continue;

    // Faction: from the joint posterior when there is one, else the side layer.
    const truthEvil = new Set(evil);
    const f = cell("faction");
    f.games += 1;
    const ranked: { id: string; p: number }[] = [];
    for (const player of game.players) {
      let p: number;
      if (roles) {
        p = 0;
        for (const r of EVIL_SET) p += roles.byPlayer.get(player.id)?.get(r) ?? 0;
      } else {
        p = side.evilProbability.get(player.id) ?? evilCount(game.playerCount) / game.playerCount;
      }
      const y = truthEvil.has(player.id) ? 1 : 0;
      f.brier += (p - y) ** 2;
      f.logLoss -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
      f.seats += 1;
      ranked.push({ id: player.id, p });
    }
    ranked.sort((a, b) => b.p - a.p);
    const k = evilCount(game.playerCount);
    let caught = 0;
    for (const r of ranked.slice(0, k)) if (truthEvil.has(r.id)) caught += 1;
    f.hits += caught / k;

    if (!roles) continue;
    for (const role of ROLES) {
      const seat = truth.roles.get(role);
      if (!seat) continue;
      const c = cell(role);
      c.games += 1;
      let best = "", bestP = -1;
      for (const player of game.players) {
        const p = roles.byPlayer.get(player.id)?.get(role) ?? 0;
        const y = player.id === seat ? 1 : 0;
        c.brier += (p - y) ** 2;
        c.logLoss -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
        c.seats += 1;
        if (p > bestP) { bestP = p; best = player.id; }
      }
      if (best === seat) c.hits += 1;
    }
  }

  const out = new Map<string, Row>();
  for (const [k, c] of acc) {
    out.set(k, {
      brier: c.seats ? c.brier / c.seats : NaN,
      logLoss: c.seats ? c.logLoss / c.seats : NaN,
      top1: c.games ? c.hits / c.games : NaN,
      games: c.games,
    });
  }
  return out;
}

describe("belief engine V1", () => {
  const corpus = loadCorpus().filter(
    (c) => c.game.playerCount >= 7 && c.game.playerCount <= 10,
  );
  const test = corpus.filter((_, i) => i % 2 === 1).slice(0, 300);
  const ROUNDS = [1, 2, 3, 4, 5];
  const MODELS: { label: string; opts: RoleOptions | null }[] = [
    { label: "只有阵营（基线）", opts: null },
    { label: "联合后验 λ=1", opts: { roleTemperature: 1 } },
    { label: "联合后验 λ=0.3", opts: { roleTemperature: 0.3 } },
  ];

  it("scores every role three ways at every round", () => {
    console.log("");
    console.log(`留出集 ${test.length} 局（7–10 人）`);
    const grid = MODELS.map((m) => ROUNDS.map((r) => evaluate(test, r, m.opts)));

    for (const key of ["faction", ...ROLES]) {
      const label =
        key === "faction" ? "阵营" :
        key === "merlin" ? "梅林" :
        key === "percival" ? "派西维尔" :
        key === "morgana" ? "莫甘娜" :
        key === "mordred" ? "莫德雷德" :
        key === "oberon" ? "奥伯伦" : "刺客";
      console.log("");
      console.log(`【${label}】`);
      console.log("模型             指标        R1       R2       R3       R4       R5");
      MODELS.forEach((m, i) => {
        const cells = grid[i].map((g) => g.get(key));
        if (cells.every((c) => !c)) return;
        const row = (name: string, pick: (r: Row) => number) =>
          console.log(
            m.label.padEnd(16) + name.padEnd(11) +
              cells.map((c) => (c && !Number.isNaN(pick(c)) ? pick(c).toFixed(4).padStart(8) : "       —")).join(" "),
          );
        row("Brier ↓", (r) => r.brier);
        row("LogLoss ↓", (r) => r.logLoss);
        row("Top-1 ↑", (r) => r.top1);
      });
      console.log(
        "局数".padEnd(18) + "         " +
          grid[2].map((g) => String(g.get(key)?.games ?? 0).padStart(8)).join(" "),
      );
    }
  }, 3_600_000);
});
