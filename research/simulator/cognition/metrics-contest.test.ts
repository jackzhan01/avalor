import { describe, expect, it } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { SEATS, type Seat, type Side } from "../core/types";
import { claimContestFrom, type ClaimContest } from "./claim-contest";
import type { PublicRecord, RevealedRoles } from "./metrics";
import {
  actionableRequestRate,
  activeClaimantsByTurn,
  attackGraph,
  claimantRoles,
  claimTimeline,
  coalitionsByClaimant,
  contestChangedTheGame,
  contestReport,
  counterclaimLatency,
  credibilityAcrossMissions,
  defenceResponseRate,
  falseLeaderCapture,
  followerSwitches,
  loyalAlignmentSplit,
  retractionOutcomes,
  teamOverlapWithClaimant,
  truePercivalInfluence,
  voteAlignmentByClaimant,
  type ContestObservation,
} from "./metrics-contest";

/**
 * Contest metrics, on inputs with answers you can count by eye.
 *
 * Hand-built for the same reason `metrics.test.ts` is: a metric checked against
 * a driven game can only be asserted to be "plausible", and the numbers that
 * matter most here — did the table follow Morgana, did the true Percival ever
 * address a rival, did any of it move a vote — are exactly the ones where
 * plausible is not good enough.
 */

/** A public log built from real speech events, so the registry is real. */
function log(
  entries: readonly {
    seq: number;
    speaker: Seat;
    claim?: RoleType | null;
    retract?: boolean;
    stances?: readonly { seat: Seat; valence: number; confidence: number }[];
    team?: readonly Seat[] | null;
  }[],
) {
  return entries.map((e) => ({
    type: "speech" as const,
    sequence: e.seq,
    missionNumber: 1,
    attempt: 1,
    speaker: e.speaker,
    slot: "regular" as const,
    publicMessage: "…",
    tentativeTeam: e.team ?? null,
    noTeamYet: false,
    claim: e.claim ?? null,
    ...(e.retract ? { retractClaim: true as const } : {}),
    stances: e.stances ?? [],
  }));
}

function obs(patch: Partial<ContestObservation> & { seat: Seat }): ContestObservation {
  return {
    taskId: "speech-regular",
    atSequence: 1,
    ownClaimStatus: "hidden",
    act: "stay-hidden",
    targetSeats: [],
    requestedTeam: null,
    requestedVote: "none",
    stance: "undecided",
    selectedClaimant: null,
    assessments: [],
    rivalSeats: [],
    ...patch,
  };
}

const EMPTY: PublicRecord = { votes: [], proposals: [], missions: [], speeches: [] };

/** Seat 2 Percival, 7 Morgana, 8 Assassin, 9 Mordred, 10 Oberon. */
const ROLES: RevealedRoles = (() => {
  const bySeat: Record<Seat, RoleType> = {
    1: "merlin",
    2: "percival",
    3: "loyal",
    4: "loyal",
    5: "loyal",
    6: "loyal",
    7: "morgana",
    8: "assassin",
    9: "mordred",
    10: "oberon",
  };
  const sideOf = {} as Record<Seat, Side>;
  for (const seat of SEATS) sideOf[seat] = seat >= 7 ? "evil" : "good";
  return { bySeat, sideOf };
})();

/** Two claimants, one attack, one retraction. */
const CONTEST: ClaimContest = claimContestFrom(
  log([
    { seq: 4, speaker: 2, claim: "percival", team: [1, 2, 3] },
    { seq: 8, speaker: 7, claim: "percival" },
    { seq: 12, speaker: 7, stances: [{ seat: 2, valence: -0.7, confidence: 0.6 }] },
    { seq: 20, speaker: 4, stances: [{ seat: 7, valence: 0.6, confidence: 0.5 }] },
    { seq: 30, speaker: 7, retract: true },
  ]) as never,
);

