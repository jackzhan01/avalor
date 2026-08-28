import { describe, expect, it } from "vitest";
import {
  buildSpeakingOrder,
  directionForLadySide,
  isSeat,
  ladyHolderForSide,
  leftNeighbor,
  nextSeat,
  rightNeighbor,
  seatsFrom,
  seatsUntilLead,
} from "./order";
import { SEATS, type Seat } from "./types";

describe("neighbours", () => {
  it("puts your left hand on the next clockwise seat", () => {
    expect(leftNeighbor(1)).toBe(2);
    expect(leftNeighbor(5)).toBe(6);
    expect(leftNeighbor(9)).toBe(10);
  });

  it("puts your right hand on the previous one", () => {
    expect(rightNeighbor(2)).toBe(1);
    expect(rightNeighbor(5)).toBe(4);
    expect(rightNeighbor(10)).toBe(9);
  });

  it("wraps at both ends of the table", () => {
    // The only two seats where the arithmetic can be wrong without anyone
    // noticing in a normal game.
    expect(leftNeighbor(10)).toBe(1);
    expect(rightNeighbor(1)).toBe(10);
  });

  it("is a bijection: every seat is somebody's left and somebody's right", () => {
    expect(new Set(SEATS.map(leftNeighbor)).size).toBe(10);
    expect(new Set(SEATS.map(rightNeighbor)).size).toBe(10);
    for (const seat of SEATS) {
      expect(rightNeighbor(leftNeighbor(seat))).toBe(seat);
      expect(leftNeighbor(rightNeighbor(seat))).toBe(seat);
    }
  });

  it("recognises only 1..10 as seats", () => {
    expect(isSeat(1)).toBe(true);
    expect(isSeat(10)).toBe(true);
    expect(isSeat(0)).toBe(false);
    expect(isSeat(11)).toBe(false);
    expect(isSeat(3.5)).toBe(false);
    expect(isSeat("3")).toBe(false);
    expect(isSeat(null)).toBe(false);
  });
});

describe("the opening choice sets the direction", () => {
  /**
   * The inversion that is easy to get backwards and would corrupt every game
   * silently: handing the Lady to your LEFT sends play to the RIGHT.
   */
  it("sends play the opposite way from the Lady", () => {
    expect(directionForLadySide("left")).toBe("right");
    expect(directionForLadySide("right")).toBe("left");
  });

  it("gives the token to the named neighbour", () => {
    expect(ladyHolderForSide(5, "left")).toBe(6);
    expect(ladyHolderForSide(5, "right")).toBe(4);
    expect(ladyHolderForSide(10, "left")).toBe(1);
    expect(ladyHolderForSide(1, "right")).toBe(10);
  });

  it("steps the way the direction says", () => {
    expect(nextSeat(7, "left")).toBe(8);
    expect(nextSeat(7, "right")).toBe(6);
    expect(nextSeat(10, "left")).toBe(1);
    expect(nextSeat(1, "right")).toBe(10);
  });

  it("walks the whole table once, in order", () => {
    expect(seatsFrom(9, "left")).toEqual([9, 10, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seatsFrom(2, "right")).toEqual([2, 1, 10, 9, 8, 7, 6, 5, 4, 3]);
  });
});

describe("speaking order", () => {
  it("is leader, then nine others in the play direction, then the leader again", () => {
    const order = buildSpeakingOrder(3, "left");
    expect(order).toHaveLength(11);
    expect(order[0]).toEqual({ seat: 3, slot: "opening" });
    expect(order.slice(1, 10).map((t) => t.seat)).toEqual([4, 5, 6, 7, 8, 9, 10, 1, 2]);
    expect(order.slice(1, 10).every((t) => t.slot === "regular")).toBe(true);
    expect(order[10]).toEqual({ seat: 3, slot: "closing" });
  });

  it("runs the other way when the table turned the other way", () => {
    const order = buildSpeakingOrder(3, "right");
    expect(order.map((t) => t.seat)).toEqual([3, 2, 1, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("gives every seat exactly one turn and the leader two", () => {
    for (const leader of SEATS) {
      for (const direction of ["left", "right"] as const) {
        const order = buildSpeakingOrder(leader, direction);
        const counts = new Map<Seat, number>();
        for (const turn of order) counts.set(turn.seat, (counts.get(turn.seat) ?? 0) + 1);
        expect(counts.get(leader)).toBe(2);
        for (const seat of SEATS) {
          if (seat !== leader) expect(counts.get(seat)).toBe(1);
        }
      }
    }
  });
});

describe("distance to leadership", () => {
  it("is zero for the current leader", () => {
    expect(seatsUntilLead(4, 4, "left")).toBe(0);
  });

  it("counts rotations in the play direction, not seat distance", () => {
    expect(seatsUntilLead(6, 4, "left")).toBe(2);
    // The same pair of seats is nine rotations apart when play runs the other
    // way, which is exactly the number a player needs and would get wrong by
    // subtracting seat numbers.
    expect(seatsUntilLead(6, 4, "right")).toBe(8);
  });

  it("wraps", () => {
    expect(seatsUntilLead(2, 10, "left")).toBe(2);
    expect(seatsUntilLead(10, 2, "right")).toBe(2);
  });
});
