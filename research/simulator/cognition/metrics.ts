/**
 * Coordination metrics, computed AFTER a game from the private trace.
 *
 * OBSERVATIONAL, and that word is doing real work. Nothing here is reachable
 * from an agent: these functions take recorded telemetry and produce numbers
 * for a human, and no code path leads from a number back into a prompt. The
 * distinction matters because several of them (`trueVersusApparentPercival`,
 * `falseLeaderCapture`) read hidden role truth from the deal — which is fine in
 * a post-mortem and would be a catastrophe in a decision.
 *
 * WHY THESE NUMBERS. The completed M5 pilot could not answer the question the
 * milestone is about. "Did anybody lead?" had to be inferred from reading 154
 * speeches by hand, and the one number I did compute by hand — engagement
 * falling from 48% to 21% — I first got wrong because the regex was written
 * against the older game's phrasing. Counting from the SOCIAL BLOCK instead of
 * from prose is the fix: the block is structured, so the count is not a
 * judgement call about wording.
 *
 * WHAT IS DELIBERATELY NOT HERE: a "leader score". Each seat's read is its own;
 * concentration is reported as a distribution, never resolved into one answer.
 * Two seats disagreeing about who is focal is a real table state.
 */

import type { RoleType } from "@/lib/types/game";
import type { Seat, Side } from "../core/types";
import { SEATS } from "../core/types";
import type { AlignmentStance, Credibility, Influence } from "./social";

/* ── Input ──────────────────────────────────────────────────────────────── */

/**
 * One decision's social record, flattened from the trace.
 *
 * Deliberately a flat shape rather than the `SocialModel` itself: the trace
 * stores telemetry, not ledgers, and a metrics module that needed a live ledger
 * could not run against a finished game's artifact.
 */
export interface SocialObservation {
  readonly seat: Seat;
  readonly taskId: string;
  readonly atSequence: number;
  readonly focalCandidates: readonly {
    readonly seat: Seat;
    readonly influence: Influence;
    readonly credibility: Credibility;
    readonly restsOnUnverified: boolean;
  }[];
  readonly stance: AlignmentStance | null;
  readonly focalSeat: Seat | null;
  readonly proposition: string;
  readonly publicAction: string;
  readonly coordinateWith: readonly Seat[];
  readonly proposedTeam: readonly Seat[] | null;
  readonly votingBloc: "approve" | "reject" | "undecided";
}

/** What the referee actually recorded, for the alignment comparisons. */
export interface PublicRecord {
  readonly votes: readonly {
    readonly missionNumber: number;
    readonly attempt: number;
    readonly leader: Seat;
    readonly team: readonly Seat[];
    readonly votes: Readonly<Record<Seat, "approve" | "reject">>;
    readonly result: "passed" | "rejected";
    readonly atSequence: number;
  }[];
  readonly proposals: readonly {
    readonly missionNumber: number;
    readonly attempt: number;
    readonly leader: Seat;
    readonly team: readonly Seat[];
    readonly atSequence: number;
  }[];
  readonly missions: readonly {
    readonly missionNumber: number;
    readonly result: "success" | "fail";
    readonly atSequence: number;
  }[];
  /** Speeches, so "did anyone make a concrete public request" is countable. */
  readonly speeches: readonly {
    readonly speaker: Seat;
    readonly publicMessage: string;
    readonly atSequence: number;
  }[];
  /** The one irreversible decision. Absent in a game evil never reached. */
  readonly assassination?: {
    readonly assassin: Seat;
    readonly target: Seat;
    readonly atSequence: number;
  } | null;
}

/** Hidden truth. Post-mortem only — see the header. */
export interface RevealedRoles {
  readonly bySeat: Readonly<Record<Seat, RoleType>>;
  readonly sideOf: Readonly<Record<Seat, Side>>;
}

/* ── 1. Focal concentration ─────────────────────────────────────────────── */

export interface ConcentrationPoint {
  readonly atSequence: number;
  /** How many DISTINCT seats were named focal across the ten ledgers. */
  readonly distinctFocalSeats: number;
  /** The most-named seat and how many ledgers named it. */
  readonly topSeat: Seat | null;
  readonly topCount: number;
  readonly observers: number;
}

/**
 * How much the table agrees about who is leading, over time.
 *
 * Bucketed by decision index rather than by sequence so the series is readable:
 * ten seats do not decide at the same moment, and a per-sequence series would
 * be a sawtooth of single observations.
 */
