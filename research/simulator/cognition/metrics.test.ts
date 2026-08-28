import { describe, expect, it } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { SEATS, type Seat, type Side } from "../core/types";
import {
  coordinationOutcomes,
  coordinationReport,
  endorsementGraph,
  focalConcentration,
  focalShiftsAroundMissions,
  leaderTruth,
  minorityDissentUptake,
  publicRequestCounts,
  stanceCounts,
  teamOverlapWithPlan,
  voteAlignmentWithFocal,
  type PublicRecord,
  type RevealedRoles,
  type SocialObservation,
} from "./metrics";

/**
 * The coordination metrics, on hand-built inputs with known answers.
 *
 * Hand-built rather than driven from a game on purpose: a metric checked
 * against a real run can only be asserted to be "plausible", and the numbers
 * that matter here — how often the table followed an evil player, whether a
 * vindicated dissenter was picked up — are exactly the ones where plausible is
 * not good enough. Every expectation below is countable by eye from the fixture
 * above it.
 */

function obs(patch: Partial<SocialObservation> & { seat: Seat }): SocialObservation {
  return {
    taskId: "vote",
    atSequence: 1,
    focalCandidates: [],
    stance: "follow",
    focalSeat: null,
    proposition: "",
    publicAction: "",
    coordinateWith: [],
    proposedTeam: null,
    votingBloc: "undecided",
    ...patch,
  };
}

const EMPTY_RECORD: PublicRecord = { votes: [], proposals: [], missions: [], speeches: [] };

/** Seat 2 is Percival, 7-10 evil. Matches the reference deal's shape. */
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

describe("focal concentration", () => {
  it("reports how many distinct seats the table is following", () => {
    const observations = [
      obs({ seat: 1, focalSeat: 2 }),
      obs({ seat: 3, focalSeat: 2 }),
      obs({ seat: 4, focalSeat: 2 }),
      obs({ seat: 5, focalSeat: 6 }),
    ];
    const [point] = focalConcentration(observations, 10);
    expect(point.distinctFocalSeats).toBe(2);
    expect(point.topSeat).toBe(2);
    expect(point.topCount).toBe(3);
    expect(point.observers).toBe(4);
  });

  it("does not resolve disagreement into one answer", () => {
    // Two seats, two different focal players, and the metric says exactly that
    // rather than picking a winner. A global "leader" would be a referee fact
    // nobody earned.
    const [point] = focalConcentration(
      [obs({ seat: 1, focalSeat: 2 }), obs({ seat: 3, focalSeat: 6 })],
      10,
    );
    expect(point.distinctFocalSeats).toBe(2);
    expect(point.topCount).toBe(1);
  });

  it("ignores seats that are tracking somebody without following them", () => {
    const observations = [
      obs({
        seat: 1,
        stance: "independent",
        focalSeat: null,
        focalCandidates: [
          { seat: 2, influence: "high", credibility: "credible", restsOnUnverified: false },
        ],
      }),
    ];
    expect(focalConcentration(observations, 10)[0].distinctFocalSeats).toBe(0);
  });
});

describe("the endorsement graph", () => {
  it("separates following, conditional following and challenging", () => {
    const edges = endorsementGraph([
      obs({ seat: 1, focalSeat: 2, stance: "follow" }),
      obs({ seat: 1, focalSeat: 2, stance: "conditional-follow" }),
      obs({ seat: 1, focalSeat: 2, stance: "challenge" }),
      obs({ seat: 3, focalSeat: 2, stance: "follow" }),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: 1, to: 2, follows: 1, conditional: 1, challenges: 1 });
    expect(edges[1]).toMatchObject({ from: 3, to: 2, follows: 1 });
  });

  it("drops independent stances, which have no edge", () => {
    expect(endorsementGraph([obs({ seat: 1, stance: "independent", focalSeat: null })])).toHaveLength(0);
  });

  it("counts stances in total", () => {
    const counts = stanceCounts([
      obs({ seat: 1, stance: "follow", focalSeat: 2 }),
      obs({ seat: 2, stance: "challenge", focalSeat: 3 }),
      obs({ seat: 3, stance: "independent", focalSeat: null }),
    ]);
    expect(counts).toMatchObject({ follow: 1, challenge: 1, independent: 1, total: 3 });
  });
});

