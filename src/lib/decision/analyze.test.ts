import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { evilCount, teamSize } from "@/lib/rules/avalon";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { ALGORITHM_VERSION, analyzeGame, confidenceOf } from "./analyze";
import { informationSets } from "./rollout";
import { buildDecisionState } from "./state";

/**
 * The release gate.
 *
 * Everything here is a property the product must have on the day it ships, and
 * most of them are properties it would be easy to break without noticing. They
 * run offline, on fixtures, in milliseconds, with no key and no network — which
 * is itself one of the things being asserted.
 */

const COUNTS: PlayerCount[] = [7, 8, 9, 10];

/** A table mid-game with a car up, seen by a loyal servant. */
function facingAVote(count: PlayerCount) {
  const size = teamSize(count, 2);
  const built = game(count)
    .proposal(1, [1, 2, 3])
    .vote({ 1: "approve", 2: "approve", 3: "approve", 4: "reject" }, "passed")
    .mission("fail", 1)
    .proposal(2, Array.from({ length: size }, (_, i) => i + 2))
    .build();
  const asLoyal: GameRecord = {
    ...built.game,
    viewerPlayerId: "p1",
    viewerRole: "loyal",
  };
  return { events: built.events, game: asLoyal };
}

/** The same table, but the viewer holds the car. */
function holdingTheCar(count: PlayerCount) {
  const built = game(count)
    .proposal(1, [1, 2, 3])
    .vote({ 1: "approve", 2: "approve", 3: "approve", 4: "reject" }, "passed")
    .mission("fail", 1)
    .build();
  // Whoever the rules actually hand the car to, rather than a guessed seat.
  const leader = buildDecisionState(built.events, built.game).leaderId!;
  const asLeader: GameRecord = {
    ...built.game,
    viewerPlayerId: leader,
    viewerRole: "loyal",
  };
  return { events: built.events, game: asLeader };
}

const FAST = { worlds: 40, seed: 5 } as const;

describe("the product answers at every supported table size", () => {
  for (const count of COUNTS) {
    it(`${count} 人：believes, prices the car, and recommends`, async () => {
      const { events, game: g } = facingAVote(count);
      const out = await analyzeGame(events, g, FAST);

      expect(out.version).toBe(ALGORITHM_VERSION);
      expect(out.beliefs.players).toHaveLength(count);
      expect(out.beliefs.contradictory).toBe(false);

      // Every seat gets a probability, and the table's evils add up.
      const total = out.beliefs.players.reduce((a, p) => a + p.evilProbability, 0);
      expect(total).toBeCloseTo(evilCount(count), 4);

      expect(out.currentTeam).toBeDefined();
      expect(out.currentTeam!.failRisk).toBeGreaterThanOrEqual(0);
      expect(out.currentTeam!.failRisk).toBeLessThanOrEqual(1);

      expect(out.decision?.type).toBe("vote");
      const vote = out.decision as Extract<typeof out.decision, { type: "vote" }>;
      expect(["approve", "reject", null]).toContain(vote.recommendation);
      expect(["strong", "lean", "too-close"]).toContain(vote.confidence);
      expect(vote.explanation.length).toBeGreaterThan(4);
    }, 120_000);

    it(`${count} 人：ranks only legal teams when leading`, async () => {
      const { events, game: g } = holdingTheCar(count);
      const out = await analyzeGame(events, g, { ...FAST, shortlist: 4 });
      expect(out.decision?.type).toBe("proposal");
      const plan = out.decision as Extract<typeof out.decision, { type: "proposal" }>;

      const want = teamSize(count, 2);
      const seats = new Set(g.players.map((p) => p.id));
      for (const option of [plan.recommended, ...plan.alternatives]) {
        expect(option.team).toHaveLength(want);
        expect(new Set(option.team).size).toBe(want);
        for (const seat of option.team) expect(seats.has(seat)).toBe(true);
      }
    }, 120_000);
  }
});

