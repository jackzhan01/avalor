/**
 * Proposal and vote discipline, measured. PRIVATE, observational only.
 *
 * WHY THESE FIVE. The M5.3 Terra game passed all five proposals on the first
 * attempt, including one that carried a seat the previous mission's three fail
 * cards had implicated, with no public explanation. None of the existing
 * metrics could see that: they count claims, coalitions and votes, and a table
 * that always approves produces a clean-looking record of nothing happening.
 *
 * NOTHING HERE IS A TARGET. A first-pass acceptance rate of 100% is not a
 * failing grade — on a table where every proposal is genuinely good it is the
 * right number. What these measure is whether the vote CARRIES INFORMATION:
 * whether approval is a decision or a default. Reading them as a score to
 * optimise would recreate the quota this milestone refused to build.
 *
 * Nothing on the live path imports this file, and a test asserts that.
 */

import type { Seat } from "../core/types";
import type { PublicRecord } from "./metrics";

export interface ProposalDiscipline {
  /** Proposals that passed on the first attempt of their round. */
  readonly firstPassAccepted: number;
  readonly firstPassTotal: number;
  readonly firstPassRate: number;

  /** The first proposal after a mission FAILED, and whether it passed. */
  readonly afterFailureAccepted: number;
  readonly afterFailureTotal: number;

  /**
   * Proposals carrying the leader of the team that just failed.
   *
   * The specific shape the Terra game produced: the seat that proposed a
   * three-fail team stayed aboard the next one, unexplained, and it passed.
   */
  readonly carriedFailedLeaderAccepted: number;
  readonly carriedFailedLeaderTotal: number;

  /** Rejections followed by a DIFFERENT team from the next leader. */
  readonly objectionsThatChangedTheTeam: number;
  readonly rejections: number;
}

const sameTeam = (a: readonly Seat[], b: readonly Seat[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((s, i) => s === [...b].sort((x, y) => x - y)[i]);

export function proposalDiscipline(record: PublicRecord): ProposalDiscipline {
  const votes = [...record.votes].sort((a, b) => a.atSequence - b.atSequence);
  const proposals = [...record.proposals].sort((a, b) => a.atSequence - b.atSequence);
  const missions = [...record.missions].sort((a, b) => a.atSequence - b.atSequence);

  let firstPassAccepted = 0;
  let firstPassTotal = 0;
  for (const v of votes) {
    if (v.attempt !== 1) continue;
    firstPassTotal += 1;
    if (v.result === "passed") firstPassAccepted += 1;
  }

  // The first vote after each failed mission resolves.
  let afterFailureAccepted = 0;
  let afterFailureTotal = 0;
  for (const m of missions) {
    if (m.result !== "fail") continue;
    const next = votes.find((v) => v.atSequence > m.atSequence);
    if (!next) continue;
    afterFailureTotal += 1;
    if (next.result === "passed") afterFailureAccepted += 1;
  }

  // Teams carrying the leader of the most recent failed team.
  let carriedAccepted = 0;
  let carriedTotal = 0;
  for (const v of votes) {
    const priorFail = missions
      .filter((m) => m.result === "fail" && m.atSequence < v.atSequence)
      .at(-1);
    if (!priorFail) continue;
    const failedProposal = proposals
      .filter((p) => p.atSequence < priorFail.atSequence)
      .at(-1);
    if (!failedProposal) continue;
    if (!v.team.includes(failedProposal.leader)) continue;
    carriedTotal += 1;
    if (v.result === "passed") carriedAccepted += 1;
  }

  // A rejection, then a different team.
  let changed = 0;
  let rejections = 0;
  for (const [i, v] of votes.entries()) {
    if (v.result === "passed") continue;
    rejections += 1;
    const next = votes[i + 1];
    if (next && !sameTeam(next.team, v.team)) changed += 1;
  }

  return {
    firstPassAccepted,
    firstPassTotal,
    firstPassRate: firstPassTotal === 0 ? 0 : firstPassAccepted / firstPassTotal,
    afterFailureAccepted,
    afterFailureTotal,
    carriedFailedLeaderAccepted: carriedAccepted,
    carriedFailedLeaderTotal: carriedTotal,
    objectionsThatChangedTheTeam: changed,
    rejections,
  };
}

/**
 * Did a catastrophic result move who the table follows?
 *
 * "Catastrophic" means a mission that opened MORE fail cards than it needed —
 * the shape that publishes the evil team's size. The question is whether the
 * standing claimants' public support changed across it, measured as stance
 * edges before versus after.
 */
export interface CatastropheEffect {
  readonly missionNumber: number;
  readonly failCount: number;
  readonly required: number;
  readonly atSequence: number;
  readonly supportBefore: Readonly<Record<number, number>>;
  readonly supportAfter: Readonly<Record<number, number>>;
}

export function catastropheEffects(
  record: PublicRecord,
  claimants: readonly Seat[],
  missionFails: readonly {
    readonly missionNumber: number;
    readonly failCount: number;
    readonly required: number;
    readonly atSequence: number;
  }[],
  stances: readonly {
    readonly speaker: Seat;
    readonly seat: Seat;
    readonly valence: number;
    readonly atSequence: number;
  }[],
): CatastropheEffect[] {
  void record;
  return missionFails
    .filter((m) => m.failCount > m.required)
    .map((m) => {
      const count = (before: boolean) => {
        const out: Record<number, number> = {};
        for (const c of claimants) out[c] = 0;
        for (const s of stances) {
          if (!claimants.includes(s.seat) || s.valence <= 0) continue;
          if (before ? s.atSequence < m.atSequence : s.atSequence > m.atSequence) {
            out[s.seat] = (out[s.seat] ?? 0) + 1;
          }
        }
        return out;
      };
      return {
        missionNumber: m.missionNumber,
        failCount: m.failCount,
        required: m.required,
        atSequence: m.atSequence,
        supportBefore: count(true),
        supportAfter: count(false),
      };
    });
}
