import { describe, expect, it } from "vitest";
import { SEATS } from "../core/types";
import {
  assignPersonas,
  NEUTRAL_PERSONA,
  personaById,
  PERSONA_MODES,
  PERSONAS,
  renderPersona,
  type PersonaDefinition,
} from "./personas";

/**
 * A persona describes HOW someone talks, never WHAT they are.
 *
 * The scans below are blunt on purpose. A persona that needs the word 「坏人」
 * or 「视野」 has stopped being a communication style and become a strategy or
 * a leak, and the right response is to rewrite it rather than to widen the
 * filter. Personas are re-assigned across seats every game precisely so that
 * "does this style help" and "does this seat win" stay separable questions;
 * if a persona also implied a side, neither question would mean anything.
 */

/** Role names, in both languages. None may appear anywhere in a persona. */
const ROLE_WORDS = [
  "merlin",
  "percival",
  "loyal",
  "morgana",
  "mordred",
  "assassin",
  "oberon",
  "minion",
  "梅林",
  "派西维尔",
  "忠臣",
  "莫甘娜",
  "莫德雷德",
  "刺客",
  "奥伯伦",
  "爪牙",
];

/** Anything that would tell a persona which side it is on. */
const SIDE_WORDS = ["好人", "坏人", "阵营", "正义", "邪恶", "同伴", "队友"];

/** Anything that would smuggle a private game fact into a style description. */
const PRIVATE_WORDS = ["我知道", "我看到", "视野", "发牌", "底牌", "身份是"];

/** Role-specific tactics belong to the strategy layer, not here. */
const TACTIC_WORDS = ["跳派", "反跳", "验人", "刺杀", "出坏票", "上车名单"];

function textOf(persona: PersonaDefinition): string {
  return `${persona.id} ${persona.name} ${persona.text} ${renderPersona(persona)}`;
}

