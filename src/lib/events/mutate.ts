/**
 * Pure add/edit/delete/cascade logic over a GameEvent[].
 *
 * No Dexie, no store, no React — so the cascade rules can be unit-tested
 * directly, which matters because getting them wrong silently corrupts a game.
 */

import type { GameEvent } from "@/lib/types/events";
import { isMissionEvent, isVoteEvent } from "@/lib/types/events";

export interface CascadePlan {
  target: GameEvent;
  /** Events that must go with it, because they'd otherwise be unrenderable. */
  dependents: GameEvent[];
  /** All ids to remove, target first. */
  ids: string[];
  /** Human-readable warning for the confirm dialog. Empty if nothing cascades. */
  description: string;
}

/**
 * Work out what deleting an event drags with it.
 *
 * The rules, and why:
 *   opinion / text → nothing. Deleting the latest rating simply makes the
 *                    previous one current again; deleting the only one returns
 *                    the pair to "never expressed" (null, NOT 3).
 *   mission        → nothing. Its proposal reverts to `passed`.
 *   vote           → the mission on the same proposal, but only if no other
 *                    vote remains to justify it. Otherwise the mission would be
 *                    hanging off a proposal that never passed.
 *   proposal       → its votes and their missions. An orphan vote cannot be
 *                    rendered in a timeline that groups by proposal.
 */
export function collectCascade(
  events: GameEvent[],
  id: string,
): CascadePlan | null {
  const target = events.find((e) => e.id === id);
  if (!target) return null;

  const dependents: GameEvent[] = [];

  if (target.type === "proposal") {
    for (const event of events) {
      if (isVoteEvent(event) && event.proposalId === target.id) {
        dependents.push(event);
      } else if (isMissionEvent(event) && event.proposalId === target.id) {
        dependents.push(event);
      }
    }
  } else if (isVoteEvent(target)) {
    const otherVoteRemains = events.some(
      (e) => isVoteEvent(e) && e.proposalId === target.proposalId && e.id !== id,
    );
    if (!otherVoteRemains) {
      for (const event of events) {
        if (isMissionEvent(event) && event.proposalId === target.proposalId) {
          dependents.push(event);
        }
      }
    }
  }

  const voteCount = dependents.filter(isVoteEvent).length;
  const missionCount = dependents.filter(isMissionEvent).length;
  const parts: string[] = [];
  if (voteCount > 0) parts.push(`${voteCount} 条投票记录`);
  if (missionCount > 0) parts.push(`${missionCount} 条任务结果`);

  return {
    target,
    dependents,
    ids: [target.id, ...dependents.map((d) => d.id)],
    description:
      parts.length > 0 ? `同时还会删除 ${parts.join("、")}。` : "",
  };
}

/** Remove events by id. Sequences of the survivors are left untouched. */
export function removeEvents(
  events: GameEvent[],
  ids: readonly string[],
): GameEvent[] {
  const doomed = new Set(ids);
  return events.filter((e) => !doomed.has(e.id));
}

/**
 * Re-insert events, restoring their original sequence numbers.
 *
 * This is only correct because deletion never renumbers: the restored rows slot
 * straight back into their original positions in the ordering.
 */
export function insertEvents(
  events: GameEvent[],
  restored: readonly GameEvent[],
): GameEvent[] {
  const merged = [...events, ...restored];
  merged.sort((a, b) => a.sequence - b.sequence);
  return merged;
}

/** Replace one event, keeping the array sorted by sequence. */
export function replaceEvent(
  events: GameEvent[],
  updated: GameEvent,
): GameEvent[] {
  return events.map((e) => (e.id === updated.id ? updated : e));
}

/** Next sequence number for a game. Gaps from deletions are expected and fine. */
export function nextSequence(events: readonly GameEvent[]): number {
  let max = 0;
  for (const e of events) if (e.sequence > max) max = e.sequence;
  return max + 1;
}
