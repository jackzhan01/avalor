import { describe, it, expect } from "vitest";
import {
  getClaimants,
  getIntendedTeam,
  getIntendedTeamHistory,
  getPlayerStatements,
  getRoleClaim,
  getRoleClaimHistory,
} from "./statements";
import { deriveTimeline } from "./derive-timeline";
import { getPlayerProposalHistory } from "./proposals";
import { allApprove, approveOnly, game } from "@/lib/fixtures/builder";
import { removeEvents } from "@/lib/events/mutate";

describe("意向车 — stated teams", () => {
  it("returns null when a player never said who they'd take", () => {
    const built = game(9).intendedTeam(1, [1, 2, 3]).build();
    expect(getIntendedTeam(built.events, built.game.players[4].id)).toBeNull();
  });

  it("keeps every version and reports the latest as current", () => {
    const built = game(9)
      .intendedTeam(3, [1, 3, 5])
      .intendedTeam(3, [1, 3, 7])
      .intendedTeam(3, [2, 3, 8])
      .build();
    const p3 = built.game.players[2].id;

    const history = getIntendedTeamHistory(built.events, p3);
    expect(history).toHaveLength(3);
    expect(history.map((e) => e.teamPlayerIds.length)).toEqual([3, 3, 3]);
    expect(getIntendedTeam(built.events, p3)!.id).toBe(history[2].id);
  });

  it("falls back to the previous statement when the latest is deleted", () => {
    const built = game(9)
      .intendedTeam(3, [1, 3, 5])
      .intendedTeam(3, [1, 3, 7])
      .build();
    const p3 = built.game.players[2].id;
    const latest = getIntendedTeam(built.events, p3)!;
    const after = removeEvents(built.events, [latest.id]);
    expect(getIntendedTeam(after, p3)!.teamPlayerIds).toEqual(
      [1, 3, 5].map((s) => `p${s}`),
    );
  });

  it("returns to null when the only statement is deleted", () => {
    const built = game(9).intendedTeam(3, [1, 3, 5]).build();
    const after = removeEvents(built.events, [built.events[0].id]);
    expect(getIntendedTeam(after, built.game.players[2].id)).toBeNull();
  });
});

describe("意向车 is kept apart from the proposals they actually make", () => {
  // The whole point: "said 1/3/5, took 2/4/6" has to stay legible.
  const built = game(9)
    .intendedTeam(3, [1, 3, 5])
    .proposal(3, [2, 4, 6])
    .vote(allApprove(9), "passed")
    .build();
  const p3 = built.game.players[2].id;

  it("does not turn a real proposal into a stated intention", () => {
    const history = getIntendedTeamHistory(built.events, p3);
    expect(history).toHaveLength(1);
    expect(history[0].teamPlayerIds).toEqual(["p1", "p3", "p5"]);
  });

  it("does not turn a stated intention into a proposal", () => {
    const proposals = getPlayerProposalHistory(built.events, built.game, p3);
    expect(proposals.asLeader).toHaveLength(1);
    expect(proposals.asLeader[0].teamPlayerIds).toEqual(["p2", "p4", "p6"]);
  });
});

describe("跳派 — Percival claims", () => {
  it("returns null for a player who never said either way", () => {
    const built = game(9).claim(4).build();
    expect(getRoleClaim(built.events, built.game.players[0].id)).toBeNull();
  });

  it("distinguishes 'never said' from an explicit retraction", () => {
    const built = game(9).claim(4).claim(4, false).build();
    const p4 = built.game.players[3].id;
    const state = getRoleClaim(built.events, p4)!;

    expect(state).not.toBeNull(); // they said something
    expect(state.claimed).toBe(false); // and what they said was "not me"
    expect(state.revisionCount).toBe(2);
  });

  it("keeps the whole flip-flop chain", () => {
    const built = game(9).claim(4).claim(4, false).claim(4).build();
    const p4 = built.game.players[3].id;
    expect(getRoleClaimHistory(built.events, p4).map((e) => e.claimed)).toEqual([
      true,
      false,
      true,
    ]);
    expect(getRoleClaim(built.events, p4)!.claimed).toBe(true);
  });

  it("lists everyone currently claiming — two claimants is the interesting case", () => {
    const built = game(9).claim(4).claim(7).claim(2).claim(2, false).build();
    const claimants = getClaimants(built.events).sort();
    expect(claimants).toEqual(["p4", "p7"]);
  });
});

describe("statements never move the game forward", () => {
  it("leaves phase and numbering untouched", () => {
    const withStatements = game(9)
      .intendedTeam(1, [1, 2, 3])
      .claim(4)
      .opinion(1, 4, 2)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1]), "rejected")
      .intendedTeam(2, [2, 4, 6])
      .claim(4, false)
      .build();

    const timeline = deriveTimeline(withStatements.events, withStatements.game);
    expect(timeline.phase).toBe("discussion");
    expect(timeline.missionNumber).toBe(1);
    expect(timeline.proposalNumber).toBe(2); // only the rejection advanced it
    expect(timeline.warnings).toEqual([]);
  });

  it("files statements under the round they were made in", () => {
    const built = game(9)
      .intendedTeam(1, [1, 2, 3]) // mission 1, proposal 1
      .proposal(1, [1, 2, 3])
      .vote(allApprove(9), "passed")
      .mission("success", 0)
      .claim(5) // mission 2, proposal 1
      .build();
    const timeline = deriveTimeline(built.events, built.game);

    expect(timeline.eventContext.get(built.events[0].id)).toEqual({
      missionNumber: 1,
      proposalNumber: 1,
    });
    expect(timeline.eventContext.get(built.events[4].id)).toEqual({
      missionNumber: 2,
      proposalNumber: 1,
    });
  });
});

describe("getPlayerStatements", () => {
  it("bundles both statement kinds for one player", () => {
    const built = game(9)
      .intendedTeam(6, [1, 6, 9])
      .claim(6)
      .intendedTeam(6, [2, 6, 8])
      .build();
    const p6 = built.game.players[5].id;
    const bundle = getPlayerStatements(built.events, p6);

    expect(bundle.intendedTeams).toHaveLength(2);
    expect(bundle.roleClaims).toHaveLength(1);
    expect(bundle.currentIntendedTeam!.teamPlayerIds).toEqual(["p2", "p6", "p8"]);
    expect(bundle.currentRoleClaim!.claimed).toBe(true);
  });

  it("returns empty bundles for a silent player", () => {
    const built = game(9).claim(6).build();
    const bundle = getPlayerStatements(built.events, built.game.players[0].id);
    expect(bundle.intendedTeams).toEqual([]);
    expect(bundle.currentIntendedTeam).toBeNull();
    expect(bundle.currentRoleClaim).toBeNull();
  });
});
