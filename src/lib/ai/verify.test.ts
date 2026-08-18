import { describe, expect, it } from "vitest";
import { missingProvenSeats, verifyAnalysis } from "./verify";
import { game } from "@/lib/fixtures/builder";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import type { AnalysisResult } from "./types";
import type { GameRecord } from "@/lib/types/game";

/** Merlin at seat 1 who has seen 4 and 6 — so those three seats are proven. */
function merlinGame() {
  const { game: g, events } = game(9)
    .mark(4, { kind: "side", side: "evil" }, "known")
    .mark(6, { kind: "side", side: "evil" }, "known")
    .build();
  const withRole: GameRecord = {
    ...g,
    viewerPlayerId: "p1",
    viewerRole: "merlin",
  };
  return { game: withRole, events };
}

function analysis(seats: AnalysisResult["seats"]): AnalysisResult {
  return { headline: "x", seats, keyPoints: [] };
}

describe("contradicting a proof", () => {
  it("catches calling a provably good seat evil", () => {
    const { game: g, events } = merlinGame();
    const found = verifyAnalysis(
      analysis([{ seat: 1, read: "坏人", confidence: "high", why: "" }]),
      g,
      events,
    );
    // Seat 1 is also the viewer, so two rules apply — but only the more
    // specific one is reported, to keep the panel readable.
    expect(found).toHaveLength(1);
    expect(found[0].because).toContain("证明他是好人");
  });

  it("catches calling a provably evil seat good", () => {
    const { game: g, events } = merlinGame();
    const found = verifyAnalysis(
      analysis([{ seat: 4, read: "好人", confidence: "high", why: "" }]),
      g,
      events,
    );
    expect(found).toHaveLength(1);
    expect(found[0].because).toContain("证明他是坏人");
  });

  it("passes an analysis that agrees with the proofs", () => {
    const { game: g, events } = merlinGame();
    const found = verifyAnalysis(
      analysis([
        { seat: 1, read: "我自己", confidence: "high", why: "" },
        { seat: 4, read: "坏人", confidence: "high", why: "" },
        { seat: 6, read: "坏人", confidence: "high", why: "" },
        { seat: 2, read: "不好说", confidence: "low", why: "" },
      ]),
      g,
      events,
    );
    expect(found).toHaveLength(0);
  });

  it("says nothing when it has nothing to check against", () => {
    // No vision, no failed missions: the hard layer proves nothing, so the
    // checker must not invent objections.
    const { game: g, events } = game(9).build();
    const found = verifyAnalysis(
      analysis([{ seat: 3, read: "坏人", confidence: "high", why: "" }]),
      g,
      events,
    );
    expect(found).toHaveLength(0);
  });

  it("stays quiet on a self-contradictory log", () => {
    const { game: g, events } = game(9)
      .mark(1, { kind: "side", side: "good" }, "known")
      .mark(2, { kind: "side", side: "good" }, "known")
      .mark(3, { kind: "side", side: "good" }, "known")
      .proposal(1, [1, 2, 3])
      .vote({}, "passed")
      .mission("fail", 1)
      .build();
    expect(
      verifyAnalysis(
        analysis([{ seat: 1, read: "坏人", confidence: "high", why: "" }]),
        g,
        events,
      ),
    ).toHaveLength(0);
  });
});

describe("seats that do not exist", () => {
  it("catches a seat number past the end of the table", () => {
    const { game: g, events } = ninePlayerGame();
    const found = verifyAnalysis(
      analysis([{ seat: 12, read: "坏人", confidence: "low", why: "" }]),
      g,
      events,
    );
    expect(found).toHaveLength(1);
    expect(found[0].because).toContain("没有 12号");
  });
});

describe("analysing the user themselves", () => {
  it("catches the model treating the viewer as a suspect", () => {
    // The exact failure seen in a live run: the assassin's own seat written up
    // as "更像被带节奏的好人".
    const { game: g, events } = game(9).build();
    const asAssassin: GameRecord = {
      ...g,
      viewerPlayerId: "p4",
      viewerRole: "assassin",
    };
    // "可能是坏人" happens to be the right side — he IS the assassin — so no
    // proof is contradicted. It is still wasted output: his identity is the
    // one thing he already knows.
    const found = verifyAnalysis(
      analysis([{ seat: 4, read: "可能是坏人", confidence: "medium", why: "" }]),
      asAssassin,
      events,
    );
    expect(found.some((c) => c.claim.includes("你自己"))).toBe(true);
  });

  it("accepts the seat when it is labelled as the user", () => {
    const { game: g, events } = game(9).build();
    const asAssassin: GameRecord = {
      ...g,
      viewerPlayerId: "p4",
      viewerRole: "assassin",
    };
    expect(
      verifyAnalysis(
        analysis([{ seat: 4, read: "我自己", confidence: "high", why: "" }]),
        asAssassin,
        events,
      ),
    ).toHaveLength(0);
  });
});

describe("missingProvenSeats", () => {
  it("reports a proven seat the analysis skipped", () => {
    const { game: g, events } = merlinGame();
    const missing = missingProvenSeats(
      analysis([{ seat: 2, read: "不好说", confidence: "low", why: "" }]),
      g,
      events,
    );
    expect(missing).toEqual([1, 4, 6]);
  });

  it("is empty when everything proven was covered", () => {
    const { game: g, events } = merlinGame();
    const missing = missingProvenSeats(
      analysis([
        { seat: 1, read: "我自己", confidence: "high", why: "" },
        { seat: 4, read: "坏人", confidence: "high", why: "" },
        { seat: 6, read: "坏人", confidence: "high", why: "" },
      ]),
      g,
      events,
    );
    expect(missing).toEqual([]);
  });
});
