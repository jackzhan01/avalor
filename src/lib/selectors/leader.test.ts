import { describe, it, expect } from "vitest";
import { getCurrentLeader, getSuggestedLeader } from "./leader";
import { allApprove, approveOnly, game } from "@/lib/fixtures/builder";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";

/** Seat number of the suggested leader, for readable assertions. */
function suggestedSeat(built: {
  game: GameRecord;
  events: GameEvent[];
}): number | null {
  const id = getSuggestedLeader(built.events, built.game);
  return built.game.players.find((p) => p.id === id)?.seat ?? null;
}

describe("getCurrentLeader", () => {
  it("starts at the configured first leader", () => {
    const built = game(9).firstLeader(4).build();
    const { playerId, source } = getCurrentLeader(built.events, built.game);
    expect(built.game.players.find((p) => p.id === playerId)!.seat).toBe(4);
    expect(source).toBe("initial");
  });

  it("uses the active proposal's leader while a proposal is on the table", () => {
    const built = game(9).firstLeader(1).proposal(6, [1, 2, 3]).build();
    const { playerId, source } = getCurrentLeader(built.events, built.game);
    expect(built.game.players.find((p) => p.id === playerId)!.seat).toBe(6);
    expect(source).toBe("active_proposal");
  });

  it("advances one seat after a proposal is voted on", () => {
    const built = game(9)
      .firstLeader(1)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .build();
    expect(suggestedSeat(built)).toBe(2);
    expect(getCurrentLeader(built.events, built.game).source).toBe("rotation");
  });

  it("advances after a mission completes too", () => {
    const built = game(9)
      .firstLeader(1)
      .proposal(3, [1, 2, 3])
      .vote(allApprove(9), "passed")
      .mission("success", 0)
      .build();
    expect(suggestedSeat(built)).toBe(4);
  });

  it("wraps from the last seat back to the first", () => {
    const built = game(9)
      .firstLeader(9)
      .proposal(9, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .build();
    expect(suggestedSeat(built)).toBe(1);
  });

  it("wraps at 10 players as well", () => {
    const built = game(10)
      .proposal(10, [1, 2, 3])
      .vote(approveOnly(10, [1]), "rejected")
      .build();
    expect(suggestedSeat(built)).toBe(1);
  });
});

describe("the leader is anchored, not counted", () => {
  /*
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * A modulo implementation — (firstLeader + proposalCount) % playerCount —
   * looks right until a user overrides a leader by hand, which happens all the
   * time (someone passed, someone was skipped, the user mis-tapped). After that
   * a counter is permanently off by the size of the skip and can never recover.
   * Anchoring on the last observed leader self-corrects immediately.
   */
  it("re-anchors on a manually chosen leader instead of drifting", () => {
    const built = game(9)
      .firstLeader(1)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      // The user records seat 7 as leader, skipping the natural rotation.
      .proposal(7, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .build();

    // Anchored: the seat after 7.
    expect(suggestedSeat(built)).toBe(8);

    // A counter would have said (1 + 2) = seat 3. Assert we are NOT that.
    expect(suggestedSeat(built)).not.toBe(3);
  });

  it("stays correct after several overrides in a row", () => {
    const built = game(10)
      .firstLeader(1)
      .proposal(5, [1, 2, 3])
      .vote(approveOnly(10, [1]), "rejected")
      .proposal(2, [1, 2, 3])
      .vote(approveOnly(10, [1]), "rejected")
      .proposal(9, [1, 2, 3])
      .vote(approveOnly(10, [1]), "rejected")
      .build();
    expect(suggestedSeat(built)).toBe(10);
  });

  it("ignores a proposal that was superseded before any vote", () => {
    const built = game(9)
      .firstLeader(1)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .proposal(2, [1, 2, 3]) // draft, replaced below
      .proposal(5, [1, 2, 4]) // the one that actually stands
      .build();
    // Still an active proposal, so the leader is that proposal's leader.
    expect(suggestedSeat(built)).toBe(5);
  });
});