describe("the timeline", () => {
  it("counts claims, counterclaims and retractions", () => {
    const timeline = claimTimeline(CONTEST);
    expect(timeline.percivalClaims).toBe(2);
    expect(timeline.counterclaims).toBe(1);
    expect(timeline.retractions).toBe(1);
    expect(timeline.events[0]).toMatchObject({ seat: 2, kind: "claim", sequence: 4 });
  });

  it("tracks how crowded the identity is over time", () => {
    const points = activeClaimantsByTurn(CONTEST);
    expect(points.map((p) => p.active)).toEqual([1, 2, 1]);
    expect(points[points.length - 1].retracted).toBe(1);
  });

  it("measures how long the table waited to contest a claim", () => {
    const latency = counterclaimLatency(CONTEST);
    expect(latency.pairs).toBe(1);
    expect(latency.fastest).toBe(4);
    expect(latency.meanSequences).toBe(4);
  });

  it("reports zero latency when only one seat ever claimed", () => {
    const alone = claimContestFrom(log([{ seq: 4, speaker: 2, claim: "percival" }]) as never);
    expect(counterclaimLatency(alone)).toMatchObject({ pairs: 0, fastest: null });
  });
});

describe("who fought whom", () => {
  it("separates claimant-on-claimant attacks from bystander ones", () => {
    const edges = attackGraph(CONTEST);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: 7, to: 2, attacks: 1, betweenClaimants: 1 });
  });

  it("counts an answer only when the target's next move addresses it", () => {
    const answered = defenceResponseRate(
      [obs({ seat: 2, atSequence: 16, act: "defend-own-claim" })],
      CONTEST,
    );
    expect(answered).toMatchObject({ attacksReceived: 1, answered: 1, rate: 1 });

    const ignored = defenceResponseRate(
      [obs({ seat: 2, atSequence: 16, act: "stay-hidden" })],
      CONTEST,
    );
    expect(ignored).toMatchObject({ attacksReceived: 1, answered: 0, rate: 0 });
  });

  it("does not count a move made BEFORE the attack as an answer", () => {
    const early = defenceResponseRate(
      [obs({ seat: 2, atSequence: 6, act: "defend-own-claim" })],
      CONTEST,
    );
    expect(early.answered).toBe(0);
  });
});

describe("did claimants ask for anything executable", () => {
  it("counts a claimant move carrying a team or a vote", () => {
    const rate = actionableRequestRate([
      obs({ seat: 2, ownClaimStatus: "active", requestedTeam: [1, 2, 3] }),
      obs({ seat: 2, ownClaimStatus: "active", requestedVote: "approve" }),
      obs({ seat: 2, ownClaimStatus: "active" }),
      // Not a claimant: excluded from the denominator entirely.
      obs({ seat: 5, ownClaimStatus: "hidden" }),
    ]);
    expect(rate).toMatchObject({ claimantDecisions: 3, withTeamOrVote: 2 });
    expect(rate.rate).toBeCloseTo(2 / 3);
  });

  it("reports zero when nobody was claiming", () => {
    expect(actionableRequestRate([obs({ seat: 1 })])).toMatchObject({
      claimantDecisions: 0,
      rate: 0,
    });
  });
});

describe("coalitions and movement", () => {
  it("groups the last read of each seat under the claimant it backs", () => {
    const coalitions = coalitionsByClaimant([
      obs({ seat: 3, atSequence: 10, stance: "support", selectedClaimant: 2 }),
      obs({ seat: 4, atSequence: 10, stance: "conditional-support", selectedClaimant: 2 }),
      obs({ seat: 5, atSequence: 10, stance: "oppose", selectedClaimant: 2 }),
      obs({ seat: 6, atSequence: 10, stance: "support", selectedClaimant: 7 }),
    ]);
    const two = coalitions.find((c) => c.claimant === 2)!;
    expect(two.supporters).toEqual([3]);
    expect(two.conditionalSupporters).toEqual([4]);
    expect(two.opponents).toEqual([5]);
    expect(two.size).toBe(2);
  });

  it("uses only the LAST read, so a seat is not counted twice", () => {
    const coalitions = coalitionsByClaimant([
      obs({ seat: 3, atSequence: 5, stance: "support", selectedClaimant: 2 }),
      obs({ seat: 3, atSequence: 40, stance: "support", selectedClaimant: 7 }),
    ]);
    expect(coalitions.find((c) => c.claimant === 2)).toBeUndefined();
    expect(coalitions.find((c) => c.claimant === 7)!.supporters).toEqual([3]);
  });

  it("records every switch, in order", () => {
    const switches = followerSwitches([
      obs({ seat: 3, atSequence: 5, selectedClaimant: 2 }),
      obs({ seat: 3, atSequence: 25, selectedClaimant: 7 }),
      obs({ seat: 3, atSequence: 45, selectedClaimant: 2 }),
    ]);
    expect(switches).toHaveLength(2);
    expect(switches[0]).toMatchObject({ seat: 3, from: 2, to: 7 });
    expect(switches[1]).toMatchObject({ seat: 3, from: 7, to: 2 });
  });

  it("does not call a first choice a switch", () => {
    expect(followerSwitches([obs({ seat: 3, selectedClaimant: 2 })])).toHaveLength(0);
  });
});

