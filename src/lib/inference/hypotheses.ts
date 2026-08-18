/**
 * Enumerating the hypothesis space.
 *
 * The whole approach rests on one fact: this space is tiny. A 9-player game has
 * C(9,3) = 84 ways to place the evil seats; a 10-player game has C(10,4) = 210.
 * That is small enough to enumerate exhaustively and score exactly, which is
 * why this file contains no search, no sampling and no approximation.
 *
 * It is worth being explicit about what that buys, because the published work
 * in this area reaches for heavier machinery: belief propagation is an
 * APPROXIMATE inference algorithm, needed when the graph is too large to solve
 * outright. At 210 worlds we can just compute the exact posterior — more
 * accurate than the approximation, and in under a millisecond.
 */

import { evilCount } from "@/lib/rules/avalon";
import type { GameRecord } from "@/lib/types/game";
import type { Hypothesis } from "./types";

/**
 * Every way to choose `k` evil seats out of the table.
 *
 * Returned in a stable order (seats ascending, lexicographic) so that anything
 * downstream — tests, the UI's "here are the remaining worlds" list — is
 * reproducible run to run.
 */
export function enumerateHypotheses(game: GameRecord): Hypothesis[] {
  const seats = [...game.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.id);
  const k = evilCount(game.playerCount);

  const out: Hypothesis[] = [];
  const current: string[] = [];

  function choose(start: number): void {
    if (current.length === k) {
      out.push(makeHypothesis(current));
      return;
    }
    // Stop early once too few seats remain to finish the selection.
    for (let i = start; i <= seats.length - (k - current.length); i++) {
      current.push(seats[i]);
      choose(i + 1);
      current.pop();
    }
  }

  if (k > 0 && k <= seats.length) choose(0);
  return out;
}

function makeHypothesis(evilSeats: readonly string[]): Hypothesis {
  // A Set per hypothesis costs a few hundred allocations for a whole game and
  // turns every constraint check into O(1) — the constraints run over every
  // hypothesis for every mission, so this is the hot path.
  const set = new Set(evilSeats);
  const evil = [...evilSeats];
  return {
    evil,
    isEvil: (playerId: string) => set.has(playerId),
  };
}

/** How many of `team` are evil under this hypothesis. */
export function evilOnTeam(
  hypothesis: Hypothesis,
  team: readonly string[],
): number {
  let n = 0;
  for (const playerId of team) if (hypothesis.isEvil(playerId)) n += 1;
  return n;
}
