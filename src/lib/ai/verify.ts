/**
 * Checking the model's homework against arithmetic.
 *
 * The model is handed a briefing that states, in bold, which seats are proven
 * good and which are proven evil. It still occasionally contradicts them —
 * that is simply what language models do, and no amount of prompt firmness
 * fixes it reliably. What DOES fix it is that we can check: the inference
 * layer's proofs are derived from the rules, so any analysis disagreeing with
 * one is wrong, and provably so, with no judgement call involved.
 *
 * This exists because of a specific observed failure. In a live test from the
 * assassin's seat, the model wrote a key point about "4号更像被带节奏的好人" —
 * where 4 was the user themselves. Prompt wording reduced that; only a checker
 * can catch it.
 *
 * Deliberately NARROW. It flags only what can be decided mechanically:
 * contradicting a proof, naming a seat that does not exist, analysing the user
 * as though they were a suspect. It does not attempt to referee reasoning —
 * an unconvincing argument is not a defect this layer can adjudicate, and
 * pretending otherwise would make it noisy enough to ignore.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { deriveSideInference } from "@/lib/inference";
import { seatOf } from "@/lib/format/labels";
import { readTone, type AnalysisResult } from "./types";

export interface Contradiction {
  /** Seat the problem is about, when there is one. */
  seat?: number;
  /** What the model said. */
  claim: string;
  /** Why that cannot be true. */
  because: string;
}

/**
 * Everything mechanically wrong with an analysis, or an empty array.
 *
 * Returned rather than thrown, and never used to reject the response: a
 * partly-wrong analysis with its errors marked is more useful at a table than
 * an error message, and the user is perfectly able to discount one flagged row.
 */
export function verifyAnalysis(
  result: AnalysisResult,
  game: GameRecord,
  events: GameEvent[],
): Contradiction[] {
  const side = deriveSideInference(events, game);
  if (side.contradictory) return []; // nothing to check against

  const provenEvil = new Set(
    side.provenEvil.map((id) => seatOf(game, id)).filter((s): s is number => s != null),
  );
  const provenGood = new Set(
    side.provenGood.map((id) => seatOf(game, id)).filter((s): s is number => s != null),
  );
  const viewerSeat = game.viewerPlayerId
    ? seatOf(game, game.viewerPlayerId)
    : null;
  const realSeats = new Set(game.players.map((p) => p.seat));

  const out: Contradiction[] = [];

  for (const row of result.seats) {
    if (!realSeats.has(row.seat)) {
      out.push({
        seat: row.seat,
        claim: `${row.seat}号`,
        because: `这局只有 ${game.playerCount} 个人，没有 ${row.seat}号`,
      });
      continue;
    }

    const tone = readTone(row.read);

    // At most one finding per seat, most severe first. Two complaints about
    // the same row read as noise and get the whole panel ignored — and when
    // the model calls the user themselves evil, both rules below fire.
    if (tone === "evil" && provenGood.has(row.seat)) {
      out.push({
        seat: row.seat,
        claim: `说 ${row.seat}号 是「${row.read}」`,
        because: "但排除法已经证明他是好人",
      });
      continue;
    }
    if (tone === "good" && provenEvil.has(row.seat)) {
      out.push({
        seat: row.seat,
        claim: `说 ${row.seat}号 是「${row.read}」`,
        because: "但排除法已经证明他是坏人",
      });
      continue;
    }
    // The user knows their own role; treating them as a suspect is wasted
    // output at best and actively confusing at worst.
    if (
      viewerSeat !== null &&
      row.seat === viewerSeat &&
      tone !== "self" &&
      tone !== "neutral"
    ) {
      out.push({
        seat: row.seat,
        claim: `把 ${row.seat}号（你自己）当成了分析对象`,
        because: "你自己的身份是已知的，不需要推断",
      });
    }
  }

  return out;
}

/**
 * Whether a proven seat is missing from the analysis entirely.
 *
 * Not a contradiction, so it is kept separate: a model that simply omits the
 * one seat we can prove is evil has produced a technically-consistent but
 * much less useful answer, and that is worth surfacing quietly rather than as
 * an error.
 */
export function missingProvenSeats(
  result: AnalysisResult,
  game: GameRecord,
  events: GameEvent[],
): number[] {
  const side = deriveSideInference(events, game);
  if (side.contradictory) return [];
  const covered = new Set(result.seats.map((r) => r.seat));
  return [...side.provenEvil, ...side.provenGood]
    .map((id) => seatOf(game, id))
    .filter((s): s is number => s != null && !covered.has(s))
    .sort((a, b) => a - b);
}