describe("did any of it move a vote or a team", () => {
  const record: PublicRecord = {
    ...EMPTY,
    votes: [
      {
        missionNumber: 1,
        attempt: 1,
        leader: 2,
        team: [1, 2, 3],
        votes: { 1: "approve", 2: "approve", 3: "approve", 4: "reject", 5: "approve", 6: "approve", 7: "reject", 8: "reject", 9: "reject", 10: "reject" },
        result: "passed",
        atSequence: 40,
      },
    ],
    proposals: [{ missionNumber: 1, attempt: 1, leader: 3, team: [1, 2, 3], atSequence: 38 }],
  };

  it("counts a backer voting with its claimant", () => {
    const alignment = voteAlignmentByClaimant(
      [obs({ seat: 5, atSequence: 20, stance: "support", selectedClaimant: 2 })],
      record,
    );
    expect(alignment).toHaveLength(1);
    expect(alignment[0]).toMatchObject({ claimant: 2, compared: 1, agreed: 1 });
  });

  it("catches a backer voting against its claimant", () => {
    const alignment = voteAlignmentByClaimant(
      [obs({ seat: 4, atSequence: 20, stance: "support", selectedClaimant: 2 })],
      record,
    );
    expect(alignment[0]).toMatchObject({ compared: 1, agreed: 0, rate: 0 });
  });

  it("scores an exact team match at 1", () => {
    const overlap = teamOverlapWithClaimant(
      [
        obs({ seat: 3, atSequence: 20, stance: "support", selectedClaimant: 2 }),
        obs({ seat: 2, atSequence: 20, requestedTeam: [1, 2, 3] }),
      ],
      record,
    );
    expect(overlap).toMatchObject({ compared: 1, meanJaccard: 1 });
  });

  it("reports both halves of the impact separately", () => {
    const moved = contestChangedTheGame(
      [
        obs({ seat: 3, atSequence: 20, stance: "support", selectedClaimant: 2 }),
        obs({ seat: 2, atSequence: 20, requestedTeam: [1, 2, 3] }),
      ],
      record,
    );
    expect(moved.changedProposal).toBe(true);
    expect(moved.changedVote).toBe(true);
    // Seat 3 led this proposal AND was backing claimant 2 at the time.
    expect(moved.proposalsUnderAClaimant).toBe(1);
    expect(moved.voteFollowingsCompared).toBeGreaterThan(0);
  });
});

/**
 * The four impact metrics, one test per cell of the truth table.
 *
 * The old single boolean was `changedProposal && changedVote` and was reported
 * as "the contest changed the game". A run where the contest reshaped every
 * team but moved nobody's vote came out `false`, which reads as "the contest
 * did nothing" — and that is the opposite of what happened.
 *
 * Each fixture below isolates one cell by controlling exactly two things: does
 * a leader who is backing a claimant propose a team overlapping what that
 * claimant asked for, and does a backer vote with its claimant.
 */
