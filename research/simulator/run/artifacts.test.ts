import { describe, expect, it } from "vitest";
import { GOOD_ROLES, EVIL_ROLES } from "@/lib/types/game";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import { testConfig } from "../fixtures/harness";
import { runGame } from "./runner";
import {
  buildPrivateResearchTrace,
  buildPublicReplay,
  parseJsonl,
  publicReplayLines,
  serialisePrivateResearchTrace,
  serialisePublicReplay,
  type PublicReplayLine,
} from "./artifacts";

/**
 * The public artifact must be publishable; the private one must not.
 *
 * A public replay ends up in a paper appendix, a demo, or the context of a
 * later study. If any of the things below leaked into it, every downstream
 * evaluation using it would be reading the answers — and would look brilliant
 * while doing so, which is the failure mode that is hardest to notice.
 */

const ROLE_NAMES = [...GOOD_ROLES, ...EVIL_ROLES];

async function played(seed: number, profile = PROFILES.mixed) {
  const agents = scriptedTable({ seed, profile });
  // A run id that does NOT encode the seed, which is the rule a batch has to
  // follow if its public replays are going to be published.
  const result = await runGame({ seed, agents, config: testConfig(), runId: "run-A" });
  return { agents, ...result };
}

describe("the public replay", () => {
  it("carries the public events and nothing beside them", async () => {
    const { state, agents } = await played(101);
    const replay = buildPublicReplay(state, agents);
    expect(replay.artifact).toBe("public-replay");
    expect(replay.events).toEqual([...state.log]);
    expect(replay.metadata.seats.map((s) => s.seat)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("names no seat's role in its metadata", async () => {
    const { state, agents } = await played(102);
    const metadata = buildPublicReplay(state, agents).metadata;
    const text = JSON.stringify(metadata);
    for (const role of ROLE_NAMES) expect(text).not.toContain(role);
    for (const entry of metadata.seats) {
      expect(Object.keys(entry).sort()).toEqual(["agent", "persona", "seat", "strategy"]);
    }
  });

  /**
   * The ordering guarantee: a reader working through the artifact learns the
   * roles at the moment the table did, and not one line earlier.
   */
  it("reveals roles only in the final event", async () => {
    for (const seed of [103, 104, 105, 106]) {
      const { state, agents } = await played(seed);
      const lines = publicReplayLines(buildPublicReplay(state, agents));
      const beforeTheEnd = lines.filter(
        (line) => !(line.t === "event" && line.data.type === "game_end"),
      );
      const text = JSON.stringify(beforeTheEnd);
      for (const role of ROLE_NAMES) {
        // `rolesInPlay` in game_start lists the DECK, which is public — but it
        // is a bare list, so a role name attached to a seat would show up as a
        // key/value pair. Check the pairing rather than the word.
        for (let seat = 1; seat <= 10; seat += 1) {
          expect(text).not.toContain(`"${seat}":"${role}"`);
        }
      }
      // And the reveal really is there at the end.
      const end = lines.at(-2);
      expect(end?.t).toBe("event");
      if (end?.t === "event" && end.data.type === "game_end") {
        expect(Object.keys(end.data.reveal)).toHaveLength(10);
      }
    }
  });

  /**
   * Seed plus this code reproduces the deal, so a seed in the public artifact
   * would defeat the ordering guarantee above for anyone holding the source.
   */
  it("does not carry the seed", async () => {
    const { state, agents } = await played(4242);
    const text = serialisePublicReplay(buildPublicReplay(state, agents));
    expect(text).not.toContain('"seed"');
    expect(text).not.toContain("4242");
  });

  it("has a default run id that does not encode the seed either", async () => {
    const agents = scriptedTable({ seed: 4243, profile: PROFILES.mixed });
    const result = await runGame({ seed: 4243, agents, config: testConfig() });
    const text = serialisePublicReplay(buildPublicReplay(result.state, agents));
    expect(text).not.toContain("4243");
  });

  it("carries no private stream, no mission-card owner, no memory patch", async () => {
    const { state, agents } = await played(107, PROFILES.passiveEvil);
    const text = serialisePublicReplay(buildPublicReplay(state, agents));

    // The game really did produce all of these; they are simply not here.
    expect(state.privateLog.some((e) => e.type === "lady_result")).toBe(true);
    expect(state.privateLog.some((e) => e.type === "evil_discussion")).toBe(true);

    for (const forbidden of [
      "lady_result",
      "evil_reveal",
      "evil_discussion",
      "trueSide",
      "memoryPatch",
      "missionCards",
      "pendingVotes",
      "beliefs",
      "rationale",
      "private-manifest",
      "containsPrivateInformation",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("carries no raw model response and no action record", async () => {
    const { state, agents } = await played(108);
    const lines = parseJsonl<PublicReplayLine>(
      serialisePublicReplay(buildPublicReplay(state, agents)),
    );
    expect(lines.every((line) => ["public-metadata", "event", "outcome"].includes(line.t))).toBe(
      true,
    );
    expect(lines.some((line) => (line as { t: string }).t === "action")).toBe(false);
    expect(lines.some((line) => (line as { t: string }).t === "model-call")).toBe(false);
  });

  it("redacts anything that looks like a credential", async () => {
    const config = testConfig({
      model: { id: "m", params: { apiKey: "sk-must-not-appear", temperature: 0.1 } },
      pricing: { configured: false },
    });
    const agents = scriptedTable({ seed: 109, profile: PROFILES.mixed });
    const result = await runGame({ seed: 109, agents, config });
    const text = serialisePublicReplay(buildPublicReplay(result.state, agents));
    expect(text).not.toContain("sk-must-not-appear");
    expect(text).toContain("[redacted]");
  });
});

describe("the private research trace", () => {
  it("says loudly what it is", async () => {
    const { state, agents, actions } = await played(201);
    const trace = buildPrivateResearchTrace(state, agents, actions);
    expect(trace.artifact).toBe("private-research-trace");
    expect(trace.containsPrivateInformation).toBe(true);
    expect(trace.warning).toContain("绝不能作为公开回放分发");
  });

  it("carries everything a replay and an analysis need", async () => {
    const { state, agents, actions } = await played(202, PROFILES.passiveEvil);
    const trace = buildPrivateResearchTrace(state, agents, actions);

    expect(trace.manifest.seed).toBe(202);
    expect(trace.manifest.deal).toEqual(state.deal.bySeat);
    expect(trace.manifest.seats.every((s) => typeof s.role === "string")).toBe(true);
    expect(trace.publicEvents).toEqual([...state.log]);
    expect(trace.privateEvents).toEqual([...state.privateLog]);
    expect(trace.actions).toEqual(actions);
    expect(trace.finalMemory).toEqual(state.memory);
    expect(trace.ladyResults).toEqual(state.ladyResults);
    // Reserved for the model client, and empty because nothing was called.
    expect(trace.modelCalls).toEqual([]);
  });

  it("shares a join key with the public replay of the same game", async () => {
    const { state, agents, actions } = await played(203);
    expect(buildPrivateResearchTrace(state, agents, actions).manifest.gameId).toBe(
      buildPublicReplay(state, agents).metadata.gameId,
    );
  });

  it("still redacts credentials", async () => {
    const config = testConfig({
      model: { id: "m", params: { apiKey: "sk-must-not-appear" } },
      pricing: { configured: false },
    });
    const agents = scriptedTable({ seed: 204, profile: PROFILES.mixed });
    const result = await runGame({ seed: 204, agents, config });
    const text = serialisePrivateResearchTrace(
      buildPrivateResearchTrace(result.state, agents, result.actions),
    );
    // The trace holds the deal on purpose. A provider key is not part of the
    // experiment and has no reason to be in any artifact at all.
    expect(text).not.toContain("sk-must-not-appear");
  });
});
