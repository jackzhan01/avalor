import { describe, expect, it } from "vitest";
import { drive, referenceDeal, testConfig } from "../fixtures/harness";
import { observationFor } from "../core/observation";
import { SEATS, type Action, type Seat } from "../core/types";
import { claimContestFrom, type ClaimContest } from "./claim-contest";
import { buildFactRegistry, CURRENT_STATE_ID, PRIVATE_IDS } from "./fact-ids";
import { ledgerFrom } from "./ledger";
import { limitsFor } from "./limits";
import {
  applyContest,
  checkContestBounds,
  contestFragment,
  contestProblems,
  parseContest,
  renderContest,
  ASSESSMENT_VALUES,
  CLAIM_ACT_VALUES,
  CONTEST_STANCE_VALUES,
  type ContestWire,
} from "./contest";

/**
 * The private claim-contest block.
 *
 * Two things are being defended, and they pull against each other. The block
 * has to be rich enough to represent "seat 4 and I are both claiming Percival,
 * here is how I reduce his credibility and what happens when he answers" — and
 * it has to stay a set of CONCLUSIONS, because a free-text reasoning field is a
 * prompt that grows without a ceiling and two paid games have died on ceilings.
 *
 * The third property, and the one this milestone turns on: an attack on a claim
 * is not an accusation. `currentAssessment` runs `leading → broken` and every
 * value describes the CLAIM. Nothing in the vocabulary lets a model record
 * "this claimant is evil" as a conclusion of the contest.
 */

const CONFIG = testConfig();
const L = limitsFor("prompt-0.4.0");

/* ── A position with two standing claimants ─────────────────────────────── */

function speech(patch: Partial<Extract<Action, { kind: "speech" }>> = {}) {
  return {
    kind: "speech" as const,
    publicMessage: "说点什么。",
    tentativeTeam: null,
    noTeamYet: false,
    stances: [],
    claim: null,
    ...patch,
  };
}

function speakingOrder(): Seat[] {
  const seen: Seat[] = [];
  drive({
    deal: referenceDeal(),
    config: CONFIG,
    onObservation: (o) => {
      if (o.request?.kind === "speech" && !seen.includes(o.seat)) seen.push(o.seat);
    },
    stopWhen: (state) => state.missionNumber >= 2,
  });
  return seen;
}

const ORDER = speakingOrder();
const RIVAL_A = ORDER[0];
const RIVAL_B = ORDER[1];
const BYSTANDER = SEATS.find((s) => s !== RIVAL_A && s !== RIVAL_B)!;

const CONTESTED = drive({
  deal: referenceDeal(),
  config: CONFIG,
  override: (o) => {
    if (o.request?.kind !== "speech") return undefined;
    if (o.seat === RIVAL_A || o.seat === RIVAL_B) return speech({ claim: "percival" });
    return undefined;
  },
  stopWhen: (state) => state.missionNumber >= 2,
});

const CONTEST: ClaimContest = claimContestFrom(CONTESTED.state.log);

function registryFor(seat: Seat) {
  const observation = observationFor(CONTESTED.state, seat);
  const ledger = ledgerFrom(observation, SEATS);
  return {
    observation,
    ledger,
    registry: buildFactRegistry(ledger.publicFacts, ledger.claims, observation, CONTEST),
  };
}

/* ── A legal block, and helpers to break exactly one thing ──────────────── */

