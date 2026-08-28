import { describe, expect, it } from "vitest";
import { drive, referenceDeal } from "../fixtures/harness";
import { applyAction } from "../core/referee";
import { emptyMemory, IllegalActionError, SEATS } from "../core/types";
import {
  MAX_BELIEFS,
  MAX_COMMITMENTS,
  MAX_INTENTIONS,
  MAX_NOTE_CHARS,
  normalisePatch,
  withBelief,
} from "./memory";

describe("compact private memory", () => {
  it("starts empty", () => {
    const memory = emptyMemory();
    expect(memory.version).toBe(0);
    expect(memory.beliefs).toEqual([]);
    expect(memory.intentions).toEqual([]);
    expect(memory.commitments).toEqual([]);
  });

  it("caps the belief list, the notes and the lists of lines", () => {
    const patch = normalisePatch({
      beliefs: SEATS.map((seat) => ({ seat, pEvil: 0.5, note: "字".repeat(500) })),
      intentions: ["a", "b", "c", "d", "e"],
      commitments: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(patch.beliefs).toHaveLength(MAX_BELIEFS);
    expect([...patch.beliefs![0].note].length).toBe(MAX_NOTE_CHARS);
    expect(patch.intentions).toHaveLength(MAX_INTENTIONS);
    expect(patch.commitments).toHaveLength(MAX_COMMITMENTS);
  });

  it("keeps one entry per seat", () => {
    const patch = normalisePatch({
      beliefs: [
        { seat: 3, pEvil: 0.1, note: "first" },
        { seat: 3, pEvil: 0.9, note: "second" },
      ],
    });
    expect(patch.beliefs).toHaveLength(1);
    expect(patch.beliefs![0].pEvil).toBe(0.1);
  });

  it("clamps probabilities into range", () => {
    const patch = normalisePatch({
      beliefs: [
        { seat: 1, pEvil: 5, note: "" },
        { seat: 2, pEvil: -3, note: "" },
      ],
    });
    expect(patch.beliefs![0].pEvil).toBe(1);
    expect(patch.beliefs![1].pEvil).toBe(0);
  });

  it("replaces one seat's entry and leaves the rest", () => {
    const base = {
      ...emptyMemory(),
      beliefs: [
        { seat: 1 as const, pEvil: 0.2, note: "a" },
        { seat: 2 as const, pEvil: 0.4, note: "b" },
      ],
    };
    const patch = withBelief(base, { seat: 2, pEvil: 0.9, note: "changed" });
    expect(patch.beliefs).toEqual([
      { seat: 1, pEvil: 0.2, note: "a" },
      { seat: 2, pEvil: 0.9, note: "changed" },
    ]);
  });

  /**
   * Truncating a private note is fine — nobody else reads it and nothing
   * downstream depends on its bytes. Truncating a public SPEECH is not, and
   * the referee rejects that instead. The two rules living in different files
   * is the point.
   */
  it("is truncated where a public speech would be rejected", () => {
    expect([...normalisePatch({ intentions: ["字".repeat(500)] }).intentions![0]].length).toBe(
      MAX_NOTE_CHARS,
    );
  });
});

describe("the referee is the only writer", () => {
  it("bumps the version and stamps the sequence when a patch lands", () => {
    const { state } = drive({
      seed: 2,
      deal: referenceDeal(),
      override: (observation) => {
        if (observation.request?.kind === "choose_opening_direction") {
          return {
            kind: "choose_opening_direction",
            ladySide: "left",
            publicMessage: "开局",
            memoryPatch: { intentions: ["先看第一辆车"] },
          };
        }
        return undefined;
      },
      stopWhen: (s) => s.phase === "discussion",
    });
    const leader = state.initialLeader;
    expect(state.memory[leader].version).toBe(1);
    expect(state.memory[leader].intentions).toEqual(["先看第一辆车"]);
    expect(state.memory[leader].lastUpdatedSequence).toBeGreaterThan(0);
    // Nobody else's memory moved.
    for (const seat of SEATS) {
      if (seat !== leader) expect(state.memory[seat].version).toBe(0);
    }
  });

  it("rejects a malformed patch rather than storing it", () => {
    const { state } = drive({
      seed: 3,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "vote",
    });
    const seat = state.pending!.seat;
    const before = state.memory[seat];
    expect(() =>
      applyAction(state, seat, {
        kind: "vote",
        choice: "approve",
        memoryPatch: { beliefs: [{ seat: 99 as unknown as 1, pEvil: 0.5, note: "" }] },
      }),
    ).toThrow(IllegalActionError);
    expect(() =>
      applyAction(state, seat, {
        kind: "vote",
        choice: "approve",
        memoryPatch: { beliefs: [{ seat: 1, pEvil: 7, note: "" }] },
      }),
    ).toThrow(IllegalActionError);
    expect(state.memory[seat]).toBe(before);
    expect(state.pendingVotes[seat]).toBeUndefined();
  });
});
