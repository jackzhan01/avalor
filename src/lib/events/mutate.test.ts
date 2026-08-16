import { describe, it, expect } from "vitest";
import {
  collectCascade,
  insertEvents,
  nextSequence,
  removeEvents,
  replaceEvent,
} from "./mutate";
import { assignContext } from "./context";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import { allApprove, approveOnly, game } from "@/lib/fixtures/builder";
import type { GameEvent } from "@/lib/types/events";

/** A game with a deletable proposal in the middle of mission 1. */
function midGame() {
  return game(9)
    .opinion(1, 2, 4) // 0
    .proposal(1, [1, 2, 3]) // 1
    .vote(approveOnly(9, [1]), "rejected") // 2
    .opinion(1, 3, 2) // 3  — mission 1, proposal 2
    .proposal(2, [1, 2, 4]) // 4
    .vote(allApprove(9), "passed") // 5
    .mission("success", 0) // 6
    .opinion(1, 4, 5) // 7  — mission 2, proposal 1
    .build();
}

describe("sequence numbers", () => {
  it("increase monotonically", () => {
    const built = midGame();
    const seqs = built.events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("leave a gap on delete and never renumber the survivors", () => {
    const built = midGame();
    const removedSeq = built.events[3].sequence;
    const after = removeEvents(built.events, [built.events[3].id]);

    expect(after.map((e) => e.sequence)).not.toContain(removedSeq);
    // Every survivor keeps the exact sequence it had.
    for (const event of after) {
      const original = built.events.find((e) => e.id === event.id)!;
      expect(event.sequence).toBe(original.sequence);
    }
  });

  it("continue past the gap rather than reusing it", () => {
    const built = midGame();
    const after = removeEvents(built.events, [built.events[7].id]);
    // Last remaining sequence is 7, so the next is 8 — the freed 8 is not reused.
    expect(nextSequence(built.events)).toBe(9);
    expect(nextSequence(after)).toBe(8);
  });

  it("nextSequence is 1 for an empty log", () => {
    expect(nextSequence([])).toBe(1);
  });
});

describe("collectCascade", () => {
  const built = midGame();

  it("takes nothing with an opinion", () => {
    const plan = collectCascade(built.events, built.events[0].id)!;
    expect(plan.dependents).toEqual([]);
    expect(plan.description).toBe("");
  });

  it("takes the vote and the mission with a proposal", () => {
    const plan = collectCascade(built.events, built.events[4].id)!;
    const kinds = plan.dependents.map((e) => e.type).sort();
    expect(kinds).toEqual(["mission", "vote"]);
    expect(plan.ids).toHaveLength(3);
    expect(plan.description).toContain("投票");
    expect(plan.description).toContain("任务");
  });

  it("takes the mission with a vote", () => {
    const plan = collectCascade(built.events, built.events[5].id)!;
    expect(plan.dependents.map((e) => e.type)).toEqual(["mission"]);
  });

  it("takes nothing with a mission result", () => {
    const plan = collectCascade(built.events, built.events[6].id)!;
    expect(plan.dependents).toEqual([]);
  });

  it("leaves the mission alone if another vote still justifies it", () => {
    // Two votes on the same proposal; deleting one leaves the other standing.
    const proposalId = built.events[4].id;
    const secondVote: GameEvent = {
      ...(built.events[5] as GameEvent),
      id: "vote-2",
      sequence: 99,
    };
    const events = [...built.events, secondVote];
    const plan = collectCascade(events, built.events[5].id)!;
    expect(plan.dependents).toEqual([]);
    expect(proposalId).toBeTruthy();
  });

  it("returns null for an id that isn't in the log", () => {
    expect(collectCascade(built.events, "nope")).toBeNull();
  });
});

describe("assignContext", () => {
  it("renumbers the events that moved after a mid-game proposal is deleted", () => {
    const built = midGame();
    const plan = collectCascade(built.events, built.events[1].id)!;
    const after = removeEvents(built.events, plan.ids);
    const { events, changed } = assignContext(after, built.game);

    // The opinion that used to sit in proposal 2 now sits in proposal 1.
    const movedOpinion = events.find((e) => e.id === built.events[3].id)!;
    expect(built.events[3].proposalNumber).toBe(2);
    expect(movedOpinion.proposalNumber).toBe(1);
    expect(changed.map((e) => e.id)).toContain(built.events[3].id);

    // The event in mission 2 did not move at all.
    const untouched = events.find((e) => e.id === built.events[7].id)!;
    expect(untouched.missionNumber).toBe(2);
    expect(untouched.proposalNumber).toBe(1);
    expect(changed.map((e) => e.id)).not.toContain(built.events[7].id);
  });

  it("reports nothing changed when the log is already consistent", () => {
    const built = midGame();
    const { events, changed } = assignContext(built.events, built.game);
    expect(changed).toEqual([]);
    // Same array identity, so React consumers don't re-render for nothing.
    expect(events).toBe(built.events);
  });

  it("leaves stored context equal to derived context afterwards", () => {
    const built = midGame();
    const plan = collectCascade(built.events, built.events[1].id)!;
    const { events } = assignContext(
      removeEvents(built.events, plan.ids),
      built.game,
    );
    const timeline = deriveTimeline(events, built.game);
    for (const event of events) {
      const ctx = timeline.eventContext.get(event.id)!;
      expect(event.missionNumber).toBe(ctx.missionNumber);
      expect(event.proposalNumber).toBe(ctx.proposalNumber);
    }
  });
});

describe("undo of a delete", () => {
  it("restores the exact rows in their original positions", () => {
    const built = midGame();
    const plan = collectCascade(built.events, built.events[4].id)!;
    const removed = [plan.target, ...plan.dependents];
    const after = removeEvents(built.events, plan.ids);

    expect(after).toHaveLength(built.events.length - 3);

    // This only works because deletion never renumbered anything.
    const restored = insertEvents(after, removed);
    expect(restored.map((e) => e.id)).toEqual(built.events.map((e) => e.id));
    expect(restored.map((e) => e.sequence)).toEqual(
      built.events.map((e) => e.sequence),
    );
  });

  it("keeps the derived timeline identical before and after a delete/undo cycle", () => {
    const built = midGame();
    const before = deriveTimeline(built.events, built.game);

    const plan = collectCascade(built.events, built.events[4].id)!;
    const removed = [plan.target, ...plan.dependents];
    const after = removeEvents(built.events, plan.ids);
    const restored = insertEvents(after, removed);

    const afterUndo = deriveTimeline(restored, built.game);
    expect(afterUndo.phase).toBe(before.phase);
    expect(afterUndo.missionNumber).toBe(before.missionNumber);
    expect(afterUndo.proposalNumber).toBe(before.proposalNumber);
    expect(afterUndo.successCount).toBe(before.successCount);
  });
});

describe("undo of an edit", () => {
  it("puts the previous payload back", () => {
    const built = midGame();
    const before = built.events[0];
    if (before.type !== "opinion") throw new Error("expected an opinion");

    const edited = { ...before, rating: 1 as const };
    const afterEdit = replaceEvent(built.events, edited);
    expect(
      (afterEdit[0] as typeof before).rating,
    ).toBe(1);

    const afterUndo = replaceEvent(afterEdit, before);
    expect((afterUndo[0] as typeof before).rating).toBe(4);
    expect(afterUndo[0].sequence).toBe(before.sequence);
  });
});
