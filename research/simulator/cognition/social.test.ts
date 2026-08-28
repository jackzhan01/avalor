import { describe, expect, it } from "vitest";
import { drive, referenceDeal, testConfig } from "../fixtures/harness";
import { observationFor } from "../core/observation";
import { SEATS, type Seat } from "../core/types";
import { buildFactRegistry, CURRENT_STATE_ID, PRIVATE_IDS } from "./fact-ids";
import { ledgerFrom } from "./ledger";
import { limitsFor } from "./limits";
import {
  applySocial,
  checkSocialBounds,
  parseSocial,
  renderSocial,
  socialFragment,
  socialProblems,
  type SocialWire,
} from "./social";

/**
 * The bounded social model.
 *
 * Two things are being defended here, and they pull in opposite directions.
 * The block has to be rich enough to represent "I am following 6号's exclusion
 * of 3, and here is what would make me stop" — and it has to stay a set of
 * CONCLUSIONS, because a free-text field for reasoning is a prompt that grows
 * without a ceiling and two paid games have already died on ceilings.
 */

const CONFIG = testConfig();
const L = limitsFor("prompt-0.3.1");

function wire(patch: Partial<SocialWire> = {}): SocialWire {
  return {
    focalCandidates: [
      {
        seat: 6,
        basisIds: [CURRENT_STATE_ID],
        claimedRole: null,
        influence: "medium",
        credibility: "contested",
        directive: "下一车避开首轮失败位",
        reasonsToFollow: ["理由能对上裁判记录"],
        reasonsToChallenge: ["还没有结果检验过"],
        conditionToReconsider: "他推的车挂了就重看",
      },
    ],
    alignment: {
      stance: "conditional-follow",
      focalSeat: 6,
      proposition: "下一车应该避开第一轮失败车的三个人",
      strongestSupport: "第一轮的失败是裁判记录",
      publicAction: "公开说明我接住的是这一条，并据此投票",
    },
    coalitionPlan: {
      coordinateWith: [1, 5],
      proposedTeam: [1, 5, 6],
      votingBloc: "approve",
      messageObjective: "让 1、5 知道我按哪条标准走",
      strongestDissent: "避开失败车不等于剩下的人都干净",
    },
    ...patch,
  };
}

function ok(input: SocialWire) {
  const parsed = parseSocial(input as unknown);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.social;
}

function errorOf(input: unknown): string {
  const parsed = parseSocial(input);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? "" : parsed.error;
}