describe("the four impact metrics", () => {
  /** One proposal by seat 3, one vote where seats 3 and 5 disagree. */
  function record(patch: Partial<PublicRecord> = {}): PublicRecord {
    return {
      ...EMPTY,
      proposals: [{ missionNumber: 1, attempt: 1, leader: 3, team: [1, 2, 3], atSequence: 30 }],
      votes: [
        {
          missionNumber: 1,
          attempt: 1,
          leader: 3,
          team: [1, 2, 3],
          // Claimant 2 approves. Seat 3 (the leader) and seat 5 vote the other
          // way; seat 6 votes with it. That is what makes each cell of the
          // truth table reachable by changing only one thing at a time.
          votes: { 1: "approve", 2: "approve", 3: "reject", 4: "reject", 5: "reject", 6: "approve", 7: "reject", 8: "reject", 9: "reject", 10: "reject" },
          result: "rejected",
          atSequence: 40,
        },
      ],
      ...patch,
    };
  }

  /** Seat 3 leads and backs claimant 2. Whether it follows is the variable. */
  const leaderBacking = (requestedTeam: readonly Seat[] | null) => [
    obs({ seat: 3, atSequence: 10, stance: "support", selectedClaimant: 2 }),
    obs({ seat: 2, atSequence: 10, requestedTeam }),
  ];

  /** Seat 5 backs claimant 2 and votes the OTHER way — no vote effect. */
  const backerWhoDefects = obs({
    seat: 5,
    atSequence: 10,
    stance: "support",
    selectedClaimant: 2,
  });

  /** Seat 6 backs claimant 2 and votes WITH it — a vote effect. */
  const backerWhoFollows = obs({
    seat: 6,
    atSequence: 10,
    stance: "support",
    selectedClaimant: 2,
  });

  it("neither changed", () => {
    // The leader backs a claimant that asked for nothing, and the only backer
    // voted against it. Talk, and nothing downstream.
    const impact = contestChangedTheGame(
      [...leaderBacking(null), backerWhoDefects],
      record(),
    );
    expect(impact).toMatchObject({
      changedProposal: false,
      changedVote: false,
      changedEither: false,
      changedBoth: false,
    });
    expect(impact.proposalsFollowingTheAsk).toBe(0);
    expect(impact.votesMatchingTheClaimant).toBe(0);
    // The comparison WAS possible; it just came out negative. That is the
    // difference between "no effect" and "no data".
    expect(impact.proposalsUnderAClaimant).toBe(1);
    expect(impact.voteFollowingsCompared).toBeGreaterThan(0);
  });

  it("proposal only", () => {
    const impact = contestChangedTheGame(
      [...leaderBacking([1, 2, 3]), backerWhoDefects],
      record(),
    );
    expect(impact).toMatchObject({
      changedProposal: true,
      changedVote: false,
      changedEither: true,
      changedBoth: false,
    });
    expect(impact.proposalsFollowingTheAsk).toBe(1);
  });

  it("vote only", () => {
    const impact = contestChangedTheGame(
      [...leaderBacking(null), backerWhoFollows],
      record(),
    );
    expect(impact).toMatchObject({
      changedProposal: false,
      changedVote: true,
      changedEither: true,
      changedBoth: false,
    });
    expect(impact.votesMatchingTheClaimant).toBeGreaterThan(0);
  });

  it("both changed", () => {
    const impact = contestChangedTheGame(
      [...leaderBacking([1, 2, 3]), backerWhoFollows],
      record(),
    );
    expect(impact).toMatchObject({
      changedProposal: true,
      changedVote: true,
      changedEither: true,
      changedBoth: true,
    });
  });

  it("separates an explicit vote request from mere agreement", () => {
    const asked = contestChangedTheGame(
      [
        obs({ seat: 6, atSequence: 10, stance: "support", selectedClaimant: 2 }),
        obs({ seat: 2, atSequence: 10, requestedVote: "approve" }),
      ],
      record(),
    );
    // The strong arm: the claimant asked, the backer did it.
    expect(asked.votesMatchingAnExplicitAsk).toBe(1);
    expect(asked.votesMatchingTheClaimant).toBe(0);

    const agreed = contestChangedTheGame([backerWhoFollows], record());
    // The weak arm: they happen to have voted the same way.
    expect(agreed.votesMatchingAnExplicitAsk).toBe(0);
    expect(agreed.votesMatchingTheClaimant).toBe(1);
  });

  it("does not count a seat that only opposed or stayed undecided", () => {
    const impact = contestChangedTheGame(
      [
        obs({ seat: 6, atSequence: 10, stance: "oppose", selectedClaimant: 2 }),
        obs({ seat: 5, atSequence: 10, stance: "undecided", selectedClaimant: null }),
      ],
      record(),
    );
    expect(impact.voteFollowingsCompared).toBe(0);
    expect(impact.changedEither).toBe(false);
  });

  it("reads the record that PRECEDED the proposal, not one stamped on it", () => {
    /*
     * The M5.2 pilot's shape, exactly.
     *
     * A record's `atSequence` is the log length when the seat was asked, so a
     * record stamped `S` was made after event `S` already existed. In the pilot
     * the proposal event sat at sequence 30, seat 7's closing decision (which
     * produced it) at 28 asking for [3,4,5,6], and seat 7's own VOTE decision at
     * 30 asking for nothing. A `<=` comparison picked the vote and reported
     * `changedProposal: false` for a proposal that matched the ask exactly.
     */
    const pilotShape: PublicRecord = {
      ...EMPTY,
      proposals: [{ missionNumber: 2, attempt: 1, leader: 7, team: [3, 4, 5, 6], atSequence: 30 }],
    };
    const impact = contestChangedTheGame(
      [
        obs({
          seat: 7,
          atSequence: 28,
          stance: "support",
          selectedClaimant: 7,
          requestedTeam: [3, 4, 5, 6],
        }),
        // Made AFTER the proposal existed. Must not be read as the ask.
        obs({ seat: 7, atSequence: 30, stance: "support", selectedClaimant: 7, requestedTeam: null }),
      ],
      pilotShape,
    );
    expect(impact.proposalsUnderAClaimant).toBe(1);
    expect(impact.proposalsFollowingTheAsk).toBe(1);
    expect(impact.changedProposal).toBe(true);
  });

  it("still sees a vote decision stamped just before the vote event", () => {
    // The mirror case: vote decisions are all recorded before the single vote
    // event is emitted, so the strict comparison must not exclude them.
    const shape: PublicRecord = {
      ...EMPTY,
      votes: [
        {
          missionNumber: 1,
          attempt: 1,
          leader: 3,
          team: [1, 2, 3],
          votes: { 1: "approve", 2: "approve", 3: "approve", 4: "reject", 5: "reject", 6: "approve", 7: "reject", 8: "reject", 9: "reject", 10: "reject" },
          result: "rejected",
          atSequence: 16,
        },
      ],
    };
    const impact = contestChangedTheGame(
      [obs({ seat: 6, atSequence: 15, stance: "support", selectedClaimant: 2 })],
      shape,
    );
    expect(impact.voteFollowingsCompared).toBe(1);
    expect(impact.changedVote).toBe(true);
  });

  it("keeps the deprecated alias equal to changedBoth, never to changedEither", () => {
    for (const observations of [
      [...leaderBacking(null), backerWhoDefects],
      [...leaderBacking([1, 2, 3]), backerWhoDefects],
      [...leaderBacking(null), backerWhoFollows],
      [...leaderBacking([1, 2, 3]), backerWhoFollows],
    ]) {
      const impact = contestChangedTheGame(observations, record());
      expect(impact.changedSomething).toBe(impact.changedBoth);
    }
    // And in the one cell where the two differ, the alias is the pessimistic
    // one — which is exactly why it was the wrong headline.
    const proposalOnly = contestChangedTheGame(
      [...leaderBacking([1, 2, 3]), backerWhoDefects],
      record(),
    );
    expect(proposalOnly.changedEither).toBe(true);
    expect(proposalOnly.changedSomething).toBe(false);
  });
});

