/**
 * 派权争夺, from one seat's side: my claim, their claims, and what I do next.
 *
 * WHY THIS AND NOT THE SOCIAL MODEL. `social.ts` asks "who is leading and do I
 * follow". That is the right question once authority has settled. It is the
 * wrong question while authority is being FOUGHT OVER, which is what early
 * high-level play looks like: two or three seats standing on Percival, each
 * with a story, each attacking the others, followers moving between them. A
 * `focalCandidate` can represent "I am tracking seat 8"; it cannot represent
 * "seat 8 and I are both claiming Percival, here is why the table should
 * believe me instead, and here is the test I will propose."
 *
 * FIVE PARTS, and each answers something the contest makes urgent:
 *
 *   ownClaimStrategy      am I in this fight, on what story, and what would
 *                         make me enter or leave it
 *   claimantAssessments   a COMPARATIVE read of everyone standing on a claim,
 *                         built from public ids
 *   rivalPlan             only when I am claiming: how I reduce a rival's
 *                         credibility, and what happens when they answer
 *   alignment             which claimant I am backing, on which proposition,
 *                         with which vote, and what would switch me
 *   publicClaimMove       the thing I actually do at the table this turn
 *
 * WHAT IS DELIBERATELY ABSENT. Any field that would let a model assert another
 * seat's alignment as settled. `currentAssessment` runs `leading → broken` and
 * every value is about the CLAIM's standing, not the claimant's side. Attacking
 * a rival's credibility and declaring them evil are different moves, and the
 * vocabulary keeps them different — which is Part F's central point.
 *
 * All bounded, all frozen, all seat-private, all checkpointed, none of it in
 * the public replay.
 */

import type { RoleType } from "@/lib/types/game";
import { deepFreeze } from "../core/freeze";
import { SEATS, type Seat } from "../core/types";
import type { Fragment } from "../model/json-schema";
import type { ClaimContest } from "./claim-contest";
import type { PublicClaimStatus } from "./claim-contest";
import { isVerifiedPremise, type VisibleFactRegistry } from "./fact-ids";
import {
  checkChars,
  checkCount,
  type CognitionLimitsV3,
  type LimitViolation,
} from "./limits";

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

/** Where this seat stands in the fight, from its own point of view. */
export type OwnClaimStatus =
  | "hidden"
  | "considering"
  | "active"
  | "defending"
  | "retracting"
  | "retracted";

/**
 * How a rival claim is holding up. About the CLAIM, never about the person.
 *
 * `broken` means the public record has contradicted the story, not that the
 * seat is evil — a Loyal servant who invented a cover story and got caught is
 * `broken` and good. Collapsing the two would make every successful attack an
 * accusation, which is exactly the mistake Part F warns about.
 */
export type ClaimAssessmentLevel =
  | "leading"
  | "plausible"
  | "contested"
  | "weak"
  | "broken";

/** What this seat backs, among the claimants. */
export type ContestStance = "support" | "conditional-support" | "oppose" | "undecided";

/** The public act. One per turn, chosen from a closed list. */
export type ClaimAct =
  | "claim-percival"
  | "counterclaim-percival"
  | "defend-own-claim"
  | "attack-rival-claim"
  | "endorse-claimant"
  | "challenge-claimant"
  | "retract-claim"
  | "compare-claimants"
  | "stay-hidden";

export const OWN_STATUS_VALUES: readonly OwnClaimStatus[] = [
  "hidden",
  "considering",
  "active",
  "defending",
  "retracting",
  "retracted",
];
export const ASSESSMENT_VALUES: readonly ClaimAssessmentLevel[] = [
  "leading",
  "plausible",
  "contested",
  "weak",
  "broken",
];
export const CONTEST_STANCE_VALUES: readonly ContestStance[] = [
  "support",
  "conditional-support",
  "oppose",
  "undecided",
];
export const CLAIM_ACT_VALUES: readonly ClaimAct[] = [
  "claim-percival",
  "counterclaim-percival",
  "defend-own-claim",
  "attack-rival-claim",
  "endorse-claimant",
  "challenge-claimant",
  "retract-claim",
  "compare-claimants",
  "stay-hidden",
];

/** Acts that only make sense while standing on a claim of one's own. */
const NEEDS_OWN_CLAIM: readonly ClaimAct[] = [
  "defend-own-claim",
  "retract-claim",
];
/** Acts that must name somebody who has claimed. */
const NEEDS_TARGET_CLAIMANT: readonly ClaimAct[] = [
  "attack-rival-claim",
  "endorse-claimant",
  "challenge-claimant",
];

/* ── The stored shape ───────────────────────────────────────────────────── */

export interface OwnClaimStrategy {
  readonly currentStatus: OwnClaimStatus;
  /** What this seat claims, or would claim. Never what it is. */
  readonly intendedClaimRole: RoleType | null;
  /** THIS position's benefit, not a general one. See `contestProblems`. */
  readonly situationSpecificBenefit: string;
  readonly situationSpecificRisk: string;
  readonly triggerToClaim: string;
  readonly triggerToRetract: string;
  /** The pair story this seat would tell in public. May be entirely invented. */
  readonly candidatePairStory: string;
  readonly leadershipObjective: string;
  /** What staying hidden costs, right now. Empty is legal only when claiming. */
  readonly concealmentCost: string;
  /** Things already said in public that this seat must stay consistent with. */
  readonly consistencyObligations: readonly string[];
  readonly atSequence: number;
}

export interface ClaimantAssessment {
  readonly claimantSeat: Seat;
  /** Copied from the referee's own derivation, never from the model. */
  readonly publicClaimStatus: PublicClaimStatus;
  readonly claimedRole: RoleType | null;
  /** The pair they told the table, if they told one. Two distinct seats. */
  readonly claimedOrImpliedPair: readonly Seat[] | null;
  readonly positiveCase: readonly string[];
  readonly negativeCase: readonly string[];
  readonly contradictions: readonly string[];
  readonly fulfilledPredictions: readonly string[];
  readonly failedPredictions: readonly string[];
  readonly currentAssessment: ClaimAssessmentLevel;
  readonly conditionToUpgrade: string;
  readonly conditionToDowngrade: string;
  readonly premiseIds: readonly string[];
  /** Computed from `premiseIds`. The one-way valve, again. */
  readonly restsOnUnverified: boolean;
}

