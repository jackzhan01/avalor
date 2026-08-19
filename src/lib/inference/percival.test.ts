import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { percivalEvidence } from "./percival";

/**
 * The pair Percival sees is UNORDERED. A casting that swaps Merlin and Morgana
 * between those two seats is, to him, the same observation — so it must carry
 * the same evidence. Any preference between the two has to come from public
 * behaviour scored elsewhere, never from his private sighting.
 */
describe("Percival's pair is symmetric", () => {
  const { game: g, events } = game(9)
    .proposal(1, [1, 2, 3])
    .vote({ 4: "reject", 5: "approve", 6: "reject" }, "rejected")
    .proposal(2, [1, 4, 5])
    .vote({ 2: "approve", 3: "reject", 6: "approve" }, "passed")
    .mission("success")
    .build();

  // Pair evidence does not depend on which world we are in — how many of a
  // pair rode a car is a fact about the car.
  const evidence = percivalEvidence(events, g);

  it("gives one entry per unordered pair, not per ordered one", () => {
    const forward = evidence.get("p1")?.get("p2");
    const reversed = evidence.get("p2")?.get("p1");
    expect(forward).toBeDefined();
    // The SAME object, not merely an equal one: both orders are the same
    // observation to him, so the symmetry is structural rather than checked.
    expect(reversed).toBe(forward);
  });

  it("scores a seat identically whichever way round the pair is read", () => {
    const pair = evidence.get("p1")!.get("p2")!;
    for (const [seat, value] of pair) {
      expect(Number.isFinite(value)).toBe(true);
      expect(evidence.get("p2")!.get("p1")!.get(seat)).toBe(value);
    }
  });

  it("never scores a candidate as Percival — he is not one of the two", () => {
    const pair = evidence.get("p1")!.get("p2")!;
    expect(pair.has("p1")).toBe(false);
    expect(pair.has("p2")).toBe(false);
  });

  it("moves a seat that voted, and leaves an unrecorded seat at zero", () => {
    const pair = evidence.get("p1")!.get("p2")!;
    // p4 voted from off the car in mission 1; p9 never voted at all.
    expect(pair.get("p4")).not.toBe(0);
    expect(pair.get("p9")).toBe(0);
  });
});