export function focalConcentration(
  observations: readonly SocialObservation[],
  bucketSize = 10,
): ConcentrationPoint[] {
  const points: ConcentrationPoint[] = [];
  for (let i = 0; i < observations.length; i += bucketSize) {
    const bucket = observations.slice(i, i + bucketSize);
    const counts = new Map<Seat, number>();
    for (const o of bucket) {
      // The seat this observation is ALIGNED to, not every candidate it tracks:
      // tracking somebody is not following them.
      if (o.focalSeat !== null) counts.set(o.focalSeat, (counts.get(o.focalSeat) ?? 0) + 1);
    }
    let topSeat: Seat | null = null;
    let topCount = 0;
    for (const [seat, n] of counts) {
      if (n > topCount) {
        topCount = n;
        topSeat = seat;
      }
    }
    points.push({
      atSequence: bucket[0]?.atSequence ?? 0,
      distinctFocalSeats: counts.size,
      topSeat,
      topCount,
      observers: bucket.length,
    });
  }
  return points;
}

/* ── 2-3. Endorsements, challenges, and the graph ───────────────────────── */

export interface EndorsementEdge {
  readonly from: Seat;
  readonly to: Seat;
  readonly follows: number;
  readonly conditional: number;
  readonly challenges: number;
}

/** Who aligned with whom, how often, and which way. */
export function endorsementGraph(
  observations: readonly SocialObservation[],
): EndorsementEdge[] {
  const edges = new Map<string, { from: Seat; to: Seat; follows: number; conditional: number; challenges: number }>();
  for (const o of observations) {
    if (o.focalSeat === null || o.stance === null || o.stance === "independent") continue;
    const key = `${o.seat}->${o.focalSeat}`;
    const edge =
      edges.get(key) ?? { from: o.seat, to: o.focalSeat, follows: 0, conditional: 0, challenges: 0 };
    if (o.stance === "follow") edge.follows += 1;
    else if (o.stance === "conditional-follow") edge.conditional += 1;
    else edge.challenges += 1;
    edges.set(key, edge);
  }
  return [...edges.values()].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
}

export interface StanceCounts {
  readonly follow: number;
  readonly conditional: number;
  readonly challenge: number;
  readonly independent: number;
  readonly total: number;
}

export function stanceCounts(observations: readonly SocialObservation[]): StanceCounts {
  const c = { follow: 0, conditional: 0, challenge: 0, independent: 0, total: 0 };
  for (const o of observations) {
    if (o.stance === null) continue;
    c.total += 1;
    if (o.stance === "follow") c.follow += 1;
    else if (o.stance === "conditional-follow") c.conditional += 1;
    else if (o.stance === "challenge") c.challenge += 1;
    else c.independent += 1;
  }
  return c;
}

/* ── 4. Vote alignment with the chosen focal player ─────────────────────── */

export interface VoteAlignment {
  readonly compared: number;
  readonly agreed: number;
  readonly rate: number;
}

/**
 * When a seat said it was following somebody, did it then vote with them?
 *
 * Compared per vote event, using the observation that immediately preceded it.
 * A `follow` that reliably votes the other way is either a lie or a stale
 * ledger, and both are worth seeing.
 */
export function voteAlignmentWithFocal(
  observations: readonly SocialObservation[],
  record: PublicRecord,
): VoteAlignment {
  let compared = 0;
  let agreed = 0;
  for (const vote of record.votes) {
    for (const seat of SEATS) {
      const mine = latestBefore(observations, seat, vote.atSequence);
      if (!mine || mine.focalSeat === null) continue;
      if (mine.stance !== "follow" && mine.stance !== "conditional-follow") continue;
      const theirs = vote.votes[mine.focalSeat];
      const ours = vote.votes[seat];
      if (theirs === undefined || ours === undefined) continue;
      compared += 1;
      if (theirs === ours) agreed += 1;
    }
  }
  return { compared, agreed, rate: compared === 0 ? 0 : agreed / compared };
}

/* ── 5. Team overlap with the focal player's recommendation ─────────────── */

export interface TeamOverlap {
  readonly compared: number;
  readonly meanJaccard: number;
}

/**
 * When a seat led, how close was its team to what it said it wanted?
 *
 * Jaccard rather than a count so team-size changes across missions do not move
 * the number on their own.
 */
export function teamOverlapWithPlan(
  observations: readonly SocialObservation[],
  record: PublicRecord,
): TeamOverlap {
  let compared = 0;
  let total = 0;
  for (const proposal of record.proposals) {
    const mine = latestBefore(observations, proposal.leader, proposal.atSequence);
    if (!mine?.proposedTeam || mine.proposedTeam.length === 0) continue;
    const a = new Set(mine.proposedTeam);
    const b = new Set(proposal.team);
    const both = [...a].filter((s) => b.has(s)).length;
    const either = new Set([...a, ...b]).size;
    compared += 1;
    total += either === 0 ? 0 : both / either;
  }
  return { compared, meanJaccard: compared === 0 ? 0 : total / compared };
}

