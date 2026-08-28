/**
 * Compact private memory: what a seat is allowed to carry between decisions.
 *
 * The constraint that shapes this file is that we do NOT store raw hidden
 * reasoning. A model is asked for beliefs, intentions and commitments it is
 * willing to state, and only those are kept — which means a run can be
 * audited, diffed and replayed, and nobody has to argue about whether some
 * unlogged chain of thought explains a result.
 *
 * The second constraint is size. Memory is rebuilt into every future request,
 * so an unbounded note field is a slow leak straight into the input-token
 * ceiling. Everything here is capped.
 */

import type { Belief, PrivateMemory, PrivateMemoryPatch, Seat } from "../core/types";

/** Nine other seats is the most a belief list can usefully hold. */
export const MAX_BELIEFS = 9;
export const MAX_NOTE_CHARS = 120;
export const MAX_INTENTIONS = 3;
export const MAX_COMMITMENTS = 5;

function clampText(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit).join("");
}

/**
 * Bring a proposed patch inside the caps.
 *
 * Truncating a private NOTE is fine — it is this seat's own scratch, nobody
 * else reads it and nothing downstream depends on its exact bytes. That is the
 * opposite of a public speech, which is rejected rather than clipped, because
 * a clipped speech is a different speech and the transcript is the experiment.
 */
export function normalisePatch(patch: PrivateMemoryPatch): PrivateMemoryPatch {
  const out: {
    beliefs?: Belief[];
    intentions?: string[];
    commitments?: string[];
  } = {};

  if (patch.beliefs) {
    const seen = new Set<Seat>();
    const beliefs: Belief[] = [];
    for (const belief of patch.beliefs) {
      if (seen.has(belief.seat)) continue;
      seen.add(belief.seat);
      beliefs.push({
        seat: belief.seat,
        pEvil: Math.min(1, Math.max(0, belief.pEvil)),
        note: clampText(belief.note ?? "", MAX_NOTE_CHARS),
      });
      if (beliefs.length >= MAX_BELIEFS) break;
    }
    out.beliefs = beliefs;
  }

  if (patch.intentions) {
    out.intentions = patch.intentions
      .slice(0, MAX_INTENTIONS)
      .map((line) => clampText(line, MAX_NOTE_CHARS));
  }
  if (patch.commitments) {
    out.commitments = patch.commitments
      .slice(0, MAX_COMMITMENTS)
      .map((line) => clampText(line, MAX_NOTE_CHARS));
  }

  return out;
}

/** Set or replace one seat's entry, leaving the rest of the memory alone. */
export function withBelief(
  memory: PrivateMemory,
  belief: Belief,
): PrivateMemoryPatch {
  const others = memory.beliefs.filter((b) => b.seat !== belief.seat);
  return normalisePatch({ beliefs: [...others, belief] });
}
