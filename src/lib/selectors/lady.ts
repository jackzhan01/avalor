/**
 * 湖中女神.
 *
 * The token starts with whoever the first 车主 hands it to, and after missions
 * 2, 3 and 4 its holder looks at one player's loyalty and says something about
 * it out loud. The token then moves to the player who was examined, and nobody
 * who has already held it can be examined again — which is why the chain of
 * past holders matters as much as the current one.
 *
 * Only the ANNOUNCEMENT lives here. What the holder actually saw is private to
 * them; if that holder is the user, it belongs in the private layer instead.
 */

import type { GameEvent, LadyCheckEvent } from "@/lib/types/events";
import { isLadyAssignEvent, isLadyCheckEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { memoize2ByRef } from "@/lib/utils/memo";
import { deriveTimeline } from "./derive-timeline";

/** Used after missions 2, 3 and 4 — three times in a full game. */
export const MAX_LADY_CHECKS = 3;

export interface LadyState {
  enabled: boolean;
  /** Who holds the token now. null when it has never been assigned. */
  holderId: string | null;
  /** Everyone who has ever held it, oldest first. None may be examined again. */
  heldBy: string[];
  checks: LadyCheckEvent[];
  /** How many checks the rules expect to have happened by now. */
  expected: number;
  /** A check is owed and hasn't been recorded. */
  due: boolean;
  /** Seats that may still be examined: not a past holder, not the holder. */
  examinable: string[];
}

function computeLady(events: GameEvent[], game: GameRecord): LadyState {
  const enabled = game.ladyEnabled === true;

  let holderId: string | null = null;
  const heldBy: string[] = [];
  const checks: LadyCheckEvent[] = [];

  for (const event of events) {
    if (isLadyAssignEvent(event)) {
      // Re-assigning replaces the opening hand-off rather than adding to the
      // chain: it is a correction, not the token changing hands.
      holderId = event.holderId;
      heldBy.length = 0;
      heldBy.push(event.holderId);
      checks.length = 0;
    } else if (isLadyCheckEvent(event)) {
      checks.push(event);
      holderId = event.targetId;
      if (!heldBy.includes(event.targetId)) heldBy.push(event.targetId);
    }
  }

  const completedMissions = deriveTimeline(events, game).missions.filter(
    (m) => m.result !== null,
  ).length;
  // One check after each of missions 2, 3 and 4.
  const expected = Math.min(
    Math.max(completedMissions - 1, 0),
    MAX_LADY_CHECKS,
  );

  const examinable = enabled
    ? game.players
        .map((p) => p.id)
        .filter((id) => id !== holderId && !heldBy.includes(id))
    : [];

  return {
    enabled,
    holderId,
    heldBy,
    checks,
    expected,
    due: enabled && holderId !== null && checks.length < expected,
    examinable,
  };
}

export const deriveLady = memoize2ByRef(computeLady);

export function getLadyHolder(
  events: GameEvent[],
  game: GameRecord,
): string | null {
  return deriveLady(events, game).holderId;
}

/** True when the game has the token but nobody has been given it yet. */
export function ladyNeedsAssigning(
  events: GameEvent[],
  game: GameRecord,
): boolean {
  const lady = deriveLady(events, game);
  return lady.enabled && lady.holderId === null;
}
