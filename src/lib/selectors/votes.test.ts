import { describe, it, expect } from "vitest";
import { getPlayerVoteHistory, summarizeVote } from "./votes";
import { deriveTimeline } from "./derive-timeline";
import { allApprove, approveOnly, game } from "@/lib/fixtures/builder";
import { tenPlayerGame } from "@/lib/fixtures/ten-player-game";

describe("the full vote pattern is preserved", () => {
  // Storing "6-4 通过" would throw away most of the information: which six
  // approved is the actual signal (spec §21).
  it("distinguishes two different 6-4 passes", () => {
    const a = game(10)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(10, [1, 2, 3, 4, 5, 6]), "passed")
      .build();
    const b = game(10)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(10, [1, 3, 5, 7, 8, 10]), "passed")
      .build();

    const voteA = deriveTimeline(a.events, a.game).proposalsById.get(a.events[0].id)!.vote!;
    const voteB = deriveTimeline(b.events, b.game).proposalsById.get(b.events[0].id)!.vote!;

    const approvers = (votes: Record<string, string>) =>
      Object.entries(votes)
        .filter(([, v]) => v === "approve")
        .map(([id]) => id)
        .sort();

    expect(approvers(voteA.votes)).toHaveLength(6);
    expect(approvers(voteB.votes)).toHaveLength(6);
    expect(approvers(voteA.votes)).not.toEqual(approvers(voteB.votes));
  });
});

describe("'unknown' is not the same as 'not recorded'", () => {
  const built = game(9)
    .proposal(1, [1, 2, 3])
    // 1 approves, 2 rejects, 3 explicitly unknown, everyone else untouched.
    .vote({ 1: "approve", 2: "reject", 3: "unknown" }, "passed")
    .build();
  const [p1, p2, p3, p4] = built.game.players;

  it("reports an explicit unknown as 'unknown'", () => {
    const { records } = getPlayerVoteHistory(built.events, built.game, p3.id);
    expect(records[0].vote).toBe("unknown");
  });

  it("reports an absent seat as null", () => {
    const { records } = getPlayerVoteHistory(built.events, built.game, p4.id);
    expect(records[0].vote).toBeNull();
  });

  it("tallies the two separately", () => {
    expect(getPlayerVoteHistory(built.events, built.game, p1.id).tally).toEqual({
      approve: 1, reject: 0, unknown: 0, unrecorded: 0,
    });
    expect(getPlayerVoteHistory(built.events, built.game, p2.id).tally).toEqual({
      approve: 0, reject: 1, unknown: 0, unrecorded: 0,
    });
    expect(getPlayerVoteHistory(built.events, built.game, p3.id).tally).toEqual({
      approve: 0, reject: 0, unknown: 1, unrecorded: 0,
    });
    expect(getPlayerVoteHistory(built.events, built.game, p4.id).tally).toEqual({
      approve: 0, reject: 0, unknown: 0, unrecorded: 1,
    });
  });

  it("summarizeVote splits all four buckets", () => {
    const vote = built.events[1];
    if (vote.type !== "vote") throw new Error("expected a vote event");
    const summary = summarizeVote(vote.votes, built.game);
    expect(summary.approve).toEqual([p1.id]);
    expect(summary.reject).toEqual([p2.id]);
    expect(summary.unknown).toEqual([p3.id]);
    expect(summary.unrecorded).toHaveLength(6);
  });
});

describe("vote records carry their context", () => {
  const built = game(9)
    .proposal(1, [1, 2, 3])
    .vote(approveOnly(9, [1]), "rejected")
    .proposal(2, [2, 4, 6])
    .vote(allApprove(9), "passed")
    .mission("success", 0)
    .build();
  const [p1, p2] = built.game.players;

  it("knows whether the voter was on the team", () => {
    const { records } = getPlayerVoteHistory(built.events, built.game, p2.id);
    expect(records.map((r) => r.wasOnTeam)).toEqual([true, true]);
    const forP1 = getPlayerVoteHistory(built.events, built.game, p1.id).records;
    expect(forP1.map((r) => r.wasOnTeam)).toEqual([true, false]);
  });

  it("carries the mission and proposal number of each vote", () => {
    const { records } = getPlayerVoteHistory(built.events, built.game, p1.id);
    expect(records.map((r) => [r.missionNumber, r.proposalNumber])).toEqual([
      [1, 1],
      [1, 2],
    ]);
  });

  it("carries the final result of the proposal", () => {
    const { records } = getPlayerVoteHistory(built.events, built.game, p1.id);
    expect(records.map((r) => r.finalResult)).toEqual(["rejected", "passed"]);
  });
});

describe("Fixture B partial voting", () => {
  const built = tenPlayerGame();
  const players = built.game.players;

  it("keeps two seats as explicit unknown and one seat unrecorded on mission 4's vote", () => {
    const p5 = getPlayerVoteHistory(built.events, built.game, players[4].id).records;
    const p6 = getPlayerVoteHistory(built.events, built.game, players[5].id).records;
    const p10 = getPlayerVoteHistory(built.events, built.game, players[9].id).records;

    // Mission 4's proposal is the 8th; find its record by mission number.
    const m4 = (records: typeof p5) => records.find((r) => r.missionNumber === 4)!;
    expect(m4(p5).vote).toBe("unknown");
    expect(m4(p6).vote).toBe("unknown");
    expect(m4(p10).vote).toBeNull();
  });
});
