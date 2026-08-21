import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import {
  EvilOdds,
  SocialLedger,
  socialFromEvents,
  syntheticRound,
  valenceOfRating,
  type SocialEvidence,
} from ".";
import { makeRng } from "@/lib/decision/sampler";

const piece = (over: Partial<SocialEvidence> = {}): SocialEvidence => ({
  sequence: 1,
  missionNumber: 1,
  speakerId: "p1",
  targetId: "p2",
  valence: -1,
  confidence: 1,
  source: "synthetic",
  audience: null,
  ...over,
});

describe("the ledger", () => {
  it("will not let a seat read the future", () => {
    const ledger = new SocialLedger();
    ledger.add(piece({ sequence: 5 }));
    ledger.add(piece({ sequence: 50, missionNumber: 4 }));

    expect(ledger.observedBy("p3", 10)).toHaveLength(1);
    expect(ledger.observedBy("p3", 100)).toHaveLength(2);
  });

  it("will not let a seat read what it was not in the room for", () => {
    const ledger = new SocialLedger();
    ledger.add(piece({ sequence: 1, audience: ["p1", "p2"] }));
    ledger.add(piece({ sequence: 2, audience: null }));

    expect(ledger.observedBy("p1", 99)).toHaveLength(2);
    // p3 was not part of that side conversation and never learns of it.
    expect(ledger.observedBy("p3", 99)).toHaveLength(1);
    expect(ledger.publicUpTo(99)).toHaveLength(1);
  });

  it("refuses evidence a seat expressed about itself", () => {
    const ledger = new SocialLedger();
    expect(() => ledger.add(piece({ speakerId: "p4", targetId: "p4" }))).toThrow();
  });

  it("orders by sequence, not by arrival", () => {
    const ledger = new SocialLedger();
    ledger.add(piece({ sequence: 9 }));
    ledger.add(piece({ sequence: 2 }));
    expect(ledger.all().map((e) => e.sequence)).toEqual([2, 9]);
  });
});

describe("reading the notebook", () => {
  it("maps a 1-5 stance onto a valence, with 3 meaning it was looked at", () => {
    expect(valenceOfRating(1)).toBe(-1);
    expect(valenceOfRating(3)).toBe(0);
    expect(valenceOfRating(5)).toBe(1);
  });

  it("keeps every revision, exactly as the log does", () => {
    const built = game(9).opinion(3, 6, 4).opinion(3, 6, 5).opinion(3, 6, 2).build();
    const social = socialFromEvents(built.events);
    expect(social).toHaveLength(3);
    // The chain survives: a change of mind is two facts, not a correction.
    expect(social.map((e) => e.valence)).toEqual([0.5, 1, -0.5]);
  });

  it("produces nothing for a pair that was never rated", () => {
    const built = game(9).opinion(3, 6, 4).build();
    const social = socialFromEvents(built.events);
    expect(social.some((e) => e.targetId === "p7")).toBe(false);
  });

  it("never reads the private layer", () => {
    const built = game(9)
      .mark(4, { kind: "side", side: "evil" }, "known")
      .opinion(1, 2, 5)
      .build();
    const social = socialFromEvents(built.events);
    expect(social).toHaveLength(1);
    expect(social[0].source).toBe("rating");
  });
});

