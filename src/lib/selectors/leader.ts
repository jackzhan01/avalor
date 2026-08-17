import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import type { LeaderSource } from "@/lib/types/derived";
import { deriveTimeline, nextSeatAfter } from "./derive-timeline";

/**
 * Who is the 车主 right now.
 *
 * Anchored on the last observed fact, never computed as
 * (firstLeader + proposalCount) % playerCount — a modulo counter desynchronises
 * permanently the first time a user manually overrides a leader, and it can
 * never recover. See leader.test.ts for the regression that catches this.
 */
export function getCurrentLeader(
  events: GameEvent[],
  game: GameRecord,
): { playerId: string | null; source: LeaderSource } {
  const timeline = deriveTimeline(events, game);
  return { playerId: timeline.currentLeaderId, source: timeline.leaderSource };
}

/** Default selection for the proposal builder. Always overridable by the user. */
export function getSuggestedLeader(
  events: GameEvent[],
  game: GameRecord,
): string | null {
  return deriveTimeline(events, game).currentLeaderId;
}

export { nextSeatAfter };
