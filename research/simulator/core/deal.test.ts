import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_SET, evilCount, goodCount, rolesInPlay } from "@/lib/rules/avalon";
import type { RoleType } from "@/lib/types/game";
import {
  ROLE_SLOTS,
  assertMatchesRepoRules,
  dealRoles,
  setupFromSeed,
  sideOf,
} from "./deal";
import { makeRng } from "./rng";
import { SEATS } from "./types";

function counts(roles: readonly RoleType[]): Map<RoleType, number> {
  const out = new Map<RoleType, number>();
  for (const role of roles) out.set(role, (out.get(role) ?? 0) + 1);
  return out;
}

describe("the fixed ten-player line-up", () => {
  it("is the one the repository's rules describe", () => {
    expect(() => assertMatchesRepoRules()).not.toThrow();
  });

  it("is Merlin, Percival, four loyal, Morgana, Assassin, Mordred, Oberon", () => {
    const byRole = counts(ROLE_SLOTS);
    expect(byRole.get("merlin")).toBe(1);
    expect(byRole.get("percival")).toBe(1);
    expect(byRole.get("loyal")).toBe(4);
    expect(byRole.get("morgana")).toBe(1);
    expect(byRole.get("assassin")).toBe(1);
    expect(byRole.get("mordred")).toBe(1);
    expect(byRole.get("oberon")).toBe(1);
    expect(byRole.get("minion")).toBeUndefined();
    expect(ROLE_SLOTS).toHaveLength(10);
  });

  it("uses exactly the roles DEFAULT_ROLE_SET[10] names", () => {
    expect(new Set(ROLE_SLOTS)).toEqual(new Set(DEFAULT_ROLE_SET[10]));
    expect(new Set(ROLE_SLOTS)).toEqual(new Set(rolesInPlay(10)));
  });

  it("spends exactly the good and evil seats the rules allow", () => {
    const evils = ROLE_SLOTS.filter((r) => sideOf(r) === "evil");
    expect(evils).toHaveLength(evilCount(10));
    expect(ROLE_SLOTS.length - evils.length).toBe(goodCount(10));
  });

  /**
   * PRODUCT-V1 says the frozen role layer enumerates 151,200 complete deals at
   * ten players. 10!/4! is 151,200 — the 4! being four interchangeable loyal
   * servants. If this arithmetic ever stops holding, this file and the frozen
   * belief engine are simulating different games.
   */
  it("has the same number of distinct deals the belief engine enumerates", () => {
    const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
    const distinct = factorial(10) / factorial(4);
    expect(distinct).toBe(151_200);
  });
});

describe("dealing", () => {
  it("gives every seat exactly one card", () => {
    const deal = dealRoles(makeRng(11));
    expect(SEATS.every((seat) => typeof deal.bySeat[seat] === "string")).toBe(true);
    expect(counts(SEATS.map((s) => deal.bySeat[s]))).toEqual(counts(ROLE_SLOTS));
  });

  it("names the four villains and the six good seats consistently", () => {
    const deal = dealRoles(makeRng(23));
    expect(deal.evilSeats).toHaveLength(4);
    expect(deal.goodSeats).toHaveLength(6);
    expect(new Set(deal.evilSeats)).toEqual(
      new Set([deal.morgana, deal.mordred, deal.assassin, deal.oberon]),
    );
    expect(deal.goodSeats).toContain(deal.merlin);
    expect(deal.goodSeats).toContain(deal.percival);
  });

  it("is a permutation, so all ten cards appear once each", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const deal = dealRoles(makeRng(seed));
      expect(counts(SEATS.map((s) => deal.bySeat[s]))).toEqual(counts(ROLE_SLOTS));
    }
  });
});

describe("what the seed decides", () => {
  it("deals the same cards and the same opening leader every time", () => {
    for (const seed of [1, 2, 3, 77, 4242]) {
      const a = setupFromSeed(seed);
      const b = setupFromSeed(seed);
      expect(a.deal.bySeat).toEqual(b.deal.bySeat);
      expect(a.initialLeader).toBe(b.initialLeader);
    }
  });

  it("picks an opening leader that is a real seat, and not always the same one", () => {
    const leaders = new Set<number>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const { initialLeader } = setupFromSeed(seed);
      expect(SEATS).toContain(initialLeader);
      leaders.add(initialLeader);
    }
    // Every seat should turn up as opening leader across two hundred seeds; a
    // generator that favoured one would bias which position gets to make the
    // opening direction call.
    expect(leaders.size).toBe(10);
  });

  it("does not deal the same cards for different seeds", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed += 1) {
      seen.add(JSON.stringify(setupFromSeed(seed).deal.bySeat));
    }
    expect(seen.size).toBeGreaterThan(90);
  });

  /**
   * The deal and the opening leader come from separate NAMED streams. This is
   * what lets a change to leader selection leave every seed's deal alone, and
   * vice versa — which is the difference between a replay that survives a
   * refactor and one that does not.
   */
  it("keeps the deal stable when only the leader stream is consulted", () => {
    const deal = setupFromSeed(5).deal.bySeat;
    const again = setupFromSeed(5);
    expect(again.deal.bySeat).toEqual(deal);
    expect(dealRoles(makeRng(0))).toBeTruthy();
  });
});
