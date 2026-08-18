import { describe, expect, it } from "vitest";
import { baselineEvil, seatSignal, summarise } from "./display";
import { deriveSideInference } from "./side";
import { game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import type { GameRecord } from "@/lib/types/game";

describe("baseline", () => {
  it("is the share of the table that is evil", () => {
    const { game: nine } = game(9).build();
    const { game: ten } = game(10).build();
    expect(baselineEvil(nine)).toBeCloseTo(3 / 9, 6);
    expect(baselineEvil(ten)).toBeCloseTo(4 / 10, 6);
  });
});

describe("every seat always gets a number", () => {
  it("shows the baseline on an untouched game rather than a blank", () => {
    const { game: g, events } = game(9).build();
    const side = deriveSideInference(events, g);

    for (const player of g.players) {
      const signal = seatSignal(side, g, player.id);
      // "0% confident about everyone" is the honest opening position, and it
      // is distinguishable from "not computed" — which a blank would not be.
      expect(signal.text).toBe("0%");
      expect(signal.direction).toBe("none");
      expect(signal.confidence).toBeCloseTo(0, 6);
      expect(signal.significant).toBe(false);
    }
  });

  it("leaves a seat grey while it still sits on the baseline", () => {
    // A car proposed but never voted on and never run: nothing for either
    // layer to work with, so every seat stays exactly where it started.
    const { game: g, events } = game(9).proposal(1, [1, 2, 3]).build();
    const side = deriveSideInference(events, g);

    for (const player of g.players) {
      const signal = seatSignal(side, g, player.id);
      expect(signal.text).toMatch(/^\d+%$/);
      expect(signal.significant).toBe(false);
    }
  });
});

describe("speaking when there is something to say", () => {
  it("shows certainty as 100% / 0%, in one format with everything else", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .build();
    const asMerlin: GameRecord = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    };
    const side = deriveSideInference(events, asMerlin);

    // Both ends read 100%, differing only in direction — which is the whole
    // point of the change: "certainly good" used to render as "0%".
    expect(seatSignal(side, asMerlin, "p4")).toEqual({
      text: "100%",
      direction: "evil",
      confidence: 1,
      proven: "evil",
      significant: true,
    });
    expect(seatSignal(side, asMerlin, "p1")).toEqual({
      text: "100%",
      direction: "good",
      confidence: 1,
      proven: "good",
      significant: true,
    });
  });

  it("prints a percentage for a seat that has genuinely moved", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .build();
    const asMerlin: GameRecord = {
      ...g,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    };
    const side = deriveSideInference(events, asMerlin);

    // The six seats Merlin cannot see hold Mordred between them: 1/6 each,
    // against a 33% baseline — so he is fairly (not fully) confident each one
    // is good, and the reading points that way.
    const signal = seatSignal(side, asMerlin, "p2");
    expect(signal.direction).toBe("good");
    expect(signal.confidence).toBeCloseTo(0.5, 2);
    expect(signal.text).toBe("50%");
    expect(signal.proven).toBeNull();
  });

  it("points evil for a seat above the baseline", () => {
    const { game: g, events } = game(9)
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 2)
      .build();
    const side = deriveSideInference(events, g);

    // Two fail cards from a three-person team pushes all three hard.
    const signal = seatSignal(side, g, "p1");
    expect(signal.direction).toBe("evil");
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.text).toMatch(/%$/);
  });
});

describe("contradiction", () => {
  it("says nothing per-seat and explains itself in the summary", () => {
    const { game: g, events } = game(9)
      .mark(1, { kind: "side", side: "good" }, "known")
      .mark(2, { kind: "side", side: "good" }, "known")
      .mark(3, { kind: "side", side: "good" }, "known")
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();
    const side = deriveSideInference(events, g);

    // A dash, not a number and not a blank: there is no posterior to report,
    // and saying so is different from having nothing to say.
    expect(seatSignal(side, g, "p1").text).toBe("—");
    expect(seatSignal(side, g, "p1").significant).toBe(false);
    expect(summarise(side, g)).toContain("矛盾");
  });
});

describe("summary line", () => {
  it("says nothing has been ruled out yet when that is true", () => {
    const { game: g, events } = game(9).build();
    expect(summarise(deriveSideInference(events, g), g)).toContain(
      "还没排除任何一种",
    );
  });

  it("reports the narrowing", () => {
    const { game: g, events } = ninePlayerGame();
    expect(summarise(deriveSideInference(events, g), g)).toContain(
      "84 → 还剩 74 种",
    );
  });

  it("always says what the number counts", () => {
    // The ambiguity this fixes: a green "17%" was read as "only 17% good".
    const { game: g, events } = ninePlayerGame();
    expect(summarise(deriveSideInference(events, g), g)).toContain(
      "数字＝是坏人的可能",
    );
  });

  it("anchors the reader, because 33% here is what 50% is on a go board", () => {
    const { game: nine, events } = game(9).build();
    const { game: ten } = game(10).build();
    expect(summarise(deriveSideInference(events, nine), nine)).toContain(
      "平均 33%",
    );
    expect(summarise(deriveSideInference(events, ten), ten)).toContain(
      "平均 40%",
    );
  });

  it("has its own wording for a solved game", () => {
    const { game: g, events } = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .mark(8, { kind: "side", side: "evil" }, "known")
      .build();
    expect(summarise(deriveSideInference(events, g), g)).toContain(
      "只剩一种可能了",
    );
  });
});
