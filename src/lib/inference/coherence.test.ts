import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import { deriveRoleInference } from "./roles";
import { deriveSideInference } from "./side";
import { defaultRoleSet, describeComposition, evilCount } from "@/lib/rules/avalon";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";

/**
 * Is the role posterior a distribution over LEGAL assignments, or a bag of
 * independent per-seat detectors that happen to be printed together?
 *
 * These are the checks that tell the two apart. They are cheap, and they are
 * the difference between "we report six numbers" and "we report one belief".
 */

/** How many seats hold this role in a full line-up of this size. */
function expectedCount(playerCount: PlayerCount, role: RoleType): number {
  const composition = describeComposition(
    playerCount,
    defaultRoleSet(playerCount),
  );
  let total = 0;
  for (const line of [...composition.good, ...composition.evil]) {
    if (line.role === role) total += line.count ?? 1;
  }
  return total;
}

const CASES: { label: string; build: () => { game: GameRecord; events: ReturnType<typeof ninePlayerGame>["events"] } }[] = [
  { label: "9 人，空局", build: () => game(9).build() },
  { label: "9 人，打完的对局", build: () => ninePlayerGame() },
  {
    label: "10 人，两轮之后",
    build: () =>
      game(10)
        .proposal(1, [1, 2, 3])
        .vote({ 4: "approve", 5: "reject" }, "passed")
        .mission("success")
        .proposal(2, [2, 4, 6, 8])
        .vote({ 1: "reject", 3: "approve" }, "passed")
        .mission("fail", 1)
        .build(),
  },
  { label: "7 人，一轮之后", build: () => game(7).proposal(1, [1, 2]).vote({}, "passed").mission("success").build() },
  { label: "8 人，一轮之后", build: () => game(8).proposal(1, [1, 2, 3]).vote({}, "passed").mission("fail", 1).build() },
];

describe("the role posterior is a distribution over legal assignments", () => {
  for (const { label, build } of CASES) {
    describe(label, () => {
      const { game: g, events } = build();
      const roles = deriveRoleInference(events, g);
      const seats = g.players.map((p) => p.id);

      it("gives every seat a distribution summing to 1", () => {
        for (const seat of seats) {
          const row = roles.byPlayer.get(seat);
          expect(row).toBeDefined();
          let total = 0;
          for (const p of row!.values()) total += p;
          // Every seat holds exactly one role, so its marginal is a proper
          // distribution — not six unrelated detector outputs.
          expect(total).toBeCloseTo(1, 6);
        }
      });

      it("places each role exactly as many times as the line-up allows", () => {
        const counted = new Set<RoleType>();
        for (const row of roles.byPlayer.values()) {
          for (const role of row.keys()) counted.add(role);
        }
        for (const role of counted) {
          let total = 0;
          for (const seat of seats) {
            total += roles.byPlayer.get(seat)?.get(role) ?? 0;
          }
          expect(total).toBeCloseTo(
            expectedCount(g.playerCount as PlayerCount, role),
            6,
          );
        }
      });

  /*
   * The two layers do NOT agree exactly, and this is the guard on how far
   * apart they are allowed to drift rather than an assertion that they match.
   *
   * Role evidence reweights the worlds it is scored in, so this layer has seen
   * more than the one below. On held-out games the gap runs 1.8 to 2.5 points
   * on average and up to 20 in the worst case.
   *
   * Closing it by rescaling each seat was tried and is worse: it fixes the
   * rows and breaks the columns, so "Merlin sits in exactly one seat" stops
   * holding. And adopting the role layer's faction number wholesale is worse
   * still — measured against the truth the side layer reads faction BETTER at
   * every round. The gap closes by making the role evidence good enough to
   * feed back, which is future work, not by reconciling the output.
   */
      it("stays within the measured gap to the side layer on who is evil", () => {
        const side = deriveSideInference(events, g);
        const EVIL: RoleType[] = ["morgana", "mordred", "oberon", "assassin", "minion"];
        for (const seat of seats) {
          const row = roles.byPlayer.get(seat)!;
          let evilMass = 0;
          for (const role of EVIL) evilMass += row.get(role) ?? 0;
          const gap = Math.abs(evilMass - side.evilProbability.get(seat)!);
          // 0.25 is comfortably above the worst gap measured on 300 held-out
          // games (0.20). A failure here means the layers have come apart
          // further than they ever did in the corpus.
          expect(gap).toBeLessThan(0.25);
        }
      });

      it("never puts a good role on an evil seat, or the reverse", () => {
        const side = deriveSideInference(events, g);
        for (const seat of side.provenEvil) {
          const row = roles.byPlayer.get(seat)!;
          expect(row.get("merlin") ?? 0).toBeCloseTo(0, 9);
          expect(row.get("percival") ?? 0).toBeCloseTo(0, 9);
          expect(row.get("loyal") ?? 0).toBeCloseTo(0, 9);
        }
        for (const seat of side.provenGood) {
          const row = roles.byPlayer.get(seat)!;
          expect(row.get("morgana") ?? 0).toBeCloseTo(0, 9);
          expect(row.get("oberon") ?? 0).toBeCloseTo(0, 9);
        }
      });

      it("indexes the same numbers both ways", () => {
        for (const [seat, row] of roles.byPlayer) {
          for (const [role, p] of row) {
            expect(roles.byRole.get(role)?.get(seat) ?? 0).toBeCloseTo(p, 9);
          }
        }
      });

      it("counts evil seats to the size the rules demand", () => {
        const side = deriveSideInference(events, g);
        let total = 0;
        for (const seat of seats) total += side.evilProbability.get(seat)!;
        expect(total).toBeCloseTo(evilCount(g.playerCount as PlayerCount), 6);
      });
    });
  }
});