/* ── 6. Does a failed mission change who is focal? ──────────────────────── */

export interface FocalShift {
  readonly missionNumber: number;
  readonly result: "success" | "fail";
  readonly before: Seat | null;
  readonly after: Seat | null;
  readonly changed: boolean;
}

/** The most-followed seat immediately before and after each mission result. */
export function focalShiftsAroundMissions(
  observations: readonly SocialObservation[],
  record: PublicRecord,
): FocalShift[] {
  const mostFollowed = (from: number, to: number): Seat | null => {
    const counts = new Map<Seat, number>();
    for (const o of observations) {
      if (o.atSequence < from || o.atSequence >= to) continue;
      if (o.focalSeat === null) continue;
      if (o.stance !== "follow" && o.stance !== "conditional-follow") continue;
      counts.set(o.focalSeat, (counts.get(o.focalSeat) ?? 0) + 1);
    }
    let best: Seat | null = null;
    let bestN = 0;
    for (const [seat, n] of counts) if (n > bestN) [best, bestN] = [seat, n];
    return best;
  };

  return record.missions.map((mission, i) => {
    const previous = record.missions[i - 1]?.atSequence ?? 0;
    const next = record.missions[i + 1]?.atSequence ?? Number.MAX_SAFE_INTEGER;
    const before = mostFollowed(previous, mission.atSequence);
    const after = mostFollowed(mission.atSequence, next);
    return {
      missionNumber: mission.missionNumber,
      result: mission.result,
      before,
      after,
      changed: before !== after,
    };
  });
}

/* ── 7-8. Hidden-truth comparisons. POST-MORTEM ONLY. ───────────────────── */

export interface LeaderTruth {
  /** Followings whose target was the real Percival. */
  readonly truePercival: number;
  /** Followings whose target was evil. The capture rate's numerator. */
  readonly evilLeader: number;
  /** Followings whose target was a good seat that is not Percival. */
  readonly otherGood: number;
  readonly total: number;
  /** `evilLeader / total`. How often the table followed the wrong person. */
  readonly falseLeaderCaptureRate: number;
}

/**
 * Who was the table actually following?
 *
 * Reads the deal. This is the number the whole milestone is aimed at — a good
 * table that follows an evil focal player has coordinated itself into a loss —
 * and it is exactly the number no agent may ever see.
 */
export function leaderTruth(
  observations: readonly SocialObservation[],
  roles: RevealedRoles,
): LeaderTruth {
  let truePercival = 0;
  let evilLeader = 0;
  let otherGood = 0;
  for (const o of observations) {
    if (o.focalSeat === null) continue;
    if (o.stance !== "follow" && o.stance !== "conditional-follow") continue;
    const role = roles.bySeat[o.focalSeat];
    if (roles.sideOf[o.focalSeat] === "evil") evilLeader += 1;
    else if (role === "percival") truePercival += 1;
    else otherGood += 1;
  }
  const total = truePercival + evilLeader + otherGood;
  return {
    truePercival,
    evilLeader,
    otherGood,
    total,
    falseLeaderCaptureRate: total === 0 ? 0 : evilLeader / total,
  };
}

/* ── 9. Minority dissent uptake ─────────────────────────────────────────── */

export interface DissentUptake {
  readonly dissents: number;
  readonly takenUp: number;
  readonly rate: number;
}

/**
 * A seat that rejected a team the table passed, and whose mission then failed —
 * did anybody align to it afterwards?
 *
 * The M5 pilot's clearest waste: several seats gave specific pre-vote reasons
 * that the result then vindicated, and nothing on the table picked them up.
 */
export function minorityDissentUptake(
  observations: readonly SocialObservation[],
  record: PublicRecord,
): DissentUptake {
  let dissents = 0;
  let takenUp = 0;
  for (const mission of record.missions) {
    if (mission.result !== "fail") continue;
    const vote = [...record.votes]
      .filter((v) => v.atSequence < mission.atSequence && v.result === "passed")
      .pop();
    if (!vote) continue;
    const rejecters = SEATS.filter((s) => vote.votes[s] === "reject");
    // A lone or near-lone dissenter is the interesting case; a majority that
    // rejected and lost anyway is not "minority dissent".
    if (rejecters.length === 0 || rejecters.length > 3) continue;
    for (const rejecter of rejecters) {
      dissents += 1;
      const followedAfter = observations.some(
        (o) =>
          o.atSequence > mission.atSequence &&
          o.focalSeat === rejecter &&
          (o.stance === "follow" || o.stance === "conditional-follow"),
      );
      if (followedAfter) takenUp += 1;
    }
  }
  return { dissents, takenUp, rate: dissents === 0 ? 0 : takenUp / dissents };
}

