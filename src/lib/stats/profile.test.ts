import { describe, it, expect } from "vitest";
import { computeProfileStats, mostPlayedRole, winRate } from "./profile";
import type { GameRecord, RoleType, WinningSide } from "@/lib/types/game";

function makeGame(
  id: string,
  patch: Partial<GameRecord> = {},
): GameRecord {
  return {
    id,
    schemaVersion: 1,
    playerCount: 10,
    players: [],
    firstLeaderId: "p1",
    status: "completed",
    lastSequence: 0,
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z",
    ...patch,
  };
}

function played(role: RoleType, winner: WinningSide): Partial<GameRecord> {
  return { viewerRole: role, winningSide: winner };
}

describe("win rate needs both halves", () => {
  // A win rate built on assumptions is worse than no win rate, so a game with
  // only one of "which side was I" / "who won" stays unrated rather than
  // being folded in with a guess.
  it("skips games with no recorded role", () => {
    const stats = computeProfileStats([
      makeGame("a", { winningSide: "good" }),
      makeGame("b", { winningSide: "evil" }),
    ]);
    expect(stats.total).toBe(2);
    expect(stats.rated).toBe(0);
    expect(stats.wins).toBe(0);
    expect(winRate({ played: stats.rated, won: stats.wins })).toBeNull();
  });

  it("skips games with no recorded winner", () => {
    const stats = computeProfileStats([makeGame("a", { viewerRole: "merlin" })]);
    expect(stats.rated).toBe(0);
    // The role still counts toward "roles I have been dealt".
    expect(stats.roleCounts.merlin).toBe(1);
  });

  it("counts a game only once both are present", () => {
    const stats = computeProfileStats([
      makeGame("a", played("merlin", "good")),
      makeGame("b", played("assassin", "good")),
    ]);
    expect(stats.rated).toBe(2);
    expect(stats.wins).toBe(1);
  });
});

describe("sides", () => {
  const stats = computeProfileStats([
    makeGame("a", played("merlin", "good")), // good, won
    makeGame("b", played("percival", "evil")), // good, lost
    makeGame("c", played("loyal", "good")), // good, won
    makeGame("d", played("assassin", "evil")), // evil, won
    makeGame("e", played("morgana", "good")), // evil, lost
  ]);

  it("splits good and evil correctly", () => {
    expect(stats.asGood).toEqual({ played: 3, won: 2 });
    expect(stats.asEvil).toEqual({ played: 2, won: 1 });
  });

  it("reports each side's rate as a whole percentage", () => {
    expect(winRate(stats.asGood)).toBe(67);
    expect(winRate(stats.asEvil)).toBe(50);
  });

  it("treats every evil role as evil", () => {
    for (const role of [
      "morgana",
      "mordred",
      "assassin",
      "oberon",
      "minion",
    ] as RoleType[]) {
      const one = computeProfileStats([makeGame("x", played(role, "evil"))]);
      expect(one.asEvil.played).toBe(1);
      expect(one.asEvil.won).toBe(1);
      expect(one.asGood.played).toBe(0);
    }
  });

  it("treats every good role as good", () => {
    for (const role of ["merlin", "percival", "loyal"] as RoleType[]) {
      const one = computeProfileStats([makeGame("x", played(role, "good"))]);
      expect(one.asGood).toEqual({ played: 1, won: 1 });
      expect(one.asEvil.played).toBe(0);
    }
  });
});

describe("tallies", () => {
  const stats = computeProfileStats(
    [
      makeGame("a", { playerCount: 10, viewerRole: "merlin" }),
      makeGame("b", { playerCount: 10, viewerRole: "loyal" }),
      makeGame("c", { playerCount: 9, viewerRole: "merlin", status: "active" }),
    ],
    { a: 120, b: 80, c: 30 },
  );

  it("counts games by table size", () => {
    expect(stats.byPlayerCount).toEqual({ 10: 2, 9: 1 });
  });

  it("counts completed separately from total", () => {
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(2);
  });

  it("sums recorded events", () => {
    expect(stats.totalEvents).toBe(230);
  });

  it("finds the most played role", () => {
    expect(mostPlayedRole(stats)).toEqual({ role: "merlin", count: 2 });
  });
});

describe("empty state", () => {
  it("handles no games without dividing by zero", () => {
    const stats = computeProfileStats([]);
    expect(stats.total).toBe(0);
    expect(winRate(stats.asGood)).toBeNull();
    expect(winRate(stats.asEvil)).toBeNull();
    expect(mostPlayedRole(stats)).toBeNull();
  });
});