function wire(patch: Partial<ContestWire> = {}): ContestWire {
  return {
    ownClaimStrategy: {
      currentStatus: "hidden",
      intendedClaimRole: null,
      situationSpecificBenefit: "现在不进场，先看两个人的车怎么组",
      situationSpecificRisk: "拖久了话语权会被其中一个拿走",
      triggerToClaim: "有人推的车会直接决定胜负时",
      triggerToRetract: "我的说法和任务结果对不上时",
      candidatePairStory: "",
      leadershipObjective: "",
      concealmentCost: "现在没有人代表我说话",
      consistencyObligations: [],
    },
    claimantAssessments: [RIVAL_A, RIVAL_B].map((seat) => ({
      claimantSeat: seat,
      claimedRole: "percival",
      claimedOrImpliedPair: null,
      positiveCase: ["目前还没有被公开记录打脸"],
      negativeCase: ["还没有结果检验过"],
      contradictions: [],
      fulfilledPredictions: [],
      failedPredictions: [],
      currentAssessment: "plausible" as const,
      conditionToUpgrade: "他推的车成功",
      conditionToDowngrade: "他推的车挂了",
      premiseIds: [CURRENT_STATE_ID],
    })),
    rivalPlans: [],
    alignment: {
      selectedClaimant: null,
      stance: "undecided",
      proposition: "现在还分不开这两个声称",
      voteOrTeamConsequence: "按公开记录投，不因为声称改票",
      conditionToSwitch: "有一辆车的结果能分开他们",
    },
    publicClaimMove: {
      act: "compare-claimants",
      targetSeats: [RIVAL_A, RIVAL_B],
      publicProposition: "两个人都要给出一辆能被检验的车",
      requestedTeam: null,
      requestedVote: "none",
      evidenceIds: [CURRENT_STATE_ID],
      informationToConceal: "",
    },
    ...patch,
  };
}

const ok = (input: ContestWire) => {
  const parsed = parseContest(input as unknown);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.contest;
};

function errorOf(input: unknown): string {
  const parsed = parseContest(input);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? "" : parsed.error;
}

