import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import { deriveRoleInference } from "@/lib/inference";
import type { RoleType } from "@/lib/types/game";
import { makeRng, sampleAssignments } from "./sampler";

/**
 * The sampler must draw from the SAME distribution the frozen engine reports.
 *
 * It reads through the engine's own enumeration rather than repeating it, and
 * this closes the loop from the other side: draw a lot of worlds, count how
 * often each seat holds each role, and check the frequencies land on the
 * engine's marginals.
 */
describe("sampled worlds reproduce the frozen marginals", () => {
  for (const [label, build] of [
    ["9 人，打完的对局", () => ninePlayerGame()],
    [
      "10 人，两轮之后",
      () =>
        game(10)
          .proposal(1, [1, 2, 3])
          .vote({ 4: "approve", 5: "reject" }, "passed")
          .mission("success")
          .proposal(2, [2, 4, 6, 8])
          .vote({ 1: "reject", 3: "approve" }, "passed")
          .mission("fail", 1)
          .build(),
    ],
  ] as const) {
    it(label, () => {
      const { game: g, events } = build();
      const truth = deriveRoleInference(events, g);
      const draws = 4000;
      const worlds = sampleAssignments(events, g, draws, makeRng(20260819));
      expect(worlds).toHaveLength(draws);

      const seen = new Map<string, Map<RoleType, number>>();
      for (const world of worlds) {
        for (const [seat, role] of world) {
          let row = seen.get(seat);
          if (!row) seen.set(seat, (row = new Map()));
          row.set(role, (row.get(role) ?? 0) + 1);
        }
      }

      let worst = 0;
      for (const player of g.players) {
        const row = truth.byPlayer.get(player.id)!;
        for (const [role, p] of row) {
          const observed = (seen.get(player.id)?.get(role) ?? 0) / draws;
          worst = Math.max(worst, Math.abs(observed - p));
        }
      }
      // Sampling without replacement from a weighted population; 0.05 is well
      // inside what 4,000 draws support and far below any real disagreement.
      expect(worst).toBeLessThan(0.05);
    });
  }

  it("is reproducible from a seed", () => {
    const { game: g, events } = ninePlayerGame();
    const a = sampleAssignments(events, g, 50, makeRng(7));
    const b = sampleAssignments(events, g, 50, makeRng(7));
    expect(a.map((m) => [...m].sort().join())).toEqual(
      b.map((m) => [...m].sort().join()),
    );
  });

  it("never returns an illegal casting", () => {
    const { game: g, events } = ninePlayerGame();
    for (const world of sampleAssignments(events, g, 200, makeRng(3))) {
      expect(world.size).toBe(g.players.length);
      const merlins = [...world.values()].filter((r) => r === "merlin").length;
      expect(merlins).toBeLessThanOrEqual(1);
    }
  });
});