describe("did following turn into voting together", () => {
  const record: PublicRecord = {
    ...EMPTY_RECORD,
    votes: [
      {
        missionNumber: 1,
        attempt: 1,
        leader: 2,
        team: [1, 2, 3],
        votes: { 1: "approve", 2: "approve", 3: "reject", 4: "approve", 5: "approve", 6: "approve", 7: "reject", 8: "reject", 9: "reject", 10: "reject" },
        result: "passed",
        atSequence: 10,
      },
    ],
  };

  it("counts a follower who voted with its leader", () => {
    const result = voteAlignmentWithFocal(
      [obs({ seat: 1, focalSeat: 2, stance: "follow", atSequence: 5 })],
      record,
    );
    expect(result).toMatchObject({ compared: 1, agreed: 1, rate: 1 });
  });

  it("catches a follower who voted the other way", () => {
    const result = voteAlignmentWithFocal(
      [obs({ seat: 3, focalSeat: 2, stance: "follow", atSequence: 5 })],
      record,
    );
    expect(result).toMatchObject({ compared: 1, agreed: 0, rate: 0 });
  });

  it("ignores a seat that said it was independent", () => {
    const result = voteAlignmentWithFocal(
      [obs({ seat: 3, focalSeat: null, stance: "independent", atSequence: 5 })],
      record,
    );
    expect(result.compared).toBe(0);
  });

  it("uses the read that was current when the vote happened", () => {
    // A later change of mind must not be back-applied to an earlier vote.
    const result = voteAlignmentWithFocal(
      [
        obs({ seat: 1, focalSeat: 2, stance: "follow", atSequence: 5 }),
        obs({ seat: 1, focalSeat: 7, stance: "follow", atSequence: 40 }),
      ],
      record,
    );
    expect(result).toMatchObject({ compared: 1, agreed: 1 });
  });
});

describe("did a leader's team match its own plan", () => {
  it("scores an exact match at 1", () => {
    const record: PublicRecord = {
      ...EMPTY_RECORD,
      proposals: [
        { missionNumber: 1, attempt: 1, leader: 2, team: [1, 2, 3], atSequence: 10 },
      ],
    };
    const result = teamOverlapWithPlan(
      [obs({ seat: 2, proposedTeam: [1, 2, 3], atSequence: 5 })],
      record,
    );
    expect(result).toMatchObject({ compared: 1, meanJaccard: 1 });
  });

  it("scores a half-kept plan below 1", () => {
    const record: PublicRecord = {
      ...EMPTY_RECORD,
      proposals: [
        { missionNumber: 1, attempt: 1, leader: 2, team: [1, 2, 9], atSequence: 10 },
      ],
    };
    const result = teamOverlapWithPlan(
      [obs({ seat: 2, proposedTeam: [1, 2, 3], atSequence: 5 })],
      record,
    );
    expect(result.meanJaccard).toBeCloseTo(2 / 4);
  });
});

describe("does a mission result move the chair", () => {
  it("reports the change around each mission", () => {
    const record: PublicRecord = {
      ...EMPTY_RECORD,
      missions: [
        { missionNumber: 1, result: "fail", atSequence: 20 },
        { missionNumber: 2, result: "success", atSequence: 60 },
      ],
    };
    const shifts = focalShiftsAroundMissions(
      [
        obs({ seat: 1, focalSeat: 2, atSequence: 10 }),
        obs({ seat: 3, focalSeat: 2, atSequence: 12 }),
        obs({ seat: 1, focalSeat: 6, atSequence: 30 }),
        obs({ seat: 3, focalSeat: 6, atSequence: 32 }),
      ],
      record,
    );
    expect(shifts[0]).toMatchObject({ missionNumber: 1, before: 2, after: 6, changed: true });
  });
});

describe("hidden-truth comparisons", () => {
  it("counts followings of the true Percival, of evil, and of everyone else", () => {
    const truth = leaderTruth(
      [
        obs({ seat: 1, focalSeat: 2, stance: "follow" }),
        obs({ seat: 3, focalSeat: 2, stance: "conditional-follow" }),
        obs({ seat: 4, focalSeat: 7, stance: "follow" }),
        obs({ seat: 5, focalSeat: 6, stance: "follow" }),
      ],
      ROLES,
    );
    expect(truth).toMatchObject({ truePercival: 2, evilLeader: 1, otherGood: 1, total: 4 });
    expect(truth.falseLeaderCaptureRate).toBeCloseTo(0.25);
  });

  it("does not count a challenge as a following", () => {
    const truth = leaderTruth([obs({ seat: 1, focalSeat: 7, stance: "challenge" })], ROLES);
    expect(truth.total).toBe(0);
    expect(truth.falseLeaderCaptureRate).toBe(0);
  });

  it("pairs coordination with the mission it preceded, per side", () => {
    const record: PublicRecord = {
      ...EMPTY_RECORD,
      missions: [{ missionNumber: 1, result: "fail", atSequence: 50 }],
    };
    // Four of six good seats followed seat 2; the mission failed anyway.
    const observations = [1, 3, 4, 5].map((seat) =>
      obs({ seat: seat as Seat, focalSeat: 2, stance: "follow", atSequence: 10 }),
    );
    const [good, evil] = coordinationOutcomes(observations, record, ROLES);
    expect(good).toMatchObject({
      side: "good",
      coordinatedMissions: 1,
      coordinatedWins: 0,
    });
    // Evil coordinated on nobody, and won.
    expect(evil).toMatchObject({ side: "evil", uncoordinatedMissions: 1, uncoordinatedWins: 1 });
  });
});