const problems = (input: ContestWire, seat: Seat = BYSTANDER, teamSize: number | null = 3) =>
  contestProblems(input, { seat, contest: CONTEST, teamSize });

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe("the block is conclusions, not a scratchpad", () => {
  it("offers no free-text reasoning field anywhere", () => {
    const json = JSON.stringify(contestFragment(L));
    for (const forbidden of ["reasoning", "analysis", "notes", "thoughts", "chainOfThought"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it("does not let the model assert what the system computes", () => {
    const json = JSON.stringify(contestFragment(L));
    // Public status comes from the referee; the two `restsOn` flags come from
    // the registry. A field the system overwrites is a field somebody trusts.
    expect(json).not.toContain("publicClaimStatus");
    expect(json).not.toContain("restsOnUnverified");
    expect(json).not.toContain("evidenceResolves");
  });

  it("keeps the assessment vocabulary about the claim, not the person", () => {
    // The enums are the load-bearing part: an `evil` or `morgana` value would
    // let a model record a role conclusion as an outcome of the contest.
    for (const value of [...ASSESSMENT_VALUES, ...CONTEST_STANCE_VALUES]) {
      for (const alignment of ["evil", "good", "morgana", "percival", "merlin"]) {
        expect(value, `${value}/${alignment}`).not.toContain(alignment);
      }
    }
    // `percival` appears in the schema exactly twice, and both times as an ACT
    // — the thing a seat does, not a thing it is.
    const json = JSON.stringify(contestFragment(L));
    for (const alignment of ["evil", "good", "morgana", "merlin", "mordred", "oberon"]) {
      expect(json, alignment).not.toContain(alignment);
    }
    expect(json.match(/percival/g)).toEqual(["percival", "percival"]);
    expect(json).toContain("claim-percival");
    expect(json).toContain("counterclaim-percival");
  });

  it("offers exactly the nine acts, and nothing that means 'accuse'", () => {
    expect(CLAIM_ACT_VALUES).toHaveLength(9);
    expect(CLAIM_ACT_VALUES).toContain("attack-rival-claim");
    expect(CLAIM_ACT_VALUES).not.toContain("accuse");
  });
});

describe("parsing refuses what makes a contest read useless", () => {
  it("accepts a well-formed block", () => {
    expect(ok(wire()).claimantAssessments).toHaveLength(2);
  });

  it("refuses an assessment with no public basis", () => {
    const error = errorOf(
      wire({
        claimantAssessments: [{ ...wire().claimantAssessments[0], premiseIds: [] }],
      }),
    );
    expect(error).toContain("premiseIds");
    expect(error).toContain("[k…]");
  });

  it("refuses an assessment that cannot say what would move it", () => {
    const error = errorOf(
      wire({
        claimantAssessments: [{ ...wire().claimantAssessments[0], conditionToUpgrade: "" }],
      }),
    );
    expect(error).toContain("conditionToUpgrade");
  });

  it("refuses a candidate pair that is not two distinct seats", () => {
    for (const pair of [[3, 3], [3], [3, 4, 5]]) {
      const error = errorOf(
        wire({
          claimantAssessments: [
            { ...wire().claimantAssessments[0], claimedOrImpliedPair: pair },
          ],
        }),
      );
      expect(error, JSON.stringify(pair)).toContain("claimedOrImpliedPair");
    }
  });

  it("refuses a general benefit where a situation-specific one belongs", () => {
    const error = errorOf(
      wire({
        ownClaimStrategy: { ...wire().ownClaimStrategy, situationSpecificBenefit: "" },
      }),
    );
    expect(error).toContain("situationSpecificBenefit");
    expect(error).toContain("不是一般道理");
  });

  it("refuses an own-claim strategy with no trigger", () => {
    const error = errorOf(
      wire({ ownClaimStrategy: { ...wire().ownClaimStrategy, triggerToClaim: "" } }),
    );
    expect(error).toContain("triggerToClaim");
  });

  it("refuses supporting or opposing nobody in particular", () => {
    const error = errorOf(
      wire({ alignment: { ...wire().alignment, stance: "support", selectedClaimant: null } }),
    );
    expect(error).toContain("selectedClaimant");
  });

  it("refuses an alignment with no vote or team consequence", () => {
    const error = errorOf(
      wire({ alignment: { ...wire().alignment, voteOrTeamConsequence: "" } }),
    );
    expect(error).toContain("voteOrTeamConsequence");
  });

  it("refuses an incomplete rival plan", () => {
    const error = errorOf(
      wire({
        rivalPlans: [
          {
            rivalSeat: RIVAL_A,
            whyTheirClaimCompetesWithMine: "我们站在同一个身份上",
            attackCase: "时机对不上",
            expectedDefense: "",
            myResponse: "要求他给车",
            riskOfOverattacking: "显得我在急",
            distinctionTest: "各给一辆车",
          },
        ],
      }),
    );
    expect(error).toContain("expectedDefense");
  });

  it("refuses a public move with no proposition, even when staying hidden", () => {
    const error = errorOf(
      wire({ publicClaimMove: { ...wire().publicClaimMove, publicProposition: "" } }),
    );
    expect(error).toContain("publicProposition");
    expect(error).toContain("stay-hidden");
  });

  it("names the field rather than saying 'invalid'", () => {
    for (const broken of [
      wire({ ownClaimStrategy: { ...wire().ownClaimStrategy, currentStatus: "vibing" as never } }),
      wire({ publicClaimMove: { ...wire().publicClaimMove, act: "shout" as never } }),
      wire({ alignment: { ...wire().alignment, stance: "maybe" as never } }),
    ]) {
      expect(errorOf(broken).startsWith("contest.")).toBe(true);
    }
  });
});

describe("structural checks against the referee's own record", () => {
  it("passes a clean block", () => {
    expect(problems(wire())).toHaveLength(0);
  });

  it("refuses attacking somebody who never claimed", () => {
    const found = problems(
      wire({
        publicClaimMove: {
          ...wire().publicClaimMove,
          act: "attack-rival-claim",
          targetSeats: [BYSTANDER === 1 ? 2 : 1],
        },
      }),
    );
    expect(found.join(" ")).toContain("从来没有声称过身份");
  });

  it("refuses attacking with no target at all", () => {
    const found = problems(
      wire({
        publicClaimMove: { ...wire().publicClaimMove, act: "attack-rival-claim", targetSeats: [] },
      }),
    );
    expect(found.join(" ")).toContain("targetSeats 是空的");
  });

  it("refuses targeting yourself", () => {
    const found = problems(
      wire({
        publicClaimMove: {
          ...wire().publicClaimMove,
          act: "challenge-claimant",
          targetSeats: [BYSTANDER],
        },
      }),
      BYSTANDER,
    );
    expect(found.join(" ")).toContain("你自己");
  });

  it("refuses defending a claim you do not have", () => {
    const found = problems(
      wire({ publicClaimMove: { ...wire().publicClaimMove, act: "defend-own-claim" } }),
    );
    expect(found.join(" ")).toContain("没有成立的身份声称");
  });

  it("refuses retracting a claim you never made", () => {
    const found = problems(
      wire({ publicClaimMove: { ...wire().publicClaimMove, act: "retract-claim" } }),
    );
    expect(found.join(" ")).toContain("从来没有声称过");
  });

  it("allows defending when you ARE standing on a claim", () => {
    const found = problems(
      wire({
        ownClaimStrategy: { ...wire().ownClaimStrategy, currentStatus: "defending" },
        claimantAssessments: wire().claimantAssessments.filter((a) => a.claimantSeat !== RIVAL_A),
        rivalPlans: [
          {
            rivalSeat: RIVAL_B,
            whyTheirClaimCompetesWithMine: "同一个身份",
            attackCase: "时机对不上",
            expectedDefense: "他会说后发才看清",
            myResponse: "要求他给车",
            riskOfOverattacking: "显得我在急",
            distinctionTest: "各给一辆车",
          },
        ],
        publicClaimMove: { ...wire().publicClaimMove, act: "defend-own-claim", targetSeats: [] },
      }),
      RIVAL_A,
    );
    expect(found).toHaveLength(0);
  });

  it("refuses a counterclaim when nobody else is standing on it", () => {
    // Built against an empty contest: no claims at all.
    const empty = claimContestFrom([]);
    const found = contestProblems(
      wire({
        claimantAssessments: [],
        publicClaimMove: {
          ...wire().publicClaimMove,
          act: "counterclaim-percival",
          targetSeats: [],
        },
      }),
      { seat: BYSTANDER, contest: empty, teamSize: 3 },
    );
    expect(found.join(" ")).toContain("需要桌上已经有人在声称");
  });

  it("refuses a requested team of the wrong size", () => {
    const found = problems(
      wire({ publicClaimMove: { ...wire().publicClaimMove, requestedTeam: [1, 2, 3, 4] } }),
      BYSTANDER,
      3,
    );
    expect(found.join(" ")).toContain("这一轮的车是 3 人");
  });

  it("refuses a requested team with a repeated seat", () => {
    expect(
      errorOf(wire({ publicClaimMove: { ...wire().publicClaimMove, requestedTeam: [1, 1, 3] } })),
    ).toContain("重复座位");
  });

  it("refuses claiming while the own-status still says hidden", () => {
    const found = problems(
      wire({ publicClaimMove: { ...wire().publicClaimMove, act: "claim-percival" } }),
    );
    expect(found.join(" ")).toContain("还写着 hidden");
  });
});

describe("claimants must be compared, not ignored", () => {
  it("refuses a block that skips a standing claimant", () => {
    const found = problems(
      wire({ claimantAssessments: [wire().claimantAssessments[0]] }),
    );
    expect(found.join(" ")).toContain("派权争夺不能只看自己");
  });

  it("refuses an assessment with neither a positive nor a negative case", () => {
    const found = problems(
      wire({
        claimantAssessments: wire().claimantAssessments.map((a) => ({
          ...a,
          positiveCase: [],
          negativeCase: [],
        })),
      }),
    );
    expect(found.join(" ")).toContain("那不是评估");
  });

  it("refuses backing a claimant it never assessed", () => {
    const found = problems(
      wire({
        claimantAssessments: [wire().claimantAssessments[0]],
        alignment: { ...wire().alignment, stance: "support", selectedClaimant: RIVAL_B },
      }),
    );
    expect(found.join(" ")).toContain("但你没有对他做出评估");
  });

  it("requires a rival plan from a claimant who has rivals", () => {
    const found = problems(
      wire({
        ownClaimStrategy: { ...wire().ownClaimStrategy, currentStatus: "active" },
        claimantAssessments: wire().claimantAssessments.filter((a) => a.claimantSeat !== RIVAL_A),
        rivalPlans: [],
      }),
      RIVAL_A,
    );
    // Part F, made structural: a rival is not a parallel opinion.
    expect(found.join(" ")).toContain("竞争者不能当作平行意见");
  });

  it("refuses a rival plan from a seat that is not itself claiming", () => {
    const found = problems(
      wire({
        rivalPlans: [
          {
            rivalSeat: RIVAL_A,
            whyTheirClaimCompetesWithMine: "同一个身份",
            attackCase: "时机",
            expectedDefense: "他会答",
            myResponse: "我会回",
            riskOfOverattacking: "风险",
            distinctionTest: "检验",
          },
        ],
      }),
    );
    expect(found.join(" ")).toContain("只在你自己也站在声称上时才有意义");
  });
});

describe("a copied delay justification is refused", () => {
  it("catches a hidden-to-hidden update with byte-identical reasons", () => {
    const previous = applyContest(BYSTANDER, wire(), registryFor(BYSTANDER).registry, CONTEST, 10);
    const found = contestProblems(wire(), {
      seat: BYSTANDER,
      contest: CONTEST,
      teamSize: 3,
      previous,
    });
    // The M5 pilot's Percival wrote nearly the same trigger seventeen times.
    expect(found.join(" ")).toContain("一字不差");
  });

  it("accepts an update whose reasons moved with the board", () => {
    const previous = applyContest(BYSTANDER, wire(), registryFor(BYSTANDER).registry, CONTEST, 10);
    const fresh = wire({
      ownClaimStrategy: {
        ...wire().ownClaimStrategy,
        situationSpecificBenefit: "第一轮结果出来之后，我要用它来分开这两个人",
      },
    });
    const found = contestProblems(fresh, {
      seat: BYSTANDER,
      contest: CONTEST,
      teamSize: 3,
      previous,
    });
    expect(found.join(" ")).not.toContain("一字不差");
  });

  it("does not fire when the seat has entered the contest", () => {
    const previous = applyContest(RIVAL_A, wire(), registryFor(RIVAL_A).registry, CONTEST, 10);
    const now = wire({
      ownClaimStrategy: { ...wire().ownClaimStrategy, currentStatus: "active" },
    });
    const found = contestProblems(now, {
      seat: RIVAL_A,
      contest: CONTEST,
      teamSize: 3,
      previous,
    });
    expect(found.join(" ")).not.toContain("一字不差");
  });
});

describe("the one-way valve", () => {
  it("computes restsOnUnverified from the premises", () => {
    const registry = registryFor(BYSTANDER).registry;
    const hard = applyContest(BYSTANDER, wire(), registry, CONTEST, 20);
    expect(hard.claimantAssessments[0].restsOnUnverified).toBe(false);

    const soft = applyContest(
      BYSTANDER,
      wire({
        claimantAssessments: wire().claimantAssessments.map((a) => ({
          ...a,
          premiseIds: ["k999:invented"],
        })),
      }),
      registry,
      CONTEST,
      20,
    );
    expect(soft.claimantAssessments[0].restsOnUnverified).toBe(true);
  });

  it("takes publicClaimStatus from the referee, never from the model", () => {
    const model = applyContest(BYSTANDER, wire(), registryFor(BYSTANDER).registry, CONTEST, 20);
    for (const a of model.claimantAssessments) {
      expect(a.publicClaimStatus).toBe(CONTEST.bySeat[a.claimantSeat]?.status);
      // Both rivals claimed the same role, so the referee says `contested`
      // whatever the model believes about them.
      expect(a.publicClaimStatus).toBe("contested");
    }
  });

  it("refuses another seat's private id as evidence", () => {
    const model = applyContest(
      BYSTANDER,
      wire({
        publicClaimMove: { ...wire().publicClaimMove, evidenceIds: [PRIVATE_IDS.percivalPair] },
      }),
      registryFor(BYSTANDER).registry,
      CONTEST,
      20,
    );
    expect(model.publicClaimMove?.evidenceResolves).toBe(false);
  });

  it("freezes what it produces", () => {
    const model = applyContest(BYSTANDER, wire(), registryFor(BYSTANDER).registry, CONTEST, 20);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.claimantAssessments)).toBe(true);
  });
});

describe("bounds are reported, never truncated", () => {
  it("flags an over-long attack case and keeps the text whole", () => {
    const long = "很".repeat(L.rivalCaseChars + 60);
    const input = wire({
      rivalPlans: [
        {
          rivalSeat: RIVAL_A,
          whyTheirClaimCompetesWithMine: "同一个身份",
          attackCase: long,
          expectedDefense: "他会答",
          myResponse: "我会回",
          riskOfOverattacking: "风险",
          distinctionTest: "检验",
        },
      ],
    });
    expect(checkContestBounds(input, L).some((v) => v.path.includes("attackCase"))).toBe(true);
    expect(ok(input).rivalPlans[0].attackCase).toBe(long);
  });

  it("reports nothing for a block inside its limits", () => {
    expect(checkContestBounds(wire(), L)).toHaveLength(0);
  });
});

describe("rendering it back", () => {
  it("shows the contest, the assessments and the plan", () => {
    const model = applyContest(
      RIVAL_A,
      wire({
        ownClaimStrategy: { ...wire().ownClaimStrategy, currentStatus: "active" },
        rivalPlans: [
          {
            rivalSeat: RIVAL_B,
            whyTheirClaimCompetesWithMine: "同一个身份",
            attackCase: "时机对不上",
            expectedDefense: "他会说后发才看清",
            myResponse: "要求他给车",
            riskOfOverattacking: "显得我在急",
            distinctionTest: "各给一辆车",
          },
        ],
      }),
      registryFor(RIVAL_A).registry,
      CONTEST,
      20,
    );
    const text = renderContest(model);
    expect(text).toContain("已经跳了");
    expect(text).toContain("能分开你们俩的公开检验");
    expect(text).toContain("什么会让你上调");
    expect(text).toContain("打过头的风险");
  });

  it("renders nothing for a seat with no contest model", () => {
    expect(renderContest(null)).toBe("");
  });
});

describe("the version gate", () => {
  it("gives 0.4.0 the contest bounds and leaves the older tables alone", () => {
    expect(limitsFor("prompt-0.4.0").maxClaimantAssessments).toBe(4);
    expect(limitsFor("prompt-0.3.1").maxHypotheses).toBe(6);
    expect(limitsFor("prompt-0.3.0").maxHypotheses).toBe(4);
    expect(limitsFor("prompt-0.3.0").maxPublicCommitments).toBe(8);
  });

  it("carries the M5.1 numbers forward unchanged", () => {
    // No M5.1 game has run, so there is no measurement that would justify
    // moving one — and moving a limit with no measurement is what put
    // `maxOutputTokens` at 20,000.
    for (const key of ["maxHypotheses", "maxPublicCommitments", "maxFocalCandidates"] as const) {
      expect(limitsFor("prompt-0.4.0")[key]).toBe(limitsFor("prompt-0.3.1")[key]);
    }
  });
});
