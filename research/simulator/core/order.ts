/**
 * Table geometry: who sits where, who speaks when, who leads next.
 *
 * Seats run 1..10 CLOCKWISE. For a player facing inward that means their LEFT
 * hand points at the next clockwise seat and their RIGHT hand at the previous
 * one, so:
 *
 *     left(seat)  = seat + 1   (10 → 1)
 *     right(seat) = seat - 1   (1 → 10)
 *
 * Everything else in this file is one of those two, repeated. The repo's own
 * rotation lives in `deriveTimeline.nextSeatAfter` and is parameterised by two
 * independent direction flags because a real table can number itself one way
 * and pass the lead the other. This simulator collapses that to a single
 * `PlayDirection` decided once, at the opening, and never changed again.
 */

import { PLAYER_COUNT, type PlayDirection, type Seat, type SpeechSlot } from "./types";

function wrap(n: number): Seat {
  // JS % keeps the sign, so shift into range before taking it.
  const zeroBased = (((n - 1) % PLAYER_COUNT) + PLAYER_COUNT) % PLAYER_COUNT;
  return (zeroBased + 1) as Seat;
}

export function isSeat(value: unknown): value is Seat {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PLAYER_COUNT
  );
}

/** The next clockwise seat. Facing inward, this is the player on your left. */
export function leftNeighbor(seat: Seat): Seat {
  return wrap(seat + 1);
}

/** The previous clockwise seat. Facing inward, the player on your right. */
export function rightNeighbor(seat: Seat): Seat {
  return wrap(seat - 1);
}

/** One step in the fixed play direction. */
export function nextSeat(seat: Seat, direction: PlayDirection): Seat {
  return direction === "left" ? leftNeighbor(seat) : rightNeighbor(seat);
}

/**
 * Which way the table turns, given which neighbour the opening leader handed
 * the Lady to.
 *
 * The two are OPPOSITE by rule: giving the token to your left sends play to
 * the right, and vice versa. Encoded once, here, so no caller has to remember
 * the inversion.
 */
export function directionForLadySide(ladySide: "left" | "right"): PlayDirection {
  return ladySide === "left" ? "right" : "left";
}

/** Which neighbour receives the token at the opening. */
export function ladyHolderForSide(leader: Seat, ladySide: "left" | "right"): Seat {
  return ladySide === "left" ? leftNeighbor(leader) : rightNeighbor(leader);
}

/** Every seat starting at `from`, walking the play direction once around. */
export function seatsFrom(from: Seat, direction: PlayDirection): Seat[] {
  const out: Seat[] = [];
  let seat = from;
  for (let i = 0; i < PLAYER_COUNT; i += 1) {
    out.push(seat);
    seat = nextSeat(seat, direction);
  }
  return out;
}

/** How many leadership rotations until `seat` holds the car. 0 if it already does. */
export function seatsUntilLead(
  seat: Seat,
  leader: Seat,
  direction: PlayDirection,
): number {
  let steps = 0;
  let current = leader;
  while (current !== seat) {
    current = nextSeat(current, direction);
    steps += 1;
  }
  return steps;
}

export interface SpeechTurn {
  readonly seat: Seat;
  readonly slot: SpeechSlot;
}

/**
 * The eleven speaking turns of one proposal attempt.
 *
 * The leader opens, the other nine speak once each starting from the adjacent
 * seat in the play direction, and the leader closes. Eleven turns for ten
 * players: the leader gets two, and its two 220-character budgets are
 * independent — see `referee.ts`.
 *
 * The repo has no other notion of speaking order, deliberately: `llm-talk.ts`
 * refuses to let a later seat read an earlier one precisely because that would
 * "invent a speaking order the game does not have". This simulator does have
 * one, and this function is its only definition.
 */
export function buildSpeakingOrder(
  leader: Seat,
  direction: PlayDirection,
): SpeechTurn[] {
  const turns: SpeechTurn[] = [{ seat: leader, slot: "opening" }];
  let seat = nextSeat(leader, direction);
  for (let i = 0; i < PLAYER_COUNT - 1; i += 1) {
    turns.push({ seat, slot: "regular" });
    seat = nextSeat(seat, direction);
  }
  turns.push({ seat: leader, slot: "closing" });
  return turns;
}
