import { describe, expect, it } from "vitest";
import { childRng, makeRng, pick, randomInt, shuffled } from "./rng";

describe("the seeded stream", () => {
  it("repeats exactly for the same seed", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 1000; i += 1) expect(a()).toBe(b());
  });

  it("differs between seeds", () => {
    const a = Array.from({ length: 20 }, makeRng(1));
    const b = Array.from({ length: 20 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it("stays inside [0, 1)", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 5000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("survives a zero seed instead of degenerating", () => {
    // xorshift is dead at zero, so `makeRng` substitutes 1. Without that a
    // caller passing seed 0 would get an endless run of the same number and
    // every game would be identical.
    const rng = makeRng(0);
    const first = rng();
    const second = rng();
    expect(first).not.toBe(second);
  });
});

describe("named child streams", () => {
  it("gives different labels different streams", () => {
    const a = childRng(99, "agent:1:mixed");
    const b = childRng(99, "agent:2:mixed");
    expect(a()).not.toBe(b());
  });

  it("gives the same label the same stream", () => {
    const a = childRng(99, "deal");
    const b = childRng(99, "deal");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  /**
   * The property the replay contract rests on: an agent's behaviour must not
   * depend on how many draws the referee happened to make before it. Naming
   * the stream is what buys that, so it is asserted rather than assumed.
   */
  it("does not depend on draws taken from the parent seed", () => {
    const parent = makeRng(99);
    parent();
    parent();
    const after = childRng(99, "agent:1:mixed");
    const clean = childRng(99, "agent:1:mixed");
    expect(after()).toBe(clean());
  });
});

describe("helpers", () => {
  it("keeps randomInt inside range", () => {
    const rng = makeRng(3);
    for (let i = 0; i < 2000; i += 1) {
      const n = randomInt(rng, 10);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(10);
    }
  });

  it("shuffles a permutation, not a subset", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = shuffled(makeRng(42), items);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
    expect(out).not.toEqual(items);
  });

  it("refuses to pick from nothing", () => {
    expect(() => pick(makeRng(1), [])).toThrow();
  });
});