export interface RivalPlan {
  readonly rivalSeat: Seat;
  readonly whyTheirClaimCompetesWithMine: string;
  readonly attackCase: string;
  readonly expectedDefense: string;
  readonly myResponse: string;
  /** Attacking too hard is itself a tell. Required, so the cost is priced. */
  readonly riskOfOverattacking: string;
  /** A public test that would separate the two claims. */
  readonly distinctionTest: string;
}

export interface ContestAlignment {
  readonly selectedClaimant: Seat | null;
  readonly stance: ContestStance;
  readonly proposition: string;
  readonly voteOrTeamConsequence: string;
  readonly conditionToSwitch: string;
}

export interface PublicClaimMove {
  readonly act: ClaimAct;
  readonly targetSeats: readonly Seat[];
  readonly publicProposition: string;
  readonly requestedTeam: readonly Seat[] | null;
  readonly requestedVote: "approve" | "reject" | "none";
  readonly evidenceIds: readonly string[];
  /** What this move must NOT give away. Private forever. */
  readonly informationToConceal: string;
  /** Computed from `evidenceIds`. */
  readonly evidenceResolves: boolean;
}

export interface ContestModel {
  readonly seat: Seat;
  readonly ownClaimStrategy: OwnClaimStrategy | null;
  readonly claimantAssessments: readonly ClaimantAssessment[];
  readonly rivalPlans: readonly RivalPlan[];
  readonly alignment: ContestAlignment | null;
  readonly publicClaimMove: PublicClaimMove | null;
  readonly atSequence: number;
}

export function emptyContestModel(seat: Seat): ContestModel {
  return deepFreeze({
    seat,
    ownClaimStrategy: null,
    claimantAssessments: [],
    rivalPlans: [],
    alignment: null,
    publicClaimMove: null,
    atSequence: 0,
  });
}

/* ── The wire shape ─────────────────────────────────────────────────────── */

export interface ContestWire {
  readonly ownClaimStrategy: {
    readonly currentStatus: OwnClaimStatus;
    readonly intendedClaimRole: string | null;
    readonly situationSpecificBenefit: string;
    readonly situationSpecificRisk: string;
    readonly triggerToClaim: string;
    readonly triggerToRetract: string;
    readonly candidatePairStory: string;
    readonly leadershipObjective: string;
    readonly concealmentCost: string;
    readonly consistencyObligations: readonly string[];
  };
  readonly claimantAssessments: readonly {
    readonly claimantSeat: number;
    readonly claimedRole: string | null;
    readonly claimedOrImpliedPair: readonly number[] | null;
    readonly positiveCase: readonly string[];
    readonly negativeCase: readonly string[];
    readonly contradictions: readonly string[];
    readonly fulfilledPredictions: readonly string[];
    readonly failedPredictions: readonly string[];
    readonly currentAssessment: ClaimAssessmentLevel;
    readonly conditionToUpgrade: string;
    readonly conditionToDowngrade: string;
    readonly premiseIds: readonly string[];
  }[];
  readonly rivalPlans: readonly {
    readonly rivalSeat: number;
    readonly whyTheirClaimCompetesWithMine: string;
    readonly attackCase: string;
    readonly expectedDefense: string;
    readonly myResponse: string;
    readonly riskOfOverattacking: string;
    readonly distinctionTest: string;
  }[];
  readonly alignment: {
    readonly selectedClaimant: number | null;
    readonly stance: ContestStance;
    readonly proposition: string;
    readonly voteOrTeamConsequence: string;
    readonly conditionToSwitch: string;
  };
  readonly publicClaimMove: {
    readonly act: ClaimAct;
    readonly targetSeats: readonly number[];
    readonly publicProposition: string;
    readonly requestedTeam: readonly number[] | null;
    readonly requestedVote: "approve" | "reject" | "none";
    readonly evidenceIds: readonly string[];
    readonly informationToConceal: string;
  };
}

/**
 * The strict schema for the contest block.
 *
 * `publicClaimStatus`, `restsOnUnverified` and `evidenceResolves` are all
 * absent: each is computed by the system from the referee's own record, and a
 * field the model fills in and the system overwrites is a field somebody will
 * eventually trust.
 */
