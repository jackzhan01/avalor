import { describe, expect, it } from "vitest";
import { informationSets } from "@/lib/decision/rollout";
import type { RoleType } from "@/lib/types/game";
import { dealRoles } from "./deal";
import { makeRng } from "./rng";
import { knowledgeFor } from "./visibility";
import { SEATS, type Seat } from "./types";

/**
 * `visibility.ts` is the simulator's third implementation of who-sees-what.
 * The other two are `visionFor()` in the rules file and `informationSets()` in
 * the frozen decision layer, and the point of a third is that the simulator
 * does not have to import the decision graph to play a game.
 *
 * A third implementation is also a third chance to be wrong, so this pins it
 * against the one that already runs inside a rollout. Like `rng.equivalence`,
 * this is a test — the only context where importing a frozen module is allowed.
 *
 * `informationSets` speaks in player ids ("p1".."p10") and in `InfoSet`, which
 * carries `visibleEvil` for Merlin, `knownEvil` for a recognising villain and
 * `pair` for Percival. The mapping below is the whole translation.
 */

const seatId = (seat: Seat) => `p${seat}`;
const seatOf = (id: string) => Number(id.slice(1)) as Seat;

describe("the simulator's visibility matches the decision layer's", () => {
  it("agrees on every seat, over three hundred random deals", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const deal = dealRoles(makeRng(seed));
      const assignment = new Map<string, RoleType>(
        SEATS.map((seat) => [seatId(seat), deal.bySeat[seat]]),
      );
      const theirs = informationSets(assignment);

      for (const seat of SEATS) {
        const info = theirs.get(seatId(seat));
        if (!info) throw new Error(`decision layer produced no info set for ${seat}`);
        const mine = knowledgeFor(deal, seat);
        const role = deal.bySeat[seat];

        const theirVisible = [...info.visibleEvil].map(seatOf).sort((a, b) => a - b);
        const theirKnown = [...info.knownEvil].map(seatOf).sort((a, b) => a - b);
        const theirPair = info.pair ? info.pair.map(seatOf).sort((a, b) => a - b) : null;

        if (role === "merlin") {
          expect(mine.kind).toBe("sees_evil");
          if (mine.kind !== "sees_evil") throw new Error("unreachable");
          expect([...mine.seats]).toEqual(theirVisible);
          expect(theirKnown).toEqual([]);
          continue;
        }

        if (role === "percival") {
          expect(mine.kind).toBe("merlin_or_morgana");
          if (mine.kind !== "merlin_or_morgana") throw new Error("unreachable");
          expect([...mine.pair]).toEqual(theirPair);
          continue;
        }

        if (role === "morgana" || role === "mordred" || role === "assassin") {
          expect(mine.kind).toBe("knows_teammates");
          if (mine.kind !== "knows_teammates") throw new Error("unreachable");
          expect([...mine.seats]).toEqual(theirKnown);
          expect(theirVisible).toEqual([]);
          continue;
        }

        // Loyal servants and Oberon: both implementations show nothing.
        expect(mine).toEqual({ kind: "none" });
        expect(theirVisible).toEqual([]);
        expect(theirKnown).toEqual([]);
        expect(theirPair).toBeNull();
      }
    }
  });

  it("agrees that Oberon is invisible to his own side", () => {
    // Stated separately because it is the rule most often implemented as "evil
    // sees all other evils", which passes a casual review and is wrong.
    for (let seed = 1; seed <= 50; seed += 1) {
      const deal = dealRoles(makeRng(seed));
      const assignment = new Map<string, RoleType>(
        SEATS.map((seat) => [seatId(seat), deal.bySeat[seat]]),
      );
      const theirs = informationSets(assignment);
      for (const seat of [deal.morgana, deal.mordred, deal.assassin]) {
        expect([...theirs.get(seatId(seat))!.knownEvil]).not.toContain(seatId(deal.oberon));
      }
      expect([...theirs.get(seatId(deal.oberon))!.knownEvil]).toEqual([]);
    }
  });
});