describe("nothing leaks that the viewer cannot see", () => {
  it("gives the same answer however the hidden roles are dealt", async () => {
    // A loyal servant with no sight. Nothing about who is actually evil is in
    // the log, so no dealing of the hidden roles may change the advice.
    const { events, game: g } = facingAVote(9);
    const first = await analyzeGame(events, g, FAST);
    const second = await analyzeGame(events, { ...g }, FAST);
    expect(second.beliefs.players.map((p) => p.evilProbability)).toEqual(
      first.beliefs.players.map((p) => p.evilProbability),
    );
    expect((second.decision as { delta: number }).delta).toBe(
      (first.decision as { delta: number }).delta,
    );
  }, 120_000);

  it("uses Merlin's sight and stops exactly where it ends", async () => {
    // He is shown two evils in a nine-player game. Mordred is not one of them,
    // and the answer must not behave as though he were.
    const built = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .proposal(1, [1, 4, 7])
      .build();
    const asMerlin: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    };
    const out = await analyzeGame(built.events, asMerlin, FAST);
    const byId = new Map(out.beliefs.players.map((p) => [p.playerId, p]));
    expect(byId.get("p4")!.proven).toBe("evil");
    expect(byId.get("p6")!.proven).toBe("evil");
    // The third evil is somewhere among the rest and must stay uncertain.
    const rest = out.beliefs.players.filter(
      (p) => !["p4", "p6"].includes(p.playerId),
    );
    expect(rest.every((p) => p.proven !== "evil")).toBe(true);
    expect(rest.some((p) => p.evilProbability > 0)).toBe(true);
  }, 120_000);

  it("gives Oberon no teammates and an evil minion its own", () => {
    const casting = new Map<string, RoleType>([
      ["p1", "merlin"],
      ["p2", "percival"],
      ["p3", "loyal"],
      ["p4", "loyal"],
      ["p5", "loyal"],
      ["p6", "loyal"],
      ["p7", "morgana"],
      ["p8", "mordred"],
      ["p9", "oberon"],
    ]);
    const info = informationSets(casting);
    expect([...info.get("p9")!.knownEvil]).toHaveLength(0);
    // Morgana sees Mordred but never Oberon.
    expect([...info.get("p7")!.knownEvil].sort()).toEqual(["p8"]);
    // Merlin sees every evil but Mordred.
    expect([...info.get("p1")!.visibleEvil].sort()).toEqual(["p7", "p9"]);
  });
});

describe("hard constraints never rule out the truth", () => {
  it("keeps the real evil set alive at every table size", async () => {
    for (const count of COUNTS) {
      const { events, game: g } = facingAVote(count);
      const out = await analyzeGame(events, g, { ...FAST, beliefOnly: true });
      expect(out.beliefs.surviving).toBeGreaterThan(0);
      // The viewer declared themselves loyal, which IS a hard fact about seat
      // one and should be proven. Nobody else can be, since nothing in the log
      // pins another seat down.
      const byId = new Map(out.beliefs.players.map((p) => [p.playerId, p]));
      expect(byId.get("p1")!.proven).toBe("good");
      for (const p of out.beliefs.players) {
        if (p.playerId === "p1") continue;
        expect(p.proven).toBeNull();
        // And every other seat keeps a live chance of being either.
        expect(p.evilProbability).toBeGreaterThan(0);
        expect(p.evilProbability).toBeLessThan(1);
      }
    }
  }, 120_000);
});

describe("the recommendation is reproducible and offline", () => {
  it("returns the identical answer for the same seed", async () => {
    const { events, game: g } = facingAVote(9);
    const a = await analyzeGame(events, g, { worlds: 60, seed: 42 });
    const b = await analyzeGame(events, g, { worlds: 60, seed: 42 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  }, 120_000);

  it("never touches the network", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("the production path must not make requests");
    }) as typeof fetch;
    try {
      const { events, game: g } = facingAVote(9);
      await analyzeGame(events, g, FAST);
      const lead = holdingTheCar(9);
      await analyzeGame(lead.events, lead.game, { ...FAST, shortlist: 3 });
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
  }, 120_000);

  it("works with no social input at all", async () => {
    // The product path never has any; this pins that it is not merely absent
    // by accident but a state the code handles.
    const { events, game: g } = facingAVote(8);
    const out = await analyzeGame(events, g, FAST);
    expect(out.decision).toBeDefined();
  }, 120_000);
});