export function contestFragment(limits: CognitionLimitsV3): Fragment {
  const seat: Fragment = { type: "integer", minimum: 1, maximum: 10 };
  const shortList = (maxItems: number, maxLength: number): Fragment => ({
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength: maxLength * 3 },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "ownClaimStrategy",
      "claimantAssessments",
      "rivalPlans",
      "alignment",
      "publicClaimMove",
    ],
    properties: {
      ownClaimStrategy: {
        type: "object",
        additionalProperties: false,
        required: [
          "currentStatus",
          "intendedClaimRole",
          "situationSpecificBenefit",
          "situationSpecificRisk",
          "triggerToClaim",
          "triggerToRetract",
          "candidatePairStory",
          "leadershipObjective",
          "concealmentCost",
          "consistencyObligations",
        ],
        properties: {
          currentStatus: { type: "string", enum: [...OWN_STATUS_VALUES] },
          intendedClaimRole: { type: ["string", "null"] },
          situationSpecificBenefit: { type: "string", minLength: 1 },
          situationSpecificRisk: { type: "string", minLength: 1 },
          triggerToClaim: { type: "string", minLength: 1 },
          triggerToRetract: { type: "string", minLength: 1 },
          candidatePairStory: { type: "string" },
          leadershipObjective: { type: "string" },
          concealmentCost: { type: "string" },
          consistencyObligations: shortList(
            limits.maxConsistencyObligations,
            limits.consistencyObligationChars,
          ),
        },
      },
      claimantAssessments: {
        type: "array",
        maxItems: limits.maxClaimantAssessments,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "claimantSeat",
            "claimedRole",
            "claimedOrImpliedPair",
            "positiveCase",
            "negativeCase",
            "contradictions",
            "fulfilledPredictions",
            "failedPredictions",
            "currentAssessment",
            "conditionToUpgrade",
            "conditionToDowngrade",
            "premiseIds",
          ],
          properties: {
            claimantSeat: seat,
            claimedRole: { type: ["string", "null"] },
            claimedOrImpliedPair: {
              type: ["array", "null"],
              items: seat,
              minItems: 2,
              maxItems: 2,
            },
            positiveCase: shortList(limits.maxClaimCases, limits.claimCaseChars),
            negativeCase: shortList(limits.maxClaimCases, limits.claimCaseChars),
            contradictions: shortList(
              limits.maxClaimContradictions,
              limits.claimContradictionChars,
            ),
            fulfilledPredictions: shortList(
              limits.maxClaimPredictions,
              limits.claimPredictionChars,
            ),
            failedPredictions: shortList(
              limits.maxClaimPredictions,
              limits.claimPredictionChars,
            ),
            currentAssessment: { type: "string", enum: [...ASSESSMENT_VALUES] },
            conditionToUpgrade: { type: "string", minLength: 1 },
            conditionToDowngrade: { type: "string", minLength: 1 },
            premiseIds: {
              type: "array",
              minItems: 1,
              maxItems: limits.maxClaimPremiseIds,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
      rivalPlans: {
        type: "array",
        maxItems: limits.maxRivalPlans,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "rivalSeat",
            "whyTheirClaimCompetesWithMine",
            "attackCase",
            "expectedDefense",
            "myResponse",
            "riskOfOverattacking",
            "distinctionTest",
          ],
          properties: {
            rivalSeat: seat,
            whyTheirClaimCompetesWithMine: { type: "string", minLength: 1 },
            attackCase: { type: "string", minLength: 1 },
            expectedDefense: { type: "string", minLength: 1 },
            myResponse: { type: "string", minLength: 1 },
            riskOfOverattacking: { type: "string", minLength: 1 },
            distinctionTest: { type: "string", minLength: 1 },
          },
        },
      },
      alignment: {
        type: "object",
        additionalProperties: false,
        required: [
          "selectedClaimant",
          "stance",
          "proposition",
          "voteOrTeamConsequence",
          "conditionToSwitch",
        ],
        properties: {
          selectedClaimant: { type: ["integer", "null"], minimum: 1, maximum: 10 },
          stance: { type: "string", enum: [...CONTEST_STANCE_VALUES] },
          proposition: { type: "string", minLength: 1 },
          voteOrTeamConsequence: { type: "string", minLength: 1 },
          conditionToSwitch: { type: "string", minLength: 1 },
        },
      },
      publicClaimMove: {
        type: "object",
        additionalProperties: false,
        required: [
          "act",
          "targetSeats",
          "publicProposition",
          "requestedTeam",
          "requestedVote",
          "evidenceIds",
          "informationToConceal",
        ],
        properties: {
          act: { type: "string", enum: [...CLAIM_ACT_VALUES] },
          targetSeats: { type: "array", items: seat, maxItems: limits.maxMoveTargets },
          publicProposition: { type: "string", minLength: 1 },
          requestedTeam: { type: ["array", "null"], items: seat, maxItems: 5 },
          requestedVote: { type: "string", enum: ["approve", "reject", "none"] },
          evidenceIds: {
            type: "array",
            maxItems: limits.maxMoveEvidenceIds,
            items: { type: "string", minLength: 1 },
          },
          informationToConceal: { type: "string" },
        },
      },
    },
  };
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

export type ContestParse =
  | { readonly ok: true; readonly contest: ContestWire }
  | { readonly ok: false; readonly error: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? [...(v as string[])] : null;
const seatArray = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "number" && SEATS.includes(x as Seat))
    ? [...(v as number[])]
    : null;

/**
 * Field-specific errors, for the reason the rest of this layer gives them: a
 * repair note costs a whole request, so it had better teach something.
 */
