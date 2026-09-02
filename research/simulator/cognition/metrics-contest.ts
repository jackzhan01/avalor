/**
 * Claim-contest metrics, computed AFTER a game from the private trace.
 *
 * OBSERVATIONAL, in the same strict sense as `metrics.ts`: nothing here is
 * reachable from an agent, every function takes recorded telemetry, and no code
 * path leads from a number back into a prompt. Three of these read the deal —
 * `claimantRoles`, `truePercivalInfluence`, `falseLeaderCapture` — which is fine
 * in a post-mortem and would be a catastrophe in a decision.
 *
 * WHY A SEPARATE FILE. `metrics.ts` answers "who was the table following". These
 * answer "who was fighting over the identity, who won, and did it change any
 * actual vote". They share nothing but the discipline, and folding them together
 * would put the reveal-reading functions next to the ones that do not need it —
 * which is the exact adjacency worth avoiding.
 *
 * THE QUESTION THE WHOLE SET EXISTS FOR is the last one:
 * `contestChangedTheGame`. A claim contest that produces a great deal of talk
 * and changes no proposal and no vote is theatre, and the cheapest way to find
 * that out is to check whether teams and votes actually moved with it.
 */

import type { RoleType } from "@/lib/types/game";
import { SEATS, type Seat, type Side } from "../core/types";
import type { ClaimContest, PublicClaimStatus } from "./claim-contest";
import type { PublicRecord, RevealedRoles } from "./metrics";

/* ── Input ──────────────────────────────────────────────────────────────── */

/** One decision's contest record, flattened from the trace. */
export interface ContestObservation {
  readonly seat: Seat;
  readonly taskId: string;
  readonly atSequence: number;
  readonly ownClaimStatus: string;
  readonly act: string;
  readonly targetSeats: readonly Seat[];
  readonly requestedTeam: readonly Seat[] | null;
  readonly requestedVote: string;
  readonly stance: string;
  readonly selectedClaimant: Seat | null;
  readonly assessments: readonly {
    readonly seat: Seat;
    readonly level: string;
    readonly publicStatus: string;
    readonly restsOnUnverified: boolean;
  }[];
  readonly rivalSeats: readonly Seat[];
  /** True when this update was rejected for repeating the previous one. */
  readonly rejectedForRepetition?: boolean;
}

/* ── 1-2. How many claims, when, and by whom ────────────────────────────── */

export interface ClaimTimeline {
  readonly total: number;
  readonly percivalClaims: number;
  readonly retractions: number;
  readonly counterclaims: number;
  readonly events: readonly {
    readonly sequence: number;
    readonly seat: Seat;
    readonly kind: "claim" | "retract";
    readonly claimed: RoleType | null;
    readonly counter: boolean;
  }[];
}

export function claimTimeline(contest: ClaimContest): ClaimTimeline {
  const events = contest.events
    .filter((e): e is Extract<ClaimContest["events"][number], { kind: "claim" | "retract" }> =>
      e.kind === "claim" || e.kind === "retract",
    )
    .map((e) => ({
      sequence: e.sequence,
      seat: e.seat,
      kind: e.kind,
      claimed: e.kind === "claim" ? e.claimed : e.retracted,
      counter: e.kind === "claim" ? e.counter : false,
    }));
  return {
    total: events.filter((e) => e.kind === "claim").length,
    percivalClaims: events.filter((e) => e.kind === "claim" && e.claimed === "percival").length,
    retractions: events.filter((e) => e.kind === "retract").length,
    counterclaims: events.filter((e) => e.counter).length,
    events,
  };
}

/**
 * Which roles claimed. POST-MORTEM ONLY.
 *
 * The headline of the whole milestone: the design says every role may claim
 * Percival, and this is how a run says whether any of them did.
 */