describe("aggregating into log-odds", () => {
  it("reads an accusation as evidence toward evil, and a defence away", () => {
    const odds = new EvilOdds({ decay: 1 });
    odds.absorb([piece({ valence: -1, targetId: "p2" })], 1);
    odds.absorb([piece({ valence: 1, targetId: "p3" })], 1);
    expect(odds.get("p2")).toBeGreaterThan(0);
    expect(odds.get("p3")).toBeLessThan(0);
  });

  it("discounts a speaker the table does not trust", () => {
    const trusted = new EvilOdds({ decay: 1 });
    const doubted = new EvilOdds({ decay: 1 });
    trusted.absorb([piece()], 1, new Map([["p1", 1]]));
    doubted.absorb([piece()], 1, new Map([["p1", 0.2]]));
    expect(doubted.get("p2")).toBeLessThan(trusted.get("p2"));
  });

  it("fades talk as the game moves past it", () => {
    const fresh = new EvilOdds();
    const stale = new EvilOdds();
    fresh.absorb([piece({ missionNumber: 4 })], 4);
    stale.absorb([piece({ missionNumber: 1 })], 4);
    expect(stale.get("p2")).toBeLessThan(fresh.get("p2"));
  });

  it("does not care what order evidence arrives in", () => {
    const a = piece({ sequence: 1, valence: -0.8, targetId: "p2" });
    const b = piece({ sequence: 2, valence: 0.3, targetId: "p2" });
    const forward = new EvilOdds({ decay: 1 });
    const backward = new EvilOdds({ decay: 1 });
    forward.absorb([a, b], 1);
    backward.absorb([b, a], 1);
    expect(backward.get("p2")).toBeCloseTo(forward.get("p2"), 12);
  });

  it("counts one voice at full weight however it is clustered", () => {
    // A cluster of one has design effect 1 and must be untouched, or every
    // sparse channel silently loses strength.
    const plain = new EvilOdds({ decay: 1 });
    const discounted = new EvilOdds({ decay: 1, rho: 0.5 });
    plain.absorb([piece()], 1);
    discounted.absorb([piece()], 1);
    expect(discounted.get("p2")).toBeCloseTo(plain.get("p2"), 12);
  });

  it("discounts a cluster by its design effect, and only within it", () => {
    const four = [
      piece({ sequence: 1, speakerId: "p1", targetId: "p2", valence: -1 }),
      piece({ sequence: 2, speakerId: "p3", targetId: "p2", valence: -1 }),
      piece({ sequence: 3, speakerId: "p4", targetId: "p2", valence: -1 }),
      piece({ sequence: 4, speakerId: "p5", targetId: "p2", valence: -1 }),
    ];
    const plain = new EvilOdds({ decay: 1, ceiling: 99 });
    const discounted = new EvilOdds({ decay: 1, ceiling: 99, rho: 0.25 });
    plain.absorb(four, 1);
    discounted.absorb(four, 1);
    // D = 1 + (4 - 1) * 0.25 = 1.75
    expect(discounted.get("p2")).toBeCloseTo(plain.get("p2") / 1.75, 10);

    // A different target is a different cluster and keeps its own size: the
    // lone stance about p6 is not dragged down by the four about p2.
    const alone = piece({ sequence: 5, speakerId: "p1", targetId: "p6" });
    const mixed = new EvilOdds({ decay: 1, ceiling: 99, rho: 0.25 });
    const solo = new EvilOdds({ decay: 1, ceiling: 99 });
    mixed.absorb([...four, alone], 1);
    solo.absorb([alone], 1);
    expect(mixed.get("p6")).toBeCloseTo(solo.get("p6"), 12);
  });

  it("clusters by round as well as target", () => {
    const spread = [
      piece({ sequence: 1, missionNumber: 1, speakerId: "p1", valence: -1 }),
      piece({ sequence: 2, missionNumber: 2, speakerId: "p3", valence: -1 }),
    ];
    const together = [
      piece({ sequence: 1, missionNumber: 1, speakerId: "p1", valence: -1 }),
      piece({ sequence: 2, missionNumber: 1, speakerId: "p3", valence: -1 }),
    ];
    const a = new EvilOdds({ decay: 1, ceiling: 99, rho: 0.5 });
    const b = new EvilOdds({ decay: 1, ceiling: 99, rho: 0.5 });
    a.absorb(spread, 1);
    b.absorb(together, 1);
    // Two rounds are two clusters of one; one round is a cluster of two.
    expect(b.get("p2")).toBeLessThan(a.get("p2"));
  });

  it("will not let one loud seat manufacture certainty", () => {
    const odds = new EvilOdds({ decay: 1, ceiling: 2.5 });
    const shouting = Array.from({ length: 200 }, (_, i) =>
      piece({ sequence: i, valence: -1 }),
    );
    odds.absorb(shouting, 1);
    expect(odds.get("p2")).toBe(2.5);
  });
});