export function parseContest(raw: unknown): ContestParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "缺少 contest 对象" };
  }
  const c = raw as Record<string, unknown>;
  const fail = (error: string): ContestParse => ({ ok: false, error });

  /* ── ownClaimStrategy ──────────────────────────────────────────────── */
  const own = c.ownClaimStrategy;
  if (!own || typeof own !== "object") return fail("contest.ownClaimStrategy 必须是对象");
  const o = own as Record<string, unknown>;
  const currentStatus = str(o.currentStatus);
  if (!currentStatus || !(OWN_STATUS_VALUES as readonly string[]).includes(currentStatus)) {
    return fail(`contest.ownClaimStrategy.currentStatus 必须是 ${OWN_STATUS_VALUES.join(" / ")}`);
  }
  const benefit = str(o.situationSpecificBenefit);
  const risk = str(o.situationSpecificRisk);
  if (!benefit) {
    return fail(
      "contest.ownClaimStrategy.situationSpecificBenefit 不能为空 —— 要写**这一手**换到什么，不是一般道理",
    );
  }
  if (!risk) return fail("contest.ownClaimStrategy.situationSpecificRisk 不能为空");
  const triggerToClaim = str(o.triggerToClaim);
  const triggerToRetract = str(o.triggerToRetract);
  if (!triggerToClaim) {
    return fail(
      "contest.ownClaimStrategy.triggerToClaim 不能为空 —— 说不出什么条件会让你跳，就是还没决定",
    );
  }
  if (!triggerToRetract) return fail("contest.ownClaimStrategy.triggerToRetract 不能为空");

  const ownClaimStrategy: ContestWire["ownClaimStrategy"] = {
    currentStatus: currentStatus as OwnClaimStatus,
    intendedClaimRole: str(o.intendedClaimRole),
    situationSpecificBenefit: benefit,
    situationSpecificRisk: risk,
    triggerToClaim,
    triggerToRetract,
    candidatePairStory: str(o.candidatePairStory) ?? "",
    leadershipObjective: str(o.leadershipObjective) ?? "",
    concealmentCost: str(o.concealmentCost) ?? "",
    consistencyObligations: strArray(o.consistencyObligations) ?? [],
  };

  /* ── claimantAssessments ───────────────────────────────────────────── */
  if (!Array.isArray(c.claimantAssessments)) {
    return fail("contest.claimantAssessments 必须是数组（没有声称者就给空数组）");
  }
  const claimantAssessments: ContestWire["claimantAssessments"][number][] = [];
  for (const [i, item] of (c.claimantAssessments as unknown[]).entries()) {
    if (!item || typeof item !== "object") return fail(`contest.claimantAssessments[${i}] 不是对象`);
    const a = item as Record<string, unknown>;
    const claimantSeat = typeof a.claimantSeat === "number" ? a.claimantSeat : null;
    if (claimantSeat === null || !SEATS.includes(claimantSeat as Seat)) {
      return fail(`contest.claimantAssessments[${i}].claimantSeat 必须是 1-10`);
    }
    const level = str(a.currentAssessment);
    if (!level || !(ASSESSMENT_VALUES as readonly string[]).includes(level)) {
      return fail(
        `contest.claimantAssessments[${i}].currentAssessment 必须是 ${ASSESSMENT_VALUES.join(" / ")}`,
      );
    }
    const premiseIds = strArray(a.premiseIds);
    if (!premiseIds || premiseIds.length === 0) {
      return fail(
        `contest.claimantAssessments[${i}].premiseIds 不能为空 —— 事实表和声称表每行开头的 \`[f…]\` / \`[c…]\` / \`[k…]\` 就是 id`,
      );
    }
    const pair = a.claimedOrImpliedPair === null ? null : seatArray(a.claimedOrImpliedPair);
    if (a.claimedOrImpliedPair !== null && !pair) {
      return fail(`contest.claimantAssessments[${i}].claimedOrImpliedPair 必须是两个座位或 null`);
    }
    if (pair && (pair.length !== 2 || pair[0] === pair[1])) {
      return fail(
        `contest.claimantAssessments[${i}].claimedOrImpliedPair 必须正好是两个**不同**的座位`,
      );
    }
    const up = str(a.conditionToUpgrade);
    const down = str(a.conditionToDowngrade);
    if (!up || !down) {
      return fail(
        `contest.claimantAssessments[${i}] 需要 conditionToUpgrade 和 conditionToDowngrade —— 说不出什么会改变评价，就不是评价`,
      );
    }
    claimantAssessments.push({
      claimantSeat,
      claimedRole: str(a.claimedRole),
      claimedOrImpliedPair: pair,
      positiveCase: strArray(a.positiveCase) ?? [],
      negativeCase: strArray(a.negativeCase) ?? [],
      contradictions: strArray(a.contradictions) ?? [],
      fulfilledPredictions: strArray(a.fulfilledPredictions) ?? [],
      failedPredictions: strArray(a.failedPredictions) ?? [],
      currentAssessment: level as ClaimAssessmentLevel,
      conditionToUpgrade: up,
      conditionToDowngrade: down,
      premiseIds,
    });
  }

  /* ── rivalPlans ────────────────────────────────────────────────────── */
  if (!Array.isArray(c.rivalPlans)) {
    return fail("contest.rivalPlans 必须是数组（不在声称就给空数组）");
  }
  const rivalPlans: ContestWire["rivalPlans"][number][] = [];
  for (const [i, item] of (c.rivalPlans as unknown[]).entries()) {
    if (!item || typeof item !== "object") return fail(`contest.rivalPlans[${i}] 不是对象`);
    const r = item as Record<string, unknown>;
    const rivalSeat = typeof r.rivalSeat === "number" ? r.rivalSeat : null;
    if (rivalSeat === null || !SEATS.includes(rivalSeat as Seat)) {
      return fail(`contest.rivalPlans[${i}].rivalSeat 必须是 1-10`);
    }
    const fields = [
      "whyTheirClaimCompetesWithMine",
      "attackCase",
      "expectedDefense",
      "myResponse",
      "riskOfOverattacking",
      "distinctionTest",
    ] as const;
    const values: Record<string, string> = {};
    for (const key of fields) {
      const value = str(r[key]);
      if (!value) return fail(`contest.rivalPlans[${i}].${key} 不能为空`);
      values[key] = value;
    }
    rivalPlans.push({
      rivalSeat,
      whyTheirClaimCompetesWithMine: values.whyTheirClaimCompetesWithMine,
      attackCase: values.attackCase,
      expectedDefense: values.expectedDefense,
      myResponse: values.myResponse,
      riskOfOverattacking: values.riskOfOverattacking,
      distinctionTest: values.distinctionTest,
    });
  }

  /* ── alignment ─────────────────────────────────────────────────────── */
  const al = c.alignment;
  if (!al || typeof al !== "object") return fail("contest.alignment 必须是对象");
  const a = al as Record<string, unknown>;
  const stance = str(a.stance);
  if (!stance || !(CONTEST_STANCE_VALUES as readonly string[]).includes(stance)) {
    return fail(`contest.alignment.stance 必须是 ${CONTEST_STANCE_VALUES.join(" / ")}`);
  }
  const selectedClaimant = typeof a.selectedClaimant === "number" ? a.selectedClaimant : null;
  if (selectedClaimant !== null && !SEATS.includes(selectedClaimant as Seat)) {
    return fail("contest.alignment.selectedClaimant 必须是 1-10 或 null");
  }
  if (stance !== "undecided" && selectedClaimant === null) {
    return fail(
      `contest.alignment.stance 是 ${stance}，就必须点名 selectedClaimant —— 支持谁、反对谁，牌桌要能对上号`,
    );
  }
  const proposition = str(a.proposition);
  if (!proposition) {
    return fail("contest.alignment.proposition 不能为空 —— 要写清你接受或拒绝的**那一句话**");
  }
  const consequence = str(a.voteOrTeamConsequence);
  if (!consequence) {
    return fail("contest.alignment.voteOrTeamConsequence 不能为空 —— 支持要落到票或车上");
  }
  const conditionToSwitch = str(a.conditionToSwitch);
  if (!conditionToSwitch) return fail("contest.alignment.conditionToSwitch 不能为空");

  /* ── publicClaimMove ───────────────────────────────────────────────── */
  const mv = c.publicClaimMove;
  if (!mv || typeof mv !== "object") return fail("contest.publicClaimMove 必须是对象");
  const m = mv as Record<string, unknown>;
  const act = str(m.act);
  if (!act || !(CLAIM_ACT_VALUES as readonly string[]).includes(act)) {
    return fail(`contest.publicClaimMove.act 必须是 ${CLAIM_ACT_VALUES.join(" / ")} 之一`);
  }
  const targetSeats = seatArray(m.targetSeats);
  if (!targetSeats) return fail("contest.publicClaimMove.targetSeats 必须是座位数组");
  const publicProposition = str(m.publicProposition);
  if (!publicProposition) {
    return fail(
      "contest.publicClaimMove.publicProposition 不能为空 —— 就算这一步是 stay-hidden，也要写你要让牌桌接受什么",
    );
  }
  const requestedTeam = m.requestedTeam === null ? null : seatArray(m.requestedTeam);
  if (m.requestedTeam !== null && !requestedTeam) {
    return fail("contest.publicClaimMove.requestedTeam 必须是座位数组或 null");
  }
  if (requestedTeam && new Set(requestedTeam).size !== requestedTeam.length) {
    return fail("contest.publicClaimMove.requestedTeam 里有重复座位");
  }
  const requestedVote = str(m.requestedVote);
  if (!requestedVote || !["approve", "reject", "none"].includes(requestedVote)) {
    return fail("contest.publicClaimMove.requestedVote 必须是 approve / reject / none");
  }

  return {
    ok: true,
    contest: {
      ownClaimStrategy,
      claimantAssessments,
      rivalPlans,
      alignment: {
        selectedClaimant,
        stance: stance as ContestStance,
        proposition,
        voteOrTeamConsequence: consequence,
        conditionToSwitch,
      },
      publicClaimMove: {
        act: act as ClaimAct,
        targetSeats,
        publicProposition,
        requestedTeam,
        requestedVote: requestedVote as "approve" | "reject" | "none",
        evidenceIds: strArray(m.evidenceIds) ?? [],
        informationToConceal: str(m.informationToConceal) ?? "",
      },
    },
  };
}

