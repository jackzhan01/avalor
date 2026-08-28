import { describe, expect, it } from "vitest";
import { loadProfile } from "../config/load";
import { fusedSchemaFor } from "./build-cognitive";
import { taskSchemaFor } from "../prompts/tasks";
import { limitsFor } from "./limits";
import { parseCognition } from "./response";
import type { Fragment } from "../model/json-schema";

/**
 * The five re-asks the M5 pilot actually had, one regression each.
 *
 * They were reported as "four invalid votes and one invalid speech". They were
 * not: replaying the game and re-submitting each recorded answer showed the
 * referee accepted every one of them. All five were the `cognition` block, and
 * `live-game.ts` marks the last attempt `appliedLegalAction = false` for BOTH
 * kinds of repairable rejection, so the analysis script could only guess which
 * had happened — and guessed wrong, in a shipped report.
 *
 * The two defects:
 *
 *   FOUR × EMPTY `premiseIds`.  Seat 8 wrote premiseLabels of real quality —
 *     "裁判记录：R1#1正式车为8、1、3" — and an EMPTY id array, because the fact
 *     tables printed no ids to copy. The schema permitted the empty array and
 *     the parser refused it, so the model paid a whole request to discover a
 *     rule the provider could have enforced for free.
 *
 *   ONE × EMPTY hypothesis fields.  Two hypotheses with `label: ""` and
 *     `rationale: ""`. `minItems: 2` was satisfied and no world was described.
 *
 * Both are fixed at the schema, so the provider refuses first; both are also
 * still refused by the parser, because a schema is a provider's promise and a
 * parser is ours.
 */

const V2 = limitsFor("prompt-0.3.1");
const PARSE = { limits: V2, withSocial: true } as const;

/** A cognition block that is legal apart from whatever the test breaks. */
function block(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    factsUsed: ["f.now"],
    claimsReliedOn: [],
    claimsQuestioned: [],
    alternativesConsidered: ["上票", "下票"],
    selectedActionSummary: "按硬事实选",
    intendedPublicSignal: "让别人看到依据",
    updatedRolePlan: null,
    constraints: [
      {
        id: "k1",
        statement: "首轮失败车里至少有一个坏人",
        premiseIds: ["f.fail1"],
        premiseLabels: ["第一轮失败"],
      },
    ],
    hypotheses: [
      { id: "h1", label: "坏人在首车", evilSeats: [1], rationale: "失败集中", standing: "unresolved" },
      { id: "h2", label: "坏人分散", evilSeats: [2], rationale: "两次不同", standing: "unresolved" },
    ],
    seatReads: [],
    coverStory: "",
    claimPlan: "",
    nextTurnPlan: "",
    newCommitments: [],
    closedCommitments: [],
    social: {
      focalCandidates: [
        {
          seat: 6,
          basisIds: ["f.now"],
          claimedRole: null,
          influence: "medium",
          credibility: "contested",
          directive: "避开首轮失败位",
          reasonsToFollow: ["有公开依据"],
          reasonsToChallenge: ["未经检验"],
          conditionToReconsider: "他推的车挂了",
        },
      ],
      alignment: {
        stance: "conditional-follow",
        focalSeat: 6,
        proposition: "下一车避开首轮失败车三人",
        strongestSupport: "任务结果是裁判记录",
        publicAction: "复述这一条并据此投票",
      },
      coalitionPlan: {
        coordinateWith: [1],
        proposedTeam: null,
        votingBloc: "undecided",
        messageObjective: "让别人知道我的标准",
        strongestDissent: "避开不等于洗清",
      },
    },
    ...patch,
  };
}

/** The `cognition` sub-schema the 0.3.1 stack sends. */
function cognitionSchema(): Record<string, Fragment> {
  const task = taskSchemaFor(
    { kind: "vote", seat: 1, missionNumber: 1, attempt: 1, team: [1, 2, 3] } as never,
    120,
  );
  const fused = fusedSchemaFor(task, "prompt-0.3.1") as {
    properties: { cognition: { properties: Record<string, Fragment> } };
  };
  return fused.properties.cognition.properties;
}

