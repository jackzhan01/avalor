/**
 * The side layer: which seats can still be evil.
 *
 * Enumerate every split, drop the ones the rules forbid, count what is left.
 * That is the entire algorithm — and the fact that it is this simple is the
 * point. There is no model to be wrong, no parameter to tune, no training data
 * to lack. A number out of this file is a count of possible worlds.
 */

import { evilCount } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { memoize2ByRef } from "@/lib/utils/memo";
import { applyRules, collectRules } from "./constraints";
import { enumerateHypotheses } from "./hypotheses";
import { weighHypotheses } from "./soft";
import type { SideInference } from "./types";

function computeSide(events: GameEvent[], game: GameRecord): SideInference {
  const all = enumerateHypotheses(game);
  const { surviving, eliminations } = applyRules(all, collectRules(events, game));

  const evilFrequency = new Map<string, number>();
  const evilProbability = new Map<string, number>();
  const provenEvil: string[] = [];
  const provenGood: string[] = [];

  /*
   * A contradictory log — nothing survives — is not a crash and not an
   * exception. Users mistype, and this app's whole stance is that a partly
   * wrong record is still a record. So we report the contradiction and fall
   * back to "we know nothing" rather than dividing by zero or, worse,
   * inventing a frequency.
   */
  const contradictory = surviving.length === 0;

  if (!contradictory) {
    const weights = weighHypotheses(surviving, events, game);
    for (const player of game.players) {
      let count = 0;
      let weighted = 0;
      for (let i = 0; i < surviving.length; i++) {
        if (surviving[i].isEvil(player.id)) {
          count += 1;
          weighted += weights[i];
        }
      }
      evilFrequency.set(player.id, count / surviving.length);
      // True in every surviving world, or none. These are the only two claims
      // this layer will make as fact — and note they are read off the COUNT,
      // never the weights, so no behavioural assumption can manufacture one.
      const provenAll = count === surviving.length;
      const provenNone = count === 0;
      if (provenAll) provenEvil.push(player.id);
      else if (provenNone) provenGood.push(player.id);
      // Summing normalised weights leaves float dust — a seat evil in every
      // surviving world lands on 0.9999999999999999. Snapped at the source
      // rather than at the point of display, so every consumer sees the exact
      // value the mathematics demands and `=== 1` keeps working downstream.
      evilProbability.set(
        player.id,
        provenAll ? 1 : provenNone ? 0 : weighted,
      );
    }
  } else {
    for (const player of game.players) {
      evilFrequency.set(player.id, 0);
      evilProbability.set(player.id, 0);
    }
  }

  return {
    surviving,
    total: all.length,
    evilFrequency,
    evilProbability,
    eliminations,
    provenEvil,
    provenGood,
    // Uniform over survivors, so entropy is just log2 of the count.
    entropyBits: contradictory ? 0 : Math.log2(surviving.length),
    contradictory,
  };
}

export const deriveSideInference = memoize2ByRef(computeSide);

/**
 * The starting entropy for this table — what you know before anything happens.
 *
 * Useful as a denominator: "you have narrowed it down by 3.8 of the 6.4 bits
 * this table started with" is far more meaningful than a raw count.
 */
export function initialEntropyBits(game: GameRecord): number {
  const n = game.playerCount;
  const k = evilCount(n);
  let combinations = 1;
  for (let i = 0; i < k; i++) combinations = (combinations * (n - i)) / (i + 1);
  return Math.log2(Math.round(combinations));
}