/* ── Bounds ─────────────────────────────────────────────────────────────── */

export function checkContestBounds(
  c: ContestWire,
  limits: CognitionLimitsV3,
): LimitViolation[] {
  const bad: LimitViolation[] = [];
  const o = c.ownClaimStrategy;
  bad.push(...checkChars("contest.own.benefit", o.situationSpecificBenefit, limits.claimBenefitChars));
  bad.push(...checkChars("contest.own.risk", o.situationSpecificRisk, limits.claimRiskChars));
  bad.push(...checkChars("contest.own.triggerToClaim", o.triggerToClaim, limits.claimTriggerChars));
  bad.push(
    ...checkChars("contest.own.triggerToRetract", o.triggerToRetract, limits.claimTriggerChars),
  );
  bad.push(
    ...checkChars("contest.own.pairStory", o.candidatePairStory, limits.candidatePairStoryChars),
  );
  bad.push(
    ...checkChars(
      "contest.own.leadershipObjective",
      o.leadershipObjective,
      limits.leadershipObjectiveChars,
    ),
  );
  bad.push(
    ...checkChars("contest.own.concealmentCost", o.concealmentCost, limits.concealmentCostChars),
  );
  bad.push(
    ...checkCount(
      "contest.own.consistencyObligations",
      o.consistencyObligations,
      limits.maxConsistencyObligations,
    ),
  );
  for (const [i, text] of o.consistencyObligations.entries()) {
    bad.push(
      ...checkChars(
        `contest.own.consistencyObligations[${i}]`,
        text,
        limits.consistencyObligationChars,
      ),
    );
  }

  bad.push(
    ...checkCount(
      "contest.claimantAssessments",
      c.claimantAssessments,
      limits.maxClaimantAssessments,
    ),
  );
  for (const a of c.claimantAssessments) {
    const at = `claimant[${a.claimantSeat}]`;
    bad.push(...checkCount(`${at}.positiveCase`, a.positiveCase, limits.maxClaimCases));
    bad.push(...checkCount(`${at}.negativeCase`, a.negativeCase, limits.maxClaimCases));
    bad.push(
      ...checkCount(`${at}.contradictions`, a.contradictions, limits.maxClaimContradictions),
    );
    bad.push(...checkCount(`${at}.premiseIds`, a.premiseIds, limits.maxClaimPremiseIds));
    for (const [i, text] of [...a.positiveCase, ...a.negativeCase].entries()) {
      bad.push(...checkChars(`${at}.case[${i}]`, text, limits.claimCaseChars));
    }
    for (const [i, text] of a.contradictions.entries()) {
      bad.push(...checkChars(`${at}.contradictions[${i}]`, text, limits.claimContradictionChars));
    }
    for (const [i, text] of [...a.fulfilledPredictions, ...a.failedPredictions].entries()) {
      bad.push(...checkChars(`${at}.prediction[${i}]`, text, limits.claimPredictionChars));
    }
    bad.push(...checkChars(`${at}.conditionToUpgrade`, a.conditionToUpgrade, limits.claimConditionChars));
    bad.push(
      ...checkChars(`${at}.conditionToDowngrade`, a.conditionToDowngrade, limits.claimConditionChars),
    );
  }

  bad.push(...checkCount("contest.rivalPlans", c.rivalPlans, limits.maxRivalPlans));
  for (const r of c.rivalPlans) {
    const at = `rival[${r.rivalSeat}]`;
    bad.push(...checkChars(`${at}.why`, r.whyTheirClaimCompetesWithMine, limits.rivalReasonChars));
    bad.push(...checkChars(`${at}.attackCase`, r.attackCase, limits.rivalCaseChars));
    bad.push(...checkChars(`${at}.expectedDefense`, r.expectedDefense, limits.rivalDefenceChars));
    bad.push(...checkChars(`${at}.myResponse`, r.myResponse, limits.rivalResponseChars));
    bad.push(...checkChars(`${at}.risk`, r.riskOfOverattacking, limits.rivalRiskChars));
    bad.push(...checkChars(`${at}.distinctionTest`, r.distinctionTest, limits.distinctionTestChars));
  }

  bad.push(
    ...checkChars("contest.alignment.proposition", c.alignment.proposition, limits.publicPropositionChars),
  );
  bad.push(
    ...checkChars(
      "contest.alignment.conditionToSwitch",
      c.alignment.conditionToSwitch,
      limits.claimConditionChars,
    ),
  );
  bad.push(
    ...checkCount("contest.move.targetSeats", c.publicClaimMove.targetSeats, limits.maxMoveTargets),
  );
  bad.push(
    ...checkChars(
      "contest.move.publicProposition",
      c.publicClaimMove.publicProposition,
      limits.publicPropositionChars,
    ),
  );
  bad.push(
    ...checkCount("contest.move.evidenceIds", c.publicClaimMove.evidenceIds, limits.maxMoveEvidenceIds),
  );
  bad.push(
    ...checkChars(
      "contest.move.informationToConceal",
      c.publicClaimMove.informationToConceal,
      limits.concealChars,
    ),
  );
  return bad;
}

