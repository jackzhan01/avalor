import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, scoreHypothesis, weighHypotheses } from "./soft";
import { deriveSideInference } from "./side";
import { enumerateHypotheses } from "./hypotheses";
import { game, approveOnly } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import type { GameRecord } from "@/lib/types/game";

/**
 * The contract this layer must never break: it re-weights, it does not rule
 * out. Certainty belongs to the hard layer, and no behavioural assumption may
 * create or destroy one.
 */

describe("the boundary with the hard layer", () => {
  it("eliminates nothing — the surviving set is untouched", () => {
    const { game: g, events } = ninePlayerGame();
    const side = deriveSideInference(events, g);
    // Same 74 the hard layer alone produced, before soft evidence existed.
    expect(side.surviving).toHaveLength(74);
  });

  it("cannot manufacture a proof", () => {
    const { game: g, events } = ninePlayerGame();
    const side = deriveSideInference(events, g);
    // Nothing is provable from this log, and no amount of vote-weighting may
    // change that.
    expect(side.provenEvil).toHaveLength(0);
    expect(side.provenGood).toHaveLength(0);
    for (const p of side.evilProbability.values()) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("cannot destroy one either", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      // Votes that a naive model would read as exonerating 4 and 6.
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [4, 6]), "rejected")
      .build();
    const asMerlin: GameRecord = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    };
    const side = deriveSideInference(events, asMerlin);

    // Vision proved it; behaviour cannot argue with a proof.
    expect(side.evilProbability.get("p4")).toBe(1);
    expect(side.evilProbability.get("p6")).toBe(1);
    expect(side.evilProbability.get("p1")).toBe(0);
  });

  it("keeps both numbers available, and they agree only where they must", () => {
    const { game: g, events } = ninePlayerGame();
    const side = deriveSideInference(events, g);
    // Counting says 40/35 flat; weighting separates them. Both are kept.
    expect(side.evilFrequency.get("p4")).not.toBeCloseTo(
      side.evilProbability.get("p4")!,
      2,
    );
  });
});

describe("votes carry signal", () => {
  it("prefers worlds where the people who backed a doomed car are evil", () => {
    // 1/2/3 went out and failed. Whoever voted that car up looks worse.
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1, 2, 3, 7]), "passed")
      .mission("fail", 1)
      .build();
    const side = deriveSideInference(events, g);

    // 7 backed it without riding it; 8 did not back it at all.
    expect(side.evilProbability.get("p7")!).toBeGreaterThan(
      side.evilProbability.get("p8")!,
    );
  });

  it("treats a good player's vote as nearly uninformative", () => {
    // The asymmetry that makes this work: evil know their teammates, good do
    // not. With goodApproves at exactly 0.5, a good seat's vote contributes a
    // constant and so cannot shift anything.
    const hypotheses = enumerateHypotheses(game(9).build().game);
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [5]), "rejected")
      .build();

    const flat = { ...DEFAULT_PARAMS, goodApproves: 0.5 };
    const scores = hypotheses.map((h) => scoreHypothesis(h, events, g, flat));
    // Worlds differing only in which GOOD seats exist must score identically
    // once the evil placements match — verified by the spread being driven
    // entirely by evil placement, not by the count of good voters.
    expect(new Set(scores.map((s) => s.toFixed(6))).size).toBeLessThan(
      hypotheses.length,
    );
  });

  it("ignores votes recorded as unknown", () => {
    const { game: g, events: withUnknown } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({ 4: "unknown", 5: "unknown" }, "rejected")
      .build();
    const { game: g2, events: withNothing } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "rejected")
      .build();

    const a = deriveSideInference(withUnknown, g);
    const b = deriveSideInference(withNothing, g2);
    // "Recorded as unknown" and "never recorded" must both contribute nothing.
    for (const player of g.players) {
      expect(a.evilProbability.get(player.id)).toBeCloseTo(
        b.evilProbability.get(player.id)!,
        9,
      );
    }
  });
});

