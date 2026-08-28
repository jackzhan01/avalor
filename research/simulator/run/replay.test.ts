import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import { checkInvariants } from "../fixtures/invariants";
import { testConfig } from "../fixtures/harness";
import { fingerprint, replayGame, runGame } from "./runner";
import {
  actionsFromPrivateTrace,
  buildPrivateResearchTrace,
  serialisePrivateResearchTrace,
} from "./artifacts";

/**
 * Determinism and replay, with the network removed.
 *
 * `globalThis.fetch` is replaced by something that throws for the whole file.
 * Nothing in the simulator's path should reach for it — there is no model
 * client yet and the scripted agents are pure functions — so this is a
 * standing assertion rather than a mock. It is the same technique PRODUCT-V1
 * uses to keep the shipped decision path offline, and it costs nothing to
 * carry from the first milestone rather than adding it once somebody has
 * already introduced a call.
 */

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    fetchCalls += 1;
    throw new Error("the simulator must not make network calls");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the same inputs produce the same game", () => {
  it("replays a game from its own recorded actions", async () => {
    for (const seed of [1, 2, 17, 99, 2026]) {
      const first = await runGame({
        seed,
        agents: scriptedTable({ seed, profile: PROFILES.mixed }),
        config: testConfig(),
      });
      const replayed = replayGame(seed, first.actions, testConfig());
      expect(fingerprint(replayed.state)).toBe(fingerprint(first.state));
      expect(replayed.outcome).toEqual(first.outcome);
      expect(checkInvariants(replayed.state, replayed.actions)).toEqual([]);
    }
    expect(fetchCalls).toBe(0);
  });

  it("re-runs identically with freshly built agents", async () => {
    // Not the same as replaying: this proves the AGENTS are deterministic too,
    // which is what makes a run reproducible from a seed rather than from a log.
    for (const seed of [3, 44, 512]) {
      const a = await runGame({ seed, agents: scriptedTable({ seed, profile: PROFILES.mixed }) });
      const b = await runGame({ seed, agents: scriptedTable({ seed, profile: PROFILES.mixed }) });
      expect(fingerprint(b.state)).toBe(fingerprint(a.state));
      expect(b.actions).toEqual(a.actions);
    }
    expect(fetchCalls).toBe(0);
  });

  it("gives different seeds different games", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const result = await runGame({
        seed,
        agents: scriptedTable({ seed, profile: PROFILES.mixed }),
      });
      seen.add(fingerprint(result.state));
    }
    expect(seen.size).toBe(40);
  });

  it("notices when a replay does not match the referee", async () => {
    const result = await runGame({
      seed: 7,
      agents: scriptedTable({ seed: 7, profile: PROFILES.mixed }),
    });
    // Drop an action from the middle: the log no longer describes this game.
    const damaged = result.actions.filter((_, i) => i !== 20);
    expect(() => replayGame(7, damaged, testConfig())).toThrow();
  });

  it("refuses a replay that runs out of actions", async () => {
    const result = await runGame({
      seed: 8,
      agents: scriptedTable({ seed: 8, profile: PROFILES.mixed }),
    });
    expect(() => replayGame(8, result.actions.slice(0, -1), testConfig())).toThrow(
      /ran out of actions/,
    );
  });

  it("replays from a serialised private trace, with no agents and no network", async () => {
    const agents = scriptedTable({ seed: 9, profile: PROFILES.passiveEvil });
    const original = await runGame({ seed: 9, agents });
    const text = serialisePrivateResearchTrace(
      buildPrivateResearchTrace(original.state, agents, original.actions),
    );

    const replayed = replayGame(9, actionsFromPrivateTrace(text));
    expect(fingerprint(replayed.state)).toBe(fingerprint(original.state));
    expect(fetchCalls).toBe(0);
  });
});

describe("the observation hook cannot reach the referee's state", () => {
  it("is handed the observation and nothing else", async () => {
    const seen: unknown[][] = [];
    await runGame({
      seed: 12,
      agents: scriptedTable({ seed: 12, profile: PROFILES.mixed }),
      onObservation: (...args) => {
        seen.push(args);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    // One argument. A second one used to be the GameState, which made a hook
    // whose name promised nothing of the sort a side door into the deal.
    for (const args of seen) expect(args).toHaveLength(1);
  });
});
