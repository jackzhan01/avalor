import { describe, it, expect } from "vitest";
import { deriveTimeline } from "./derive-timeline";
import { allApprove, approveOnly, game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import { tenPlayerGame } from "@/lib/fixtures/ten-player-game";
import type { VoteEvent } from "@/lib/types/events";

describe("deriveTimeline — the empty log", () => {
  it("starts at mission 1, proposal 1, discussion", () => {
    const built = game(9).build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.phase).toBe("discussion");
    expect(t.missionNumber).toBe(1);
    expect(t.proposalNumber).toBe(1);
    expect(t.activeProposalId).toBeNull();
    expect(t.successCount).toBe(0);
    expect(t.failCount).toBe(0);
    expect(t.isComplete).toBe(false);
    expect(t.missions).toHaveLength(5);
  });
});

describe("deriveTimeline — phase transitions", () => {
  it("a proposal moves the game to voting", () => {
    const built = game(9).proposal(1, [1, 2, 3]).build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.phase).toBe("voting");
    expect(t.activeProposalId).not.toBeNull();
    expect(t.proposalsById.get(t.activeProposalId!)!.status).toBe("voting");
  });

  it("a rejection bumps the proposal number and LEAVES the mission number alone", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.phase).toBe("discussion");
    expect(t.missionNumber).toBe(1); // unchanged — this is the whole point
    expect(t.proposalNumber).toBe(2);
    expect(t.rejectionStreak).toBe(1);
    expect(t.activeProposalId).toBeNull();
  });

  it("a passed vote moves to the mission phase without changing any numbering", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(allApprove(9), "passed")
      .build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.phase).toBe("mission");
    expect(t.missionNumber).toBe(1);
    expect(t.proposalNumber).toBe(1);
    // The passed proposal stays "active" until its mission result lands.
    expect(t.activeProposalId).not.toBeNull();
    expect(t.proposalsById.get(t.activeProposalId!)!.status).toBe("passed");
  });

  it("a mission result advances the mission and resets the proposal number", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .proposal(2, [1, 2, 4])
      .vote(allApprove(9), "passed")
      .mission("success", 0)
      .build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.phase).toBe("discussion");
    expect(t.missionNumber).toBe(2);
    expect(t.proposalNumber).toBe(1); // reset, not carried over
    expect(t.rejectionStreak).toBe(0);
    expect(t.successCount).toBe(1);
    expect(t.activeProposalId).toBeNull();
  });
});

describe("deriveTimeline — a second proposal before any vote", () => {
  it("supersedes the first as a draft and does NOT advance the proposal number", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .proposal(1, [1, 2, 5]) // leader changed their mind
      .build();
    const t = deriveTimeline(built.events, built.game);

    const [firstId, secondId] = t.proposalOrder;
    expect(t.proposalsById.get(firstId)!.status).toBe("draft");
    expect(t.proposalsById.get(secondId)!.status).toBe("voting");
    expect(t.proposalNumber).toBe(1); // no vote happened, so nothing advances
    expect(t.activeProposalId).toBe(secondId);
    expect(t.phase).toBe("voting");
  });

  it("does not supersede a proposal that already passed", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(allApprove(9), "passed")
      .proposal(2, [1, 2, 4]) // recorded before the mission result — odd but legal
      .build();
    const t = deriveTimeline(built.events, built.game);
    const [firstId] = t.proposalOrder;
    expect(t.proposalsById.get(firstId)!.status).toBe("passed");
  });
});

