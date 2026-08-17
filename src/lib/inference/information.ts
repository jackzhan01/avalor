/**
 * What a question is worth before you ask it.
 *
 * The rest of this module answers "what do I believe". This one answers "what
 * should I look at next" — the information-theoretic half of the CSP4SDG
 * approach, which the constraint half here already mirrors. It is the piece
 * that turns a belief state into advice about a decision.
 *
 * The decision it serves is 湖中女神. Whoever holds the token picks one seat and
 * learns their side for certain, three times a game, and the choice is usually
 * made badly for a reason that is worth naming: people check whoever they
 * suspect most. That is close to the worst seat to spend a check on. A seat you
 * are 85% sure about has little left to tell you; the check almost always says
 * what you expected and the board barely moves.
 *
 * The arithmetic makes this exact. A check is a deterministic function of the
 * hidden assignment, so the expected reduction in entropy from checking a seat
 * is the entropy of your current belief about that seat, and nothing else:
 *
 *     EIG(seat) = H_b(P(seat is evil))
 *
 * where H_b is the binary entropy function, maximised at exactly one bit when
 * P = 0.5. Every term about the rest of the table cancels. So:
 *
 *   **验你最拿不准的那个人，不是你最怀疑的那个人。**
 *
 * WHAT THIS DOES NOT MODEL, and the caller must not pretend otherwise:
 *
 *   - Only the information. Checking to publicly clear a seat before it leads,
 *     or to bait a reaction, are real reasons this cannot see.
 *   - Only a check you make yourself. The token passes to whoever you check,
 *     and what THEY announce publicly may be a lie; the value of that
 *     announcement depends on whether they can be believed, which is a belief
 *     about them, not a property of the check.
 *   - Only one step. It does not look ahead to who receives the token next.
 */

import type { Hypothesis } from "./types";

export interface CheckValue {
  playerId: string;
  /** Posterior probability this seat is evil, from the same weights the UI shows. */
  pEvil: number;
  /**
   * Expected bits of uncertainty removed by checking this seat, in [0, 1].
   * One bit is the most a yes/no answer can ever be worth.
   */
  bits: number;
}

/** Binary entropy in bits. 0 at certainty either way, 1 at a coin flip. */
export function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/**
 * Ranks candidate seats by how much a check would tell you, best first.
 *
 * `weights` must align with `surviving` — pass what `weighHypotheses` returned
 * for the same array, or an empty array to weight every world equally.
 *
 * Ties break on seat order via the candidate order given, so the output is
 * reproducible rather than depending on Map iteration.
 */
export function rankChecks(
  surviving: readonly Hypothesis[],
  weights: readonly number[],
  candidates: readonly string[],
): CheckValue[] {
  if (surviving.length === 0 || candidates.length === 0) return [];

  const uniform = weights.length !== surviving.length;
  const weightAt = (i: number) => (uniform ? 1 / surviving.length : weights[i]);

  const values = candidates.map((playerId) => {
    let pEvil = 0;
    for (let i = 0; i < surviving.length; i++) {
      if (surviving[i].isEvil(playerId)) pEvil += weightAt(i);
    }
    return { playerId, pEvil, bits: binaryEntropy(pEvil) };
  });

  // Stable: equal bits keep the caller's ordering, which is seat order.
  return values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value.bits - a.value.bits || a.index - b.index)
    .map((entry) => entry.value);
}

/**
 * The one-line reason, in the vernacular, for why this seat is or is not worth
 * a check. Separated from the arithmetic so the wording can change without
 * anyone touching a probability.
 */
export function explainCheck(value: CheckValue): string {
  if (value.bits >= 0.97) return "完全拿不准 —— 验他收获最大";
  if (value.bits >= 0.8) return "心里没底，验他很有价值";
  if (value.bits >= 0.4) return "有点倾向了，验他还有些收获";
  if (value.pEvil >= 0.5) return "已经挺确定他是坏人了，验他基本白验";
  return "已经挺确定他是好人了，验他基本白验";
}
