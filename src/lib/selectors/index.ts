/**
 * The selector barrel. Components import from here and nowhere deeper — that
 * keeps the derivation layer swappable and keeps Dexie out of the render path.
 */

export { deriveTimeline, nextSeatAfter } from "./derive-timeline";
export {
  deriveOpinions,
  getCurrentOpinions,
  getCurrentOpinion,
  getOpinionHistory,
  getPlayerOpinions,
  RATING_LABELS,
} from "./opinions";
export {
  getCurrentProposal,
  getProposalsInOrder,
  getPlayerProposalHistory,
} from "./proposals";
export { getPlayerVoteHistory, summarizeVote, getVoteWarnings } from "./votes";
export {
  getMissionSummaries,
  getMissionResults,
  getScore,
  getPlayerMissionParticipation,
  getPlayerNotes,
  getAllNotes,
} from "./missions";
export { getCurrentLeader, getSuggestedLeader } from "./leader";
export {
  getIntegrityWarnings,
  getWarningsForEvent,
  validateRoleSet,
} from "./integrity";

import type { GameEvent } from "@/lib/types/events";
import type { GamePhase, GameRecord } from "@/lib/types/game";
import { deriveTimeline } from "./derive-timeline";

export function getGamePhase(
  events: GameEvent[],
  game: GameRecord,
): GamePhase {
  return deriveTimeline(events, game).phase;
}

/**
 * What the primary CTA should offer. GamePhase has no terminal member by
 * design, so "the game is over" is resolved here, at the render boundary.
 */
export type CtaMode = GamePhase | "complete";

export function getCtaMode(events: GameEvent[], game: GameRecord): CtaMode {
  const timeline = deriveTimeline(events, game);
  return timeline.isComplete ? "complete" : timeline.phase;
}
