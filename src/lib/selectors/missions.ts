import type { GameEvent, TextEvent } from "@/lib/types/events";
import { isTextEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import type {
  MissionSummary,
  PlayerMissionParticipation,
} from "@/lib/types/derived";
import { memoize2Keyed, memoizeKeyed } from "@/lib/utils/memo";
import { deriveTimeline } from "./derive-timeline";

/** Always length 5, one entry per mission, including ones not played yet. */
export function getMissionSummaries(
  events: GameEvent[],
  game: GameRecord,
): MissionSummary[] {
  return deriveTimeline(events, game).missions;
}

/** Only the missions that actually have a recorded result. */
export function getMissionResults(
  events: GameEvent[],
  game: GameRecord,
): MissionSummary[] {
  return getMissionSummaries(events, game).filter((m) => m.result !== null);
}

export function getScore(
  events: GameEvent[],
  game: GameRecord,
): { good: number; evil: number } {
  const timeline = deriveTimeline(events, game);
  return { good: timeline.successCount, evil: timeline.failCount };
}

/** Which missions this player actually went on, per the mission snapshots. */
export const getPlayerMissionParticipation = memoize2Keyed(
  (
    events: GameEvent[],
    game: GameRecord,
    playerId: string,
  ): PlayerMissionParticipation[] => {
    const out: PlayerMissionParticipation[] = [];
    for (const mission of getMissionSummaries(events, game)) {
      if (mission.result === null || !mission.teamPlayerIds) continue;
      if (!mission.teamPlayerIds.includes(playerId)) continue;
      out.push({
        missionNumber: mission.missionNumber,
        result: mission.result,
        failCount: mission.failCount,
      });
    }
    return out;
  },
);

/** Free-text notes attached to a player. */
export const getPlayerNotes = memoizeKeyed(
  (events: GameEvent[], playerId: string): TextEvent[] =>
    events.filter((e): e is TextEvent => isTextEvent(e) && e.playerId === playerId),
);

export const getAllNotes = (events: GameEvent[]): TextEvent[] =>
  events.filter(isTextEvent);
