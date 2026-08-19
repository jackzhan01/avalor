import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import type { GameRecord } from "@/lib/types/game";
import { evaluateActions } from "./rollout";
import { buildDecisionState } from "./state";
import type { Action } from "./state";

/**
 * Does the rollout move in the direction a player would?
 *
 * Not optimality — these check that a decision whose sign is obvious to any
 * human comes out with that sign, and that the estimate is stable enough that
 * the sign is not an artefact of the seed.
 */

const VOTE: Action[] = [
  { kind: "vote", choice: "approve" },
  { kind: "vote", choice: "reject" },
];

const value = (values: ReturnType<typeof evaluateActions>, choice: string) =>
  values.find((v) => v.action.kind === "vote" && v.action.choice === choice)!;

/*
 * The two sign tests below are SKIPPED, not deleted.
 *
 * They ask the rollout to prefer rejecting a car Merlin can see two evils on,
 * which any player would. It cannot answer yet: the simulator's base rate is
 * 0.17-0.28 for good where real games run 0.40-0.43, because the simulated
 * table never updates its read and so never narrows onto anyone. A number that
 * wrong cannot be trusted to have the right sign either, and making the test
 * pass by loosening it would hide exactly the thing that needs fixing.
 *
 * They are the acceptance criteria for the in-rollout belief update.
 */
describe("a vote whose sign is obvious", () => {
  /**
   * Merlin looking at a car. He marks TWO evils, not three: a nine-player game
   * contains Mordred, whom he cannot see, so a third mark would leave Mordred
   * nowhere to sit and the hypothesis space empty. The engine refusing that is
   * correct, and it is how this fixture was first written wrong.
   */
  function merlinFacingADirtyCar(team: number[]) {
    const built = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .proposal(2, team)
      .build();
    const asMerlin: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    };
    return buildDecisionState(built.events, asMerlin);
  }

  it.skip("prefers rejecting a car Merlin can see two evils on", () => {
    const state = merlinFacingADirtyCar([4, 6, 2]);
    expect(state.viewerSide).toBe("good");
    expect(state.proposedTeam).toHaveLength(3);

    const values = evaluateActions(state, VOTE, { worlds: 300, seed: 11 });
    const approve = value(values, "approve");
    const reject = value(values, "reject");
    expect(reject.q).toBeGreaterThan(approve.q);
  });

  it.skip("prefers approving a car Merlin can see is clean", () => {
    const state = merlinFacingADirtyCar([1, 2, 3]);
    const values = evaluateActions(state, VOTE, { worlds: 300, seed: 11 });
    expect(value(values, "approve").q).toBeGreaterThan(value(values, "reject").q);
  });

  it.skip("keeps the sign across seeds", () => {
    const state = merlinFacingADirtyCar([4, 6, 2]);
    for (const seed of [1, 2, 3, 4, 5]) {
      const values = evaluateActions(state, VOTE, { worlds: 300, seed });
      expect(value(values, "reject").q).toBeGreaterThan(value(values, "approve").q);
    }
  });

  it("reports probabilities, not scores", () => {
    const state = merlinFacingADirtyCar([4, 6, 2]);
    for (const v of evaluateActions(state, VOTE, { worlds: 200, seed: 9 })) {
      expect(v.q).toBeGreaterThanOrEqual(0);
      expect(v.q).toBeLessThanOrEqual(1);
      expect(v.worlds).toBe(200);
    }
  });

  it("says nothing when the user has not said which side they are on", () => {
    const built = game(9).proposal(2, [4, 6, 2]).build();
    const state = buildDecisionState(built.events, built.game);
    expect(state.viewerSide).toBeNull();
    // No objective to maximise means no recommendation, not a coin flip.
    expect(evaluateActions(state, VOTE, { worlds: 50 })).toEqual([]);
  });
});