/* ── 10-11. Was anything actually said out loud? ────────────────────────── */

export interface PublicRequestCounts {
  readonly speeches: number;
  /** Speeches naming a seat AND asking for something concrete. */
  readonly withConcreteRequest: number;
  /** Speeches that name the seat the speaker's ledger says it is following. */
  readonly citingTheirFocal: number;
  readonly requestRate: number;
}

/**
 * Concrete public requests, counted from the speech text.
 *
 * The one number here that IS a wording judgement, and it is kept crude on
 * purpose: a seat number plus one of a short list of asking-verbs. A cleverer
 * regex tuned on one game is how the first pilot comparison went wrong — the
 * pattern fitted the older game's phrasing and reported a 36%→5% collapse that
 * a wider pattern showed was 48%→21%.
 */
const ASKING = ["建议", "请", "我会投", "应该", "换成", "改成", "避开", "不要带", "上票", "下票"];

export function publicRequestCounts(
  observations: readonly SocialObservation[],
  record: PublicRecord,
): PublicRequestCounts {
  let withConcreteRequest = 0;
  let citingTheirFocal = 0;
  for (const speech of record.speeches) {
    const namesSeat = /\d+\s*号/.test(speech.publicMessage);
    const asks = ASKING.some((verb) => speech.publicMessage.includes(verb));
    if (namesSeat && asks) withConcreteRequest += 1;
    const mine = latestBefore(observations, speech.speaker, speech.atSequence);
    if (
      mine?.focalSeat != null &&
      (mine.stance === "follow" || mine.stance === "conditional-follow") &&
      new RegExp(`${mine.focalSeat}\\s*号`).test(speech.publicMessage)
    ) {
      citingTheirFocal += 1;
    }
  }
  return {
    speeches: record.speeches.length,
    withConcreteRequest,
    citingTheirFocal,
    requestRate: record.speeches.length === 0 ? 0 : withConcreteRequest / record.speeches.length,
  };
}

/* ── 12. Did coordination pay? ──────────────────────────────────────────── */

export interface CoordinationOutcome {
  readonly side: Side;
  /** Missions where a majority of this side's seats shared one focal player. */
  readonly coordinatedMissions: number;
  readonly coordinatedWins: number;
  readonly uncoordinatedMissions: number;
  readonly uncoordinatedWins: number;
}

/**
 * Coordination versus mission outcome, per side.
 *
 * A win for good is a successful mission; a win for evil is a failed one. The
 * number is small and noisy in one game — it exists so a SERIES of games can be
 * asked whether coordinating helped, which is the question M5.1 is a bet on.
 */
export function coordinationOutcomes(
  observations: readonly SocialObservation[],
  record: PublicRecord,
  roles: RevealedRoles,
): CoordinationOutcome[] {
  return (["good", "evil"] as const).map((side) => {
    const seats = SEATS.filter((s) => roles.sideOf[s] === side);
    let coordinatedMissions = 0;
    let coordinatedWins = 0;
    let uncoordinatedMissions = 0;
    let uncoordinatedWins = 0;
    for (const mission of record.missions) {
      const counts = new Map<Seat, number>();
      for (const seat of seats) {
        const mine = latestBefore(observations, seat, mission.atSequence);
        if (!mine?.focalSeat) continue;
        if (mine.stance !== "follow" && mine.stance !== "conditional-follow") continue;
        counts.set(mine.focalSeat, (counts.get(mine.focalSeat) ?? 0) + 1);
      }
      const top = Math.max(0, ...counts.values());
      const coordinated = top * 2 > seats.length;
      const won = side === "good" ? mission.result === "success" : mission.result === "fail";
      if (coordinated) {
        coordinatedMissions += 1;
        if (won) coordinatedWins += 1;
      } else {
        uncoordinatedMissions += 1;
        if (won) uncoordinatedWins += 1;
      }
    }
    return {
      side,
      coordinatedMissions,
      coordinatedWins,
      uncoordinatedMissions,
      uncoordinatedWins,
    };
  });
}

/* ── 13. Was the one irreversible decision spent on a known villain? ─────── */

