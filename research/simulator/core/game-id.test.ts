import { describe, expect, it } from "vitest";
import { buildPrivateResearchTrace, buildPublicReplay } from "../run/artifacts";
import { drive, referenceDeal, testConfig } from "../fixtures/harness";
import { asGameId, fixedGameId, GameIdError, newGameId } from "./game-id";
import { createGame } from "./referee";
import { scriptedTable, PROFILES } from "../agents/scripted-agent";

/**
 * The public game id must not be a function of the seed.
 *
 * The earlier version hashed `runId` and the seed with FNV-1a and its own
 * comment conceded the digest was brute-forceable. That concession WAS the
 * bug: seeds are small integers, so anyone holding a public replay and this
 * source could enumerate them, match the digest, and recover the whole deal
 * before reading the final reveal the public artifact is ordered to withhold.
 *
 * These tests attack that directly.
 */

function gameWith(seed: number, gameId?: string) {
  return createGame({
    seed,
    config: testConfig(),
    deal: referenceDeal(),
    ...(gameId ? { gameId } : {}),
  });
}

describe("a game id is opaque and supplied", () => {
  it("is a random UUID by default", () => {
    const a = newGameId();
    const b = newGameId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^g-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("can be injected, so a test can compare two runs", () => {
    const state = gameWith(7, fixedGameId("compare"));
    expect(state.gameId).toBe("g-fixed-compare");
  });

  it("rejects a shape that would break a filename or an artifact", () => {
    expect(() => asGameId("")).toThrow(GameIdError);
    expect(() => asGameId("ab")).toThrow(GameIdError);
    expect(() => asGameId("-leading-dash")).toThrow(GameIdError);
    expect(() => asGameId("has spaces")).toThrow(GameIdError);
    expect(() => asGameId("../escape")).toThrow(GameIdError);
    expect(() => asGameId(42)).toThrow(GameIdError);
    expect(asGameId("g-abc_123:x.y")).toBe("g-abc_123:x.y");
  });
});

describe("changing only the seed does not move the id", () => {
  /**
   * The adversarial property. If the id were derived from the seed, a fixed id
   * across two different seeds would be impossible — and an attacker could
   * invert the derivation. Holding the id fixed while the deal changes proves
   * the two are unrelated.
   */
  it("keeps a supplied id fixed across different seeds and different deals", () => {
    const id = fixedGameId("stable");
    const a = gameWith(1, id);
    const b = gameWith(999_983, id);
    expect(a.gameId).toBe(b.gameId);
    // And the games really are different, so the id is not tracking anything.
    expect(a.initialLeader === b.initialLeader && a.seed === b.seed).toBe(false);
  });

  it("gives two runs of the SAME seed different ids by default", () => {
    // A derived id would be identical here. A random one is not.
    const a = createGame({ seed: 4242, config: testConfig() });
    const b = createGame({ seed: 4242, config: testConfig() });
    expect(a.seed).toBe(b.seed);
    expect(a.gameId).not.toBe(b.gameId);
  });

  it("cannot be inverted by enumerating the seed space", () => {
    // The old digest was 32 bits over a small integer: a few hundred thousand
    // tries recovered the seed. Here the default id is drawn independently, so
    // sweeping every seed never reproduces it.
    const target = createGame({ seed: 31337, config: testConfig() }).gameId;
    let hits = 0;
    for (let seed = 1; seed <= 5_000; seed += 1) {
      if (createGame({ seed, config: testConfig() }).gameId === target) hits += 1;
    }
    expect(hits).toBe(0);
  });

  it("does not vary with the seed when everything else is held constant", () => {
    const ids = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      ids.add(gameWith(seed, fixedGameId("held")).gameId);
    }
    expect(ids.size).toBe(1);
  });
});

describe("the artifacts join on it, and the public one still hides the seed", () => {
  async function played(seed: number, gameId: string) {
    const agents = scriptedTable({ seed, profile: PROFILES.passiveEvil });
    const { state, actions } = drive({
      seed,
      deal: referenceDeal(),
      agents,
      profile: PROFILES.passiveEvil,
    });
    void gameId;
    return { state, actions, agents };
  }

  it("shares the id between the public replay and the private trace", async () => {
    const { state, actions, agents } = await played(11, fixedGameId("join"));
    expect(buildPublicReplay(state, agents).metadata.gameId).toBe(
      buildPrivateResearchTrace(state, agents, actions).manifest.gameId,
    );
  });

  it("puts no seed-derived material in the public artifact", async () => {
    const seed = 8675309;
    const state = gameWith(seed, fixedGameId("nopeek"));
    const agents = scriptedTable({ seed, profile: PROFILES.mixed });
    const metadata = buildPublicReplay(state, agents).metadata;
    const text = JSON.stringify(metadata);

    expect(text).not.toContain(String(seed));
    expect(text).not.toContain('"seed"');
    // The id is the one supplied, not something computed from anything.
    expect(metadata.gameId).toBe("g-fixed-nopeek");
  });

  it("records the persona arm in both", async () => {
    const { state, actions, agents } = await played(12, fixedGameId("arm"));
    expect(buildPublicReplay(state, agents).metadata.personaMode).toBe(
      "heterogeneous-rotated",
    );
    expect(
      buildPrivateResearchTrace(state, agents, actions, {
        personaMode: "homogeneous-neutral",
      }).manifest.personaMode,
    ).toBe("homogeneous-neutral");
  });
});
