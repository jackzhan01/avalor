import type { EventDraft, GameEvent } from "@/lib/types/events";
import { newId } from "@/lib/utils/id";

export interface EventContextInput {
  gameId: string;
  sequence: number;
  missionNumber: number;
  proposalNumber: number;
}

/**
 * Stamp a draft into a full event.
 *
 * The mission/proposal numbers passed in come from `deriveTimeline`, so an
 * appended event is correct by construction — only edits and deletes need the
 * later `assignContext()` reconciliation pass.
 */
export function createEvent(
  draft: EventDraft,
  ctx: EventContextInput,
): GameEvent {
  return {
    id: newId(),
    gameId: ctx.gameId,
    sequence: ctx.sequence,
    timestamp: new Date().toISOString(),
    missionNumber: ctx.missionNumber,
    proposalNumber: ctx.proposalNumber,
    ...draft,
  } as GameEvent;
}
