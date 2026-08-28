import { describe, expect, it } from "vitest";
import { dealFromAssignment, dealRoles } from "./deal";
import { makeRng } from "./rng";
import { evilRoster, knowledgeFor, renderKnowledge } from "./visibility";
import { SEATS, type RoleType, type Seat } from "./types";

/**
 * The reference table, so every expected answer below can be checked by eye:
 *
 *   1 梅林   2 派西维尔   3-6 忠臣   7 莫甘娜   8 刺客   9 莫德雷德   10 奥伯伦
 */
const REFERENCE: Readonly<Record<Seat, RoleType>> = {
  1: "merlin",
  2: "percival",
  3: "loyal",
  4: "loyal",
  5: "loyal",
  6: "loyal",
  7: "morgana",
  8: "assassin",
  9: "mordred",
  10: "oberon",
};

const deal = dealFromAssignment(REFERENCE);

describe("Merlin", () => {
  it("sees every evil except Mordred — Oberon included", () => {
    const knowledge = knowledgeFor(deal, 1);
    expect(knowledge.kind).toBe("sees_evil");
    if (knowledge.kind !== "sees_evil") throw new Error("unreachable");
    expect(knowledge.seats).toEqual([7, 8, 10]);
  });

  it("cannot see Mordred", () => {
    const knowledge = knowledgeFor(deal, 1);
    if (knowledge.kind !== "sees_evil") throw new Error("unreachable");
    expect(knowledge.seats).not.toContain(9);
  });

  it("is shown sides, never roles", () => {
    // Merlin knowing WHICH of them is the Assassin would change the whole
    // endgame. The type has no field for it and neither does the rendering.
    const rendered = renderKnowledge(knowledgeFor(deal, 1));
    expect(rendered).not.toContain("morgana");
    expect(rendered).not.toContain("莫甘娜");
    expect(rendered).not.toContain("刺客");
  });
});

describe("Percival", () => {
  it("is given the Merlin/Morgana pair", () => {
    const knowledge = knowledgeFor(deal, 2);
    expect(knowledge.kind).toBe("merlin_or_morgana");
    if (knowledge.kind !== "merlin_or_morgana") throw new Error("unreachable");
    expect(knowledge.pair).toEqual([1, 7]);
  });

  /**
   * The property that makes Percival Percival. If the pair were ordered — say,
   * Merlin first — then a model that noticed the ordering would be reading the
   * answer, and the whole role would collapse.
   */
  it("gets an identical view when Merlin and Morgana swap seats", () => {
    const swapped = dealFromAssignment({ ...REFERENCE, 1: "morgana", 7: "merlin" });
    expect(knowledgeFor(swapped, 2)).toEqual(knowledgeFor(deal, 2));
    expect(renderKnowledge(knowledgeFor(swapped, 2))).toBe(
      renderKnowledge(knowledgeFor(deal, 2)),
    );
  });

  it("stays swap-invariant wherever the two happen to sit", () => {
    // Exchanging the two cards inside an existing deal, rather than moving them
    // to arbitrary seats — that keeps the composition legal, which is the only
    // way the swap is a swap and not a different game.
    for (let seed = 1; seed <= 200; seed += 1) {
      const forward = dealRoles(makeRng(seed));
      const bySeat = { ...forward.bySeat } as Record<Seat, RoleType>;
      bySeat[forward.merlin] = "morgana";
      bySeat[forward.morgana] = "merlin";
      const reversed = dealFromAssignment(bySeat);
      expect(reversed.percival).toBe(forward.percival);
      expect(knowledgeFor(reversed, forward.percival)).toEqual(
        knowledgeFor(forward, forward.percival),
      );
    }
  });
});

describe("loyal servants", () => {
  it("see nobody", () => {
    for (const seat of [3, 4, 5, 6] as const) {
      expect(knowledgeFor(deal, seat)).toEqual({ kind: "none" });
    }
  });
});