export interface AssassinationError {
  readonly assassin: Seat;
  readonly target: Seat;
  readonly atSequence: number;
  readonly targetWasMerlin: boolean;
  /**
   * NAMED STRATEGIC ERROR: the Assassin spent the kill on a seat whose identity
   * he had already been shown.
   *
   * A legal move — the referee takes it and ends the game — and one of the most
   * instructive mistakes an Assassin can make, which is exactly why it is
   * counted here rather than prevented upstream. `assassination.ts` warns about
   * it privately and ranks those seats last; nothing refuses it, and nothing
   * rewrites the target. See the header note there.
   *
   * Computed from revealed roles, so it is right even for a game recorded
   * before the metric existed.
   */
  readonly knownEvilAssassinationTarget: boolean;
  /** Which villain, when the error occurred. */
  readonly targetRole: RoleType | null;
}

/**
 * The assassination, scored. Null if the game never reached one.
 *
 * POST-MORTEM ONLY, like every hidden-truth function in this file: it reads the
 * deal, and no path leads from its output back into a prompt.
 *
 * "Known evil" is derived from the SIDE, not from a stored roster, because the
 * three mutually aware villains and Oberon differ in what they were shown. That
 * is a real distinction and it is preserved: `oberonTarget` says the Assassin
 * killed a villain he was NOT shown, which is a different mistake — a wasted
 * kill, but not one he had the information to avoid.
 */
export function assassinationError(
  record: PublicRecord,
  roles: RevealedRoles,
): AssassinationError | null {
  const a = record.assassination;
  if (!a) return null;
  const targetRole = roles.bySeat[a.target] ?? null;
  const targetIsEvil = roles.sideOf[a.target] === "evil";
  // Oberon is evil but the Assassin was never shown him. Naming him is a wasted
  // kill, not an avoidable one, so it is not this error.
  const wasShown = targetIsEvil && targetRole !== "oberon";
  return {
    assassin: a.assassin,
    target: a.target,
    atSequence: a.atSequence,
    targetWasMerlin: targetRole === "merlin",
    knownEvilAssassinationTarget: wasShown,
    targetRole: targetIsEvil ? targetRole : null,
  };
}

/* ── Shared ─────────────────────────────────────────────────────────────── */

/**
 * The seat's own record as it stood immediately BEFORE `atSequence`.
 *
 * Strictly before. See the note on the twin function in `metrics-contest.ts`:
 * a record stamped exactly `S` was made after event `S` existed, so including
 * it answers a question about the wrong moment. Fixed in both files at once
 * because they had the same defect for the same reason.
 */
function latestBefore(
  observations: readonly SocialObservation[],
  seat: Seat,
  atSequence: number,
): SocialObservation | null {
  let best: SocialObservation | null = null;
  for (const o of observations) {
    if (o.seat !== seat) continue;
    if (o.atSequence >= atSequence) continue;
    if (!best || o.atSequence > best.atSequence) best = o;
  }
  return best;
}

/* ── The whole set, for a report ────────────────────────────────────────── */

export interface CoordinationReport {
  readonly concentration: readonly ConcentrationPoint[];
  readonly stances: StanceCounts;
  readonly graph: readonly EndorsementEdge[];
  readonly voteAlignment: VoteAlignment;
  readonly teamOverlap: TeamOverlap;
  readonly focalShifts: readonly FocalShift[];
  readonly dissentUptake: DissentUptake;
  readonly publicRequests: PublicRequestCounts;
  /** Present only when the caller supplied the reveal. */
  readonly leaderTruth: LeaderTruth | null;
  readonly coordination: readonly CoordinationOutcome[] | null;
  /** Null when the reveal was not supplied, or the game had no assassination. */
  readonly assassination: AssassinationError | null;
}

export function coordinationReport(
  observations: readonly SocialObservation[],
  record: PublicRecord,
  roles?: RevealedRoles,
): CoordinationReport {
  return {
    concentration: focalConcentration(observations),
    stances: stanceCounts(observations),
    graph: endorsementGraph(observations),
    voteAlignment: voteAlignmentWithFocal(observations, record),
    teamOverlap: teamOverlapWithPlan(observations, record),
    focalShifts: focalShiftsAroundMissions(observations, record),
    dissentUptake: minorityDissentUptake(observations, record),
    publicRequests: publicRequestCounts(observations, record),
    leaderTruth: roles ? leaderTruth(observations, roles) : null,
    coordination: roles ? coordinationOutcomes(observations, record, roles) : null,
    assassination: roles ? assassinationError(record, roles) : null,
  };
}
