import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conclusionConsistency,
  renderCognition,
  renderStanding,
  resolvePremises,
  validateConclusion,
  DECISION_PROTOCOL_LAYER,
  PROTOCOL_VERSION,
  type BoundedCognitionUpdate,
  type StructuredConclusion,
} from "./protocol";
import { deriveConstraint, emptyDossier, type Hypothesis } from "./ledger";
import { COGNITION_LIMITS } from "./limits";
import { SEATS, type Seat } from "../core/types";

/**
 * The protocol's job is to make one specific failure impossible to express:
 * a conclusion that quietly outranks its own weakest premise.
 *
 * Everything here is offline. No model is called, and the layer text is
 * asserted to be a constant — a system layer that varied per seat would miss
 * the prompt cache on every one of a game's ~150 requests.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("cognition tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK: StructuredConclusion = {
  factsUsed: ["f10", "f17"],
  claimsReliedOn: [],
  claimsQuestioned: ["c40"],
  alternativesConsidered: ["否掉这辆车", "上票并记录"],
  selectedActionSummary: "反对，理由是二车约束还没被解释",
  intendedPublicSignal: "让 6 号必须回答前提问题",
  updatedRolePlan: null,
};

describe("the conclusion shape", () => {
  it("accepts a well-formed one", () => {
    expect(validateConclusion(OK)).toEqual([]);
    expect(conclusionConsistency(OK)).toEqual([]);
  });

  it("requires at least two alternatives, because one is not a comparison", () => {
    const single = { ...OK, alternativesConsidered: ["上票"] };
    expect(validateConclusion(single).some((v) => v.path === "alternativesConsidered")).toBe(true);
  });

  it("caps every bounded field", () => {
    const long = "很".repeat(COGNITION_LIMITS.selectedActionSummaryChars + 10);
    expect(
      validateConclusion({ ...OK, selectedActionSummary: long }).some(
        (v) => v.path === "selectedActionSummary" && v.kind === "chars",
      ),
    ).toBe(true);
    expect(
      validateConclusion({
        ...OK,
        factsUsed: Array.from({ length: COGNITION_LIMITS.maxFactsUsed + 3 }, (_, i) => `f${i}`),
      }).some((v) => v.path === "factsUsed"),
    ).toBe(true);
  });

  it("rejects a claim listed as both relied on and questioned", () => {
    // Hedging is not classification, and step 4 exists to force the choice.
    const hedged = { ...OK, claimsReliedOn: ["c40"], claimsQuestioned: ["c40"] };
    const problems = conclusionConsistency(hedged);
    expect(problems.map((p) => p.code)).toContain("claim_both_ways");
  });

  it("catches duplicated facts", () => {
    expect(
      conclusionConsistency({ ...OK, factsUsed: ["f1", "f1"] }).map((p) => p.code),
    ).toContain("duplicate_facts");
  });
});

describe("premise resolution", () => {
  const update = (premiseVerified: boolean[]): BoundedCognitionUpdate => ({
    constraints: [
      {
        id: "k1",
        statement: "2、3、5 恰有两坏",
        premiseIds: ["f-mission2", "c-selfclaim"],
        premiseVerified,
        premiseLabels: ["第二轮两张失败票", "6号自称忠臣"],
      },
    ],
    hypotheses: [],
    seatReads: [],
    selfUpdate: {
      rolePlan: "",
      intendedSignal: "",
      coverStory: "",
      claimPlan: "",
      nextTurnPlan: "",
      newCommitments: [],
    },
  });

  const isFact = (id: string) => id.startsWith("f-");

  it("overrides a model that marks its own assumption verified", () => {
    // Without this the `restsOnUnverified` flag would be self-certified, and
    // the entire ledger guarantee would be a model promising to be honest.
    const { constraints, overridden } = resolvePremises(update([true, true]), isFact);
    expect(overridden).toBe(1);
    expect(constraints[0].restsOnUnverified).toBe(true);
    expect(constraints[0].premises[1].verified).toBe(false);
  });

  it("also corrects a model that under-claims", () => {
    const { constraints, overridden } = resolvePremises(update([false, false]), isFact);
    expect(overridden).toBe(1);
    expect(constraints[0].premises[0].verified).toBe(true);
    // Still soft overall, because the second premise really is a claim.
    expect(constraints[0].restsOnUnverified).toBe(true);
  });

  it("leaves a wholly factual constraint hard", () => {
    const facts: BoundedCognitionUpdate = {
      ...update([true, true]),
      constraints: [
        {
          id: "k2",
          statement: "第一轮 1、3、8 至少一坏",
          premiseIds: ["f-mission1"],
          premiseVerified: [true],
          premiseLabels: ["第一轮挂了"],
        },
      ],
    };
    const { constraints, overridden } = resolvePremises(facts, isFact);
    expect(overridden).toBe(0);
    expect(constraints[0].restsOnUnverified).toBe(false);
  });

  it("treats an unknown id as unverified rather than assuming the best", () => {
    const { constraints } = resolvePremises(update([true, true]), () => false);
    expect(constraints[0].premises.every((p) => !p.verified)).toBe(true);
  });
});

describe("rendering cognition back into a prompt", () => {
  const hypotheses: Hypothesis[] = [
    {
      id: "h1",
      label: "6号说的是真的",
      evilSeats: [2, 3],
      rationale: "二车两坏，6 号只能出成",
      standing: "unresolved",
      premises: [],
      provenance: { kind: "inference", premises: [] },
    },
    {
      id: "h2",
      label: "6号在切自己出去",
      evilSeats: [6, 3],
      rationale: "自称忠臣是最便宜的一句话",
      standing: "unresolved",
      premises: [],
      provenance: { kind: "inference", premises: [] },
    },
  ];

  const dossiers = Object.fromEntries(
    SEATS.map((s) => [s, emptyDossier(s)]),
  ) as Record<Seat, ReturnType<typeof emptyDossier>>;

  it("marks an unverified constraint inline, not in a footnote", () => {
    const soft = deriveConstraint({
      id: "k",
      statement: "2、3、5 恰有两坏",
      premises: [{ id: "c1", verified: false, label: "6号自称忠臣" }],
      atSequence: 41,
    });
    const text = renderCognition({
      constraints: [soft],
      hypotheses,
      dossiers,
      seats: SEATS,
      rolePlan: "",
      commitments: [],
    });
    // The caveat has to travel with the claim. A caveat elsewhere is a caveat
    // that gets skipped when the model quotes the conclusion.
    const line = text.split("\n").find((l) => l.includes("2、3、5 恰有两坏"));
    expect(line).toContain("【前提未证实】");
    expect(line).toContain("(未证实)");
  });

  it("marks a fully verified constraint differently", () => {
    const hard = deriveConstraint({
      id: "k",
      statement: "第一轮 1、3、8 至少一坏",
      premises: [{ id: "f1", verified: true, label: "第一轮挂了" }],
      atSequence: 10,
    });
    const text = renderCognition({
      constraints: [hard],
      hypotheses,
      dossiers,
      seats: SEATS,
      rolePlan: "",
      commitments: [],
    });
    expect(text).toContain("【前提都是裁判记录】");
    expect(text).not.toContain("【前提未证实】");
  });

  it("renders both surviving worlds, not just the favoured one", () => {
    const text = renderCognition({
      constraints: [],
      hypotheses,
      dossiers,
      seats: SEATS,
      rolePlan: "",
      commitments: [],
    });
    expect(text).toContain("6号说的是真的");
    expect(text).toContain("6号在切自己出去");
  });

  it("carries standing commitments so the agent can be held to them", () => {
    const text = renderCognition({
      constraints: [],
      hypotheses,
      dossiers,
      seats: SEATS,
      rolePlan: "先不跳，观察 7 和 9",
      commitments: ["终单不乱换我投赞成"],
    });
    expect(text).toContain("先不跳，观察 7 和 9");
    expect(text).toContain("终单不乱换我投赞成");
    expect(text).toContain("要么兑现，要么明说改了");
  });

  it("uses categorical standings and never a number", () => {
    for (const c of ["strong-good", "lean-good", "unresolved", "lean-evil", "strong-evil"] as const) {
      const label = renderStanding(c);
      expect(label).toBeTruthy();
      // A probability in a prompt is the data-informed-prompting mistake in a
      // different costume.
      expect(label).not.toMatch(/\d/);
      expect(label).not.toContain("%");
    }
  });
});

describe("the layer itself", () => {
  it("is a constant with a version", () => {
    expect(PROTOCOL_VERSION).toMatch(/^cognition-protocol-/);
    expect(DECISION_PROTOCOL_LAYER).toBe(DECISION_PROTOCOL_LAYER);
  });

  it("names all fourteen steps", () => {
    for (let i = 1; i <= 14; i += 1) {
      expect(DECISION_PROTOCOL_LAYER).toContain(`${i}. `);
    }
  });

  it("states the two rules the paid games actually got wrong", () => {
    // Experiment 3 lost on both of these, in one seat, in one speech.
    expect(DECISION_PROTOCOL_LAYER).toContain("最多和它最弱的前提一样硬");
    expect(DECISION_PROTOCOL_LAYER).toContain("「我没有证据」和「我同意」是两回事");
  });
});