describe("deriveTimeline — malformed logs are tolerated, not fatal", () => {
  it("flags a vote with no matching proposal and leaves the phase alone", () => {
    const builder = game(9);
    const orphan: VoteEvent = {
      id: "orphan-vote",
      gameId: "g1",
      type: "vote",
      proposalId: "does-not-exist",
      votes: {},
      finalResult: "passed",
      missionNumber: 1,
      proposalNumber: 1,
      sequence: 500,
      timestamp: new Date().toISOString(),
    };
    const built = builder.raw(orphan).build();
    const t = deriveTimeline(built.events, built.game);

    expect(t.warnings.some((w) => w.kind === "orphan_vote")).toBe(true);
    expect(t.phase).toBe("discussion");
    expect(t.missionNumber).toBe(1);
  });

  it("lets the newest vote on a proposal win and flags the older one", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .build();
    // Re-record the same proposal's vote, this time as passed.
    const proposalId = built.events[0].id;
    const second: VoteEvent = {
      id: "second-vote",
      gameId: "g1",
      type: "vote",
      proposalId,
      votes: {},
      finalResult: "passed",
      missionNumber: 1,
      proposalNumber: 1,
      sequence: 99,
      timestamp: new Date().toISOString(),
    };
    const events = [...built.events, second];
    const t = deriveTimeline(events, built.game);

    expect(t.proposalsById.get(proposalId)!.vote!.id).toBe("second-vote");
    expect(t.proposalsById.get(proposalId)!.status).toBe("passed");
    expect(t.phase).toBe("mission");
    expect(t.warnings.some((w) => w.kind === "superseded_vote")).toBe(true);
  });

  it("honours finalResult even when the full vote vector contradicts it", () => {
    // Everyone approves, but the user recorded the proposal as rejected.
    const built = game(5).proposal(1, [1, 2]).vote(allApprove(5), "rejected").build();
    const t = deriveTimeline(built.events, built.game);

    const proposal = t.proposalsById.get(t.proposalOrder[0])!;
    expect(proposal.status).toBe("rejected"); // recorded result wins
    expect(t.warnings.some((w) => w.kind === "vote_result_mismatch")).toBe(true);
  });

  it("does not flag a mismatch when the vote vector is incomplete", () => {
    // Only two seats recorded — nothing to check finalResult against.
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote({ 1: "approve", 2: "approve" }, "rejected")
      .build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.warnings.some((w) => w.kind === "vote_result_mismatch")).toBe(false);
  });
});

describe("deriveTimeline — completion", () => {
  it("is complete after three successful missions", () => {
    let b = game(9);
    for (let i = 0; i < 3; i++) {
      b = b.proposal(1, [1, 2, 3]).vote(allApprove(9), "passed").mission("success", 0);
    }
    const built = b.build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.successCount).toBe(3);
    expect(t.isComplete).toBe(true);
    expect(t.completionReason).toBe("missions_good");
  });

  it("is complete after three failed missions", () => {
    let b = game(9);
    for (let i = 0; i < 3; i++) {
      b = b.proposal(1, [1, 2, 3]).vote(allApprove(9), "passed").mission("fail", 1);
    }
    const built = b.build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.failCount).toBe(3);
    expect(t.completionReason).toBe("missions_evil");
  });

  it("is complete after five consecutive rejections", () => {
    let b = game(9);
    for (let i = 0; i < 5; i++) {
      b = b.proposal(1, [1, 2, 3]).vote(approveOnly(9, [1]), "rejected");
    }
    const built = b.build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.rejectionStreak).toBe(5);
    expect(t.completionReason).toBe("rejection_limit");
    expect(t.warnings.some((w) => w.kind === "rejection_limit_reached")).toBe(true);
  });

  it("treats a manually ended game as complete", () => {
    const built = game(9).complete("good").build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.isComplete).toBe(true);
    expect(t.completionReason).toBe("manual");
  });

  it("resets the rejection streak once a proposal passes", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .proposal(2, [1, 2, 4])
      .vote(approveOnly(9, [1]), "rejected")
      .proposal(3, [1, 2, 5])
      .vote(allApprove(9), "passed")
      .build();
    const t = deriveTimeline(built.events, built.game);
    expect(t.rejectionStreak).toBe(0);
    expect(t.proposalNumber).toBe(3);
  });
});