describe("credibility across a mission", () => {
  it("reports the modal read before and after", () => {
    const record: PublicRecord = {
      ...EMPTY,
      missions: [{ missionNumber: 1, result: "fail", atSequence: 50 }],
    };
    const before = [3, 4].map((seat) =>
      obs({
        seat: seat as Seat,
        atSequence: 20,
        assessments: [{ seat: 2, level: "leading", publicStatus: "active", restsOnUnverified: false }],
      }),
    );
    const after = [3, 4].map((seat) =>
      obs({
        seat: seat as Seat,
        atSequence: 60,
        assessments: [{ seat: 2, level: "weak", publicStatus: "active", restsOnUnverified: false }],
      }),
    );
    const shifts = credibilityAcrossMissions([...before, ...after], record, [2]);
    expect(shifts[0]).toMatchObject({ before: "leading", after: "weak", changed: true });
  });
});

describe("retraction outcomes", () => {
  it("says whether the retraction came before any vote, and who it lost", () => {
    const record: PublicRecord = {
      ...EMPTY,
      votes: [],
      missions: [{ missionNumber: 1, result: "fail", atSequence: 24 }],
    };
    const outcomes = retractionOutcomes(
      [
        obs({ seat: 4, atSequence: 20, stance: "support", selectedClaimant: 7 }),
        obs({ seat: 4, atSequence: 40, stance: "oppose", selectedClaimant: 7 }),
      ],
      CONTEST,
      record,
      ROLES,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ seat: 7, beforeVote: true, afterFailedMission: true });
    expect(outcomes[0].backersBefore).toBe(1);
    expect(outcomes[0].backersAfter).toBe(0);
    expect(outcomes[0].side).toBe("evil");
  });

  it("omits the side when no reveal is supplied", () => {
    const outcomes = retractionOutcomes([], CONTEST, EMPTY);
    expect(outcomes[0].side).toBeNull();
  });
});

