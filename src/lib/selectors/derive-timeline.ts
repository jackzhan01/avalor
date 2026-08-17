/**
 * THE fold. One O(n) pass over the event log produces every piece of structural
 * state the app displays: phase, the active proposal, each proposal's status,
 * mission summaries, the current leader, and which mission/proposal every event
 * belongs to.
 *
 * Pure. No React, no Dexie, no Date.now(). That is what makes it unit-testable
 * in a node environment and makes "time travel" free — slice the array and
 * re-derive.
 */

import type { GameEvent, MissionEvent, VoteEvent } from "@/lib/types/events";
import { isMissionEvent, isVoteEvent } from "@/lib/types/events";
import type { GamePhase, GameRecord } from "@/lib/types/game";
import { sortedBySeat } from "@/lib/types/game";
import type {
  DerivedTimeline,
  EventContext,
  IntegrityWarning,
  LeaderSource,
  MissionSummary,
  ProposalState,
} from "@/lib/types/derived";
import {
  MAX_PROPOSAL_ATTEMPTS,
  MISSIONS_TO_WIN,
  TOTAL_MISSIONS,
  requiredFails,
  teamSize,
} from "@/lib/rules/avalon";
import { memoize2ByRef } from "@/lib/utils/memo";

/** Mission numbers can run past 5 in a corrupted log; keep table lookups safe. */
function clampMission(n: number): number {
  return Math.min(Math.max(n, 1), TOTAL_MISSIONS);
}

function emptyMissions(game: GameRecord): MissionSummary[] {
  return Array.from({ length: TOTAL_MISSIONS }, (_, i) => {
    const missionNumber = i + 1;
    return {
      missionNumber,
      status: "upcoming" as const,
      expectedTeamSize: teamSize(game.playerCount, missionNumber),
      requiredFails: requiredFails(game.playerCount, missionNumber),
      proposalIds: [],
      passedProposalId: null,
      missionEventId: null,
      result: null,
      failCount: null,
      teamPlayerIds: null,
    };
  });
}

/**
 * A vote vector is "complete" only if every seat has an explicit approve or
 * reject. Unknown entries and absent seats both make it incomplete — which is
 * exactly why finalResult can never be inferred from the vector.
 */
function checkVoteConsistency(
  vote: VoteEvent,
  game: GameRecord,
  warnings: IntegrityWarning[],
): void {
  let approve = 0;
  let reject = 0;
  for (const player of game.players) {
    const choice = vote.votes[player.id];
    if (choice === "approve") approve++;
    else if (choice === "reject") reject++;
    else return; // incomplete — nothing to check against
  }
  const implied = approve > reject ? "passed" : "rejected";
  if (implied !== vote.finalResult) {
    warnings.push({
      kind: "vote_result_mismatch",
      eventId: vote.id,
      missionNumber: vote.missionNumber,
      message: `票型是 ${approve} 上 ${reject} 下（应为「${implied === "passed" ? "过" : "否"}」），但记录的结果是「${vote.finalResult === "passed" ? "过" : "否"}」。以记录的结果为准。`,
    });
  }
}

function checkMissionSanity(
  mission: MissionEvent,
  proposal: ProposalState,
  game: GameRecord,
  warnings: IntegrityWarning[],
): void {
  const needed = requiredFails(
    game.playerCount,
    clampMission(proposal.missionNumber),
  );

  if (mission.failCount != null) {
    if (mission.result === "fail" && mission.failCount < needed) {
      warnings.push({
        kind: "fail_count_below_required",
        eventId: mission.id,
        missionNumber: proposal.missionNumber,
        message: `第 ${proposal.missionNumber} 轮需要 ${needed} 张坏票才算失败，但记录了 ${mission.failCount} 张。`,
      });
    }
    if (mission.result === "success" && mission.failCount >= needed) {
      warnings.push({
        kind: "fail_count_below_required",
        eventId: mission.id,
        missionNumber: proposal.missionNumber,
        message: `记录为任务成功，但坏票数 ${mission.failCount} 已达到失败所需的 ${needed} 张。`,
      });
    }
  }

  // The mission's own team snapshot is authoritative for "who went"; the
  // proposal is only for grouping. A divergence usually means the proposal was
  // edited after the fact.
  const a = [...mission.teamPlayerIds].sort().join(",");
  const b = [...proposal.event.teamPlayerIds].sort().join(",");
  if (a !== b) {
    warnings.push({
      kind: "mission_team_mismatch",
      eventId: mission.id,
      missionNumber: proposal.missionNumber,
      message: "上车名单与该车记录的名单不一致，以任务记录为准。",
    });
  }
}