describe("deriveTimeline — event context", () => {
  it("assigns every event to the mission and proposal it happened in", () => {
    const built = game(9)
      .opinion(1, 2, 4) // mission 1, proposal 1
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected") // still mission 1, proposal 1
      .opinion(1, 3, 2) // mission 1, proposal 2
      .proposal(2, [1, 2, 4])
      .vote(allApprove(9), "passed")
      .mission("success", 0) // mission 1, proposal 2
      .opinion(1, 4, 5) // mission 2, proposal 1
      .build();
    const t = deriveTimeline(built.events, built.game);
    const ctx = (i: number) => t.eventContext.get(built.events[i].id)!;

    expect(ctx(0)).toEqual({ missionNumber: 1, proposalNumber: 1 });
    expect(ctx(2)).toEqual({ missionNumber: 1, proposalNumber: 1 }); // the reject vote
    expect(ctx(3)).toEqual({ missionNumber: 1, proposalNumber: 2 });
    expect(ctx(6)).toEqual({ missionNumber: 1, proposalNumber: 2 }); // the mission
    expect(ctx(7)).toEqual({ missionNumber: 2, proposalNumber: 1 });
  });

  it("agrees with the numbering the fixture builder tracked independently", () => {
    for (const built of [ninePlayerGame(), tenPlayerGame()]) {
      const t = deriveTimeline(built.events, built.game);
      for (const event of built.events) {
        const ctx = t.eventContext.get(event.id)!;
        expect(ctx.missionNumber).toBe(event.missionNumber);
        expect(ctx.proposalNumber).toBe(event.proposalNumber);
      }
    }
  });
});

describe("Fixture A — 9 players, stopped mid-game", () => {
  const built = ninePlayerGame();
  const t = deriveTimeline(built.events, built.game);

  it("ends with a proposal on the table awaiting a vote", () => {
    expect(t.phase).toBe("voting");
    expect(t.missionNumber).toBe(4);
    expect(t.proposalNumber).toBe(1);
    expect(t.activeProposalId).not.toBeNull();
  });

  it("has two successes and one fail, and is not complete", () => {
    expect(t.successCount).toBe(2);
    expect(t.failCount).toBe(1);
    expect(t.isComplete).toBe(false);
  });

  it("records three completed missions with the right results", () => {
    expect(t.missions[0].result).toBe("success");
    expect(t.missions[1].result).toBe("fail");
    expect(t.missions[1].failCount).toBe(1);
    expect(t.missions[2].result).toBe("success");
    expect(t.missions[3].result).toBeNull();
    expect(t.missions[3].status).toBe("in_progress");
  });

  it("groups all three of mission 1's proposals under mission 1", () => {
    expect(t.missions[0].proposalIds).toHaveLength(3);
    expect(t.missions[1].proposalIds).toHaveLength(2);
  });

  it("has a clean log — no integrity warnings", () => {
    expect(t.warnings).toEqual([]);
  });
});

describe("Fixture B — 10 players, played to the end", () => {
  const built = tenPlayerGame();
  const t = deriveTimeline(built.events, built.game);

  it("plays all five missions and ends with evil taking three", () => {
    expect(t.successCount).toBe(2);
    expect(t.failCount).toBe(3);
    expect(t.completionReason).toBe("missions_evil");
    expect(t.missions.every((m) => m.result !== null)).toBe(true);
  });

  it("reaches the fifth proposal in mission 3 without triggering the auto-loss", () => {
    expect(t.missions[2].proposalIds).toHaveLength(5);
    expect(t.missions[2].result).toBe("success");
  });

  it("knows mission 4 needs two fail cards at 10 players", () => {
    expect(t.missions[3].requiredFails).toBe(2);
    expect(t.missions[3].failCount).toBe(2);
    expect(t.missions[3].result).toBe("fail");
  });

  it("keeps an omitted fail count as null, not 0", () => {
    expect(t.missions[4].result).toBe("fail");
    expect(t.missions[4].failCount).toBeNull();
  });

  it("has a clean log — no integrity warnings", () => {
    expect(t.warnings).toEqual([]);
  });
});