describe("the block is a set of conclusions, not a scratchpad", () => {
  it("has no free-text reasoning field anywhere in the schema", () => {
    const json = JSON.stringify(socialFragment(L));
    for (const forbidden of ["reasoning", "analysis", "notes", "thoughts", "chainOfThought"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it("does not let the model assert whether its basis is verified", () => {
    // Same rule as `premiseVerified`: a field the system overwrites is a field
    // somebody will eventually trust.
    const json = JSON.stringify(socialFragment(L));
    expect(json).not.toContain("restsOnUnverified");
    expect(json).not.toContain("basisVerified");
  });

  it("caps every list it offers", () => {
    const fragment = socialFragment(L) as {
      properties: Record<string, { maxItems?: number; properties?: Record<string, { maxItems?: number }> }>;
    };
    expect(fragment.properties.focalCandidates.maxItems).toBe(L.maxFocalCandidates);
    expect(
      fragment.properties.coalitionPlan.properties?.coordinateWith.maxItems,
    ).toBe(L.maxCoordinateWith);
  });
});

describe("parsing refuses the things that make a social read useless", () => {
  it("accepts a well-formed block", () => {
    expect(ok(wire()).alignment.focalSeat).toBe(6);
  });

  it("refuses a focal read with no public basis", () => {
    const error = errorOf(
      wire({
        focalCandidates: [{ ...wire().focalCandidates[0], basisIds: [] }],
      }),
    );
    expect(error).toContain("basisIds");
  });

  it("refuses a focal read that cannot say what would change it", () => {
    const error = errorOf(
      wire({
        focalCandidates: [{ ...wire().focalCandidates[0], conditionToReconsider: "" }],
      }),
    );
    expect(error).toContain("conditionToReconsider");
  });

  it("refuses following or challenging nobody in particular", () => {
    const error = errorOf(
      wire({ alignment: { ...wire().alignment, focalSeat: null } }),
    );
    expect(error).toContain("focalSeat");
  });

  it("allows `independent` with no focal seat", () => {
    const parsed = ok(
      wire({
        alignment: { ...wire().alignment, stance: "independent", focalSeat: null },
      }),
    );
    expect(parsed.alignment.stance).toBe("independent");
  });

  it("refuses an empty proposition — 「我同意」 is not an alignment", () => {
    const error = errorOf(wire({ alignment: { ...wire().alignment, proposition: "" } }));
    expect(error).toContain("proposition");
  });

  it("refuses an empty public action", () => {
    const error = errorOf(wire({ alignment: { ...wire().alignment, publicAction: "" } }));
    expect(error).toContain("publicAction");
  });

  it("refuses a plan that has not named the strongest objection to itself", () => {
    const error = errorOf(
      wire({ coalitionPlan: { ...wire().coalitionPlan, strongestDissent: "" } }),
    );
    expect(error).toContain("strongestDissent");
  });

  it("names the field, not just 'invalid'", () => {
    // A repair note costs a whole request. It should teach something.
    for (const broken of [
      wire({ focalCandidates: [{ ...wire().focalCandidates[0], influence: "huge" as never }] }),
      wire({ coalitionPlan: { ...wire().coalitionPlan, votingBloc: "maybe" as never } }),
    ]) {
      const error = errorOf(broken);
      expect(error.startsWith("social.")).toBe(true);
    }
  });
});

describe("cross-field problems a size limit cannot express", () => {
  it("catches following a seat that is not being tracked", () => {
    const problems = socialProblems(
      wire({ alignment: { ...wire().alignment, focalSeat: 9 } }),
    );
    expect(problems.join(" ")).toContain("focalCandidates 里没有他");
  });

  it("catches a candidate with neither a reason to follow nor a reason to challenge", () => {
    const problems = socialProblems(
      wire({
        focalCandidates: [
          { ...wire().focalCandidates[0], reasonsToFollow: [], reasonsToChallenge: [] },
        ],
      }),
    );
    expect(problems.join(" ")).toContain("不是焦点");
  });

  it("catches the same seat listed twice", () => {
    const one = wire().focalCandidates[0];
    const problems = socialProblems(wire({ focalCandidates: [one, one] }));
    expect(problems.join(" ")).toContain("重复座位");
  });

  it("passes a clean block", () => {
    expect(socialProblems(wire())).toHaveLength(0);
  });
});

describe("bounds are reported, never truncated", () => {
  it("flags an over-long directive and keeps the text whole", () => {
    const long = "很".repeat(L.focalDirectiveChars + 40);
    const input = wire({
      focalCandidates: [{ ...wire().focalCandidates[0], directive: long }],
    });
    const violations = checkSocialBounds(input, L);
    expect(violations.some((v) => v.path.includes("directive"))).toBe(true);
    // The parser is unaffected: bounds are telemetry, not a gate.
    expect(ok(input).focalCandidates[0].directive).toBe(long);
  });

  it("reports nothing for a block inside its limits", () => {
    expect(checkSocialBounds(wire(), L)).toHaveLength(0);
  });
});

describe("the one-way valve applies here too", () => {
  const played = drive({
    deal: referenceDeal(),
    config: CONFIG,
    stopWhen: (state) => state.missionNumber >= 2,
  });

  function registryFor(seat: Seat) {
    const observation = observationFor(played.state, seat);
    const ledger = ledgerFrom(observation, SEATS);
    return buildFactRegistry(ledger.publicFacts, ledger.claims, observation);
  }

  it("computes restsOnUnverified from the basis, not from the model", () => {
    const registry = registryFor(4);
    const hard = applySocial(4, wire(), registry, 20);
    expect(hard.focalCandidates[0].restsOnUnverified).toBe(false);

    const soft = applySocial(
      4,
      wire({
        focalCandidates: [{ ...wire().focalCandidates[0], basisIds: ["f_made_up"] }],
      }),
      registry,
      20,
    );
    expect(soft.focalCandidates[0].restsOnUnverified).toBe(true);
  });

  it("refuses another seat's private id as a basis for a focal read", () => {
    // Seat 4 is loyal. Percival's pair is not its to cite, however it learned it.
    const model = applySocial(
      4,
      wire({
        focalCandidates: [
          { ...wire().focalCandidates[0], basisIds: [PRIVATE_IDS.percivalPair] },
        ],
      }),
      registryFor(4),
      20,
    );
    expect(model.focalCandidates[0].restsOnUnverified).toBe(true);
  });

  it("records a claimed role as claimed, never as known", () => {
    const model = applySocial(
      4,
      wire({
        focalCandidates: [{ ...wire().focalCandidates[0], claimedRole: "percival" }],
      }),
      registryFor(4),
      20,
    );
    expect(model.focalCandidates[0].claimedRole).toBe("percival");
    // And nothing about the model says the claim is true.
    expect(JSON.stringify(model)).not.toContain("isPercival");
  });

  it("freezes what it produces", () => {
    const model = applySocial(4, wire(), registryFor(4), 20);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.focalCandidates)).toBe(true);
  });
});

describe("rendering it back", () => {
  it("marks a focal read that rests on somebody's word", () => {
    const played = drive({
      deal: referenceDeal(),
      config: CONFIG,
      stopWhen: (state) => state.sequence > 12,
    });
    const observation = observationFor(played.state, 4);
    const registry = buildFactRegistry([], [], observation);
    const soft = applySocial(
      4,
      wire({ focalCandidates: [{ ...wire().focalCandidates[0], basisIds: ["c1:role"] }] }),
      registry,
      20,
    );
    const text = renderSocial(soft);
    expect(text).toContain("【依据里有未证实的】");
    expect(text).toContain("什么会让你改");
    expect(text).toContain("必须回答的最强反对");
  });

  it("renders nothing for a seat that has no social model yet", () => {
    expect(renderSocial(null)).toBe("");
  });
});

describe("the version gate", () => {
  it("gives 0.3.1 the wider hypothesis and commitment bounds", () => {
    expect(limitsFor("prompt-0.3.1").maxHypotheses).toBe(6);
    expect(limitsFor("prompt-0.3.1").maxPublicCommitments).toBe(12);
  });

  it("leaves the completed pilot's bounds exactly where they were", () => {
    expect(limitsFor("prompt-0.3.0").maxHypotheses).toBe(4);
    expect(limitsFor("prompt-0.3.0").maxPublicCommitments).toBe(8);
    expect(limitsFor("prompt-0.2.0").maxHypotheses).toBe(4);
  });

  it("leaves the bounds the pilot came nowhere near alone", () => {
    // Evidence peaked at 21% of its cap and constraints at 33%. Moving a limit
    // nothing approached would be a change with no measurement behind it.
    for (const key of ["evidenceForPerSeat", "maxDerivedConstraints", "evidenceChars"] as const) {
      expect(limitsFor("prompt-0.3.1")[key]).toBe(limitsFor("prompt-0.3.0")[key]);
    }
  });
});