describe("minority dissent", () => {
  const record: PublicRecord = {
    ...EMPTY_RECORD,
    votes: [
      {
        missionNumber: 1,
        attempt: 1,
        leader: 5,
        team: [5, 7, 8],
        votes: { 1: "approve", 2: "approve", 3: "approve", 4: "reject", 5: "approve", 6: "approve", 7: "approve", 8: "approve", 9: "approve", 10: "approve" },
        result: "passed",
        atSequence: 20,
      },
    ],
    missions: [{ missionNumber: 1, result: "fail", atSequence: 30 }],
  };

  it("counts a lone dissenter whose warning the mission vindicated", () => {
    const taken = minorityDissentUptake(
      [obs({ seat: 1, focalSeat: 4, stance: "follow", atSequence: 40 })],
      record,
    );
    expect(taken).toMatchObject({ dissents: 1, takenUp: 1, rate: 1 });
  });

  it("records the waste when nobody picks the dissenter up", () => {
    // The M5 pilot's clearest one: specific pre-vote reasons, vindicated, and
    // no seat aligned to the person who gave them.
    const ignored = minorityDissentUptake(
      [obs({ seat: 1, focalSeat: 5, stance: "follow", atSequence: 40 })],
      record,
    );
    expect(ignored).toMatchObject({ dissents: 1, takenUp: 0, rate: 0 });
  });

  it("ignores an alignment that predates the mission result", () => {
    const early = minorityDissentUptake(
      [obs({ seat: 1, focalSeat: 4, stance: "follow", atSequence: 5 })],
      record,
    );
    expect(early.takenUp).toBe(0);
  });
});

describe("what was actually said out loud", () => {
  it("counts a speech that names a seat and asks for something", () => {
    const record: PublicRecord = {
      ...EMPTY_RECORD,
      speeches: [
        { speaker: 1, publicMessage: "我建议 3号 换成 6号，我会投反对", atSequence: 10 },
        { speaker: 2, publicMessage: "我觉得这一轮还看不清。", atSequence: 12 },
      ],
    };
    const counts = publicRequestCounts([], record);
    expect(counts).toMatchObject({ speeches: 2, withConcreteRequest: 1 });
    expect(counts.requestRate).toBeCloseTo(0.5);
  });

  it("counts a follower who names the seat its ledger says it follows", () => {
    const record: PublicRecord = {
      ...EMPTY_RECORD,
      speeches: [
        { speaker: 1, publicMessage: "我接住 6号 关于首轮的那条，建议照他说的组车", atSequence: 20 },
        { speaker: 3, publicMessage: "我同意。", atSequence: 22 },
      ],
    };
    const counts = publicRequestCounts(
      [
        obs({ seat: 1, focalSeat: 6, stance: "follow", atSequence: 10 }),
        obs({ seat: 3, focalSeat: 6, stance: "follow", atSequence: 10 }),
      ],
      record,
    );
    // Seat 3 followed 6号 privately and said "I agree" out loud — which is the
    // exact gap the public-action bridge exists to close.
    expect(counts.citingTheirFocal).toBe(1);
  });
});

describe("the whole report", () => {
  it("omits the hidden-truth sections when no reveal is supplied", () => {
    const report = coordinationReport([obs({ seat: 1, focalSeat: 2 })], EMPTY_RECORD);
    expect(report.leaderTruth).toBeNull();
    expect(report.coordination).toBeNull();
  });

  it("includes them when it is", () => {
    const report = coordinationReport([obs({ seat: 1, focalSeat: 2 })], EMPTY_RECORD, ROLES);
    expect(report.leaderTruth).toBeTruthy();
    expect(report.coordination).toHaveLength(2);
  });
});