describe("the evil side", () => {
  it("gives Morgana, the Assassin and Mordred each other, as sides only", () => {
    expect(knowledgeFor(deal, 7)).toEqual({ kind: "knows_teammates", seats: [8, 9] });
    expect(knowledgeFor(deal, 8)).toEqual({ kind: "knows_teammates", seats: [7, 9] });
    expect(knowledgeFor(deal, 9)).toEqual({ kind: "knows_teammates", seats: [7, 8] });
  });

  it("hides Oberon from his own team", () => {
    for (const seat of [7, 8, 9] as const) {
      const knowledge = knowledgeFor(deal, seat);
      if (knowledge.kind !== "knows_teammates") throw new Error("unreachable");
      expect(knowledge.seats).not.toContain(10);
    }
  });

  it("leaves Oberon blind", () => {
    expect(knowledgeFor(deal, 10)).toEqual({ kind: "none" });
  });

  it("means Mordred is visible to his team even though Merlin cannot see him", () => {
    // The two rules are independent and it is easy to conflate them: Mordred is
    // hidden from Merlin, not from anyone else.
    const merlin = knowledgeFor(deal, 1);
    if (merlin.kind !== "sees_evil") throw new Error("unreachable");
    expect(merlin.seats).not.toContain(9);
    const morgana = knowledgeFor(deal, 7);
    if (morgana.kind !== "knows_teammates") throw new Error("unreachable");
    expect(morgana.seats).toContain(9);
  });
});

describe("nobody learns an exact role before the assassination", () => {
  it("has no representation for another seat's role", () => {
    // Structural, not behavioural: `PrivateKnowledge` carries seats and a kind,
    // never a role, so this cannot be got wrong by a future edit that forgets.
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = dealRoles(makeRng(seed));
      for (const seat of SEATS) {
        const knowledge = knowledgeFor(random, seat);
        expect(Object.keys(knowledge).sort()).not.toContain("role");
        // `kind` is a discriminant and may say "merlin_or_morgana"; what must
        // never appear is a role as a VALUE, which is what would name somebody.
        const { kind: _discriminant, ...payload } = knowledge;
        void _discriminant;
        expect(JSON.stringify(payload)).not.toMatch(
          /merlin|percival|loyal|morgana|mordred|assassin|oberon|minion/,
        );
      }
    }
  });
});

describe("the evil roster", () => {
  it("names all four exact roles, in seat order", () => {
    expect(evilRoster(deal)).toEqual([
      { seat: 7, role: "morgana" },
      { seat: 8, role: "assassin" },
      { seat: 9, role: "mordred" },
      { seat: 10, role: "oberon" },
    ]);
  });

  it("includes Oberon, who played the whole game blind", () => {
    expect(evilRoster(deal).map((e) => e.seat)).toContain(10);
  });
});

describe("consistency across random deals", () => {
  it("always shows Merlin exactly the three evils that are not Mordred", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = dealRoles(makeRng(seed));
      const knowledge = knowledgeFor(random, random.merlin);
      if (knowledge.kind !== "sees_evil") throw new Error("unreachable");
      expect(knowledge.seats).toHaveLength(3);
      expect(knowledge.seats).not.toContain(random.mordred);
      expect(new Set(knowledge.seats)).toEqual(
        new Set([random.morgana, random.assassin, random.oberon]),
      );
    }
  });

  it("always gives each recognising villain exactly the other two", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = dealRoles(makeRng(seed));
      for (const seat of [random.morgana, random.assassin, random.mordred]) {
        const knowledge = knowledgeFor(random, seat);
        if (knowledge.kind !== "knows_teammates") throw new Error("unreachable");
        expect(knowledge.seats).toHaveLength(2);
        expect(knowledge.seats).not.toContain(seat);
        expect(knowledge.seats).not.toContain(random.oberon);
      }
      expect(knowledgeFor(random, random.oberon)).toEqual({ kind: "none" });
    }
  });
});
