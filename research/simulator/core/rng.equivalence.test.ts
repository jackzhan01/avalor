import { describe, expect, it } from "vitest";
import { makeRng as decisionMakeRng } from "@/lib/decision/sampler";
import { makeRng } from "./rng";

/**
 * The simulator copies the repository's PRNG rather than importing it, because
 * `decision/sampler.ts` reaches into the frozen belief engine for the
 * posterior enumerator and one import would drag that whole graph into a
 * research tool that must not touch it.
 *
 * This is the one file in the simulator allowed to import from a frozen
 * module, and it is a test whose only job is to prove the copy is a copy. If
 * the two streams ever diverge, a simulator replay and a decision-layer
 * rollout seeded identically would quietly be different experiments.
 */
describe("the copied PRNG is the repository's", () => {
  it("produces identical streams for the same seed", () => {
    for (const seed of [0, 1, 2, 42, 12345, 0x5eed, 2 ** 31, 4_294_967_295]) {
      const mine = makeRng(seed);
      const theirs = decisionMakeRng(seed);
      for (let i = 0; i < 500; i += 1) {
        expect(mine()).toBe(theirs());
      }
    }
  });

  it("agrees on the zero-seed substitution", () => {
    // xorshift is dead at zero; both implementations substitute 1, and this is
    // where a divergence would be easiest to introduce by accident.
    expect(makeRng(0)()).toBe(decisionMakeRng(0)());
  });
});
