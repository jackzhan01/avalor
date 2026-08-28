import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/load";
import { observationFor } from "../core/observation";
import type { Observation } from "../core/observation";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import { replayPrefix, runGame } from "../run/runner";
import { SEATS, type Seat } from "../core/types";
import {
  compactionCompleteness,
  compactionTrigger,
  compactableEvents,
  failedTeamConstraints,
  packContext,
  packSize,
  renderPack,
  COMPACT_ABOVE_EVENTS,
  type ContextPack,
} from "./context-pack";
import { applyCognitionUpdate, deriveConstraint, ledgerFrom, type EpistemicLedger } from "./ledger";
import { CONTEXT_BUDGET } from "./limits";

/**
 * A bounded prompt that never loses a fact.
 *
 * Two properties, and they pull in opposite directions, which is why both need
 * proving rather than one:
 *
 *   BOUNDED     the pack stays under budget as history grows.
 *   COMPLETE    every hard fact survives whatever compaction did.
 *
 * A packer can trivially satisfy either alone. The interesting tests are the
 * ones where a long game forces compaction and the fact tables are then
 * re-derived FROM THE RENDERED TEXT — so a packer that computed the tables
 * correctly and forgot to include them fails, which a structural check would
 * not catch.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("cognition tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = loadConfig();

async function game(seed: number) {
  return runGame({
    seed,
    agents: scriptedTable({ seed, profile: PROFILES.mixed }),
    config: CONFIG,
    runId: "cog",
  });
}

/** The longest game in a small sweep — the one that actually needs compacting. */
async function longGame() {
  let best: Awaited<ReturnType<typeof game>> | null = null;
  for (let seed = 1; seed <= 12; seed += 1) {
    const result = await game(seed);
    if (!best || result.state.log.length > best.state.log.length) best = result;
  }
  if (!best) throw new Error("no game");
  return best;
}

function packFor(observation: Observation, ledger: EpistemicLedger): ContextPack {
  return packContext({
    observation,
    ledger,
    cognitionText: "",
    taskAndSchema: "## 本次任务\n请投票。",
    olderArguments: [],
  });
}

describe("the fact tables are lossless", () => {
  it("carry every mission, proposal, vote, Lady action and claim", async () => {
    const { state } = await longGame();
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const ledger = ledgerFrom(observation, SEATS);
      const report = compactionCompleteness(packFor(observation, ledger), ledger, observation);
      expect(report.missing, `${seat}号`).toEqual([]);
      expect(report.complete).toBe(true);
    }
  });

  it("state the failed-team constraint without over-claiming from it", async () => {
    const facts = [
      {
        kind: "mission_result" as const,
        id: "f1",
        provenance: { kind: "referee" as const, sequence: 1 },
        missionNumber: 1,
        team: [1, 3, 8] as Seat[],
        result: "fail" as const,
        failCount: 1,
      },
    ];
    const lines = failedTeamConstraints(facts);
    expect(lines[0]).toContain("至少有 1 个坏人");
    // The caveat is inline, not a footnote: a constraint quoted without it is
    // how a table talks itself into condemning an entire team.
    expect(lines[0]).toContain("没洗清车上其他人");
  });

  it("compute intersections and differences between two failed teams", () => {
    const mk = (n: number, team: Seat[], failCount: number) => ({
      kind: "mission_result" as const,
      id: `f${n}`,
      provenance: { kind: "referee" as const, sequence: n },
      missionNumber: n,
      team,
      result: "fail" as const,
      failCount,
    });
    const lines = failedTeamConstraints([mk(1, [1, 3, 8], 1), mk(2, [3, 8, 5, 6], 1)]);
    const comparison = lines.find((l) => l.includes("交集"));
    expect(comparison).toBeDefined();
    expect(comparison).toContain("交集 3、8号");
    expect(comparison).toContain("只在前者 1号");
    expect(comparison).toContain("只在后者 5、6号");
  });
});

