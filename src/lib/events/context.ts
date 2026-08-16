/**
 * Reconciliation for the denormalized mission/proposal numbers on each event.
 *
 * Those fields are a CACHE of a derived value. Editing a vote's finalResult, or
 * deleting a proposal, retroactively changes which mission every later event
 * belongs to. This pass re-derives the truth and rewrites only the rows that
 * actually moved, so the stored context can never drift from the log.
 *
 * Runs after every edit and every delete. Appends don't need it — the factory
 * already stamped the right numbers.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";

export interface ContextReconciliation {
  /** The full log with corrected context. New array identity if anything moved. */
  events: GameEvent[];
  /** Only the rows that changed, for a minimal bulkPut. */
  changed: GameEvent[];
}

export function assignContext(
  events: GameEvent[],
  game: GameRecord,
): ContextReconciliation {
  const timeline = deriveTimeline(events, game);
  const changed: GameEvent[] = [];

  const next = events.map((event) => {
    const ctx = timeline.eventContext.get(event.id);
    if (!ctx) return event;
    if (
      event.missionNumber === ctx.missionNumber &&
      event.proposalNumber === ctx.proposalNumber
    ) {
      return event;
    }
    const updated = {
      ...event,
      missionNumber: ctx.missionNumber,
      proposalNumber: ctx.proposalNumber,
    } as GameEvent;
    changed.push(updated);
    return updated;
  });

  return { events: changed.length > 0 ? next : events, changed };
}