describe("failure class 1: a constraint with no premise ids", () => {
  it("is what actually happened, four times", () => {
    // Reproduced verbatim from the pilot's trace: seat 8, R1 vote, attempt 1.
    const recorded = {
      id: "k1",
      statement: "若8、1、3本轮任务失败，至少一张失败票来自8、1、3中的坏人。",
      premiseIds: [],
      premiseLabels: [
        "裁判记录：R1#1正式车为8、1、3",
        "规则：第1轮一张失败票即可导致任务失败",
      ],
    };
    const parsed = parseCognition(block({ constraints: [recorded] }), PARSE);
    expect(parsed.ok).toBe(false);
  });

  it("is now refused by the provider, not just by us", () => {
    const constraints = cognitionSchema().constraints as {
      items: { properties: { premiseIds: { minItems?: number } } };
    };
    expect(constraints.items.properties.premiseIds.minItems).toBe(1);
  });

  it("still tells the model where the ids are", () => {
    const parsed = parseCognition(
      block({ constraints: [{ id: "k", statement: "x", premiseIds: [], premiseLabels: [] }] }),
      PARSE,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // The old message said "没有列出前提" and stopped there, which was true and
    // unhelpful: there was nothing to list.
    expect(parsed.error).toContain("premiseIds");
    expect(parsed.error).toContain("[f…]");
  });

  it("accepts the same constraint once it cites a real id", () => {
    expect(parseCognition(block(), PARSE).ok).toBe(true);
  });

  it("leaves the 0.3.0 schema permissive, because that game already ran", () => {
    const task = taskSchemaFor(
      { kind: "vote", seat: 1, missionNumber: 1, attempt: 1, team: [1, 2, 3] } as never,
      120,
    );
    const old = fusedSchemaFor(task, "prompt-0.3.0") as {
      properties: { cognition: { properties: Record<string, { items?: { properties?: Record<string, { minItems?: number }> } }> } };
    };
    expect(
      old.properties.cognition.properties.constraints.items?.properties?.premiseIds.minItems,
    ).toBeUndefined();
  });
});

describe("failure class 2: hypotheses that describe no world", () => {
  it("is what actually happened, once", () => {
    // Seat 6, R2#5 speech: two hypotheses, both entirely blank.
    const recorded = [
      { id: "h1", label: "", evilSeats: [], rationale: "", standing: "unresolved" },
      { id: "h2", label: "", evilSeats: [], rationale: "", standing: "unresolved" },
    ];
    const parsed = parseCognition(block({ hypotheses: recorded }), PARSE);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("占位的世界不是世界");
  });

  it("is now refused by the provider too", () => {
    const hypotheses = cognitionSchema().hypotheses as {
      items: { properties: { label: { minLength?: number }; rationale: { minLength?: number } } };
    };
    expect(hypotheses.items.properties.label.minLength).toBe(1);
    expect(hypotheses.items.properties.rationale.minLength).toBe(1);
  });

  it("refuses one blank among two good ones", () => {
    const parsed = parseCognition(
      block({
        hypotheses: [
          { id: "h1", label: "坏人在首车", evilSeats: [1], rationale: "理由", standing: "unresolved" },
          { id: "h2", label: "", evilSeats: [2], rationale: "理由", standing: "unresolved" },
        ],
      }),
      PARSE,
    );
    expect(parsed.ok).toBe(false);
  });

  it("keeps the completed pilot's exact repair note, because it was sent", () => {
    // 0.3.0 refused this too — that IS the pilot's fifth re-ask. What was wrong
    // was the wording, and the wording went into the retry prompt. Changing it
    // for 0.3.0 would change that game's bytes, so only 0.3.1 gets the fix.
    const blank = {
      ...block(),
      hypotheses: [
        { id: "h1", label: "", evilSeats: [], rationale: "", standing: "unresolved" },
        { id: "h2", label: "", evilSeats: [], rationale: "", standing: "unresolved" },
      ],
    };
    const old = parseCognition(blank, { limits: limitsFor("prompt-0.3.0") });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.error).toBe("cognition.hypotheses[0] 需要 id、label、standing");
  });
});

describe("the diagnosis is recorded now, not reconstructed later", () => {
  it("carries a field for who refused and why", async () => {
    // Read as source because the fields are optional and type-only: a runtime
    // check would need a rejected attempt, and `pilot-m5-1.test.ts` drives a
    // real one through `live-game.ts` and asserts the values.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("research/simulator/model/attempt.ts", "utf8"),
    );
    expect(source).toContain("rejectedBy");
    expect(source).toContain("rejectionReason");
  });

  it("keeps the referee's own rules exactly as strict as they were", async () => {
    // Part J says fix the prompt and the schema, never loosen the referee.
    const referee = await import("node:fs").then((fs) =>
      fs.readFileSync("research/simulator/core/referee.ts", "utf8"),
    );
    for (const rule of [
      "好人不能出坏票",
      "已经投过票了",
      "不能给自己表态",
      "说了「还组不出车」就不能同时给出意向车",
    ]) {
      expect(referee, rule).toContain(rule);
    }
  });
});

describe("the M5.1 profile carries the fixes", () => {
  it("pairs prompt-0.3.1 with expert-social and a 12,000 output cap", () => {
    const config = loadProfile("m5-1-pilot");
    expect(config.promptVersion).toBe("prompt-0.3.1");
    expect(config.experiment.strategyProfile).toBe("expert-social");
    expect(config.limits.maxOutputTokens).toBe(12_000);
    expect(config.cognition.maxCognitionRepairs).toBe(2);
  });

  it("refuses to run the completed pilot's arm under the new stack", () => {
    expect(() =>
      loadProfile("m5-1-pilot", { experiment: { strategyProfile: "expert-cognitive" } }),
    ).toThrow(/expert-social/);
  });

  it("leaves the completed pilot's profile exactly as it was", () => {
    const config = loadProfile("m5-pilot");
    expect(config.promptVersion).toBe("prompt-0.3.0");
    expect(config.experiment.strategyProfile).toBe("expert-cognitive");
    expect(config.limits.maxOutputTokens).toBe(20_000);
  });
});