describe("the synthetic table", () => {
  const seats = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const evil = new Set(["p2", "p5", "p6"]);

  /*
   * Averaged over seeds on purpose. The claim is about the generator, and one
   * round is about eighteen stances — few enough that a single draw lands a
   * fifth of a point off zero without anything being wrong.
   */
  const meanValenceTowardEvil = (quality: number) => {
    let sum = 0;
    let n = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const rows = syntheticRound(1, {
        seats,
        evilSeats: evil,
        quality,
        rng: makeRng(seed),
      });
      for (const e of rows) {
        if (evil.has(e.speakerId) || !evil.has(e.targetId)) continue;
        sum += e.valence;
        n += 1;
      }
    }
    return sum / n;
  };

  it("says nothing at zero quality", () => {
    expect(Math.abs(meanValenceTowardEvil(0))).toBeLessThan(0.05);
  });

  it("gets more accusatory toward evils as quality rises", () => {
    const low = meanValenceTowardEvil(0.2);
    const high = meanValenceTowardEvil(0.9);
    expect(high).toBeLessThan(low);
    expect(high).toBeLessThan(-0.5);
  });

  /*
   * The dial has to mean what it says. It used to be the coefficient on truth
   * before a 0.6 noise scale, so a nominal 0.31 produced stances correlated at
   * 0.48 — and a measured channel dropped into that slot was reported about
   * 1.5x stronger than it was.
   */
  it("delivers the correlation it was asked for", () => {
    const seats2 = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
    const evil2 = new Set(["p2", "p5", "p6"]);
    for (const want of [0.2, 0.4, 0.6]) {
      const v: number[] = [];
      const t: number[] = [];
      for (let seed = 1; seed <= 120; seed += 1) {
        for (const e of syntheticRound(1, {
          seats: seats2,
          evilSeats: evil2,
          quality: want,
          rng: makeRng(seed),
        })) {
          if (evil2.has(e.speakerId)) continue;
          v.push(e.valence);
          t.push(evil2.has(e.targetId) ? -1 : 1);
        }
      }
      const n = v.length;
      const mv = v.reduce((a, b) => a + b, 0) / n;
      const mt = t.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let dv = 0;
      let dt = 0;
      for (let i = 0; i < n; i += 1) {
        num += (v[i] - mv) * (t[i] - mt);
        dv += (v[i] - mv) ** 2;
        dt += (t[i] - mt) ** 2;
      }
      expect(num / Math.sqrt(dv * dt)).toBeCloseTo(want, 1);
    }
  });

  it("never lets a seat speak about itself", () => {
    const rows = syntheticRound(2, {
      seats,
      evilSeats: evil,
      quality: 0.5,
      rng: makeRng(7),
    });
    expect(rows.every((e) => e.speakerId !== e.targetId)).toBe(true);
  });

  it("has evil seats shading toward their own", () => {
    const rows = syntheticRound(1, {
      seats,
      evilSeats: evil,
      quality: 0.8,
      rng: makeRng(11),
    });
    const fromEvil = rows.filter((e) => evil.has(e.speakerId));
    const aboutTeammates = fromEvil.filter((e) => evil.has(e.targetId));
    const aboutGood = fromEvil.filter((e) => !evil.has(e.targetId));
    const mean = (xs: SocialEvidence[]) =>
      xs.reduce((a, e) => a + e.valence, 0) / xs.length;
    expect(mean(aboutTeammates)).toBeGreaterThan(mean(aboutGood));
  });
});