/* ── Cross-field consistency ────────────────────────────────────────────── */

/**
 * The structural checks Part J asks for — and only structural ones.
 *
 * Every rule below is about SHAPE against the referee's own record: does the
 * seat this move attacks actually have a claim, does this seat have one to
 * defend, is the requested team a legal size. None of them grades an argument,
 * because "is this argument good" is not a thing a keyword can answer and
 * pretending otherwise would reject good play for using the wrong words.
 */
export interface ContestCheckInput {
  readonly seat: Seat;
  readonly contest: ClaimContest;
  readonly teamSize: number | null;
  /** The seat's previous contest model, for the repetition check. */
  readonly previous?: ContestModel | null;
  /**
   * The action this answer is submitting, when it is a speech.
   *
   * Part J: the action and the claim-status update must be atomic. A block that
   * says `claim-percival` while the speech claims nothing leaves the table
   * seeing no claim at all — the seat believes it entered a contest it never
   * entered, and every later turn reasons from that.
   *
   * Checked against STRUCTURED fields only (`claim`, `retractClaim`,
   * `stances`), never against the prose. Grading an argument by keyword is what
   * Part J forbids, and it would reject good play for using the wrong words.
   */
  readonly speech?: {
    readonly claim: string | null;
    readonly retractClaim: boolean;
    readonly stances: readonly { readonly seat: number; readonly valence: number }[];
  } | null;
}

export function contestProblems(c: ContestWire, input: ContestCheckInput): string[] {
  const problems: string[] = [];
  const { seat, contest } = input;
  const move = c.publicClaimMove;

  const claimantsEver = new Set<number>(
    Object.values(contest.bySeat)
      .filter((r) => r && r.history.length > 0)
      .map((r) => r!.seat),
  );
  const iAmStanding = ["active", "contested"].includes(contest.bySeat[seat]?.status ?? "none");
  const iEverClaimed = (contest.bySeat[seat]?.history.length ?? 0) > 0;

  if (NEEDS_TARGET_CLAIMANT.includes(move.act)) {
    if (move.targetSeats.length === 0) {
      problems.push(`publicClaimMove.act 是 ${move.act}，但 targetSeats 是空的 —— 冲谁去`);
    }
    for (const target of move.targetSeats) {
      if (target === seat) {
        problems.push(`publicClaimMove.targetSeats 里有你自己（${seat}号）`);
      } else if (!claimantsEver.has(target)) {
        problems.push(
          `publicClaimMove 指向 ${target}号，但他从来没有声称过身份 —— ${move.act} 只能针对声称者`,
        );
      }
    }
  }
  if (NEEDS_OWN_CLAIM.includes(move.act) && !iAmStanding) {
    problems.push(
      `publicClaimMove.act 是 ${move.act}，但你现在没有成立的身份声称`,
    );
  }
  if (move.act === "retract-claim" && !iEverClaimed) {
    problems.push("publicClaimMove.act 是 retract-claim，但你从来没有声称过");
  }
  if (
    (move.act === "claim-percival" || move.act === "counterclaim-percival") &&
    c.ownClaimStrategy.currentStatus === "hidden"
  ) {
    problems.push(
      `这一步要跳，但 ownClaimStrategy.currentStatus 还写着 hidden —— 两边对不上`,
    );
  }
  if (
    move.act === "counterclaim-percival" &&
    contest.activePercivalClaimants.filter((s) => s !== seat).length === 0
  ) {
    problems.push("counterclaim-percival 需要桌上已经有人在声称派西维尔，现在没有");
  }
  if (move.requestedTeam) {
    if (input.teamSize !== null && move.requestedTeam.length !== input.teamSize) {
      problems.push(
        `requestedTeam 有 ${move.requestedTeam.length} 个人，这一轮的车是 ${input.teamSize} 人`,
      );
    }
    if (input.teamSize === null && move.requestedTeam.length > 5) {
      problems.push("requestedTeam 超过了任何一轮的车上限（5 人）");
    }
  }

  /* ── Comparative reading, when there is a contest to read ────────────── */
  const standing = contest.activePercivalClaimants;
  const assessed = new Set<number>(c.claimantAssessments.map((a) => a.claimantSeat));
  for (const claimant of standing) {
    if (claimant === seat) continue;
    if (!assessed.has(claimant)) {
      problems.push(
        `${claimant}号 正站在派西维尔上，但 claimantAssessments 里没有他 —— 派权争夺不能只看自己`,
      );
    }
  }
  if (
    c.alignment.stance !== "undecided" &&
    c.alignment.selectedClaimant !== null &&
    c.alignment.selectedClaimant !== seat &&
    !assessed.has(c.alignment.selectedClaimant as Seat)
  ) {
    problems.push(
      `alignment.selectedClaimant 是 ${c.alignment.selectedClaimant}号，但你没有对他做出评估`,
    );
  }
  for (const a of c.claimantAssessments) {
    if (a.claimantSeat === seat) continue;
    if (a.positiveCase.length === 0 && a.negativeCase.length === 0) {
      problems.push(
        `claimantAssessments[${a.claimantSeat}] 既没有正面也没有反面 —— 那不是评估`,
      );
    }
  }
  const rivals = new Set(c.rivalPlans.map((r) => r.rivalSeat));
  if (rivals.has(seat)) problems.push("rivalPlans 里有你自己");
  if (!iAmStanding && c.rivalPlans.length > 0) {
    problems.push("rivalPlans 只在你自己也站在声称上时才有意义");
  }
  // Part F: an active claimant facing rivals must have a plan for at least one.
  if (iAmStanding && standing.filter((s) => s !== seat).length > 0 && c.rivalPlans.length === 0) {
    problems.push(
      "你正在声称，而桌上还有别的声称者，但 rivalPlans 是空的 —— 竞争者不能当作平行意见",
    );
  }

  /* ── The action must express the move ───────────────────────────────── */
  const speech = input.speech;
  if (speech) {
    const claiming = move.act === "claim-percival" || move.act === "counterclaim-percival";
    if (claiming && speech.claim !== "percival") {
      problems.push(
        `publicClaimMove.act 是 ${move.act}，但这次发言的 claim 是 ${String(speech.claim)} —— ` +
          `只在 contest 里写「我跳了」，牌桌什么都看不到`,
      );
    }
    if (move.act === "retract-claim" && !speech.retractClaim) {
      problems.push(
        "publicClaimMove.act 是 retract-claim，但这次发言没有把 retractClaim 填 true —— " +
          "claim 填 null 只是这次不谈身份，之前的声称仍然成立",
      );
    }
    if (speech.retractClaim && move.act !== "retract-claim") {
      problems.push(
        `这次发言退了水，但 publicClaimMove.act 是 ${move.act} —— 两边对不上`,
      );
    }
    // Attacking and endorsing are expressed publicly through `stances`, which
    // is a structured field the action format already carries.
    if (move.act === "attack-rival-claim") {
      for (const target of move.targetSeats) {
        if (!speech.stances.some((st) => st.seat === target && st.valence < 0)) {
          problems.push(
            `你说要打 ${target}号 的声称，但这次发言的 stances 里没有对他的负面表态 —— 牌桌看不到这一手`,
          );
        }
      }
    }
    if (move.act === "endorse-claimant") {
      for (const target of move.targetSeats) {
        if (!speech.stances.some((st) => st.seat === target && st.valence > 0)) {
          problems.push(
            `你说要保 ${target}号，但这次发言的 stances 里没有对他的正面表态`,
          );
        }
      }
    }
  }

  /* ── The repetition check ───────────────────────────────────────────── */
  const previous = input.previous?.ownClaimStrategy;
  if (
    previous &&
    c.ownClaimStrategy.currentStatus === "hidden" &&
    previous.currentStatus === "hidden" &&
    previous.situationSpecificBenefit.trim() ===
      c.ownClaimStrategy.situationSpecificBenefit.trim() &&
    previous.situationSpecificRisk.trim() === c.ownClaimStrategy.situationSpecificRisk.trim() &&
    previous.triggerToClaim.trim() === c.ownClaimStrategy.triggerToClaim.trim()
  ) {
    // The M5 pilot's Percival wrote nearly the same trigger seventeen times.
    // Identical text across turns means the decision was not re-made, and a
    // decision that is not re-made cannot respond to the board.
    problems.push(
      "这一轮不跳的理由和上一轮一字不差 —— 局面变了理由就该变，照抄说明这个决定没有被重新做过",
    );
  }
  return problems;
}

