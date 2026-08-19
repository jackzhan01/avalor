import { loadCorpus } from "./corpus-load";

/**
 * Train / validation / test, split at the GAME level.
 *
 * Test is `i % 2 === 1` and was that before validation existed, so nothing
 * tuned has ever seen it. Validation is carved out of the other half, which
 * leaves train smaller but keeps the held-out set untouched — the alternative,
 * re-cutting all three, would have retired a test set that is still clean.
 *
 * KNOWN LEAK, recorded rather than hidden: the behaviour parameters in
 * soft.ts, merlin.ts, percival.ts and oberon.ts were measured over the WHOLE
 * corpus, test included. They are aggregate conditional frequencies over tens
 * of thousands of observations, so dropping half the data moves them by
 * roughly 1/sqrt(n) — for the fail table, n is 24,057 and the shift is under a
 * percentage point. Small, but not zero, and it means the test numbers are
 * very slightly optimistic. Refitting on train alone is the clean fix and has
 * not been done.
 */
export type Split = "train" | "validation" | "test";

export function corpusSplit(
  split: Split,
  opts: { limit?: number; playerCount?: number } = {},
) {
  const all = loadCorpus().filter(
    (c) => c.game.playerCount >= 7 && c.game.playerCount <= 10,
  );
  const picked = all.filter((_, i) => {
    if (i % 2 === 1) return split === "test";
    if (i % 4 === 0) return split === "train";
    return split === "validation";
  });
  const filtered = opts.playerCount
    ? picked.filter((c) => c.game.playerCount === opts.playerCount)
    : picked;
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/** Events up to and including the nth recorded mission result. */
export function untilMission(
  events: ReturnType<typeof loadCorpus>[number]["events"],
  n: number,
) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "mission" && ++seen === n) return events.slice(0, i + 1);
  }
  return null;
}

/**
 * Percentile bootstrap over GAMES, not over seats.
 *
 * Seats inside one game share almost all their evidence, so resampling seats
 * would report an interval several times too narrow.
 */
export function bootstrap(
  perGame: number[],
  draws = 2000,
  seed = 12345,
): { lo: number; hi: number; mean: number } {
  const n = perGame.length;
  if (n === 0) return { lo: NaN, hi: NaN, mean: NaN };
  const mean = perGame.reduce((a, b) => a + b, 0) / n;
  // Deterministic PRNG so a reported interval can be reproduced exactly.
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const means: number[] = [];
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += perGame[(next() * n) | 0];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(draws * 0.025)],
    hi: means[Math.floor(draws * 0.975)],
    mean,
  };
}