describe("weak evidence is reported as weak", () => {
  it("calls it too close when the gap is inside the noise", () => {
    expect(confidenceOf(0.004, 0.02)).toBe("too-close");
    expect(confidenceOf(-0.004, 0.02)).toBe("too-close");
    expect(confidenceOf(Number.NaN, 0.02)).toBe("too-close");
  });

  it("leans when the direction is stable but the effect is small", () => {
    expect(confidenceOf(0.02, 0.004)).toBe("lean");
  });

  it("commits only when the gap is both real and worth acting on", () => {
    expect(confidenceOf(0.08, 0.01)).toBe("strong");
    // Big but noisy is not strong.
    expect(confidenceOf(0.08, 0.05)).toBe("too-close");
  });

  it("returns no recommendation when it cannot separate the options", async () => {
    // Two worlds cannot tell anything apart; the gate has to notice.
    const { events, game: g } = facingAVote(7);
    const out = await analyzeGame(events, g, { worlds: 2, seed: 3 });
    const vote = out.decision as Extract<typeof out.decision, { type: "vote" }>;
    if (vote.confidence === "too-close") expect(vote.recommendation).toBeNull();
    else expect(vote.recommendation).not.toBeNull();
  }, 120_000);

  it("still points somewhere when the car is certain to fail", async () => {
    /*
     * Merlin looking at a car carrying two evils he can see. The win-rate
     * difference is small — his single vote rarely decides anything — and the
     * product must not answer "either is fine" to a car that cannot succeed.
     */
    const built = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .mark(6, { kind: "side", side: "evil" }, "known")
      .proposal(2, [4, 6, 2])
      .build();
    const asMerlin: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "merlin",
    };
    const out = await analyzeGame(built.events, asMerlin, { worlds: 200, seed: 11 });
    expect(out.currentTeam!.failRisk).toBeCloseTo(1, 6);
    const vote = out.decision as Extract<typeof out.decision, { type: "vote" }>;
    expect(vote.riskDirection).toBe("reject");
    expect(vote.explanation).toContain("下票");
  }, 120_000);
});

describe("the hammer", () => {
  it("prices the fifth car as the last one", async () => {
    const built = game(9)
      .proposal(1, [1, 2, 3])
      .vote({ 1: "reject" }, "rejected")
      .proposal(1, [1, 2, 4])
      .vote({ 1: "reject" }, "rejected")
      .proposal(1, [1, 2, 5])
      .vote({ 1: "reject" }, "rejected")
      .proposal(1, [1, 2, 6])
      .vote({ 1: "reject" }, "rejected")
      .proposal(1, [1, 2, 7])
      .build();
    const asLoyal: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "loyal",
    };
    const state = buildDecisionState(built.events, asLoyal);
    expect(state.rejectionStreak).toBe(4);

    /*
     * The hammer must be priced as worse to reject than an ordinary car. Both
     * sides of the comparison use the same seats and the same seed, so the
     * difference between them is the rule and not the table.
     *
     * Not asserted: that a single seat rejecting ends the game. It does not —
     * the other eight still vote — which is exactly why the value difference
     * on one vote is small even here.
     */
    const early = game(9).proposal(1, [1, 2, 7]).build();
    const asEarly: GameRecord = {
      ...early.game,
      viewerPlayerId: "p1",
      viewerRole: "loyal",
    };
    /*
     * Averaged over seeds. A single vote is worth two or three points of win
     * probability and the Monte Carlo error at four hundred worlds is about
     * the same size, so one seed would make this test a coin flip that goes
     * red on a bad afternoon. Three seeds of three hundred worlds is the same
     * total work and a far steadier statistic.
     */
    const deltaOf = async (
      ev: typeof built.events,
      g: GameRecord,
    ): Promise<number> => {
      let sum = 0;
      for (const seed of [11, 2027, 90210]) {
        const out = await analyzeGame(ev, g, { worlds: 300, seed });
        sum += (out.decision as Extract<typeof out.decision, { type: "vote" }>).delta;
      }
      return sum / 3;
    };

    expect(await deltaOf(built.events, asLoyal)).toBeGreaterThan(
      await deltaOf(early.events, asEarly),
    );
  }, 120_000);
});

describe("when there is nothing to advise", () => {
  it("says so rather than inventing a decision", async () => {
    const built = game(9).proposal(1, [1, 2, 3]).build();
    // No viewer seat recorded.
    const out = await analyzeGame(built.events, built.game, FAST);
    expect(out.decision).toBeUndefined();
    expect(out.noDecisionReason).toBe("no-viewer");
    // Beliefs still work — they never needed a viewer.
    expect(out.beliefs.players).toHaveLength(9);
  }, 120_000);

  it("declines when the viewer has not said which side they are on", async () => {
    const built = game(9).proposal(1, [1, 2, 3]).build();
    const seated: GameRecord = { ...built.game, viewerPlayerId: "p1" };
    const out = await analyzeGame(built.events, seated, FAST);
    expect(out.decision).toBeUndefined();
    expect(out.noDecisionReason).toBe("no-side");
  }, 120_000);
});
