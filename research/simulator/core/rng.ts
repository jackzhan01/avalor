/**
 * The simulator's own deterministic PRNG.
 *
 * This is a byte-for-byte copy of `makeRng` in `src/lib/decision/sampler.ts`,
 * and copying it rather than importing it is deliberate. That module reaches
 * into `@/lib/inference/roles` for the posterior enumerator, so a single
 * import would drag the whole frozen belief engine into a research tool that
 * has no business touching it. Eight lines of xorshift is a much smaller cost
 * than that dependency edge.
 *
 * The copy is kept honest by `rng.equivalence.test.ts`, which imports the real
 * one and asserts the two streams agree exactly. That is the one place in this
 * simulator allowed to touch a frozen module, and it is a test.
 */

export type Rng = () => number;

/** xorshift32. Same seed, same stream, on every machine and every run. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * A named child stream.
 *
 * Scripted agents need randomness that does not depend on how many draws the
 * referee happened to make, or a change to the dealing order would silently
 * change every agent's behaviour and no old run would replay. Mixing the label
 * into the seed gives each consumer an independent stream anchored only on the
 * run seed and its own name.
 */
export function childRng(seed: number, label: string): Rng {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i += 1) {
    // FNV-1a over the label, then folded into the seed.
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return makeRng(h);
}

/** Uniform integer in [0, n). */
export function randomInt(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Uniform pick. Throws on an empty list rather than returning undefined. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() on an empty list");
  return items[randomInt(rng, items.length)];
}

/**
 * Fisher-Yates, in place, on a copy.
 *
 * Walking downward from the end is the standard form and the one the repo's
 * `soundness.test.ts` generator uses; matching it means two shuffles seeded
 * the same way can be reasoned about together.
 */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
