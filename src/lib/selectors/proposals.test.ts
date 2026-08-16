import { describe, it, expect } from "vitest";
import { deriveTimeline } from "./derive-timeline";
import { getCurrentProposal, getPlayerProposalHistory } from "./proposals";
import {
  getMissionResults,
  getMissionSummaries,
  getPlayerMissionParticipation,
  getPlayerNotes,
  getScore,
} from "./missions";
import { allApprove, approveOnly, game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import { tenPlayerGame } from "@/lib/fixtures/ten-player-game";

describe("getCurrentProposal", () => {
  it("is null during open discussion", () => {
    const built = game(9).build();
    expect(getCurrentProposal(built.events, built.game)).toBeNull();
  });

  it("returns the proposal awaiting a vote", () => {
    const built = game(9).proposal(1, [1, 2, 3]).build();
    const proposal = getCurrentProposal(built.events, built.game)!;
    expect(proposal.status).toBe("voting");
    expect(proposal.event.teamPlayerIds).toHaveLength(3);
  });

  it("still returns the proposal after it passes, while the mission is pending", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(allApprove(9), "passed")
      .build();
    expect(getCurrentProposal(built.events, built.game)!.status).toBe("passed");
  });

  it("is null again once the mission result is in", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(allApprove(9), "passed")
      .mission("success", 0)
      .build();
    expect(getCurrentProposal(built.events, built.game)).toBeNull();
  });

  it("is null after a rejection", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .build();
    expect(getCurrentProposal(built.events, built.game)).toBeNull();
  });
});

describe("proposal statuses cover all five values", () => {
  it("produces draft, rejected, and mission_completed alongside voting/passed", () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .proposal(1, [1, 2, 4]) // supersedes -> draft
      .vote(approveOnly(9, [1]), "rejected") // -> rejected
      .proposal(2, [2, 3, 4])
      .vote(allApprove(9), "passed")
      .mission("success", 0) // -> mission_completed
      .proposal(3, [1, 2, 3]) // -> voting
      .build();

    const { proposalsById, proposalOrder } = deriveTimeline(
      built.events,
      built.game,
    );

    const statuses = proposalOrder.map((id) => proposalsById.get(id)!.status);
    expect(statuses).toEqual([
      "draft",
      "rejected",
      "mission_completed",
      "voting",
    ]);
  });
});

describe("getPlayerProposalHistory", () => {
  const built = ninePlayerGame();
  const seat = (n: number) => built.game.players[n - 1].id;

  it("splits proposals led from proposals joined", () => {
    const history = getPlayerProposalHistory(built.events, built.game, seat(1));
    expect(history.timesLed).toBe(1);
    expect(history.timesIncluded).toBeGreaterThan(1);
  });

  it("counts outcomes for proposals this player led", () => {
    const history = getPlayerProposalHistory(built.events, built.game, seat(3));
    expect(history.asLeaderOutcome.passed).toBe(1);
    expect(history.asLeaderOutcome.rejected).toBe(0);
  });

  it("counts a rejected proposal against its leader", () => {
    const history = getPlayerProposalHistory(built.events, built.game, seat(2));
    expect(history.asLeaderOutcome.rejected).toBe(1);
    expect(history.asLeaderOutcome.passed).toBe(0);
  });

  it("returns empty histories for a player who never led or rode", () => {
    const empty = game(9).build();
    const history = getPlayerProposalHistory(empty.events, empty.game, empty.game.players[0].id);
    expect(history.asLeader).toEqual([]);
    expect(history.asMember).toEqual([]);
  });
});

describe("mission summaries", () => {
  it("always has five entries, even for an empty game", () => {
    const built = game(9).build();
    const summaries = getMissionSummaries(built.events, built.game);
    expect(summaries).toHaveLength(5);
    expect(summaries.map((m) => m.status)).toEqual([
      "in_progress",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("wires team sizes and the two-fail rule from the rules table", () => {
    const built = game(10).build();
    const summaries = getMissionSummaries(built.events, built.game);
    expect(summaries.map((m) => m.expectedTeamSize)).toEqual([3, 4, 4, 5, 5]);
    expect(summaries.map((m) => m.requiredFails)).toEqual([1, 1, 1, 2, 1]);
  });

  it("keeps mission 4 at one required fail for a 5-player game", () => {
    const built = game(5).build();
    expect(getMissionSummaries(built.events, built.game).map((m) => m.requiredFails))
      .toEqual([1, 1, 1, 1, 1]);
  });

  it("returns only completed missions from getMissionResults", () => {
    const built = ninePlayerGame();
    const results = getMissionResults(built.events, built.game);
    expect(results).toHaveLength(3);
    expect(results.map((m) => m.result)).toEqual(["success", "fail", "success"]);
  });

  it("distinguishes an unrecorded fail count from zero", () => {
    const built = tenPlayerGame();
    const summaries = getMissionSummaries(built.events, built.game);
    expect(summaries[0].failCount).toBe(0); // recorded as 0
    expect(summaries[4].failCount).toBeNull(); // never recorded
  });

  it("tracks the score", () => {
    const built = ninePlayerGame();
    expect(getScore(built.events, built.game)).toEqual({ good: 2, evil: 1 });
  });
});

describe("player mission participation and notes", () => {
  const built = ninePlayerGame();
  const seat = (n: number) => built.game.players[n - 1].id;

  it("lists only the missions a player actually went on", () => {
    // 9-player fixture: mission 1 team [1,3,5], mission 2 [2,4,6,8], mission 3 [1,2,3,6].
    const p1 = getPlayerMissionParticipation(built.events, built.game, seat(1));
    expect(p1.map((m) => m.missionNumber)).toEqual([1, 3]);

    const p4 = getPlayerMissionParticipation(built.events, built.game, seat(4));
    expect(p4.map((m) => [m.missionNumber, m.result])).toEqual([[2, "fail"]]);
  });

  it("returns notes attached to a player, and not the table-wide ones", () => {
    const notes = getPlayerNotes(built.events, seat(6));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain("解释");
  });
});