describe("the draft persona set", () => {
  it("has ten distinct personas", () => {
    expect(PERSONAS).toHaveLength(10);
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(10);
    expect(new Set(PERSONAS.map((p) => p.name)).size).toBe(10);
  });

  it("is honestly labelled as a draft", () => {
    // Nothing here has been reviewed by a human or validated against a run.
    for (const persona of PERSONAS) expect(persona.status).toBe("draft");
  });

  it("names no role, in either language", () => {
    for (const persona of PERSONAS) {
      const text = textOf(persona);
      for (const word of ROLE_WORDS) {
        expect(text.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it("implies no side", () => {
    for (const persona of PERSONAS) {
      const text = textOf(persona);
      for (const word of SIDE_WORDS) expect(text).not.toContain(word);
    }
  });

  it("carries no private game fact", () => {
    for (const persona of PERSONAS) {
      const text = textOf(persona);
      for (const word of PRIVATE_WORDS) expect(text).not.toContain(word);
    }
  });

  it("prescribes no role-specific tactic", () => {
    for (const persona of PERSONAS) {
      const text = textOf(persona);
      for (const word of TACTIC_WORDS) expect(text).not.toContain(word);
    }
  });

  it("actually spreads out, rather than being ten shades of one voice", () => {
    const spread = (pick: (p: PersonaDefinition) => unknown) =>
      new Set(PERSONAS.map(pick)).size;
    expect(spread((p) => p.dials.assertiveness)).toBeGreaterThanOrEqual(4);
    expect(spread((p) => p.dials.verbosity)).toBeGreaterThanOrEqual(4);
    expect(spread((p) => p.dials.riskTolerance)).toBeGreaterThanOrEqual(3);
    expect(spread((p) => p.dials.evidencePreference)).toBe(3);
    expect(spread((p) => p.dials.conflictStyle)).toBe(3);
  });

  it("renders in Chinese, with the 220-character limit restated", () => {
    for (const persona of PERSONAS) {
      const rendered = renderPersona(persona);
      expect(rendered).toContain("## 二、你的说话风格");
      expect(rendered).toContain("220");
      expect(rendered).toContain("跟你拿到什么牌完全无关");
    }
  });

  it("looks up by id and complains about a name nobody defined", () => {
    expect(personaById("steady").id).toBe("steady");
    expect(() => personaById("nope")).toThrow(/unknown persona/);
  });
});

describe("the neutral control persona", () => {
  it("is not one of the ten", () => {
    expect(PERSONAS.map((p) => p.id)).not.toContain(NEUTRAL_PERSONA.id);
    expect(personaById("neutral")).toBe(NEUTRAL_PERSONA);
  });

  it("sits in the middle of every dial and steers nothing", () => {
    // Reusing one of the ten as the control would quietly make its style the
    // reference point every heterogeneous result was measured against.
    const d = NEUTRAL_PERSONA.dials;
    expect(d.assertiveness).toBe(3);
    expect(d.verbosity).toBe(3);
    expect(d.riskTolerance).toBe(3);
    expect(d.coalitionBuilding).toBe(3);
    expect(d.skepticism).toBe(3);
    expect(d.revisionWillingness).toBe(3);
    expect(d.evidencePreference).toBe("balanced");
  });

  it("obeys the same content rules as the ten", () => {
    const text = textOf(NEUTRAL_PERSONA);
    for (const word of [...ROLE_WORDS, ...SIDE_WORDS, ...PRIVATE_WORDS, ...TACTIC_WORDS]) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe("the two assignment modes", () => {
  it("gives every seat the same neutral persona in the homogeneous arm", () => {
    const table = assignPersonas(5, "homogeneous-neutral");
    for (const seat of SEATS) expect(table[seat].id).toBe("neutral");
    expect(new Set(SEATS.map((s) => table[s].id)).size).toBe(1);
  });

  it("gives ten distinct personas in the heterogeneous arm", () => {
    const table = assignPersonas(5, "heterogeneous-rotated");
    expect(new Set(SEATS.map((s) => table[s].id)).size).toBe(10);
    expect(SEATS.map((s) => table[s].id)).not.toContain("neutral");
  });

  it("defaults to the heterogeneous arm", () => {
    const explicit = assignPersonas(31, "heterogeneous-rotated");
    const implicit = assignPersonas(31);
    for (const seat of SEATS) expect(implicit[seat].id).toBe(explicit[seat].id);
  });

  it("is deterministic in both modes", () => {
    for (const mode of PERSONA_MODES) {
      const a = assignPersonas(77, mode);
      const b = assignPersonas(77, mode);
      for (const seat of SEATS) expect(b[seat].id).toBe(a[seat].id);
    }
  });

  it("makes the homogeneous arm seed-independent, which is the point of a control", () => {
    // Nothing about the control may vary between games, or it stops being one.
    const a = assignPersonas(1, "homogeneous-neutral");
    const b = assignPersonas(999, "homogeneous-neutral");
    for (const seat of SEATS) expect(b[seat].id).toBe(a[seat].id);
  });
});

describe("persona assignment", () => {
  it("is deterministic for a seed", () => {
    const a = assignPersonas(77);
    const b = assignPersonas(77);
    for (const seat of SEATS) expect(b[seat].id).toBe(a[seat].id);
  });

  it("gives all ten seats a persona", () => {
    const table = assignPersonas(5);
    for (const seat of SEATS) expect(table[seat]).toBeDefined();
    expect(new Set(SEATS.map((s) => table[s].id)).size).toBe(10);
  });

  /**
   * The property that keeps a batch interpretable: if a persona were welded to
   * a seat, "seat 3 wins more" and "the 顶 persona wins more" would be the same
   * number and neither could be read.
   */
  it("does not weld a persona to a seat across a batch", () => {
    const seatsFor = new Map<string, Set<number>>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const table = assignPersonas(seed);
      for (const seat of SEATS) {
        const set = seatsFor.get(table[seat].id) ?? new Set<number>();
        set.add(seat);
        seatsFor.set(table[seat].id, set);
      }
    }
    for (const persona of PERSONAS) {
      // Every persona should have sat in most of the ten seats over sixty games.
      expect(seatsFor.get(persona.id)!.size).toBeGreaterThanOrEqual(8);
    }
  });
});