function computeTimeline(
  events: GameEvent[],
  game: GameRecord,
): DerivedTimeline {
  const warnings: IntegrityWarning[] = [];

  /*
   * Pre-pass: decide which vote and which mission event is authoritative for
   * each proposal (latest sequence wins). Resolving this up front means the
   * fold never has to undo a structural effect it already applied — which is
   * what makes re-recording a vote safe.
   */
  const latestVote = new Map<string, VoteEvent>();
  const latestMission = new Map<string, MissionEvent>();
  for (const e of events) {
    if (isVoteEvent(e)) {
      const prev = latestVote.get(e.proposalId);
      if (!prev || e.sequence > prev.sequence) latestVote.set(e.proposalId, e);
    } else if (isMissionEvent(e)) {
      const prev = latestMission.get(e.proposalId);
      if (!prev || e.sequence > prev.sequence)
        latestMission.set(e.proposalId, e);
    }
  }
  const authoritativeVotes = new Set(
    Array.from(latestVote.values(), (v) => v.id),
  );
  const authoritativeMissions = new Set(
    Array.from(latestMission.values(), (m) => m.id),
  );

  let missionNumber = 1;
  let proposalNumber = 1;
  let rejectionStreak = 0;
  let successCount = 0;
  let failCount = 0;

  /** Proposal recorded but not yet voted on. */
  let awaitingVoteId: string | null = null;
  /** Proposal whose vote passed but whose mission result is not in yet. */
  let awaitingMissionId: string | null = null;
  let lastVotedProposalId: string | null = null;

  const proposalsById = new Map<string, ProposalState>();
  const proposalOrder: string[] = [];
  const eventContext = new Map<string, EventContext>();
  const missions = emptyMissions(game);

  for (const e of events) {
    eventContext.set(e.id, { missionNumber, proposalNumber });

    switch (e.type) {
      case "opinion":
      case "intended_team":
      case "role_claim":
      case "role_mark":
      case "lady_assign":
      case "lady_check":
      case "text":
        // Statements: what someone SAID. A player talking cannot advance the
        // game, so these carry context and nothing else.
        break;

      case "proposal": {
        // A second proposal before any vote means the leader changed the team
        // (or the user is fixing a mis-tap). The earlier one becomes a draft
        // and the proposal number does NOT advance — no vote was ever taken.
        if (awaitingVoteId) {
          const superseded = proposalsById.get(awaitingVoteId);
          if (superseded) superseded.status = "draft";
        }
        const expected = teamSize(game.playerCount, clampMission(missionNumber));
        proposalsById.set(e.id, {
          event: e,
          status: "voting",
          missionNumber,
          proposalNumber,
          vote: null,
          mission: null,
          expectedTeamSize: expected,
          teamSizeMismatch: e.teamPlayerIds.length !== expected,
        });
        proposalOrder.push(e.id);
        const idx = missionNumber - 1;
        if (idx >= 0 && idx < TOTAL_MISSIONS) missions[idx].proposalIds.push(e.id);
        awaitingVoteId = e.id;
        break;
      }

      case "vote": {
        const proposal = proposalsById.get(e.proposalId);
        if (!proposal) {
          warnings.push({
            kind: "orphan_vote",
            eventId: e.id,
            message: "这条投票找不到对应的车，已忽略。",
          });
          break;
        }
        if (!authoritativeVotes.has(e.id)) {
          warnings.push({
            kind: "superseded_vote",
            eventId: e.id,
            message: "这辆车后来又记了一次票，以较新的为准。",
          });
          break;
        }

        proposal.vote = e;
        checkVoteConsistency(e, game, warnings);
        lastVotedProposalId = proposal.event.id;
        if (awaitingVoteId === proposal.event.id) awaitingVoteId = null;

        if (e.finalResult === "rejected") {
          proposal.status = "rejected";
          proposalNumber += 1;
          rejectionStreak += 1;
          if (rejectionStreak >= MAX_PROPOSAL_ATTEMPTS) {
            warnings.push({
              kind: "rejection_limit_reached",
              eventId: e.id,
              missionNumber: proposal.missionNumber,
              message: `第 ${proposal.missionNumber} 轮已经连挂 ${rejectionStreak} 次，按规则坏人获胜。`,
            });
          }
        } else {
          proposal.status = "passed";
          rejectionStreak = 0;
          awaitingMissionId = proposal.event.id;
        }
        break;
      }

      case "mission": {
        const proposal = proposalsById.get(e.proposalId);
        if (!proposal) {
          warnings.push({
            kind: "orphan_mission",
            eventId: e.id,
            message: "这条任务结果找不到对应的车，已忽略。",
          });
          break;
        }
        if (!authoritativeMissions.has(e.id)) {
          warnings.push({
            kind: "superseded_mission",
            eventId: e.id,
            message: "这辆车后来又记了一次任务结果，以较新的为准。",
          });
          break;
        }
        if (proposal.status !== "passed") {
          warnings.push({
            kind: "orphan_mission",
            eventId: e.id,
            message: "这辆车没有通过，任务结果已忽略。",
          });
          break;
        }

        proposal.mission = e;
        proposal.status = "mission_completed";
        checkMissionSanity(e, proposal, game, warnings);

        const idx = proposal.missionNumber - 1;
        if (idx >= 0 && idx < TOTAL_MISSIONS) {
          const summary = missions[idx];
          summary.passedProposalId = proposal.event.id;
          summary.missionEventId = e.id;
          summary.result = e.result;
          summary.failCount = e.failCount ?? null;
          summary.teamPlayerIds = e.teamPlayerIds;
        }
        if (e.result === "success") successCount += 1;
        else failCount += 1;

        if (awaitingMissionId === proposal.event.id) awaitingMissionId = null;
        missionNumber = proposal.missionNumber + 1;
        proposalNumber = 1;
        rejectionStreak = 0;
        break;
      }
    }
  }

  /*
   * Phase, stated declaratively (the fold above is just its incremental form):
   *   voting  ⟺ some proposal has no vote
   *   mission ⟺ the last proposal passed and no mission references it
   *   otherwise discussion
   */
  const phase: GamePhase = awaitingVoteId
    ? "voting"
    : awaitingMissionId
      ? "mission"
      : "discussion";
  const activeProposalId = awaitingVoteId ?? awaitingMissionId;

  /*
   * Leader: anchored on the last observed fact, never counted as
   * (firstLeader + n) % playerCount. A modulo counter desynchronises
   * permanently the first time the user overrides a leader manually.
   */
  let currentLeaderId: string | null;
  let leaderSource: LeaderSource;
  if (activeProposalId && proposalsById.has(activeProposalId)) {
    currentLeaderId = proposalsById.get(activeProposalId)!.event.leaderId;
    leaderSource = "active_proposal";
  } else if (lastVotedProposalId && proposalsById.has(lastVotedProposalId)) {
    const previous = proposalsById.get(lastVotedProposalId)!.event.leaderId;
    currentLeaderId = nextSeatAfter(game, previous);
    leaderSource = "rotation";
  } else {
    currentLeaderId = game.firstLeaderId ?? game.players[0]?.id ?? null;
    leaderSource = "initial";
  }

  let completionReason: DerivedTimeline["completionReason"] = null;
  if (successCount >= MISSIONS_TO_WIN) completionReason = "missions_good";
  else if (failCount >= MISSIONS_TO_WIN) completionReason = "missions_evil";
  else if (rejectionStreak >= MAX_PROPOSAL_ATTEMPTS)
    completionReason = "rejection_limit";
  else if (game.status === "completed") completionReason = "manual";
  const isComplete = completionReason !== null;

  for (let i = 0; i < TOTAL_MISSIONS; i++) {
    const summary = missions[i];
    if (summary.result !== null) summary.status = "completed";
    else if (i + 1 === missionNumber && !isComplete) summary.status = "in_progress";
    else summary.status = "upcoming";
  }

  return {
    phase,
    isComplete,
    completionReason,
    missionNumber,
    proposalNumber,
    activeProposalId,
    proposalsById,
    proposalOrder,
    missions,
    currentLeaderId,
    leaderSource,
    rejectionStreak,
    successCount,
    failCount,
    eventContext,
    warnings,
  };
}

/**
 * The seat that takes the lead next, wrapping around the table.
 *
 * The step is +1 or -1 in seat numbers depending on how the two directions
 * relate: a table can number itself one way and pass the lead the other, so
 * "the lead moves clockwise" only means "seat + 1" when the numbers also run
 * clockwise.
 */
export function nextSeatAfter(
  game: GameRecord,
  playerId: string,
): string | null {
  const ordered = sortedBySeat(game.players);
  if (ordered.length === 0) return null;
  const index = ordered.findIndex((p) => p.id === playerId);
  if (index === -1) return ordered[0].id;

  const seatDirection = game.seatDirection ?? "cw";
  const leaderDirection = game.leaderDirection ?? "cw";
  const step = leaderDirection === seatDirection ? 1 : -1;
  const n = ordered.length;
  return ordered[(index + step + n) % n].id;
}

export const deriveTimeline = memoize2ByRef(computeTimeline);