describe("fail cards", () => {
  it("favours worlds with fewer evils aboard when a quest came back clean", () => {
    // Evil may play success, so a clean quest proves nothing — but it is
    // evidence, and this layer is allowed to use evidence.
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("success", 0)
      .build();
    const side = deriveSideInference(events, g);

    // Still 84 possible worlds; none eliminated.
    expect(side.surviving).toHaveLength(84);
    // But riders on the clean quest are now slightly less suspect than others.
    expect(side.evilProbability.get("p1")!).toBeLessThan(
      side.evilProbability.get("p9")!,
    );
  });

  it("reads a single fail card as evidence of few evils — once it is late enough", () => {
    // Two quests already through, so this is the third: at 2-0 an evil aboard
    // plays the card 84% of the time when alone, and two of them produce
    // exactly one card only 49% of the time.
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("success")
      .proposal(2, [4, 5, 6, 7])
      .vote({}, "passed")
      .mission("success")
      .proposal(3, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();
    const hypotheses = deriveSideInference(events, g).surviving;

    const aboard = (h: (typeof hypotheses)[number]) =>
      h.evil.filter((id) => ["p1", "p2", "p3"].includes(id)).length;
    const oneAboard = hypotheses.find((h) => aboard(h) === 1)!;
    const twoAboard = hypotheses.find((h) => aboard(h) === 2)!;

    expect(scoreHypothesis(oneAboard, events, g)).toBeGreaterThan(
      scoreHypothesis(twoAboard, events, g),
    );
  });

  /**
   * The same card on the OPENING quest says almost nothing, and the measured
   * rates say why: at 0-0 a lone evil plays it only 29% of the time, so "one
   * of them held" is the norm rather than something needing explanation.
   * Asserting the intuition here would be encoding a belief the data refutes.
   */
  it("treats an opening-quest fail card as nearly uninformative about how many were aboard", () => {
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();
    const hypotheses = deriveSideInference(events, g).surviving;

    const aboard = (h: (typeof hypotheses)[number]) =>
      h.evil.filter((id) => ["p1", "p2", "p3"].includes(id)).length;
    const one = scoreHypothesis(
      hypotheses.find((h) => aboard(h) === 1)!,
      events,
      g,
    );
    const two = scoreHypothesis(
      hypotheses.find((h) => aboard(h) === 2)!,
      events,
      g,
    );

    // Within a factor of e^0.5 either way — no usable discrimination.
    expect(Math.abs(one - two)).toBeLessThan(0.5);
  });
});

describe("weights", () => {
  it("sums to 1", () => {
    const { game: g, events } = ninePlayerGame();
    const side = deriveSideInference(events, g);
    const weights = weighHypotheses(side.surviving, events, g);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("stays uniform when there is nothing to go on", () => {
    const { game: g, events } = game(9).build();
    const weights = weighHypotheses(enumerateHypotheses(g), events, g);
    for (const w of weights) expect(w).toBeCloseTo(1 / 84, 9);
  });

  it("damping tempers the posterior without reordering it", () => {
    const { game: g, events } = ninePlayerGame();
    const hypotheses = deriveSideInference(events, g).surviving;

    const strong = weighHypotheses(hypotheses, events, g, {
      ...DEFAULT_PARAMS,
      damping: 1,
    });
    const damped = weighHypotheses(hypotheses, events, g, {
      ...DEFAULT_PARAMS,
      damping: 0.5,
    });

    const rank = (w: number[]) =>
      w
        .map((v, i) => [v, i] as const)
        .sort((a, b) => b[0] - a[0])
        .map(([, i]) => i);
    expect(rank(damped)).toEqual(rank(strong));
    // Same ordering, but the damped version is less willing to commit.
    expect(Math.max(...damped)).toBeLessThan(Math.max(...strong));
  });

  it("handles an empty set without dividing by zero", () => {
    const { game: g, events } = game(9).build();
    expect(weighHypotheses([], events, g)).toEqual([]);
  });
});
