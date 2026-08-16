import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import type {
  PlayerProposalHistory,
  ProposalRecord,
  ProposalState,
} from "@/lib/types/derived";
import { memoize2Keyed } from "@/lib/utils/memo";
import { deriveTimeline } from "./derive-timeline";

/**
 * The proposal the game is currently sitting on: the one awaiting a vote, or —
 * once a vote has passed — the one awaiting its mission result. Null during
 * open discussion.
 */
export function getCurrentProposal(
  events: GameEvent[],
  game: GameRecord,
): ProposalState | null {
  const timeline = deriveTimeline(events, game);
  if (!timeline.activeProposalId) return null;
  return timeline.proposalsById.get(timeline.activeProposalId) ?? null;
}

export function getProposalsInOrder(
  events: GameEvent[],
  game: GameRecord,
): ProposalState[] {
  const timeline = deriveTimeline(events, game);
  return timeline.proposalOrder
    .map((id) => timeline.proposalsById.get(id))
    .filter((p): p is ProposalState => p != null);
}

function toRecord(proposal: ProposalState): ProposalRecord {
  return {
    proposalEventId: proposal.event.id,
    missionNumber: proposal.missionNumber,
    proposalNumber: proposal.proposalNumber,
    leaderId: proposal.event.leaderId,
    teamPlayerIds: proposal.event.teamPlayerIds,
    status: proposal.status,
    sequence: proposal.event.sequence,
  };
}

/** Counts only — how often they led and were included. No trust scoring. */
export const getPlayerProposalHistory = memoize2Keyed(
  (
    events: GameEvent[],
    game: GameRecord,
    playerId: string,
  ): PlayerProposalHistory => {
    const asLeader: ProposalRecord[] = [];
    const asMember: ProposalRecord[] = [];
    let passed = 0;
    let rejected = 0;

    for (const proposal of getProposalsInOrder(events, game)) {
      const record = toRecord(proposal);
      if (proposal.event.leaderId === playerId) {
        asLeader.push(record);
        if (proposal.status === "rejected") rejected += 1;
        else if (
          proposal.status === "passed" ||
          proposal.status === "mission_completed"
        )
          passed += 1;
      }
      if (proposal.event.teamPlayerIds.includes(playerId)) {
        asMember.push(record);
      }
    }

    return {
      asLeader,
      asMember,
      timesLed: asLeader.length,
      timesIncluded: asMember.length,
      asLeaderOutcome: { passed, rejected },
    };
  },
);