export function claimantRoles(
  contest: ClaimContest,
  roles: RevealedRoles,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const record of Object.values(contest.bySeat)) {
    if (!record || record.history.length === 0) continue;
    if (!record.history.some((h) => h.claimed === "percival")) continue;
    const role = roles.bySeat[record.seat];
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

/* ── 3-4. How crowded, and how fast the answer came ─────────────────────── */

export interface ActiveClaimantPoint {
  readonly sequence: number;
  readonly active: number;
  readonly retracted: number;
}

/** How many seats were standing on Percival, after each contest event. */
export function activeClaimantsByTurn(contest: ClaimContest): ActiveClaimantPoint[] {
  const points: ActiveClaimantPoint[] = [];
  const status = new Map<Seat, PublicClaimStatus>();
  for (const event of contest.events) {
    if (event.kind === "claim") {
      if (event.claimed !== "percival") continue;
      status.set(event.seat, "active");
    } else if (event.kind === "retract") {
      if (event.retracted !== "percival") continue;
      status.set(event.seat, "retracted");
    } else {
      continue;
    }
    points.push({
      sequence: event.sequence,
      active: [...status.values()].filter((s) => s === "active").length,
      retracted: [...status.values()].filter((s) => s === "retracted").length,
    });
  }
  return points;
}

export interface CounterclaimLatency {
  readonly pairs: number;
  readonly meanSequences: number;
  readonly fastest: number | null;
  readonly slowest: number | null;
}

/** How long the table waited before somebody contested a standing claim. */
export function counterclaimLatency(contest: ClaimContest): CounterclaimLatency {
  const claims = contest.events.filter(
    (e): e is Extract<ClaimContest["events"][number], { kind: "claim" }> =>
      e.kind === "claim" && e.claimed === "percival",
  );
  const gaps: number[] = [];
  for (const [i, claim] of claims.entries()) {
    if (i === 0) continue;
    gaps.push(claim.sequence - claims[i - 1].sequence);
  }
  return {
    pairs: gaps.length,
    meanSequences: gaps.length === 0 ? 0 : gaps.reduce((a, b) => a + b, 0) / gaps.length,
    fastest: gaps.length === 0 ? null : Math.min(...gaps),
    slowest: gaps.length === 0 ? null : Math.max(...gaps),
  };
}

/* ── 5-6. Who fought whom, and who answered ─────────────────────────────── */

export interface AttackEdge {
  readonly from: Seat;
  readonly to: Seat;
  readonly attacks: number;
  /** Attacks by a seat that was itself standing on a claim. */
  readonly betweenClaimants: number;
}

export function attackGraph(contest: ClaimContest): AttackEdge[] {
  const edges = new Map<string, AttackEdge & { attacks: number; betweenClaimants: number }>();
  for (const event of contest.events) {
    if (event.kind !== "claimant_stance" && event.kind !== "bystander_stance") continue;
    if (event.direction !== "attack") continue;
    const key = `${event.from}->${event.to}`;
    const edge = edges.get(key) ?? {
      from: event.from,
      to: event.to,
      attacks: 0,
      betweenClaimants: 0,
    };
    edges.set(key, {
      ...edge,
      attacks: edge.attacks + 1,
      betweenClaimants: edge.betweenClaimants + (event.kind === "claimant_stance" ? 1 : 0),
    });
  }
  return [...edges.values()].sort((a, b) => a.from - b.from || a.to - b.to);
}

export interface DefenceRate {
  readonly attacksReceived: number;
  readonly answered: number;
  readonly rate: number;
}

/**
 * When a claimant was attacked, did it answer at its next decision?
 *
 * "Answered" means the seat's own next contest record chose `defend-own-claim`
 * or `attack-rival-claim` — a structured act, not a phrase in the speech. A
 * claimant that never answers is the failure mode scenario 13 is about.
 */
export function defenceResponseRate(
  observations: readonly ContestObservation[],
  contest: ClaimContest,
): DefenceRate {
  let attacksReceived = 0;
  let answered = 0;
  for (const event of contest.events) {
    if (event.kind !== "claimant_stance" && event.kind !== "bystander_stance") continue;
    if (event.direction !== "attack") continue;
    attacksReceived += 1;
    const next = observations
      .filter((o) => o.seat === event.to && o.atSequence > event.sequence)
      .sort((a, b) => a.atSequence - b.atSequence)[0];
    if (next && (next.act === "defend-own-claim" || next.act === "attack-rival-claim")) {
      answered += 1;
    }
  }
  return {
    attacksReceived,
    answered,
    rate: attacksReceived === 0 ? 0 : answered / attacksReceived,
  };
}

/* ── 7. Did claimants actually ask for anything? ────────────────────────── */

export interface ActionableRate {
  readonly claimantDecisions: number;
  readonly withTeamOrVote: number;
  readonly rate: number;
}

/**
 * How often a claimant's move carried an executable request.
 *
 * A claim with no team and no vote attached is a claim to authority that asks
 * the table to do nothing with it, which is the "I am Percival, repeatedly"
 * failure Part E forbids.
 */
export function actionableRequestRate(
  observations: readonly ContestObservation[],
): ActionableRate {
  const claimantDecisions = observations.filter((o) =>
    ["active", "defending", "retracting"].includes(o.ownClaimStatus),
  );
  const withTeamOrVote = claimantDecisions.filter(
    (o) => (o.requestedTeam && o.requestedTeam.length > 0) || o.requestedVote !== "none",
  ).length;
  return {
    claimantDecisions: claimantDecisions.length,
    withTeamOrVote,
    rate: claimantDecisions.length === 0 ? 0 : withTeamOrVote / claimantDecisions.length,
  };
}

/* ── 8-9. Coalitions around claimants ───────────────────────────────────── */

export interface ClaimantCoalition {
  readonly claimant: Seat;
  readonly supporters: readonly Seat[];
  readonly conditionalSupporters: readonly Seat[];
  readonly opponents: readonly Seat[];
  readonly size: number;
}

/** Who ended up on which claimant's side, from the last record of each seat. */
export function coalitionsByClaimant(
  observations: readonly ContestObservation[],
): ClaimantCoalition[] {
  const latest = new Map<Seat, ContestObservation>();
  for (const o of observations) {
    const current = latest.get(o.seat);
    if (!current || o.atSequence > current.atSequence) latest.set(o.seat, o);
  }
  const byClaimant = new Map<Seat, ClaimantCoalition>();
  const ensure = (claimant: Seat): ClaimantCoalition =>
    byClaimant.get(claimant) ?? {
      claimant,
      supporters: [],
      conditionalSupporters: [],
      opponents: [],
      size: 0,
    };
  for (const o of latest.values()) {
    if (o.selectedClaimant === null) continue;
    const entry = ensure(o.selectedClaimant);
    const next: ClaimantCoalition = {
      ...entry,
      supporters: o.stance === "support" ? [...entry.supporters, o.seat] : entry.supporters,
      conditionalSupporters:
        o.stance === "conditional-support"
          ? [...entry.conditionalSupporters, o.seat]
          : entry.conditionalSupporters,
      opponents: o.stance === "oppose" ? [...entry.opponents, o.seat] : entry.opponents,
      size: 0,
    };
    byClaimant.set(o.selectedClaimant, {
      ...next,
      size: next.supporters.length + next.conditionalSupporters.length,
    });
  }
  return [...byClaimant.values()].sort((a, b) => a.claimant - b.claimant);
}

/* ── 10-11. Did support turn into votes and teams? ──────────────────────── */

export interface ClaimantVoteAlignment {
  readonly claimant: Seat;
  readonly compared: number;
  readonly agreed: number;
  readonly rate: number;
}

export function voteAlignmentByClaimant(
  observations: readonly ContestObservation[],
  record: PublicRecord,
): ClaimantVoteAlignment[] {
  const byClaimant = new Map<Seat, { compared: number; agreed: number }>();
  for (const vote of record.votes) {
    for (const seat of SEATS) {
      const mine = latestBefore(observations, seat, vote.atSequence);
      if (!mine?.selectedClaimant) continue;
      if (mine.stance !== "support" && mine.stance !== "conditional-support") continue;
      const theirs = vote.votes[mine.selectedClaimant];
      const ours = vote.votes[seat];
      if (theirs === undefined || ours === undefined) continue;
      const entry = byClaimant.get(mine.selectedClaimant) ?? { compared: 0, agreed: 0 };
      byClaimant.set(mine.selectedClaimant, {
        compared: entry.compared + 1,
        agreed: entry.agreed + (theirs === ours ? 1 : 0),
      });
    }
  }
  return [...byClaimant.entries()]
    .map(([claimant, e]) => ({
      claimant,
      compared: e.compared,
      agreed: e.agreed,
      rate: e.compared === 0 ? 0 : e.agreed / e.compared,
    }))
    .sort((a, b) => a.claimant - b.claimant);
}

export interface ClaimantTeamOverlap {
  readonly compared: number;
  readonly meanJaccard: number;
}

/** How close a proposed team was to what the leader's chosen claimant asked for. */
export function teamOverlapWithClaimant(
  observations: readonly ContestObservation[],
  record: PublicRecord,
): ClaimantTeamOverlap {
  let compared = 0;
  let total = 0;
  for (const proposal of record.proposals) {
    const mine = latestBefore(observations, proposal.leader, proposal.atSequence);
    if (!mine?.selectedClaimant) continue;
    const asked = latestBefore(observations, mine.selectedClaimant, proposal.atSequence);
    if (!asked?.requestedTeam || asked.requestedTeam.length === 0) continue;
    const a = new Set(asked.requestedTeam);
    const b = new Set(proposal.team);
    const both = [...a].filter((s) => b.has(s)).length;
    const either = new Set([...a, ...b]).size;
    compared += 1;
    total += either === 0 ? 0 : both / either;
  }
  return { compared, meanJaccard: compared === 0 ? 0 : total / compared };
}

/* ── 12-13. Movement ────────────────────────────────────────────────────── */

export interface FollowerSwitch {
  readonly seat: Seat;
  readonly from: Seat;
  readonly to: Seat;
  readonly atSequence: number;
}

/** Every time a seat changed which claimant it was backing. */
export function followerSwitches(
  observations: readonly ContestObservation[],
): FollowerSwitch[] {
  const switches: FollowerSwitch[] = [];
  for (const seat of SEATS) {
    const mine = observations
      .filter((o) => o.seat === seat)
      .sort((a, b) => a.atSequence - b.atSequence);
    let current: Seat | null = null;
    for (const o of mine) {
      if (o.selectedClaimant === null) continue;
      if (current !== null && o.selectedClaimant !== current) {
        switches.push({ seat, from: current, to: o.selectedClaimant, atSequence: o.atSequence });
      }
      current = o.selectedClaimant;
    }
  }
  return switches.sort((a, b) => a.atSequence - b.atSequence);
}

export interface CredibilityShift {
  readonly claimant: Seat;
  readonly missionNumber: number;
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
}

/**
 * How the table's read on each claimant moved across a mission result.
 *
 * The modal assessment across all seats, before and after — a distribution
 * summary, deliberately not a single authoritative "credibility score".
 */
export function credibilityAcrossMissions(
  observations: readonly ContestObservation[],
  record: PublicRecord,
  claimants: readonly Seat[],
): CredibilityShift[] {
  const modal = (claimant: Seat, from: number, to: number): string | null => {
    const counts = new Map<string, number>();
    for (const o of observations) {
      if (o.atSequence < from || o.atSequence >= to) continue;
      for (const a of o.assessments) {
        if (a.seat !== claimant) continue;
        counts.set(a.level, (counts.get(a.level) ?? 0) + 1);
      }
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [level, n] of counts) if (n > bestN) [best, bestN] = [level, n];
    return best;
  };
  const shifts: CredibilityShift[] = [];
  for (const claimant of claimants) {
    for (const [i, mission] of record.missions.entries()) {
      const previous = record.missions[i - 1]?.atSequence ?? 0;
      const next = record.missions[i + 1]?.atSequence ?? Number.MAX_SAFE_INTEGER;
      const before = modal(claimant, previous, mission.atSequence);
      const after = modal(claimant, mission.atSequence, next);
      shifts.push({
        claimant,
        missionNumber: mission.missionNumber,
        before,
        after,
        changed: before !== after,
      });
    }
  }
  return shifts;
}

/* ── 14-16. Hidden truth. POST-MORTEM ONLY. ─────────────────────────────── */

export interface ClaimantCapture {
  /** Backings whose target was the real Percival. */
  readonly truePercival: number;
  /** Backings whose target was Morgana. The classic false-leader capture. */
  readonly morgana: number;
  /** Backings whose target was some other evil seat. */
  readonly otherEvil: number;
  /** Backings whose target was a good seat that is not Percival. */
  readonly otherGood: number;
  readonly total: number;
  readonly morganaCaptureRate: number;
  readonly anyEvilCaptureRate: number;
}

export function falseLeaderCapture(
  observations: readonly ContestObservation[],
  roles: RevealedRoles,
): ClaimantCapture {
  let truePercival = 0;
  let morgana = 0;
  let otherEvil = 0;
  let otherGood = 0;
  for (const o of observations) {
    if (o.selectedClaimant === null) continue;
    if (o.stance !== "support" && o.stance !== "conditional-support") continue;
    const role = roles.bySeat[o.selectedClaimant];
    if (role === "morgana") morgana += 1;
    else if (roles.sideOf[o.selectedClaimant] === "evil") otherEvil += 1;
    else if (role === "percival") truePercival += 1;
    else otherGood += 1;
  }
  const total = truePercival + morgana + otherEvil + otherGood;
  return {
    truePercival,
    morgana,
    otherEvil,
    otherGood,
    total,
    morganaCaptureRate: total === 0 ? 0 : morgana / total,
    anyEvilCaptureRate: total === 0 ? 0 : (morgana + otherEvil) / total,
  };
}

export interface LoyalAlignmentSplit {
  readonly loyalSeats: number;
  readonly withTruePercival: number;
  readonly withMorgana: number;
  readonly withOtherClaimant: number;
  readonly withNobody: number;
}

/** Where the plain Loyal servants ended up. The coalition question, per side. */
export function loyalAlignmentSplit(
  observations: readonly ContestObservation[],
  roles: RevealedRoles,
): LoyalAlignmentSplit {
  const latest = new Map<Seat, ContestObservation>();
  for (const o of observations) {
    const current = latest.get(o.seat);
    if (!current || o.atSequence > current.atSequence) latest.set(o.seat, o);
  }
  const loyal = SEATS.filter((s) => roles.bySeat[s] === "loyal");
  let withTruePercival = 0;
  let withMorgana = 0;
  let withOtherClaimant = 0;
  let withNobody = 0;
  for (const seat of loyal) {
    const mine = latest.get(seat);
    const target = mine?.selectedClaimant ?? null;
    const backing =
      mine && (mine.stance === "support" || mine.stance === "conditional-support");
    if (!backing || target === null) {
      withNobody += 1;
      continue;
    }
    const role = roles.bySeat[target];
    if (role === "percival") withTruePercival += 1;
    else if (role === "morgana") withMorgana += 1;
    else withOtherClaimant += 1;
  }
  return {
    loyalSeats: loyal.length,
    withTruePercival,
    withMorgana,
    withOtherClaimant,
    withNobody,
  };
}

export interface TruePercivalInfluence {
  readonly claimed: boolean;
  readonly claimedAtSequence: number | null;
  readonly backers: number;
  readonly attacksMade: number;
  readonly attacksReceived: number;
  /** Distinct rivals the true Percival explicitly addressed. Part F's number. */
  readonly rivalsAddressed: number;
  /** Own-claim updates refused for repeating the previous turn's reasons. */
  readonly repeatedDelaysRejected: number;
}

export function truePercivalInfluence(
  observations: readonly ContestObservation[],
  contest: ClaimContest,
  roles: RevealedRoles,
): TruePercivalInfluence {
  const seat = SEATS.find((s) => roles.bySeat[s] === "percival") ?? null;
  if (seat === null) {
    return {
      claimed: false,
      claimedAtSequence: null,
      backers: 0,
      attacksMade: 0,
      attacksReceived: 0,
      rivalsAddressed: 0,
      repeatedDelaysRejected: 0,
    };
  }
  const record = contest.bySeat[seat];
  const mine = observations.filter((o) => o.seat === seat);
  const rivals = new Set<Seat>();
  for (const o of mine) {
    for (const s of o.rivalSeats) rivals.add(s);
    if (o.act === "attack-rival-claim") for (const s of o.targetSeats) rivals.add(s);
  }
  const backers = new Set(
    observations
      .filter(
        (o) =>
          o.selectedClaimant === seat &&
          (o.stance === "support" || o.stance === "conditional-support"),
      )
      .map((o) => o.seat),
  );
  return {
    claimed: (record?.history.length ?? 0) > 0,
    claimedAtSequence: record?.firstClaimSequence ?? null,
    backers: backers.size,
    attacksMade: record?.attacked.length ?? 0,
    attacksReceived: record?.attackedBy.length ?? 0,
    rivalsAddressed: rivals.size,
    repeatedDelaysRejected: mine.filter((o) => o.rejectedForRepetition === true).length,
  };
}

/* ── 17. Retraction outcomes ────────────────────────────────────────────── */

export interface RetractionOutcome {
  readonly seat: Seat;
  readonly atSequence: number;
  readonly beforeVote: boolean;
  readonly afterFailedMission: boolean;
  /** Seats that were backing this claimant immediately before the retraction. */
  readonly backersBefore: number;
  readonly backersAfter: number;
  /** POST-MORTEM ONLY, and null when no reveal was supplied. */
  readonly side: Side | null;
}

export function retractionOutcomes(
  observations: readonly ContestObservation[],
  contest: ClaimContest,
  record: PublicRecord,
  roles?: RevealedRoles,
): RetractionOutcome[] {
  const backersAt = (claimant: Seat, at: number, after: boolean): number =>
    new Set(
      observations
        .filter(
          (o) =>
            o.selectedClaimant === claimant &&
            (o.stance === "support" || o.stance === "conditional-support") &&
            (after ? o.atSequence > at : o.atSequence <= at),
        )
        .map((o) => o.seat),
    ).size;

  return contest.events
    .filter((e): e is Extract<ClaimContest["events"][number], { kind: "retract" }> =>
      e.kind === "retract",
    )
    .map((e) => ({
      seat: e.seat,
      atSequence: e.sequence,
      // "Before a vote" means no vote happened between the claim and the
      // retraction — the retraction came while the claim was still untested.
      beforeVote: !record.votes.some(
        (v) => v.atSequence > e.claimSequence && v.atSequence < e.sequence,
      ),
      afterFailedMission: record.missions.some(
        (m) => m.result === "fail" && m.atSequence < e.sequence,
      ),
      backersBefore: backersAt(e.seat, e.sequence, false),
      backersAfter: backersAt(e.seat, e.sequence, true),
      side: roles ? roles.sideOf[e.seat] : null,
    }));
}

/* ── 18. Did any of it change the game? ─────────────────────────────────── */

export interface ContestImpact {
  readonly proposals: number;
  /** Proposals whose leader was backing a claimant at the time. */
  readonly proposalsUnderAClaimant: number;
  /** Of those, how many actually overlapped what that claimant asked for. */
  readonly proposalsFollowingTheAsk: number;
  readonly votes: number;
  /** Backer-votes that could be compared to a claimant at all. */
  readonly voteFollowingsCompared: number;
  /** Backer voted the way the claimant EXPLICITLY asked. The strong arm. */
  readonly votesMatchingAnExplicitAsk: number;
  /** Backer voted the way the claimant itself voted. The weak arm. */
  readonly votesMatchingTheClaimant: number;

  /* ── The four, reported separately and never collapsed ────────────────── */
  /** At least one proposed team followed a backed claimant's ask. */
  readonly changedProposal: boolean;
  /** At least one vote followed a backed claimant. */
  readonly changedVote: boolean;
  readonly changedEither: boolean;
  readonly changedBoth: boolean;
  /**
   * @deprecated An ALIAS of `changedBoth`, kept so older readers do not break.
   *
   * It was the primary success measure and should not have been: requiring a
   * proposal AND a vote to move made a run where the contest reshaped every
   * team but changed nobody's vote report `false`, which reads as "the contest
   * did nothing". Use `changedEither` for "did it do anything" and the two
   * halves for what it actually did.
   */
  readonly changedSomething: boolean;
}

/**
 * Did the claim contest reach the actual game?
 *
 * FOUR NUMBERS, NOT ONE. A contest can move teams without moving votes (a
 * leader takes a claimant's roster and the table approves it for its own
 * reasons) or votes without moving teams (a bloc follows a claimant onto a
 * team nobody asked for). Both are real effects, and a single conjunctive
 * boolean called them both nothing.
 *
 * WHAT "FOLLOWED" MEANS, exactly, because these are correlational and saying so
 * is the difference between a metric and a claim:
 *
 *   PROPOSAL   the leader was backing a claimant, that claimant had asked for a
 *              concrete team, and the proposal overlapped it at all. Zero
 *              overlap is evidence the leader went its own way.
 *   VOTE       either the claimant explicitly asked for a vote and the backer
 *              cast it (`votesMatchingAnExplicitAsk`, the strong arm), or the
 *              backer simply voted as the claimant did
 *              (`votesMatchingTheClaimant`, which a coincidence also produces).
 *
 * Both vote arms are reported separately so a reader can see which one fired.
 * A `changedVote` that rests only on the weak arm is worth less than one that
 * rests on the strong arm, and the shape of this record says so.
 */
export function contestChangedTheGame(
  observations: readonly ContestObservation[],
  record: PublicRecord,
): ContestImpact {
  const backing = (o: ContestObservation | null) =>
    Boolean(o?.selectedClaimant) &&
    (o!.stance === "support" || o!.stance === "conditional-support");

  /* ── Proposals ────────────────────────────────────────────────────────── */
  let proposalsUnderAClaimant = 0;
  let proposalsFollowingTheAsk = 0;
  for (const proposal of record.proposals) {
    const leader = latestBefore(observations, proposal.leader, proposal.atSequence);
    if (!backing(leader)) continue;
    proposalsUnderAClaimant += 1;
    const asked = latestBefore(observations, leader!.selectedClaimant!, proposal.atSequence);
    if (!asked?.requestedTeam || asked.requestedTeam.length === 0) continue;
    const wanted = new Set(asked.requestedTeam);
    if (proposal.team.some((seat) => wanted.has(seat))) proposalsFollowingTheAsk += 1;
  }

  /* ── Votes ────────────────────────────────────────────────────────────── */
  let voteFollowingsCompared = 0;
  let votesMatchingAnExplicitAsk = 0;
  let votesMatchingTheClaimant = 0;
  for (const vote of record.votes) {
    for (const seat of SEATS) {
      const mine = latestBefore(observations, seat, vote.atSequence);
      if (!backing(mine)) continue;
      const claimant = mine!.selectedClaimant!;
      const ours = vote.votes[seat];
      if (ours === undefined) continue;
      voteFollowingsCompared += 1;
      const asked = latestBefore(observations, claimant, vote.atSequence);
      if (asked && asked.requestedVote !== "none") {
        if (asked.requestedVote === ours) votesMatchingAnExplicitAsk += 1;
        continue;
      }
      const theirs = vote.votes[claimant];
      if (theirs !== undefined && theirs === ours) votesMatchingTheClaimant += 1;
    }
  }

  const changedProposal = proposalsFollowingTheAsk > 0;
  const changedVote = votesMatchingAnExplicitAsk > 0 || votesMatchingTheClaimant > 0;
  const changedBoth = changedProposal && changedVote;
  return {
    proposals: record.proposals.length,
    proposalsUnderAClaimant,
    proposalsFollowingTheAsk,
    votes: record.votes.length,
    voteFollowingsCompared,
    votesMatchingAnExplicitAsk,
    votesMatchingTheClaimant,
    changedProposal,
    changedVote,
    changedEither: changedProposal || changedVote,
    changedBoth,
    changedSomething: changedBoth,
  };
}

/* ── Shared ─────────────────────────────────────────────────────────────── */

/**
 * The seat's own record as it stood immediately BEFORE `atSequence`.
 *
 * STRICTLY before, and the strictness is load-bearing. A record's `atSequence`
 * is the log length when the seat was asked — so a record stamped `N` was made
 * knowing about event N and produced event N+1. A record stamped exactly `S` was
 * therefore made AFTER event S existed, and including it answers "what did they
 * want a moment later" rather than "what did they want when this happened".
 *
 * That is not hypothetical: in the M5.2 pilot the proposal event sat at
 * sequence 30, the leader's closing decision at 28, and its own vote decision at
 * 30 with `requestedTeam: null`. A `<=` comparison picked the vote, and
 * `changedProposal` reported false for a proposal that matched the ask exactly.
 */
function latestBefore(
  observations: readonly ContestObservation[],
  seat: Seat,
  atSequence: number,
): ContestObservation | null {
  let best: ContestObservation | null = null;
  for (const o of observations) {
    if (o.seat !== seat) continue;
    if (o.atSequence >= atSequence) continue;
    if (!best || o.atSequence > best.atSequence) best = o;
  }
  return best;
}

/* ── Silent support ─────────────────────────────────────────────────────── */

/**
 * Support that never said anything.
 *
 * WHY THIS EXISTS. The completed M5.2 game ended with seat 7 — the false
 * Percival — holding exactly ONE public backer and still carrying a 7:3 vote.
 * Every other vote it received came from a seat that had privately picked it
 * and never said so. That is the shape of a false consensus, and none of the
 * existing metrics could see it: `coalitionsByClaimant` counts declared
 * stances, and a silent follower declares nothing.
 *
 * PRIVATE AND OBSERVATIONAL. Nothing here is read on the live path. It needs
 * the per-seat contest records, which are private telemetry, so a runtime that
 * consulted it would be a runtime reading ten seats' private state to decide
 * one seat's move. `metrics-contest.test.ts` asserts no runtime module imports
 * this file.
 *
 * WHAT COUNTS AS PUBLIC ENDORSEMENT. A public ACT, not a private stance:
 * `endorse-claimant` naming the claimant, or a positive stance recorded in the
 * public speech event. A seat that privately holds `support` and says nothing
 * is exactly what this measures, so its private stance cannot also be what
 * makes it public.
 */
export interface SilentSupport {
  readonly claimant: Seat;
  /** Backers who voted with the claimant while never endorsing it in public. */
  readonly votedWithClaimantWithoutPublicEndorsement: number;
  /** Distinct seats in that state. */
  readonly silentSupportCount: number;
  /** Distinct seats that DID publicly endorse this claimant at least once. */
  readonly publicEndorsementCount: number;
  /** Silent backers who later went public. The ratio is over silent backers. */
  readonly silentToPublicConversion: number;
  /** Silent backers who switched to a different claimant without ever speaking. */
  readonly silentFollowerSwitching: number;
}

/** Public endorsements, from public acts only. */
function publicEndorsers(
  observations: readonly ContestObservation[],
): ReadonlyMap<Seat, ReadonlySet<Seat>> {
  const out = new Map<Seat, Set<Seat>>();
  for (const o of observations) {
    if (o.act !== "endorse-claimant") continue;
    for (const target of o.targetSeats) {
      const set = out.get(target) ?? new Set<Seat>();
      set.add(o.seat);
      out.set(target, set);
    }
  }
  return out;
}

/** The first sequence at which a seat publicly endorsed a given claimant. */
function firstPublicEndorsement(
  observations: readonly ContestObservation[],
  seat: Seat,
  claimant: Seat,
): number | null {
  let best: number | null = null;
  for (const o of observations) {
    if (o.seat !== seat || o.act !== "endorse-claimant") continue;
    if (!o.targetSeats.includes(claimant)) continue;
    if (best === null || o.atSequence < best) best = o.atSequence;
  }
  return best;
}

export function silentSupport(
  observations: readonly ContestObservation[],
  record: PublicRecord,
): SilentSupport[] {
  const endorsers = publicEndorsers(observations);
  const byClaimant = new Map<
    Seat,
    { votes: number; silent: Set<Seat>; converted: Set<Seat>; switched: Set<Seat> }
  >();
  const ensure = (claimant: Seat) => {
    const e = byClaimant.get(claimant) ?? {
      votes: 0,
      silent: new Set<Seat>(),
      converted: new Set<Seat>(),
      switched: new Set<Seat>(),
    };
    byClaimant.set(claimant, e);
    return e;
  };

  for (const vote of record.votes) {
    for (const seat of SEATS) {
      const mine = latestBefore(observations, seat, vote.atSequence);
      const claimant = mine?.selectedClaimant ?? null;
      if (!mine || claimant === null || claimant === seat) continue;
      if (mine.stance !== "support" && mine.stance !== "conditional-support") continue;
      const theirs = vote.votes[claimant];
      const ours = vote.votes[seat];
      if (theirs === undefined || ours === undefined || theirs !== ours) continue;

      // Silent AT THIS MOMENT: no public endorsement of this claimant had
      // happened yet. A seat that endorses later was still silent for this vote.
      const spokeAt = firstPublicEndorsement(observations, seat, claimant);
      if (spokeAt !== null && spokeAt < vote.atSequence) continue;

      const entry = ensure(claimant);
      entry.votes += 1;
      entry.silent.add(seat);
      if (spokeAt !== null) entry.converted.add(seat);
    }
  }

  // A silent backer that moved to a different claimant without ever endorsing
  // anybody in public. The quiet half of `followerSwitches`.
  for (const seat of SEATS) {
    const mine = observations
      .filter((o) => o.seat === seat)
      .sort((a, b) => a.atSequence - b.atSequence);
    let previous: Seat | null = null;
    for (const o of mine) {
      const now = o.selectedClaimant;
      if (previous !== null && now !== null && now !== previous) {
        const everSpoke = observations.some(
          (x) => x.seat === seat && x.act === "endorse-claimant",
        );
        if (!everSpoke) ensure(previous).switched.add(seat);
      }
      if (now !== null) previous = now;
    }
  }

  const claimants = new Set<Seat>([...byClaimant.keys(), ...endorsers.keys()]);
  return [...claimants]
    .map((claimant) => {
      const e = byClaimant.get(claimant);
      const silent = e?.silent.size ?? 0;
      return {
        claimant,
        votedWithClaimantWithoutPublicEndorsement: e?.votes ?? 0,
        silentSupportCount: silent,
        publicEndorsementCount: endorsers.get(claimant)?.size ?? 0,
        silentToPublicConversion: silent === 0 ? 0 : (e?.converted.size ?? 0) / silent,
        silentFollowerSwitching: e?.switched.size ?? 0,
      };
    })
    .sort((a, b) => a.claimant - b.claimant);
}

/* ── The whole set, for a report ────────────────────────────────────────── */

export interface ContestReport {
  /** Support that never said anything. PRIVATE, observational only. */
  readonly silentSupport: readonly SilentSupport[];
  readonly timeline: ClaimTimeline;
  readonly activeByTurn: readonly ActiveClaimantPoint[];
  readonly latency: CounterclaimLatency;
  readonly attacks: readonly AttackEdge[];
  readonly defence: DefenceRate;
  readonly actionable: ActionableRate;
  readonly coalitions: readonly ClaimantCoalition[];
  readonly voteAlignment: readonly ClaimantVoteAlignment[];
  readonly teamOverlap: ClaimantTeamOverlap;
  readonly switches: readonly FollowerSwitch[];
  readonly credibility: readonly CredibilityShift[];
  readonly retractions: readonly RetractionOutcome[];
  readonly impact: ContestImpact;
  /** Present only when the caller supplied the reveal. */
  readonly roles: Readonly<Record<string, number>> | null;
  readonly capture: ClaimantCapture | null;
  readonly loyalSplit: LoyalAlignmentSplit | null;
  readonly truePercival: TruePercivalInfluence | null;
}

export function contestReport(
  observations: readonly ContestObservation[],
  contest: ClaimContest,
  record: PublicRecord,
  roles?: RevealedRoles,
): ContestReport {
  const claimants = Object.values(contest.bySeat)
    .filter((r) => r && r.history.length > 0)
    .map((r) => r!.seat);
  return {
    timeline: claimTimeline(contest),
    activeByTurn: activeClaimantsByTurn(contest),
    latency: counterclaimLatency(contest),
    attacks: attackGraph(contest),
    defence: defenceResponseRate(observations, contest),
    actionable: actionableRequestRate(observations),
    coalitions: coalitionsByClaimant(observations),
    silentSupport: silentSupport(observations, record),
    voteAlignment: voteAlignmentByClaimant(observations, record),
    teamOverlap: teamOverlapWithClaimant(observations, record),
    switches: followerSwitches(observations),
    credibility: credibilityAcrossMissions(observations, record, claimants),
    retractions: retractionOutcomes(observations, contest, record, roles),
    impact: contestChangedTheGame(observations, record),
    roles: roles ? claimantRoles(contest, roles) : null,
    capture: roles ? falseLeaderCapture(observations, roles) : null,
    loyalSplit: roles ? loyalAlignmentSplit(observations, roles) : null,
    truePercival: roles ? truePercivalInfluence(observations, contest, roles) : null,
  };
}
