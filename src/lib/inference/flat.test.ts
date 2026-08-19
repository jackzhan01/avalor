import { describe, expect, it } from "vitest";
import { explainFlatRole, flatReasonText } from "./display";
import { deriveRoleInference } from "./roles";
import { deriveSideInference } from "./side";
import { game } from "@/lib/fixtures/builder";
import type { GameRecord } from "@/lib/types/game";

/**
 * A flat role read is a real answer, but "17% each" alone leaves the user
 * unable to tell a broken feature from an honest "cannot say". These lock in
 * which kind of nothing it is — the case that prompted them being a round-four
 * game where every car had carried an evil, so Merlin had never had a clean
 * car to wave through.
 */

const base = () =>
  game(9)
    .mark(5, { kind: "side", side: "evil" }, "known")
    .mark(6, { kind: "side", side: "evil" }, "known");
const asEvil = (g: GameRecord): GameRecord => ({
  ...g,
  viewerPlayerId: "p1",
  viewerRole: "assassin",
});

function reason(build: ReturnType<typeof game>) {
  const { game: g, events } = build.build();
  const withRole = asEvil(g);
  return explainFlatRole(
    deriveRoleInference(events, withRole),
    deriveSideInference(events, withRole),
    events,
    withRole,
    "merlin",
  );
}

describe("why the role read is still flat", () => {
  it("names the missing votes when none were recorded", () => {
    const r = reason(
      base()
        .proposal(2, [1, 2, 3])
        .vote({}, "passed")
        .mission("success", 0),
    );
    expect(r.kind).toBe("no_votes");
    expect(flatReasonText(r, "merlin")).toContain("还没记票型");
  });

  it("names the missing clean car when every car carried an evil", () => {
    // Evils are 1, 5, 6 — and one of them rode every single car.
    const r = reason(
      base()
        .proposal(2, [1, 2, 3])
        .vote({ 4: "approve", 7: "reject", 8: "reject", 9: "approve" }, "passed")
        .mission("success", 0)
        .proposal(3, [2, 3, 5])
        .vote({ 4: "approve", 7: "reject", 8: "reject", 9: "reject" }, "passed")
        .mission("fail", 1),
    );
    expect(r.kind).toBe("no_clean_car");
    // The honest line: more recording will NOT help until a clean car goes up.
    expect(flatReasonText(r, "merlin")).toContain("干净车");
  });

  /*
   * This used to expect "confident" here, and it no longer converges that far.
   *
   * That is the tempering doing its job rather than a regression. Measured on
   * the training half, with the role likelihood tempered the Merlin entropy
   * drops below 2.2 bits in only 1.6% of positions — and even in those, the
   * top candidate is right 46% of the time. The old threshold of 1.6 bits was
   * reachable only because the untempered evidence was over-weighted; it was
   * promising a confidence the data does not support.
   *
   * So the honest state here is "the votes have not separated anyone yet".
   * ROLE_CERTAIN_BITS still needs recalibrating against the tempered
   * posterior — the number to pick is the entropy at which the read is
   * actually reliable, and that measurement says it is not 1.6.
   */
  it("keeps saying the votes have not separated anyone, because they have not", () => {
    const r = reason(
      base()
        .proposal(2, [2, 3, 4])
        .vote({ 2: "approve", 3: "approve", 4: "approve", 7: "reject", 8: "approve", 9: "reject" }, "passed")
        .mission("success", 0)
        .proposal(3, [3, 7, 8])
        .vote({ 2: "approve", 3: "approve", 4: "reject", 7: "approve", 8: "approve", 9: "reject" }, "passed")
        .mission("success", 0),
    );
    expect(r.kind).toBe("votes_uninformative");
    expect(flatReasonText(r, "merlin")).not.toBeNull();
  });

  it("stays quiet for roles that are not read from behaviour", () => {
    const r = base().build();
    const withRole = asEvil(r.game);
    const explained = explainFlatRole(
      deriveRoleInference(r.events, withRole),
      deriveSideInference(r.events, withRole),
      r.events,
      withRole,
      "mordred",
    );
    expect(explained.kind).toBe("not_applicable");
    expect(flatReasonText(explained, "merlin")).toBeNull();
  });
});
