/**
 * The private layer: what the user knows or suspects about each seat.
 *
 * Deliberately its own module, mirroring the deliberate separation in the
 * event types. Nothing here describes public information, and nothing in the
 * public selectors reads from here — that boundary is what keeps the exported
 * log honest for any later analysis.
 */

import type { GameEvent, RoleMark, RoleMarkEvent } from "@/lib/types/events";
import { isRoleMarkEvent } from "@/lib/types/events";
import { memoizeByRef, memoizeKeyed } from "@/lib/utils/memo";

export interface RoleMarkState {
  mark: RoleMark;
  certainty: "known" | "guess";
  eventId: string;
  sequence: number;
  missionNumber: number;
  /** How many times this seat's mark has been changed. */
  revisionCount: number;
}

export interface DerivedPrivate {
  /** targetId → current mark. Absent = unmarked, which is not "unknown role". */
  current: Map<string, RoleMarkState>;
  /** targetId → every mark ever set, ascending. */
  history: Map<string, RoleMarkEvent[]>;
}

function computePrivate(events: GameEvent[]): DerivedPrivate {
  const history = new Map<string, RoleMarkEvent[]>();
  for (const event of events) {
    if (!isRoleMarkEvent(event)) continue;
    const chain = history.get(event.targetId);
    if (chain) chain.push(event);
    else history.set(event.targetId, [event]);
  }

  const current = new Map<string, RoleMarkState>();
  for (const [targetId, chain] of history) {
    chain.sort((a, b) => a.sequence - b.sequence);
    const latest = chain[chain.length - 1];
    // A null mark is an explicit clear, so the seat drops out of `current`
    // entirely rather than sitting there as an empty marker.
    if (latest.mark === null) continue;
    current.set(targetId, {
      mark: latest.mark,
      certainty: latest.certainty,
      eventId: latest.id,
      sequence: latest.sequence,
      missionNumber: latest.missionNumber,
      revisionCount: chain.length,
    });
  }

  return { current, history };
}

export const derivePrivate = memoizeByRef(computePrivate);

/** `null` means this seat carries no mark — not that the user thinks nothing. */
export function getRoleMark(
  events: GameEvent[],
  targetId: string,
): RoleMarkState | null {
  return derivePrivate(events).current.get(targetId) ?? null;
}

export function getRoleMarkHistory(
  events: GameEvent[],
  targetId: string,
): RoleMarkEvent[] {
  return derivePrivate(events).history.get(targetId) ?? [];
}

export function getAllRoleMarks(
  events: GameEvent[],
): ReadonlyMap<string, RoleMarkState> {
  return derivePrivate(events).current;
}

/** Seats the user is certain about, as opposed to reading. */
export const getKnownSeats = memoizeByRef((events: GameEvent[]): string[] => {
  const out: string[] = [];
  for (const [targetId, state] of derivePrivate(events).current) {
    if (state.certainty === "known") out.push(targetId);
  }
  return out;
});

export const getMarkedCount = memoizeKeyed(
  (events: GameEvent[], certainty: string): number => {
    let count = 0;
    for (const state of derivePrivate(events).current.values()) {
      if (state.certainty === certainty) count += 1;
    }
    return count;
  },
);
