import { describe, it, expect } from "vitest";
import { deriveLady, ladyNeedsAssigning } from "./lady";
import { deriveTimeline } from "./derive-timeline";
import { allApprove, game } from "@/lib/fixtures/builder";

/** Play a whole mission in one line so the tests read like a game. */
function playMission(
  b: ReturnType<typeof game>,
  leader: number,
  team: number[],
  result: "success" | "fail" = "success",
) {
  return b.proposal(leader, team).vote(allApprove(9), "passed").mission(result, 0);
}

describe("the token", () => {
  it("is absent until the game says it is in play", () => {
    const built = game(9).build();
    const lady = deriveLady(built.events, built.game);
    expect(lady.enabled).toBe(false);
    expect(lady.due).toBe(false);
  });

  it("needs assigning before anyone holds it", () => {
    const built = game(9).lady().build();
    expect(ladyNeedsAssigning(built.events, built.game)).toBe(true);
    expect(deriveLady(built.events, built.game).holderId).toBeNull();
  });

  it("moves to whoever was examined", () => {
    const built = game(9).lady().ladyTo(5).ladyCheck(5, 8, "good").build();
    expect(deriveLady(built.events, built.game).holderId).toBe("p8");
  });

  it("remembers everyone who has held it", () => {
    const built = game(9)
      .lady()
      .ladyTo(5)
      .ladyCheck(5, 8, "good")
      .ladyCheck(8, 2, "evil")
      .build();
    expect(deriveLady(built.events, built.game).heldBy).toEqual(["p5", "p8", "p2"]);
  });

  it("puts past holders out of reach", () => {
    // The rule that makes the token walk across the table rather than bounce
    // between two people.
    const built = game(9).lady().ladyTo(5).ladyCheck(5, 8, "good").build();
    const lady = deriveLady(built.events, built.game);
    expect(lady.examinable).not.toContain("p5");
    expect(lady.examinable).not.toContain("p8"); // the holder cannot self-check
    expect(lady.examinable).toContain("p1");
    expect(lady.examinable).toHaveLength(7);
  });

  it("treats re-assigning as a correction, not a hand-off", () => {
    const built = game(9).lady().ladyTo(5).ladyTo(3).build();
    const lady = deriveLady(built.events, built.game);
    expect(lady.holderId).toBe("p3");
    expect(lady.heldBy).toEqual(["p3"]);
    expect(lady.checks).toHaveLength(0);
  });
});

describe("when a check is owed", () => {
  it("is not owed before two missions are done", () => {
    let b = game(9).lady().ladyTo(5);
    b = playMission(b, 1, [1, 2, 3]);
    const built = b.build();
    expect(deriveLady(built.events, built.game).due).toBe(false);
  });

  it("is owed after mission 2", () => {
    let b = game(9).lady().ladyTo(5);
    b = playMission(b, 1, [1, 2, 3]);
    b = playMission(b, 2, [1, 2, 3, 4]);
    const built = b.build();
    const lady = deriveLady(built.events, built.game);
    expect(lady.expected).toBe(1);
    expect(lady.due).toBe(true);
  });

  it("is settled once the check is recorded", () => {
    let b = game(9).lady().ladyTo(5);
    b = playMission(b, 1, [1, 2, 3]);
    b = playMission(b, 2, [1, 2, 3, 4]);
    const built = b.ladyCheck(5, 8, "good").build();
    expect(deriveLady(built.events, built.game).due).toBe(false);
  });

  it("comes due again after missions 3 and 4", () => {
    let b = game(9).lady().ladyTo(5);
    b = playMission(b, 1, [1, 2, 3]);
    b = playMission(b, 2, [1, 2, 3, 4]);
    b = b.ladyCheck(5, 8, "good");
    b = playMission(b, 3, [1, 2, 3, 4]);
    const built = b.build();
    const lady = deriveLady(built.events, built.game);
    expect(lady.expected).toBe(2);
    expect(lady.due).toBe(true);
  });

  it("stops at three, even after mission 5", () => {
    let b = game(9).lady().ladyTo(5);
    for (let m = 1; m <= 5; m++) {
      b = playMission(b, 1, [1, 2, 3], m === 2 || m === 4 ? "fail" : "success");
    }
    const built = b.build();
    expect(deriveLady(built.events, built.game).expected).toBe(3);
  });

  it("is never owed while nobody holds it", () => {
    let b = game(9).lady();
    b = playMission(b, 1, [1, 2, 3]);
    b = playMission(b, 2, [1, 2, 3, 4]);
    const built = b.build();
    expect(deriveLady(built.events, built.game).due).toBe(false);
  });
});

describe("the announcement is public, the card is not", () => {
  it("records only what the holder said out loud", () => {
    // The holder may be lying; the log stores the claim, never the card.
    const built = game(9).lady().ladyTo(5).ladyCheck(5, 8, "good").build();
    const check = deriveLady(built.events, built.game).checks[0];
    expect(check.announced).toBe("good");
    expect(Object.keys(check)).not.toContain("actualSide");
  });

  it("allows the announcement to have been missed", () => {
    const built = game(9).lady().ladyTo(5).ladyCheck(5, 8, "unknown").build();
    expect(deriveLady(built.events, built.game).checks[0].announced).toBe(
      "unknown",
    );
  });
});

describe("the token does not move the game", () => {
  it("leaves phase and numbering untouched", () => {
    const built = game(9)
      .lady()
      .ladyTo(5)
      .proposal(1, [1, 2, 3])
      .ladyCheck(5, 8, "evil")
      .build();
    const timeline = deriveTimeline(built.events, built.game);
    expect(timeline.phase).toBe("voting");
    expect(timeline.missionNumber).toBe(1);
    expect(timeline.proposalNumber).toBe(1);
    expect(timeline.warnings).toEqual([]);
  });
});
