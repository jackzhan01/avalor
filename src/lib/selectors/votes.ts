import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import type { PlayerVoteHistory, PlayerVoteRecord } from "@/lib/types/derived";
import { memoize2Keyed } from "@/lib/utils/memo";
import { deriveTimeline } from "./derive-timeline";
import { getProposalsInOrder } from "./proposals";

/**
 * One row per proposal this player could have voted on.
 *
 * Note the two distinct "no data" cases, which must stay distinct:
 *   vote: "unknown" → recorded, but the user didn't catch how they voted
 *   vote: null      → this seat is absent from the votes map entirely
 */
export const getPlayerVoteHistory = memoize2Keyed(
  (
    events: GameEvent[],
    game: GameRecord,
    playerId: string,
  ): PlayerVoteHistory => {
    const records: PlayerVoteRecord[] = [];
    const tally = { approve: 0, reject: 0, unknown: 0, unrecorded: 0 };

    for (const proposal of getProposalsInOrder(events, game)) {
      const vote = proposal.vote;
      if (!vote) continue;

      const choice = Object.prototype.hasOwnProperty.call(vote.votes, playerId)
        ? vote.votes[playerId]
        : null;

      if (choice === "approve") tally.approve += 1;
      else if (choice === "reject") tally.reject += 1;
      else if (choice === "unknown") tally.unknown += 1;
      else tally.unrecorded += 1;

      records.push({
        voteEventId: vote.id,
        proposalEventId: proposal.event.id,
        missionNumber: proposal.missionNumber,
        proposalNumber: proposal.proposalNumber,
        vote: choice,
        finalResult: vote.finalResult,
        wasOnTeam: proposal.event.teamPlayerIds.includes(playerId),
        leaderId: proposal.event.leaderId,
        teamPlayerIds: proposal.event.teamPlayerIds,
        sequence: vote.sequence,
        timestamp: vote.timestamp,
      });
    }

    return { records, tally };
  },
);

/** Seat-level tallies for one vote. Never stored — always recomputed. */
export function summarizeVote(
  votes: Record<string, "approve" | "reject" | "unknown">,
  game: GameRecord,
): { approve: string[]; reject: string[]; unknown: string[]; unrecorded: string[] } {
  const approve: string[] = [];
  const reject: string[] = [];
  const unknown: string[] = [];
  const unrecorded: string[] = [];
  for (const player of game.players) {
    const choice = Object.prototype.hasOwnProperty.call(votes, player.id)
      ? votes[player.id]
      : null;
    if (choice === "approve") approve.push(player.id);
    else if (choice === "reject") reject.push(player.id);
    else if (choice === "unknown") unknown.push(player.id);
    else unrecorded.push(player.id);
  }
  return { approve, reject, unknown, unrecorded };
}

export function getVoteWarnings(events: GameEvent[], game: GameRecord) {
  return deriveTimeline(events, game).warnings.filter(
    (w) => w.kind === "vote_result_mismatch" || w.kind === "orphan_vote",
  );
}
