import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { deriveSideInference } from "@/lib/inference";
import { publicView } from "./public-view";

/**
 * The boundary a rollout must not cross: a simulated player reasoning from a
 * posterior that contains the user's private sight is not playing this game.
 */
describe("public view drops what only the user knows", () => {
  const built = game(9)
    .mark(4, { kind: "side", side: "evil" }, "known")
    .mark(6, { kind: "side", side: "evil" }, "known")
    .proposal(1, [1, 2, 3])
    .vote({ 4: "approve", 5: "reject" }, "passed")
    .mission("success")
    .build();
  const asMerlin = { ...built.game, viewerPlayerId: "p1", viewerRole: "merlin" as const };

  it("keeps the private marks out of the public log", () => {
    const view = publicView(built.events, asMerlin);
    expect(built.events.some((e) => e.type === "role_mark")).toBe(true);
    expect(view.events.some((e) => e.type === "role_mark")).toBe(false);
    expect(view.game.viewerRole).toBeUndefined();
  });

  it("gives a different posterior from the user-conditioned one", () => {
    const mine = deriveSideInference(built.events, asMerlin);
    const view = publicView(built.events, asMerlin);
    const theirs = deriveSideInference(view.events, view.game);

    // Merlin has seen two evils; the table has not.
    expect(mine.provenEvil.sort()).toEqual(["p4", "p6"]);
    expect(theirs.provenEvil).toHaveLength(0);
    expect(theirs.evilProbability.get("p4")).toBeLessThan(1);
  });

  it("leaves a game with no private layer untouched", () => {
    const plain = game(9).proposal(1, [1, 2, 3]).vote({}, "passed").build();
    const view = publicView(plain.events, plain.game);
    const before = deriveSideInference(plain.events, plain.game);
    const after = deriveSideInference(view.events, view.game);
    for (const player of plain.game.players) {
      expect(after.evilProbability.get(player.id)).toBeCloseTo(
        before.evilProbability.get(player.id)!,
        9,
      );
    }
  });
});