describe("hidden truth, post-mortem only", () => {
  it("counts which roles claimed Percival", () => {
    const roles = claimantRoles(CONTEST, ROLES);
    // Seat 2 is the true Percival; seat 7 is Morgana.
    expect(roles).toEqual({ percival: 1, morgana: 1 });
  });

  it("separates Morgana capture from other evil capture", () => {
    const capture = falseLeaderCapture(
      [
        obs({ seat: 3, stance: "support", selectedClaimant: 2 }),
        obs({ seat: 4, stance: "conditional-support", selectedClaimant: 7 }),
        obs({ seat: 5, stance: "support", selectedClaimant: 9 }),
        obs({ seat: 6, stance: "support", selectedClaimant: 3 }),
        // A challenge is not a following.
        obs({ seat: 1, stance: "oppose", selectedClaimant: 7 }),
      ],
      ROLES,
    );
    expect(capture).toMatchObject({ truePercival: 1, morgana: 1, otherEvil: 1, otherGood: 1 });
    expect(capture.morganaCaptureRate).toBeCloseTo(0.25);
    expect(capture.anyEvilCaptureRate).toBeCloseTo(0.5);
  });

  it("splits where the plain Loyal seats ended up", () => {
    const split = loyalAlignmentSplit(
      [
        obs({ seat: 3, atSequence: 40, stance: "support", selectedClaimant: 2 }),
        obs({ seat: 4, atSequence: 40, stance: "support", selectedClaimant: 7 }),
        obs({ seat: 5, atSequence: 40, stance: "support", selectedClaimant: 3 }),
        obs({ seat: 6, atSequence: 40, stance: "undecided", selectedClaimant: null }),
      ],
      ROLES,
    );
    expect(split).toMatchObject({
      loyalSeats: 4,
      withTruePercival: 1,
      withMorgana: 1,
      withOtherClaimant: 1,
      withNobody: 1,
    });
  });

  it("measures the true Percival's reach and how many rivals it addressed", () => {
    const influence = truePercivalInfluence(
      [
        obs({ seat: 2, atSequence: 10, ownClaimStatus: "active", rivalSeats: [7] }),
        obs({
          seat: 2,
          atSequence: 20,
          ownClaimStatus: "active",
          act: "attack-rival-claim",
          targetSeats: [4],
        }),
        obs({ seat: 3, atSequence: 30, stance: "support", selectedClaimant: 2 }),
        obs({ seat: 5, atSequence: 30, stance: "conditional-support", selectedClaimant: 2 }),
      ],
      CONTEST,
      ROLES,
    );
    expect(influence.claimed).toBe(true);
    expect(influence.claimedAtSequence).toBe(4);
    expect(influence.backers).toBe(2);
    expect(influence.attacksReceived).toBe(1);
    // Both the rival it planned against and the one it attacked.
    expect(influence.rivalsAddressed).toBe(2);
  });

  it("counts refused repetitions of a delay justification", () => {
    const influence = truePercivalInfluence(
      [
        obs({ seat: 2, atSequence: 10, rejectedForRepetition: true }),
        obs({ seat: 2, atSequence: 20, rejectedForRepetition: true }),
        obs({ seat: 2, atSequence: 30 }),
      ],
      CONTEST,
      ROLES,
    );
    expect(influence.repeatedDelaysRejected).toBe(2);
  });

  it("reports an unclaimed true Percival rather than throwing", () => {
    const quiet = claimContestFrom([]);
    const influence = truePercivalInfluence([], quiet, ROLES);
    expect(influence).toMatchObject({ claimed: false, backers: 0, rivalsAddressed: 0 });
  });
});

describe("the whole report", () => {
  it("omits every hidden-truth section when no reveal is supplied", () => {
    const report = contestReport([obs({ seat: 3 })], CONTEST, EMPTY);
    expect(report.roles).toBeNull();
    expect(report.capture).toBeNull();
    expect(report.loyalSplit).toBeNull();
    expect(report.truePercival).toBeNull();
    // The public halves are still there.
    expect(report.timeline.percivalClaims).toBe(2);
    expect(report.attacks).toHaveLength(1);
  });

  it("includes them when it is", () => {
    const report = contestReport([obs({ seat: 3 })], CONTEST, EMPTY, ROLES);
    expect(report.roles).toBeTruthy();
    expect(report.capture).toBeTruthy();
    expect(report.loyalSplit).toBeTruthy();
    expect(report.truePercival).toBeTruthy();
  });
});
