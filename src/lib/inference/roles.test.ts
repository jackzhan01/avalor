import { describe, expect, it } from "vitest";
import { deriveRoleInference, isConfidentAbout, likeliestHolder } from "./roles";
import { game, approveOnly } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import type { GameRecord } from "@/lib/types/game";

/** 9-player default set: 梅林 派 忠臣×4 / 莫甘娜 刺客 莫德雷德. */
function nineWith(patch: Partial<GameRecord>) {
  const { game: g, events } = game(9).build();
  return { game: { ...g, ...patch }, events };
}

describe("probabilities are well formed", () => {
  it("gives each seat a distribution summing to 1", () => {
    const { game: g, events } = ninePlayerGame();
    const inference = deriveRoleInference(events, g);

    for (const player of g.players) {
      const row = inference.byPlayer.get(player.id)!;
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("gives each role a distribution summing to 1 across seats", () => {
    const { game: g, events } = ninePlayerGame();
    const inference = deriveRoleInference(events, g);

    for (const role of ["merlin", "percival", "morgana", "mordred", "assassin"] as const) {
      const row = inference.byRole.get(role)!;
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("never places a role at a table size that has none", () => {
    // A 9-player game has no Oberon.
    const { game: g, events } = ninePlayerGame();
    const inference = deriveRoleInference(events, g);
    expect(inference.byRole.has("oberon")).toBe(false);
  });

  it("spreads a role uniformly when nothing is known", () => {
    const { game: g, events } = nineWith({});
    const inference = deriveRoleInference(events, g);
    const merlin = inference.byRole.get("merlin")!;
    // Every one of the nine seats is equally likely to be Merlin.
    for (const player of g.players) {
      expect(merlin.get(player.id)).toBeCloseTo(1 / 9, 6);
    }
    expect(isConfidentAbout(inference, "merlin")).toBe(false);
  });
});

describe("the user's own role is a certainty, not a guess", () => {
  it("puts the viewer's role on the viewer with probability 1", () => {
    const { game: g, events } = nineWith({
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    });
    const inference = deriveRoleInference(events, g);

    expect(inference.byRole.get("merlin")!.get("p1")).toBe(1);
    expect(inference.byPlayer.get("p1")!.get("merlin")).toBe(1);
    // And nobody else can be Merlin.
    for (const player of g.players.filter((p) => p.id !== "p1")) {
      expect(inference.byRole.get("merlin")!.get(player.id) ?? 0).toBe(0);
    }
    expect(isConfidentAbout(inference, "merlin")).toBe(true);
    expect(likeliestHolder(inference, "merlin")).toEqual({
      playerId: "p1",
      probability: 1,
    });
  });
});

describe("Percival's pair resolves both roles at once", () => {
  it("pins Merlin and Morgana to the two seats he sees, and nobody else", () => {
    const { game: g, events } = game(9)
      .mark(3, { kind: "merlin_or_morgana" }, "known")
      .mark(7, { kind: "merlin_or_morgana" }, "known")
      .build();
    const asPercival = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "percival" as const,
    };

    const inference = deriveRoleInference(events, asPercival);
    const merlin = inference.byRole.get("merlin")!;
    const morgana = inference.byRole.get("morgana")!;

    // Merlin is one of exactly two seats — a 50/50, and zero everywhere else.
    expect(merlin.get("p3")).toBeCloseTo(0.5, 6);
    expect(merlin.get("p7")).toBeCloseTo(0.5, 6);
    for (const player of asPercival.players) {
      if (player.id === "p3" || player.id === "p7") continue;
      expect(merlin.get(player.id) ?? 0).toBe(0);
    }
    // Morgana is the other one of the pair, exactly.
    expect(morgana.get("p3")).toBeCloseTo(0.5, 6);
    expect(morgana.get("p7")).toBeCloseTo(0.5, 6);

    // And the seat that is Merlin is never also Morgana — they are anti-correlated.
    expect(merlin.get("p3")! + morgana.get("p3")!).toBeCloseTo(1, 6);
  });

  it("is confident about Merlin even while the side layer is still lost", () => {
    // This is the case that killed the global confidence gate: Percival knows
    // Merlin is one of two seats (1 bit) while the side layer is at ~4.9 bits.
    const { game: g, events } = game(9)
      .mark(3, { kind: "merlin_or_morgana" }, "known")
      .mark(7, { kind: "merlin_or_morgana" }, "known")
      .build();
    const asPercival = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "percival" as const,
    };

    const inference = deriveRoleInference(events, asPercival);
    expect(inference.entropyByRole.get("merlin")).toBeCloseTo(1, 6);
    expect(isConfidentAbout(inference, "merlin")).toBe(true);
    // But it still has no idea where the assassin is.
    expect(isConfidentAbout(inference, "assassin")).toBe(false);
  });
});

describe("Merlin looking for Mordred", () => {
  it("confines Mordred to the seats Merlin could not see", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .build();
    const asMerlin = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "merlin" as const,
    };

    const inference = deriveRoleInference(events, asMerlin);
    const mordred = inference.byRole.get("mordred")!;

    // Merlin sees every evil except Mordred, so Mordred is one of the six
    // seats that are neither Merlin himself nor the two he sees.
    expect(mordred.get("p1") ?? 0).toBe(0);
    expect(mordred.get("p4") ?? 0).toBe(0);
    expect(mordred.get("p6") ?? 0).toBe(0);
    for (const seat of ["p2", "p3", "p5", "p7", "p8", "p9"]) {
      expect(mordred.get(seat)).toBeCloseTo(1 / 6, 6);
    }

    // 4 and 6 are certainly evil, and certainly not Mordred — so between them
    // they hold Morgana and the assassin.
    const morgana = inference.byRole.get("morgana")!;
    expect(morgana.get("p4")! + morgana.get("p6")!).toBeCloseTo(1, 6);
  });
});

describe("the lady sees what the deal does not", () => {
  it("does not apply Merlin's blind spot to a seat he checked himself", () => {
    // Merlin saw 4 and 6 at the deal, so neither can be Mordred. Then he held
    // the lady and checked 5, learning that 5 is evil too — and the lady is
    // not blind to Mordred, so 5 is exactly who Mordred must be.
    const { game: g, events } = game(9)
      .lady()
      .ladyTo(1)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .ladyCheck(1, 5, "evil")
      .mark(5, { kind: "side", side: "evil" }, "known")
      .build();
    const asMerlin = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "merlin" as const,
    };

    const inference = deriveRoleInference(events, asMerlin);
    const mordred = inference.byRole.get("mordred")!;

    expect(mordred.get("p5")).toBe(1);
    expect(mordred.get("p4") ?? 0).toBe(0);
    expect(mordred.get("p6") ?? 0).toBe(0);
    expect(likeliestHolder(inference, "mordred")).toEqual({
      playerId: "p5",
      probability: 1,
    });
  });
});

describe("a role mark names a role outright", () => {
  it("pins that seat and rules the role out everywhere else", () => {
    const { game: g, events } = game(9)
      .mark(5, { kind: "role", role: "morgana" }, "known")
      .build();

    const inference = deriveRoleInference(events, g);
    const morgana = inference.byRole.get("morgana")!;
    expect(morgana.get("p5")).toBe(1);
    expect(isConfidentAbout(inference, "morgana")).toBe(true);
    for (const player of g.players.filter((p) => p.id !== "p5")) {
      expect(morgana.get(player.id) ?? 0).toBe(0);
    }
  });
});

describe("votes move the role read", () => {
  /** Seat 1 is evil with teammates 5 and 6; sides are fully settled. */
  const evilVision = () =>
    game(9)
      .mark(5, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known");
  const asEvil = (g: GameRecord): GameRecord => ({
    ...g,
    viewerPlayerId: "p1",
    viewerRole: "assassin",
  });

  it("starts flat when nothing has been played", () => {
    const { game: g, events } = evilVision().build();
    const merlin = deriveRoleInference(events, asEvil(g)).byRole.get("merlin")!;
    // Six good seats, no information: 1/6 each.
    for (const seat of ["p2", "p3", "p4", "p7", "p8", "p9"]) {
      expect(merlin.get(seat)).toBeCloseTo(1 / 6, 3);
    }
  });

  it("demotes a seat that votes as though it cannot see", () => {
    // 7 approves a car carrying evil 5, then rejects a clean one. Merlin,
    // who can see, would do the opposite.
    const { game: g, events } = evilVision()
      .proposal(4, [4, 5, 9])
      .vote(approveOnly(9, [1, 5, 6, 7]), "rejected")
      .proposal(5, [2, 3, 4])
      .vote(approveOnly(9, [2, 3, 4, 8, 9]), "passed")
      .mission("success", 0)
      .build();

    const merlin = deriveRoleInference(events, asEvil(g)).byRole.get("merlin")!;
    expect(merlin.get("p7")!).toBeLessThan(1 / 6);
    // …while seats that voted like someone with sight gain.
    expect(merlin.get("p8")!).toBeGreaterThan(1 / 6);
    expect(merlin.get("p7")!).toBeLessThan(merlin.get("p8")!);
  });

  it("keeps the distribution normalised as evidence accumulates", () => {
    const { game: g, events } = evilVision()
      .proposal(4, [4, 5, 9])
      .vote(approveOnly(9, [1, 5, 6, 7]), "rejected")
      .proposal(5, [2, 3, 4])
      .vote(approveOnly(9, [2, 3, 4, 8, 9]), "passed")
      .mission("success", 0)
      .build();

    const merlin = deriveRoleInference(events, asEvil(g)).byRole.get("merlin")!;
    const total = [...merlin.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    // The evils cannot be Merlin, whatever they voted.
    for (const seat of ["p1", "p5", "p6"]) {
      expect(merlin.get(seat) ?? 0).toBe(0);
    }
  });

  it("never lets behaviour override a proven role", () => {
    // The viewer is the assassin; no voting pattern may make him Merlin.
    const { game: g, events } = evilVision()
      .proposal(4, [2, 3, 4])
      .vote(approveOnly(9, [1]), "rejected")
      .build();
    const roles = deriveRoleInference(events, asEvil(g));
    expect(roles.byRole.get("assassin")!.get("p1")).toBe(1);
    expect(roles.byRole.get("merlin")!.get("p1") ?? 0).toBe(0);
  });
});

describe("degenerate logs", () => {
  it("reports contradiction and stays silent rather than guessing", () => {
    const { game: g, events } = game(9)
      .mark(1, { kind: "side", side: "good" }, "known")
      .mark(2, { kind: "side", side: "good" }, "known")
      .mark(3, { kind: "side", side: "good" }, "known")
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();

    const inference = deriveRoleInference(events, g);
    expect(inference.contradictory).toBe(true);
    expect(isConfidentAbout(inference, "merlin")).toBe(false);
    expect(likeliestHolder(inference, "merlin")).toBeNull();
  });
});

describe("cost", () => {
  it("solves a full 10-player game well inside a frame budget", () => {
    // The worst case: 210 side splits x 6P2 good x 4P4 evil = 151,200 assignments.
    const { game: g, events } = game(10).build();
    const start = performance.now();
    deriveRoleInference(events, g);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("memoisation", () => {
  it("returns the identical object for an unchanged log", () => {
    const { game: g, events } = ninePlayerGame();
    expect(deriveRoleInference(events, g)).toBe(deriveRoleInference(events, g));
  });
});