describe("compaction", () => {
  it("triggers deterministically and only on the declared conditions", () => {
    expect(compactionTrigger(10, 5, 0)).toBeNull();
    expect(compactionTrigger(CONTEXT_BUDGET.softTargetTokens + 1, 5, 0)?.kind).toBe("soft_target");
    expect(compactionTrigger(10, COMPACT_ABOVE_EVENTS + 1, 0)?.kind).toBe("event_count");
    expect(compactionTrigger(10, 5, 3)?.kind).toBe("cycle_age");
  });

  it("only ever offers speeches for summarisation", async () => {
    const { state } = await longGame();
    const compactable = compactableEvents(state.log, state.log[state.log.length - 1].sequence);
    expect(compactable.length).toBeGreaterThan(0);
    // Every other event type is a fact and lives in the tables. If one showed
    // up here, compaction could delete a mission result.
    for (const event of compactable) expect(event.type).toBe("speech");
  });

  it("keeps every hard fact even when it does compact", async () => {
    const { state } = await longGame();
    const observation = observationFor(state, 1);
    const ledger = ledgerFrom(observation, SEATS);
    const pack = packContext({
      observation,
      ledger,
      cognitionText: "",
      taskAndSchema: "## 本次任务",
      olderArguments: [
        { missionNumber: 1, attempt: 1, text: "第一轮大家在争 4 号该不该上车", coversSequences: [3, 4, 5] },
      ],
    });
    expect(compactionCompleteness(pack, ledger, observation).missing).toEqual([]);
  });

  it("preserves an unresolved-premise constraint through packing", async () => {
    const { state } = await game(4);
    const observation = observationFor(state, 1);
    const base = ledgerFrom(observation, SEATS);
    const soft = deriveConstraint({
      id: "soft",
      statement: "如果6号说的是真的，那么2、3、5里恰有两坏",
      premises: [{ id: "c1", verified: false, label: "6号自称忠臣" }],
      atSequence: 40,
    });
    const ledger = applyCognitionUpdate(base, observation, {
      constraints: [soft],
      hypotheses: [
        { id: "a", label: "世界一", evilSeats: [2], rationale: "", standing: "unresolved", premises: [], provenance: { kind: "inference", premises: [] } },
        { id: "b", label: "世界二", evilSeats: [3], rationale: "", standing: "unresolved", premises: [], provenance: { kind: "inference", premises: [] } },
      ],
    });
    const pack = packContext({
      observation,
      ledger,
      // The renderer is what carries the constraint; an empty cognition block
      // would silently drop it, which is exactly what completeness catches.
      cognitionText: `未证实前提：${soft.statement}`,
      taskAndSchema: "## 本次任务",
      olderArguments: [],
    });
    expect(compactionCompleteness(pack, ledger, observation).missing).toEqual([]);
  });

  it("reports missing facts rather than passing silently", async () => {
    const { state } = await longGame();
    const observation = observationFor(state, 1);
    const ledger = ledgerFrom(observation, SEATS);
    const pack = packFor(observation, ledger);
    // A pack whose tables were blanked must fail completeness. This asserts the
    // checker actually reads the rendered text.
    const gutted = { ...pack, factTables: "" } as ContextPack;
    expect(compactionCompleteness(gutted, ledger, observation).missing.length).toBeGreaterThan(0);
  });
});

describe("bounds", () => {
  it("stays far under the soft target for a whole real game", async () => {
    const { state } = await longGame();
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const pack = packFor(observation, ledgerFrom(observation, SEATS));
      expect(pack.diagnostics.overHardCeiling).toBe(false);
      // Measured, not assumed: the third paid game's real peak was 14,706
      // provider tokens, so a pack near 60,000 would mean the design regressed.
      expect(pack.diagnostics.estimatedTokens).toBeLessThan(CONTEXT_BUDGET.softTargetTokens);
    }
  });

  it("is smaller than dumping the whole log verbatim", async () => {
    const { state } = await longGame();
    const observation = observationFor(state, 1);
    const pack = packFor(observation, ledgerFrom(observation, SEATS));
    const verbatim = state.log
      .map((e) => (e.type === "speech" ? `${e.speaker}号：${e.publicMessage}` : `[${e.type}]`))
      .join("\n");
    // Tables beat prose. If this ever inverts, the tables have grown into prose.
    expect(packSize(pack)).toBeLessThan(verbatim.length * 1.5);
  });
});

describe("determinism", () => {
  it("packs identical observations identically", async () => {
    const { state, actions } = await game(6);
    const rebuilt = replayPrefix(6, actions, { config: CONFIG, runId: "cog" });
    for (const seat of SEATS) {
      const a = observationFor(state, seat);
      const b = observationFor(rebuilt, seat);
      const packA = renderPack(packFor(a, ledgerFrom(a, SEATS)));
      const packB = renderPack(packFor(b, ledgerFrom(b, SEATS)));
      expect(packB, `${seat}号`).toBe(packA);
    }
  });

  it("packs the same observation identically twice", async () => {
    const { state } = await game(7);
    const observation = observationFor(state, 3);
    const first = renderPack(packFor(observation, ledgerFrom(observation, SEATS)));
    const second = renderPack(packFor(observation, ledgerFrom(observation, SEATS)));
    expect(second).toBe(first);
  });
});
