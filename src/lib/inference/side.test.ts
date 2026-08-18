import { describe, expect, it } from "vitest";
import { deriveSideInference, initialEntropyBits } from "./side";
import { enumerateHypotheses } from "./hypotheses";
import { game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";

/**
 * Every test here is a claim about what the RULES imply. If one of these ever
 * needs "and the model thinks..." to pass, the layer has been corrupted.
 */

describe("enumerateHypotheses", () => {
  it("produces C(n, evilCount) splits at each table size", () => {
    const sizes: [5 | 6 | 7 | 8 | 9 | 10, number][] = [
      [5, 10],
      [6, 15],
      [7, 35],
      [8, 56],
      [9, 84],
      [10, 210],
    ];
    for (const [players, expected] of sizes) {
      const { game: g } = game(players).build();
      expect(enumerateHypotheses(g)).toHaveLength(expected);
    }
  });

  it("gives every hypothesis exactly the right number of evil seats", () => {
    const { game: g } = game(10).build();
    for (const h of enumerateHypotheses(g)) {
      expect(h.evil).toHaveLength(4);
      expect(new Set(h.evil).size).toBe(4);
    }
  });

  it("is stable across calls", () => {
    const { game: g } = game(9).build();
    const a = enumerateHypotheses(g).map((h) => h.evil.join(","));
    const b = enumerateHypotheses(g).map((h) => h.evil.join(","));
    expect(a).toEqual(b);
  });
});

describe("a successful mission proves nothing", () => {
  it("eliminates no hypothesis, because evil may play success", () => {
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("success", 0)
      .build();

    const result = deriveSideInference(events, g);
    expect(result.surviving).toHaveLength(84);
    expect(result.eliminations).toHaveLength(0);
  });
});

describe("failed missions", () => {
  it("requires at least one evil on a failed team", () => {
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();

    const result = deriveSideInference(events, g);
    // Only the splits placing all three evils outside 1/2/3 are impossible.
    expect(result.surviving).toHaveLength(84 - 20);
    for (const h of result.surviving) {
      expect(h.evil.some((id) => ["p1", "p2", "p3"].includes(id))).toBe(true);
    }
  });

  it("uses the recorded fail count when it is stronger than the rule", () => {
    // Two fail cards means two distinct evil seats were on that team, which is
    // a much stronger claim than mission 1's "at least one".
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 2)
      .build();

    const result = deriveSideInference(events, g);
    for (const h of result.surviving) {
      const onTeam = h.evil.filter((id) => ["p1", "p2", "p3"].includes(id));
      expect(onTeam.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("constrains on fail cards even when the mission SUCCEEDED", () => {
    // Mission 4 at 9 players needs two fails. One fail card still means one
    // evil was aboard, even though the quest passed — a fact a naive
    // implementation that keys off `result` alone would throw away.
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("success", 0)
      .proposal(2, [1, 2, 3, 4])
      .vote({}, "passed")
      .mission("success", 0)
      .proposal(3, [1, 2, 3, 4])
      .vote({}, "passed")
      .mission("success", 0)
      .proposal(4, [4, 5, 6, 7, 8])
      .vote({}, "passed")
      .mission("success", 1)
      .build();

    const result = deriveSideInference(events, g);
    for (const h of result.surviving) {
      expect(
        h.evil.some((id) => ["p4", "p5", "p6", "p7", "p8"].includes(id)),
      ).toBe(true);
    }
    expect(result.eliminations.some((e) => e.kind === "mission_fail")).toBe(true);
  });
});

describe("the user's own role", () => {
  it("rules out every split that makes a good viewer evil", () => {
    const { game: g, events } = game(9).build();
    const withRole = { ...g, viewerPlayerId: "p1", viewerRole: "loyal" as const };

    const result = deriveSideInference(events, withRole);
    expect(result.surviving).toHaveLength(56); // C(8,3)
    expect(result.provenGood).toContain("p1");
    expect(result.evilFrequency.get("p1")).toBe(0);
  });

  it("forces an evil viewer into every surviving split", () => {
    const { game: g, events } = game(9).build();
    const withRole = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "assassin" as const,
    };

    const result = deriveSideInference(events, withRole);
    expect(result.surviving).toHaveLength(28); // C(8,2)
    expect(result.provenEvil).toContain("p1");
    expect(result.evilFrequency.get("p1")).toBe(1);
  });
});

describe("vision", () => {
  it("collapses Merlin's world to the seats he cannot see", () => {
    // Merlin at seat 1 sees two evils; the third is Mordred, hidden from him.
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .build();
    const asMerlin = { ...g, viewerPlayerId: "p1", viewerRole: "merlin" as const };

    const result = deriveSideInference(events, asMerlin);
    // 4 and 6 are evil, 1 is good, so Mordred is one of the other six seats.
    expect(result.surviving).toHaveLength(6);
    expect(result.provenEvil).toEqual(expect.arrayContaining(["p4", "p6"]));
    expect(result.provenGood).toContain("p1");
    expect(result.entropyBits).toBeCloseTo(Math.log2(6), 5);
  });

  it("ignores guesses — they are what this layer exists to check", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "guess")
      .build();

    const result = deriveSideInference(events, g);
    expect(result.surviving).toHaveLength(84);
    expect(result.eliminations).toHaveLength(0);
  });

  it("treats a role mark as a side constraint", () => {
    const { game: g, events } = game(9)
      .mark(5, { kind: "role", role: "morgana" }, "known")
      .build();

    const result = deriveSideInference(events, g);
    expect(result.provenEvil).toContain("p5");
    expect(result.surviving).toHaveLength(28); // C(8,2)
  });
});

describe("Percival's pair", () => {
  it("constrains the pair jointly, never either seat alone", () => {
    const { game: g, events } = game(9)
      .mark(3, { kind: "merlin_or_morgana" }, "known")
      .mark(7, { kind: "merlin_or_morgana" }, "known")
      .build();
    const asPercival = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "percival" as const,
    };

    const result = deriveSideInference(events, asPercival);
    // Exactly one of 3/7 is Morgana; the other two evils come from the six
    // seats that are neither Percival nor the pair: 2 * C(6,2) = 30.
    expect(result.surviving).toHaveLength(30);
    for (const h of result.surviving) {
      expect((h.isEvil("p3") ? 1 : 0) + (h.isEvil("p7") ? 1 : 0)).toBe(1);
    }
    // Neither seat is proven either way — that is the whole point of the pair.
    expect(result.provenEvil).not.toContain("p3");
    expect(result.provenGood).not.toContain("p3");
    expect(result.evilFrequency.get("p3")).toBeCloseTo(0.5, 5);
    expect(result.evilFrequency.get("p7")).toBeCloseTo(0.5, 5);
  });

  it("does nothing with only one seat of the pair marked", () => {
    const { game: g, events } = game(9)
      .mark(3, { kind: "merlin_or_morgana" }, "known")
      .build();

    const result = deriveSideInference(events, g);
    expect(result.surviving).toHaveLength(84);
  });
});

