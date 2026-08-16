import { describe, it, expect } from "vitest";
import {
  getCurrentOpinion,
  getCurrentOpinions,
  getOpinionHistory,
  getPlayerOpinions,
} from "./opinions";
import { game } from "@/lib/fixtures/builder";
import { tenPlayerGame } from "@/lib/fixtures/ten-player-game";
import { removeEvents } from "@/lib/events/mutate";

describe("null is not neutral", () => {
  // This is the single most important data semantic in the app. "Never said
  // anything about them" and "explicitly said 看不清" are different facts, and
  // conflating them would fabricate opinions nobody expressed.

  it("returns null for a pair that was never rated", () => {
    const built = game(9).opinion(1, 2, 4).build();
    expect(getCurrentOpinion(built.events, built.game.players[0].id, built.game.players[4].id))
      .toBeNull();
  });

  it("returns a real cell for an explicitly recorded 3", () => {
    const built = game(9).opinion(1, 5, 3).build();
    const cell = getCurrentOpinion(
      built.events,
      built.game.players[0].id,
      built.game.players[4].id,
    );
    expect(cell).not.toBeNull();
    expect(cell!.rating).toBe(3);
  });

  it("keeps an unrated pair out of the current map entirely", () => {
    const built = game(9).opinion(1, 2, 4).build();
    const current = getCurrentOpinions(built.events);
    const speaker = built.game.players[0].id;
    expect(current.get(speaker)!.has(built.game.players[1].id)).toBe(true);
    expect(current.get(speaker)!.has(built.game.players[2].id)).toBe(false);
  });

  it("has no entry at all for a speaker who never said anything", () => {
    const built = game(9).opinion(1, 2, 4).build();
    expect(getCurrentOpinions(built.events).get(built.game.players[8].id)).toBeUndefined();
  });
});

describe("opinion history is never overwritten", () => {
  const built = game(9).opinion(3, 6, 4).opinion(3, 6, 5).opinion(3, 6, 2).build();
  const speaker = built.game.players[2].id;
  const target = built.game.players[5].id;

  it("keeps every revision in order", () => {
    const history = getOpinionHistory(built.events, speaker, target);
    expect(history.map((e) => e.rating)).toEqual([4, 5, 2]);
    // Ascending by sequence, not by timestamp.
    expect(history[0].sequence).toBeLessThan(history[1].sequence);
    expect(history[1].sequence).toBeLessThan(history[2].sequence);
  });

  it("reports the latest as current, with a revision count", () => {
    const cell = getCurrentOpinion(built.events, speaker, target)!;
    expect(cell.rating).toBe(2);
    expect(cell.revisionCount).toBe(3);
  });

  it("falls back to the previous rating when the latest is deleted", () => {
    const latest = getCurrentOpinion(built.events, speaker, target)!;
    const after = removeEvents(built.events, [latest.eventId]);
    const cell = getCurrentOpinion(after, speaker, target)!;
    expect(cell.rating).toBe(5);
    expect(cell.revisionCount).toBe(2);
  });

  it("returns to null — not 3 — when the only rating is deleted", () => {
    const single = game(9).opinion(1, 2, 4).build();
    const after = removeEvents(single.events, [single.events[0].id]);
    expect(
      getCurrentOpinion(after, single.game.players[0].id, single.game.players[1].id),
    ).toBeNull();
  });

  it("returns an empty array for a pair with no history", () => {
    expect(getOpinionHistory(built.events, speaker, built.game.players[8].id)).toEqual([]);
  });
});

describe("directionality", () => {
  const built = game(9).opinion(1, 2, 5).opinion(2, 1, 1).opinion(3, 1, 4).build();
  const [p1, p2, p3] = built.game.players;

  it("separates what a player said from what was said about them", () => {
    const { expressed, received } = getPlayerOpinions(built.events, p1.id);
    expect(expressed.map((e) => [e.targetId, e.cell.rating])).toEqual([[p2.id, 5]]);
    expect(
      received.map((e) => [e.speakerId, e.cell.rating]).sort(),
    ).toEqual([[p2.id, 1], [p3.id, 4]].sort());
  });

  it("keeps asymmetric readings distinct", () => {
    expect(getCurrentOpinion(built.events, p1.id, p2.id)!.rating).toBe(5);
    expect(getCurrentOpinion(built.events, p2.id, p1.id)!.rating).toBe(1);
  });
});

describe("self-opinions", () => {
  it("are stored and retrievable like any other pair", () => {
    const built = game(9).opinion(4, 4, 5).build();
    const p4 = built.game.players[3].id;
    expect(getCurrentOpinion(built.events, p4, p4)!.rating).toBe(5);
  });
});

describe("Fixture B opinion data", () => {
  const built = tenPlayerGame();
  const [p1, , p3, p4] = built.game.players;

  it("preserves the full 4 → 5 → 2 chain", () => {
    const history = getOpinionHistory(built.events, p1.id, p4.id);
    expect(history.map((e) => e.rating)).toEqual([4, 5, 2]);
    expect(getCurrentOpinion(built.events, p1.id, p4.id)!.rating).toBe(2);
  });

  it("leaves untouched pairs as null", () => {
    // 3号 rated 4号 and 7号, but never 1号.
    expect(getCurrentOpinion(built.events, p3.id, p1.id)).toBeNull();
  });

  it("records the mission each rating was given in", () => {
    const history = getOpinionHistory(built.events, p1.id, p4.id);
    expect(history.map((e) => e.missionNumber)).toEqual([1, 2, 3]);
  });
});
