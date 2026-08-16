/**
 * Opinion derivation — kept separate from the structural fold because it
 * changes far more often and has completely disjoint consumers. Two O(n) passes
 * over ~400 events is free, and the separation keeps both readable.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: absence is not neutrality.
 *
 *   no entry  → this player never publicly said anything about that player
 *   rating 3  → this player explicitly said "看不清 / 中立"
 *
 * These are different facts and the UI renders them differently (blank cell vs
 * a "3" chip). Every accessor here returns `OpinionCell | null`, and callers
 * must never write `?? 3` or `|| 3` against one.
 */

import type { GameEvent, OpinionEvent } from "@/lib/types/events";
import { isOpinionEvent } from "@/lib/types/events";
import type {
  DerivedOpinions,
  OpinionCell,
  OpinionEdge,
} from "@/lib/types/derived";
import { memoizeByRef, memoizeKeyed } from "@/lib/utils/memo";

const pairKey = (speakerId: string, targetId: string) =>
  `${speakerId}|${targetId}`;

function computeOpinions(events: GameEvent[]): DerivedOpinions {
  const history = new Map<string, OpinionEvent[]>();

  // Pass 1: collect every revision. Nothing is ever overwritten — a 4 → 5 → 2
  // chain keeps all three, because "when did they change their mind" is the
  // whole point of the app.
  for (const event of events) {
    if (!isOpinionEvent(event)) continue;
    const key = pairKey(event.speakerId, event.targetId);
    const chain = history.get(key);
    if (chain) chain.push(event);
    else history.set(key, [event]);
  }

  // Pass 2: current state is the last link of each chain. Derived, not stored.
  const current = new Map<string, Map<string, OpinionCell>>();
  for (const chain of history.values()) {
    // Events arrive ascending by sequence, but sort defensively: an imported
    // log could be out of order, and picking the wrong "latest" is silent.
    chain.sort((a, b) => a.sequence - b.sequence);
    const latest = chain[chain.length - 1];
    const cell: OpinionCell = {
      rating: latest.rating,
      eventId: latest.id,
      sequence: latest.sequence,
      timestamp: latest.timestamp,
      missionNumber: latest.missionNumber,
      revisionCount: chain.length,
    };
    let row = current.get(latest.speakerId);
    if (!row) current.set(latest.speakerId, (row = new Map()));
    row.set(latest.targetId, cell);
  }

  return { current, history };
}

export const deriveOpinions = memoizeByRef(computeOpinions);

export function getCurrentOpinions(
  events: GameEvent[],
): ReadonlyMap<string, ReadonlyMap<string, OpinionCell>> {
  return deriveOpinions(events).current;
}

/** `null` means never expressed. It does NOT mean neutral. */
export function getCurrentOpinion(
  events: GameEvent[],
  speakerId: string,
  targetId: string,
): OpinionCell | null {
  return deriveOpinions(events).current.get(speakerId)?.get(targetId) ?? null;
}

/** Every revision of this pair, oldest first. Empty if never expressed. */
export function getOpinionHistory(
  events: GameEvent[],
  speakerId: string,
  targetId: string,
): OpinionEvent[] {
  return deriveOpinions(events).history.get(pairKey(speakerId, targetId)) ?? [];
}

/** What this player said about others, and what others said about them. */
export const getPlayerOpinions = memoizeKeyed(
  (
    events: GameEvent[],
    playerId: string,
  ): { expressed: OpinionEdge[]; received: OpinionEdge[] } => {
    const { current } = deriveOpinions(events);

    const expressed: OpinionEdge[] = [];
    const row = current.get(playerId);
    if (row) {
      for (const [targetId, cell] of row) {
        expressed.push({ speakerId: playerId, targetId, cell });
      }
    }

    const received: OpinionEdge[] = [];
    for (const [speakerId, targets] of current) {
      const cell = targets.get(playerId);
      if (cell) received.push({ speakerId, targetId: playerId, cell });
    }

    return { expressed, received };
  },
);

export const RATING_LABELS: Record<number, string> = {
  1: "强踩",
  2: "踩",
  3: "中立",
  4: "保",
  5: "强保",
};