describe("a real recorded game", () => {
  it("narrows the ninePlayerGame fixture only as far as the facts allow", () => {
    const { game: g, events } = ninePlayerGame();
    const result = deriveSideInference(events, g);

    // One failed mission (2/4/6/8), and successes prove nothing — so the only
    // splits removed are those with all three evils outside that team.
    expect(result.total).toBe(84);
    expect(result.surviving).toHaveLength(74);
    expect(result.eliminations).toHaveLength(1);
    expect(result.eliminations[0].kind).toBe("mission_fail");
    expect(result.eliminations[0].eliminated).toBe(10);
    // Nothing is provable from this little — and the layer says so rather than
    // reaching for a guess.
    expect(result.provenEvil).toHaveLength(0);
    expect(result.provenGood).toHaveLength(0);
  });
});

describe("degenerate logs", () => {
  it("reports a contradiction instead of dividing by zero", () => {
    // 1, 2 and 3 are all known good, yet a team of exactly those three failed.
    const { game: g, events } = game(9)
      .mark(1, { kind: "side", side: "good" }, "known")
      .mark(2, { kind: "side", side: "good" }, "known")
      .mark(3, { kind: "side", side: "good" }, "known")
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();

    const result = deriveSideInference(events, g);
    expect(result.contradictory).toBe(true);
    expect(result.surviving).toHaveLength(0);
    expect(result.evilFrequency.get("p1")).toBe(0);
    expect(Number.isFinite(result.entropyBits)).toBe(true);
  });

  it("returns the full space for an empty log", () => {
    const { game: g, events } = game(9).build();
    const result = deriveSideInference(events, g);
    expect(result.surviving).toHaveLength(84);
    expect(result.entropyBits).toBeCloseTo(initialEntropyBits(g), 5);
  });
});

describe("memoisation", () => {
  it("returns the identical object for an unchanged log", () => {
    const { game: g, events } = ninePlayerGame();
    expect(deriveSideInference(events, g)).toBe(deriveSideInference(events, g));
  });
});