/* ── Applying ───────────────────────────────────────────────────────────── */

/**
 * Fold a validated contest block into the seat's model.
 *
 * Three things are OVERWRITTEN rather than accepted: `publicClaimStatus` comes
 * from the referee's derivation, and `restsOnUnverified` / `evidenceResolves`
 * come from the registry. Same one-way valve as everywhere else in this layer.
 */
export function applyContest(
  seat: Seat,
  wire: ContestWire,
  registry: VisibleFactRegistry,
  contest: ClaimContest,
  atSequence: number,
): ContestModel {
  return deepFreeze({
    seat,
    ownClaimStrategy: {
      currentStatus: wire.ownClaimStrategy.currentStatus,
      intendedClaimRole: (wire.ownClaimStrategy.intendedClaimRole as RoleType | null) ?? null,
      situationSpecificBenefit: wire.ownClaimStrategy.situationSpecificBenefit,
      situationSpecificRisk: wire.ownClaimStrategy.situationSpecificRisk,
      triggerToClaim: wire.ownClaimStrategy.triggerToClaim,
      triggerToRetract: wire.ownClaimStrategy.triggerToRetract,
      candidatePairStory: wire.ownClaimStrategy.candidatePairStory,
      leadershipObjective: wire.ownClaimStrategy.leadershipObjective,
      concealmentCost: wire.ownClaimStrategy.concealmentCost,
      consistencyObligations: [...wire.ownClaimStrategy.consistencyObligations],
      atSequence,
    },
    claimantAssessments: wire.claimantAssessments.map((a) => ({
      claimantSeat: a.claimantSeat as Seat,
      // From the referee, not from the model. A seat cannot decide that a rival
      // has retracted.
      publicClaimStatus: contest.bySeat[a.claimantSeat as Seat]?.status ?? "none",
      claimedRole: (a.claimedRole as RoleType | null) ?? null,
      claimedOrImpliedPair: (a.claimedOrImpliedPair as Seat[] | null) ?? null,
      positiveCase: [...a.positiveCase],
      negativeCase: [...a.negativeCase],
      contradictions: [...a.contradictions],
      fulfilledPredictions: [...a.fulfilledPredictions],
      failedPredictions: [...a.failedPredictions],
      currentAssessment: a.currentAssessment,
      conditionToUpgrade: a.conditionToUpgrade,
      conditionToDowngrade: a.conditionToDowngrade,
      premiseIds: [...a.premiseIds],
      restsOnUnverified: a.premiseIds.some((id) => !isVerifiedPremise(registry, id)),
    })),
    rivalPlans: wire.rivalPlans.map((r) => ({ ...r, rivalSeat: r.rivalSeat as Seat })),
    alignment: {
      selectedClaimant: (wire.alignment.selectedClaimant as Seat | null) ?? null,
      stance: wire.alignment.stance,
      proposition: wire.alignment.proposition,
      voteOrTeamConsequence: wire.alignment.voteOrTeamConsequence,
      conditionToSwitch: wire.alignment.conditionToSwitch,
    },
    publicClaimMove: {
      act: wire.publicClaimMove.act,
      targetSeats: wire.publicClaimMove.targetSeats as Seat[],
      publicProposition: wire.publicClaimMove.publicProposition,
      requestedTeam: (wire.publicClaimMove.requestedTeam as Seat[] | null) ?? null,
      requestedVote: wire.publicClaimMove.requestedVote,
      evidenceIds: [...wire.publicClaimMove.evidenceIds],
      informationToConceal: wire.publicClaimMove.informationToConceal,
      evidenceResolves:
        wire.publicClaimMove.evidenceIds.length > 0 &&
        wire.publicClaimMove.evidenceIds.every((id) => isVerifiedPremise(registry, id)),
    },
    atSequence,
  });
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

const STATUS_LABEL: Readonly<Record<OwnClaimStatus, string>> = {
  hidden: "藏着",
  considering: "在考虑跳",
  active: "已经跳了",
  defending: "在防守自己的声称",
  retracting: "打算退水",
  retracted: "已经退水",
};

const LEVEL_LABEL: Readonly<Record<ClaimAssessmentLevel, string>> = {
  leading: "目前最站得住",
  plausible: "说得通",
  contested: "有人在驳",
  weak: "站不太住",
  broken: "已经被公开记录打穿",
};

const STANCE_LABEL: Readonly<Record<ContestStance, string>> = {
  support: "支持",
  "conditional-support": "有条件支持",
  oppose: "反对",
  undecided: "还没定",
};

const seatList = (seats: readonly Seat[]) => seats.join("、");

/** The contest model as the seat reads it back next turn. */
export function renderContest(model: ContestModel | null): string {
  if (!model) return "";
  if (!model.ownClaimStrategy && model.claimantAssessments.length === 0) return "";

  const lines: string[] = ["## 你在派权争夺里的位置（只有你看得到）"];

  const o = model.ownClaimStrategy;
  if (o) {
    lines.push("", "### 你自己的声称策略");
    lines.push(
      `- 现在：**${STATUS_LABEL[o.currentStatus]}**` +
        (o.intendedClaimRole ? `，打算声称 ${o.intendedClaimRole}` : ""),
    );
    lines.push(`    这一手换到的：${o.situationSpecificBenefit}`);
    lines.push(`    这一手的代价：${o.situationSpecificRisk}`);
    lines.push(`    什么会让你跳：${o.triggerToClaim}`);
    lines.push(`    什么会让你退水：${o.triggerToRetract}`);
    if (o.candidatePairStory) lines.push(`    你要讲的候选对故事：${o.candidatePairStory}`);
    if (o.leadershipObjective) lines.push(`    你想拿到的领导权用来做什么：${o.leadershipObjective}`);
    if (o.concealmentCost) lines.push(`    继续藏着的代价：${o.concealmentCost}`);
    if (o.consistencyObligations.length > 0) {
      lines.push(`    你必须保持一致的话：${o.consistencyObligations.join("；")}`);
    }
  }

  if (model.claimantAssessments.length > 0) {
    lines.push("", "### 你对每个声称者的评估");
    for (const a of model.claimantAssessments) {
      const mark = a.restsOnUnverified ? "【依据里有未证实的】" : "【依据都是裁判记录】";
      lines.push(
        `- ${a.claimantSeat}号（公开状态：${a.publicClaimStatus}` +
          (a.claimedRole ? `，声称 ${a.claimedRole}` : "") +
          `）：**${LEVEL_LABEL[a.currentAssessment]}**　${mark}`,
      );
      if (a.claimedOrImpliedPair) {
        lines.push(`    他说的候选对：${seatList(a.claimedOrImpliedPair)}号`);
      }
      if (a.positiveCase.length > 0) lines.push(`    正面：${a.positiveCase.join("；")}`);
      if (a.negativeCase.length > 0) lines.push(`    反面：${a.negativeCase.join("；")}`);
      if (a.contradictions.length > 0) lines.push(`    矛盾：${a.contradictions.join("；")}`);
      if (a.fulfilledPredictions.length > 0) {
        lines.push(`    说中了：${a.fulfilledPredictions.join("；")}`);
      }
      if (a.failedPredictions.length > 0) lines.push(`    说错了：${a.failedPredictions.join("；")}`);
      lines.push(`    什么会让你上调：${a.conditionToUpgrade}`);
      lines.push(`    什么会让你下调：${a.conditionToDowngrade}`);
    }
  }

  if (model.rivalPlans.length > 0) {
    lines.push("", "### 你打算怎么和竞争者争");
    for (const r of model.rivalPlans) {
      lines.push(`- 对 ${r.rivalSeat}号：${r.whyTheirClaimCompetesWithMine}`);
      lines.push(`    你要打的点：${r.attackCase}`);
      lines.push(`    他大概会怎么答：${r.expectedDefense}`);
      lines.push(`    你准备怎么回：${r.myResponse}`);
      lines.push(`    打过头的风险：${r.riskOfOverattacking}`);
      lines.push(`    能分开你们俩的公开检验：${r.distinctionTest}`);
    }
  }

  const al = model.alignment;
  if (al) {
    lines.push("", "### 你上一步在派权上的站位");
    lines.push(
      `- ${STANCE_LABEL[al.stance]}${al.selectedClaimant !== null ? ` ${al.selectedClaimant}号` : ""}：${al.proposition}`,
    );
    lines.push(`    落到票或车上：${al.voteOrTeamConsequence}`);
    lines.push(`    什么会让你换边：${al.conditionToSwitch}`);
  }

  const mv = model.publicClaimMove;
  if (mv) {
    lines.push("", "### 你上一步做的公开动作");
    lines.push(
      `- ${mv.act}${mv.targetSeats.length > 0 ? ` → ${seatList(mv.targetSeats)}号` : ""}：${mv.publicProposition}`,
    );
    if (mv.requestedTeam) lines.push(`    要过的车：${seatList(mv.requestedTeam)}号`);
    if (mv.requestedVote !== "none") lines.push(`    要的票：${mv.requestedVote}`);
    if (mv.informationToConceal) lines.push(`    这一步不能漏的：${mv.informationToConceal}`);
  }

  return lines.join("\n");
}
