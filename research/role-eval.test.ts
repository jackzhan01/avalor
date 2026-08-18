import { describe, expect, it } from "vitest";
import { deriveRoleInference } from "@/lib/inference/roles";
import { loadCorpus } from "./corpus-load";
import { goodCount } from "@/lib/rules/avalon";
import type { RoleType } from "@/lib/types/game";

/**
 * How good is "who is Merlin", measured against the truth?
 *
 * The side layer has had a calibration number since the corpus landed; the
 * role layer never has, which meant its behavioural evidence went in on the
 * strength of a plausible story and a demo. This closes that gap — the same
 * Brier score, asked of the role marginals.
 *
 * Scored from a SPECTATOR's seat: the corpus carries no viewer, so there is no
 * vision and nothing is forced. Whatever separation appears is produced purely
 * by how people voted, which is exactly the thing under test.
 */

/** Role layer enumeration is expensive; a sample of games is plenty. */
const SAMPLE = 600;

interface RoleScore {
  brier: number;
  baseline: number;
  top1: number;
  baselineTop1: number;
  n: number;
}

function evaluate(role: RoleType, tables: number[]): RoleScore {
  const corpus = loadCorpus()
    .filter((c) => tables.includes(c.game.playerCount))
    .filter((_, i) => i % 2 === 1)
    .slice(0, SAMPLE);

  let brier = 0;
  let baseline = 0;
  let hits = 0;
  let baselineHits = 0;
  let seats = 0;
  let games = 0;

  for (const { game, events, truth } of corpus) {
    const holder = truth.roles.get(role);
    if (!holder) continue; // role not in this game
    const inference = deriveRoleInference(events, game);
    const row = inference.byRole.get(role);
    if (!row) continue;

    // Uniform over the seats that could hold it, as the null model.
    const candidates =
      role === "merlin" || role === "percival"
        ? goodCount(game.playerCount)
        : game.playerCount - goodCount(game.playerCount);
    const flat = 1 / candidates;

    let best: { id: string; p: number } | null = null;
    for (const player of game.players) {
      const p = row.get(player.id) ?? 0;
      const y = player.id === holder ? 1 : 0;
      brier += (p - y) ** 2;
      baseline += (flat - y) ** 2;
      seats += 1;
      if (!best || p > best.p) best = { id: player.id, p };
    }
    if (best?.id === holder) hits += 1;
    baselineHits += 1 / candidates;
    games += 1;
  }

  return {
    brier: brier / seats,
    baseline: baseline / seats,
    top1: hits / games,
    baselineTop1: baselineHits / games,
    n: games,
  };
}

/**
 * The scenario the feature is actually used in.
 *
 * A spectator has to solve sides and roles at once, and the leftover doubt
 * about sides smears the role marginals. An evil player has no such doubt: he
 * was dealt his teammates, so "who is Merlin" is the only open question and
 * the six good seats are the whole search space. That is a different — and
 * much sharper — problem, and it is the one the user has.
 */
function evaluateAsEvil(): RoleScore {
  const corpus = loadCorpus()
    .filter((c) => [7, 8, 9].includes(c.game.playerCount))
    .filter((_, i) => i % 2 === 1)
    .slice(0, SAMPLE);

  let brier = 0;
  let baseline = 0;
  let hits = 0;
  let baselineHits = 0;
  let seats = 0;
  let games = 0;

  for (const { game, events, evil, truth } of corpus) {
    const holder = truth.roles.get("merlin");
    if (!holder || evil.length < 2) continue;

    // Cast the user as one evil seat who can see the rest of his team.
    const me = evil[0];
    const vision: typeof events = evil
      .filter((id) => id !== me)
      .map((id, i) => ({
        id: `v${i}`,
        gameId: game.id,
        missionNumber: 1,
        sequence: 100000 + i,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "role_mark",
        targetId: id,
        mark: { kind: "side", side: "evil" },
        certainty: "known",
      })) as typeof events;

    const withVision = { ...game, viewerPlayerId: me, viewerRole: "assassin" as const };
    const inference = deriveRoleInference([...events, ...vision], withVision);
    const row = inference.byRole.get("merlin");
    if (!row) continue;

    const candidates = game.playerCount - evil.length;
    const flat = 1 / candidates;
    let best: { id: string; p: number } | null = null;
    for (const player of game.players) {
      const p = row.get(player.id) ?? 0;
      const y = player.id === holder ? 1 : 0;
      brier += (p - y) ** 2;
      // Null model: uniform over the good seats only, since sides are known.
      baseline += ((evil.includes(player.id) ? 0 : flat) - y) ** 2;
      seats += 1;
      if (!best || p > best.p) best = { id: player.id, p };
    }
    if (best?.id === holder) hits += 1;
    baselineHits += flat;
    games += 1;
  }

  return {
    brier: brier / seats,
    baseline: baseline / seats,
    top1: hits / games,
    baselineTop1: baselineHits / games,
    n: games,
  };
}

describe("role layer accuracy", () => {
  it("finds Merlin from an evil seat, where sides are already known", () => {
    const s = evaluateAsEvil();
    console.log("\n坏人视角找梅林（阵营已知，只剩好人堆里挑）");
    console.log("            Brier ↓    均匀分布    猜中率     瞎猜      局数");
    console.log("─".repeat(62));
    console.log(
      "  实测参数",
      s.brier.toFixed(4).padStart(9),
      s.baseline.toFixed(4).padStart(11),
      `${(s.top1 * 100).toFixed(1)}%`.padStart(9),
      `${(s.baselineTop1 * 100).toFixed(1)}%`.padStart(9),
      String(s.n).padStart(9),
    );
    const lift = ((s.top1 - s.baselineTop1) / s.baselineTop1) * 100;
    console.log(
      `\n猜中率相对瞎猜提升 ${lift >= 0 ? "+" : ""}${lift.toFixed(1)}%，` +
        `Brier 改善 ${(((s.baseline - s.brier) / s.baseline) * 100).toFixed(1)}%`,
    );
    expect(s.top1).toBeGreaterThan(s.baselineTop1);
  }, 900000);

  it("scores Merlin, Percival and Mordred against the truth", () => {
    console.log("\n从旁观者视角找角色（无任何视野，纯靠投票行为）");
    console.log("角色        Brier ↓   均匀分布   猜中率    瞎猜     局数");
    console.log("─".repeat(62));

    const rows: [RoleType, string, number[]][] = [
      ["merlin", "梅林", [5, 6, 7, 8, 9]],
      ["percival", "派西维尔", [5, 6, 7, 8, 9]],
      ["mordred", "莫德雷德", [7, 8, 9, 10]],
    ];

    for (const [role, label, tables] of rows) {
      const s = evaluate(role, tables);
      if (!s.n) continue;
      const better = ((s.baseline - s.brier) / s.baseline) * 100;
      console.log(
        label.padEnd(10),
        s.brier.toFixed(4).padStart(8),
        s.baseline.toFixed(4).padStart(10),
        `${(s.top1 * 100).toFixed(1)}%`.padStart(8),
        `${(s.baselineTop1 * 100).toFixed(1)}%`.padStart(8),
        String(s.n).padStart(8),
        better > 0 ? `  (好 ${better.toFixed(1)}%)` : `  (差 ${(-better).toFixed(1)}%)`,
      );
    }

    // Merlin is the one the feature exists for; it must beat guessing.
    const merlin = evaluate("merlin", [5, 6, 7, 8, 9]);
    expect(merlin.brier).toBeLessThan(merlin.baseline);
  }, 900000);
});
