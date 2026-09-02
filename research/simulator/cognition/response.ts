/**
 * The fused response: one request returns the move AND the cognition update.
 *
 * WHY FUSED AND NOT A SECOND CALL. A game already costs 133-192 requests, and
 * input is 87% of the uncached spend. A separate cognition call would carry
 * the same fact tables and the same history a second time, so the marginal
 * cost is not one extra call — it is one extra COPY OF THE PROMPT. Folding the
 * update into the answer the model was going to give anyway makes the memory
 * free.
 *
 * WHAT THIS IS NOT. Not chain-of-thought. Every field is an id list, an enum,
 * or a short bounded conclusion; there is no field where a model could put
 * "here is my reasoning" and nothing that would store it if it tried. That is
 * a size decision as much as a policy one — stored reasoning is a prompt that
 * grows without a ceiling, and two paid games have already died on ceilings.
 *
 * THE ONE-WAY VALVE. `premiseVerified` arrives from the model and is thrown
 * away: `applyFusedUpdate` re-derives it from the referee's own fact ids. Without
 * that, `restsOnUnverified` would be self-certified and the ledger's central
 * guarantee would be a model promising to be honest.
 *
 * STATUS: runtime-connected, but only when `cognition.enabled` is true.
 */

import type { Fragment } from "../model/json-schema";
import type { Seat } from "../core/types";
import { SEATS } from "../core/types";
import {
  CONFIDENCE_VALUES,
  activeCommitments,
  applyCognitionUpdate,
  commitmentId,
  withCommitmentIds,
  emptyDossier,
  type Confidence,
  type EpistemicLedger,
  type PublicCommitment,
  type SeatDossier,
} from "./ledger";
import type { Observation } from "../core/observation";
import {
  isVerifiedPremise,
  LEGACY_OWN_ROLE_ID,
  type VisibleFactRegistry,
} from "./fact-ids";
import {
  COGNITION_LIMITS as L,
  checkChars,
  checkCount,
  checkMinCount,
  type CognitionLimitsV3,
  type LimitViolation,
} from "./limits";
import { conclusionConsistency, validateConclusion, type StructuredConclusion } from "./protocol";
import type { ClaimContest } from "./claim-contest";
import {
  applyContest,
  checkContestBounds,
  contestFragment,
  contestProblems,
  parseContest,
  type ContestCheckInput,
  type ContestModel,
  type ContestWire,
} from "./contest";
import {
  applySocial,
  checkSocialBounds,
  parseSocial,
  socialFragment,
  socialProblems,
  type SocialModel,
  type SocialWire,
} from "./social";

/* ── The wire shape ─────────────────────────────────────────────────────── */

export interface FusedCognition {
  readonly factsUsed: readonly string[];
  readonly claimsReliedOn: readonly string[];
  readonly claimsQuestioned: readonly string[];
  readonly alternativesConsidered: readonly string[];
  readonly selectedActionSummary: string;
  readonly intendedPublicSignal: string;
  readonly updatedRolePlan: string | null;
  readonly constraints: readonly {
    readonly id: string;
    readonly statement: string;
    readonly premiseIds: readonly string[];
    readonly premiseLabels: readonly string[];
  }[];
  readonly hypotheses: readonly {
    readonly id: string;
    readonly label: string;
    readonly evilSeats: readonly number[];
    readonly rationale: string;
    readonly standing: Confidence;
  }[];
  readonly seatReads: readonly {
    readonly seat: number;
    readonly standing: Confidence;
    readonly evidenceFor: readonly string[];
    readonly evidenceAgainst: readonly string[];
    readonly lastChangeReason: string;
  }[];
  readonly coverStory: string;
  readonly claimPlan: string;
  readonly nextTurnPlan: string;
  readonly newCommitments: readonly string[];
  /**
   * Commitments this turn closes, by their exact text. `prompt-0.3.1` only.
   *
   * Matched by text because text is what the model is shown; an index would be
   * a number it has to count, and a miscount would silently close the wrong
   * promise. An unmatched string is reported, never guessed at.
   */
  readonly closedCommitments?: readonly {
    /** `prompt-0.5.0`: the stable id. Absent on the two frozen stacks. */
    readonly id?: string;
    /** `prompt-0.3.1` / `0.4.0`: the exact text. Kept so those stay byte-identical. */
    readonly text?: string;
    readonly resolution: "fulfilled" | "obsolete" | "withdrawn";
  }[];
  /** The bounded social model. `prompt-0.3.1` only; absent on the 0.3.0 path. */
  readonly social?: SocialWire;
  /** The claim contest. `prompt-0.4.0` only. */
  readonly contest?: ContestWire;
}

/**
 * The strict JSON Schema for the cognition block.
 *
 * `premiseVerified` is deliberately ABSENT from the wire: a field the model
 * fills in and the system ignores is a field somebody will eventually trust.
 * Not offering it is cheaper than policing it.
 *
 * A FUNCTION, not a constant, because two prompt versions want two shapes and
 * the older one has to keep producing the same bytes. `COGNITION_FRAGMENT`
 * below is that older shape, pinned.
 */
export interface FragmentOptions {
  /** `prompt-0.3.1` adds the social block and commitment closing. */
  readonly withSocial?: boolean;
  /** `prompt-0.4.0` adds the claim contest on top of that. */
  readonly withContest?: boolean;
  /**
   * `prompt-0.5.0` closes commitments by ID rather than by exact text.
   *
   * A separate flag rather than being folded into `withContest`, because the
   * two frozen stacks must keep sending the `text` shape byte for byte — the
   * completed pilot's schema is part of its record.
   */
  readonly withCommitmentIds?: boolean;
}

export function cognitionFragment(
  limits: CognitionLimitsV3,
  options: FragmentOptions = {},
): Fragment {
  const withSocial = options.withSocial === true;
  const withContest = options.withContest === true;
  const withIds = options.withCommitmentIds === true;
  const required = [
    "factsUsed",
    "claimsReliedOn",
    "claimsQuestioned",
    "alternativesConsidered",
    "selectedActionSummary",
    "intendedPublicSignal",
    "updatedRolePlan",
    "constraints",
    "hypotheses",
    "seatReads",
    "coverStory",
    "claimPlan",
    "nextTurnPlan",
    "newCommitments",
    ...(withSocial ? ["closedCommitments", "social"] : []),
    ...(withContest ? ["contest"] : []),
  ];
  const properties: Record<string, Fragment> = {
    factsUsed: { type: "array", items: { type: "string" }, maxItems: limits.maxFactsUsed },
    claimsReliedOn: { type: "array", items: { type: "string" }, maxItems: limits.maxClaimsReliedOn },
    claimsQuestioned: {
      type: "array",
      items: { type: "string" },
      maxItems: limits.maxClaimsQuestioned,
    },
    alternativesConsidered: {
      type: "array",
      items: { type: "string", maxLength: limits.alternativeChars * 3 },
      minItems: limits.minAlternativesConsidered,
      maxItems: limits.maxAlternativesConsidered,
    },
    selectedActionSummary: { type: "string" },
    intendedPublicSignal: { type: "string" },
    updatedRolePlan: { type: ["string", "null"] },
    constraints: {
      type: "array",
      maxItems: limits.maxDerivedConstraints,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement", "premiseIds", "premiseLabels"],
        properties: {
          id: withSocial ? { type: "string", minLength: 1 } : { type: "string" },
          statement: withSocial ? { type: "string", minLength: 1 } : { type: "string" },
          premiseIds: {
            type: "array",
            items: { type: "string" },
            // The pilot's four constraint re-asks were all an EMPTY array: the
            // schema allowed it, the parser refused it, and the model paid a
            // whole request to find that out. Now the provider says no first.
            ...(withSocial ? { minItems: 1 } : {}),
            maxItems: limits.maxPremisesPerConstraint,
          },
          premiseLabels: {
            type: "array",
            items: { type: "string" },
            maxItems: limits.maxPremisesPerConstraint,
          },
        },
      },
    },
    hypotheses: {
      type: "array",
      minItems: limits.minHypotheses,
      maxItems: limits.maxHypotheses,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "evilSeats", "rationale", "standing"],
        properties: {
          id: withSocial ? { type: "string", minLength: 1 } : { type: "string" },
          // The pilot's fifth re-ask was a hypothesis with an EMPTY label and
          // an empty rationale. Two placeholder worlds satisfy `minItems: 2`
          // and say nothing, so the floor is now on the content too.
          label: withSocial ? { type: "string", minLength: 1 } : { type: "string" },
          evilSeats: {
            type: "array",
            items: { type: "integer", minimum: 1, maximum: 10 },
            maxItems: 4,
          },
          rationale: withSocial ? { type: "string", minLength: 1 } : { type: "string" },
          standing: { type: "string", enum: [...CONFIDENCE_VALUES] },
        },
      },
    },
    seatReads: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seat", "standing", "evidenceFor", "evidenceAgainst", "lastChangeReason"],
        properties: {
          seat: { type: "integer", minimum: 1, maximum: 10 },
          standing: { type: "string", enum: [...CONFIDENCE_VALUES] },
          evidenceFor: {
            type: "array",
            items: { type: "string" },
            maxItems: limits.evidenceForPerSeat,
          },
          evidenceAgainst: {
            type: "array",
            items: { type: "string" },
            maxItems: limits.evidenceAgainstPerSeat,
          },
          lastChangeReason: { type: "string" },
        },
      },
    },
    coverStory: { type: "string" },
    claimPlan: { type: "string" },
    nextTurnPlan: { type: "string" },
    newCommitments: {
      type: "array",
      items: { type: "string" },
      maxItems: limits.maxPublicCommitments,
    },
  };

  if (withSocial) {
    properties.closedCommitments = {
      type: "array",
      maxItems: limits.maxClosedCommitments,
      items: {
        type: "object",
        additionalProperties: false,
        // 0.5.0 asks for the id; the two frozen stacks keep asking for the
        // exact text, which is what their recorded schemas say.
        required: withIds ? ["id", "resolution"] : ["text", "resolution"],
        properties: withIds
          ? {
              id: { type: "string", minLength: 1 },
              resolution: { type: "string", enum: ["fulfilled", "obsolete", "withdrawn"] },
            }
          : {
              text: { type: "string", minLength: 1 },
              resolution: { type: "string", enum: ["fulfilled", "obsolete", "withdrawn"] },
            },
      },
    };
    properties.social = socialFragment(limits);
  }
  if (withContest) properties.contest = contestFragment(limits);

  return { type: "object", additionalProperties: false, required, properties };
}

/**
 * The `prompt-0.3.0` shape, pinned.
 *
 * Built from the frozen limit table with the social block off, so it is the
 * same object the completed pilot sent. `response.test.ts` diffs it against a
 * recorded digest — a change here would silently un-reproduce that game.
 */
export const COGNITION_FRAGMENT: Fragment = cognitionFragment(
  L as unknown as CognitionLimitsV3,
);

/* ── Parsing ────────────────────────────────────────────────────────────── */

/** Local helper: the parser builds arrays before the readonly shape is final. */
type Mutable<T> = T extends readonly (infer U)[] ? U[] : T;

export type CognitionParse =
  | { readonly ok: true; readonly cognition: FusedCognition }
  | { readonly ok: false; readonly error: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? [...(v as string[])] : null;

/**
 * Field-specific errors, because a repair note saying "invalid" teaches the
 * model nothing and costs a whole extra request to learn nothing from.
 */
export interface ParseOptions {
  readonly limits?: CognitionLimitsV3;
  /** `prompt-0.3.1` requires the social block. 0.3.0 must not even look. */
  readonly withSocial?: boolean;
  /** `prompt-0.4.0` requires the claim-contest block as well. */
  readonly withContest?: boolean;
  /** `prompt-0.5.0` closes commitments by id, and refuses a bare text. */
  readonly withCommitmentIds?: boolean;
}

export function parseCognition(
  raw: unknown,
  options: ParseOptions = {},
): CognitionParse {
  const limits = options.limits ?? (L as unknown as CognitionLimitsV3);
  const withSocial = options.withSocial === true;
  const withContest = options.withContest === true;
  const withCommitmentIds = options.withCommitmentIds === true;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "缺少 cognition 对象" };
  }
  const c = raw as Record<string, unknown>;
  const fail = (error: string): CognitionParse => ({ ok: false, error });

  const factsUsed = strArray(c.factsUsed);
  if (!factsUsed) return fail("cognition.factsUsed 必须是字符串数组（引用的硬事实 id）");
  const claimsReliedOn = strArray(c.claimsReliedOn);
  if (!claimsReliedOn) return fail("cognition.claimsReliedOn 必须是字符串数组");
  const claimsQuestioned = strArray(c.claimsQuestioned);
  if (!claimsQuestioned) return fail("cognition.claimsQuestioned 必须是字符串数组");
  const alternativesConsidered = strArray(c.alternativesConsidered);
  if (!alternativesConsidered) return fail("cognition.alternativesConsidered 必须是字符串数组");
  if (alternativesConsidered.length < limits.minAlternativesConsidered) {
    return fail(
      `cognition.alternativesConsidered 至少要 ${limits.minAlternativesConsidered} 条 —— 只想一个动作不叫比较`,
    );
  }

  const selectedActionSummary = str(c.selectedActionSummary);
  if (selectedActionSummary === null) return fail("cognition.selectedActionSummary 必须是字符串");
  const intendedPublicSignal = str(c.intendedPublicSignal);
  if (intendedPublicSignal === null) return fail("cognition.intendedPublicSignal 必须是字符串");
  const coverStory = str(c.coverStory) ?? "";
  const claimPlan = str(c.claimPlan) ?? "";
  const nextTurnPlan = str(c.nextTurnPlan) ?? "";
  const newCommitments = strArray(c.newCommitments) ?? [];

  if (!Array.isArray(c.constraints)) return fail("cognition.constraints 必须是数组");
  const constraints: Mutable<FusedCognition["constraints"]> = [];
  for (const [i, item] of (c.constraints as unknown[]).entries()) {
    if (!item || typeof item !== "object") return fail(`cognition.constraints[${i}] 不是对象`);
    const k = item as Record<string, unknown>;
    const id = str(k.id);
    const statement = str(k.statement);
    const premiseIds = strArray(k.premiseIds);
    if (!id || !statement || !premiseIds) {
      return fail(`cognition.constraints[${i}] 需要 id、statement、premiseIds`);
    }
    const premiseLabels = strArray(k.premiseLabels) ?? premiseIds;
    if (premiseIds.length === 0) {
      // A conclusion with no premises is the exact failure the ledger exists
      // to prevent: it cannot be checked, so it can never be un-believed.
      return fail(
        `cognition.constraints[${i}] 没有列出前提 —— 事实表每行开头的 \`[f…]\` / \`[c…]\` / \`[p…]\` 就是 id，照抄进 premiseIds`,
      );
    }
    constraints.push({ id, statement, premiseIds, premiseLabels });
  }

  if (!Array.isArray(c.hypotheses)) return fail("cognition.hypotheses 必须是数组");
  const hypotheses: Mutable<FusedCognition["hypotheses"]> = [];
  for (const [i, item] of (c.hypotheses as unknown[]).entries()) {
    if (!item || typeof item !== "object") return fail(`cognition.hypotheses[${i}] 不是对象`);
    const h = item as Record<string, unknown>;
    const id = str(h.id);
    const label = str(h.label);
    const rationale = str(h.rationale) ?? "";
    const standing = str(h.standing);
    if (withSocial && (id?.trim() === "" || label?.trim() === "" || rationale.trim() === "")) {
      // The pilot's fifth re-ask: two hypotheses with `label: ""` and
      // `rationale: ""`. `minItems: 2` was satisfied and no world was
      // described. The old message ("需要 id、label、standing") was true of a
      // MISSING field and confusing about an empty one, and cost a request to
      // say so. Only 0.3.1 gets the better wording — the note goes into the
      // retry prompt, so changing it for 0.3.0 would change that game's bytes.
      return fail(
        `cognition.hypotheses[${i}] 的 id / label / rationale 有空字符串 —— 占位的世界不是世界`,
      );
    }
    if (!id || !label || !standing) {
      return fail(`cognition.hypotheses[${i}] 需要 id、label、standing`);
    }
    if (!(CONFIDENCE_VALUES as readonly string[]).includes(standing)) {
      return fail(
        `cognition.hypotheses[${i}].standing 必须是 ${CONFIDENCE_VALUES.join(" / ")} 之一`,
      );
    }
    const evilSeats = Array.isArray(h.evilSeats)
      ? (h.evilSeats as unknown[]).filter((x): x is number => typeof x === "number")
      : [];
    hypotheses.push({ id, label, evilSeats, rationale, standing: standing as Confidence });
  }
  if (hypotheses.length < limits.minHypotheses) {
    return fail(
      `cognition.hypotheses 至少要 ${limits.minHypotheses} 种 —— 只留一种世界就是过早锁死`,
    );
  }

  if (!Array.isArray(c.seatReads)) return fail("cognition.seatReads 必须是数组");
  const seatReads: Mutable<FusedCognition["seatReads"]> = [];
  for (const [i, item] of (c.seatReads as unknown[]).entries()) {
    if (!item || typeof item !== "object") return fail(`cognition.seatReads[${i}] 不是对象`);
    const r = item as Record<string, unknown>;
    const seat = typeof r.seat === "number" ? r.seat : null;
    const standing = str(r.standing);
    if (seat === null || !SEATS.includes(seat as Seat)) {
      return fail(`cognition.seatReads[${i}].seat 必须是 1-10`);
    }
    if (!standing || !(CONFIDENCE_VALUES as readonly string[]).includes(standing)) {
      return fail(`cognition.seatReads[${i}].standing 取值不合法`);
    }
    seatReads.push({
      seat,
      standing: standing as Confidence,
      evidenceFor: strArray(r.evidenceFor) ?? [],
      evidenceAgainst: strArray(r.evidenceAgainst) ?? [],
      lastChangeReason: str(r.lastChangeReason) ?? "",
    });
  }

  let closedCommitments: FusedCognition["closedCommitments"];
  let social: SocialWire | undefined;
  if (withSocial) {
    if (!Array.isArray(c.closedCommitments)) {
      return fail("cognition.closedCommitments 必须是数组（没有要关的就给空数组）");
    }
    // Accepts BOTH shapes. 0.5.0 sends `id`; the two frozen stacks send `text`,
    // and a checkpoint resumed across the boundary can carry either.
    const closed: {
      id?: string;
      text?: string;
      resolution: "fulfilled" | "obsolete" | "withdrawn";
    }[] = [];
    for (const [i, item] of (c.closedCommitments as unknown[]).entries()) {
      if (!item || typeof item !== "object") {
        return fail(`cognition.closedCommitments[${i}] 不是对象`);
      }
      const k = item as Record<string, unknown>;
      const id = str(k.id);
      const text = str(k.text);
      const resolution = str(k.resolution);
      if (!id && !text) {
        return fail(
          `cognition.closedCommitments[${i}] 要么给 id（0.5.0），要么给 text（旧版本），不能都空`,
        );
      }
      if (withCommitmentIds && !id) {
        return fail(
          `cognition.closedCommitments[${i}].id 不能为空 —— ` +
            `0.5.0 用承诺 id 关闭，不再靠原文匹配（每条承诺前面的方括号就是它的 id）`,
        );
      }
      if (!resolution || !["fulfilled", "obsolete", "withdrawn"].includes(resolution)) {
        return fail(
          `cognition.closedCommitments[${i}].resolution 必须是 fulfilled / obsolete / withdrawn`,
        );
      }
      closed.push({
        ...(id ? { id } : {}),
        ...(text ? { text } : {}),
        resolution: resolution as "fulfilled" | "obsolete" | "withdrawn",
      });
    }
    closedCommitments = closed;

    const parsedSocial = parseSocial(c.social);
    if (!parsedSocial.ok) return fail(parsedSocial.error);
    social = parsedSocial.social;
  }

  let contest: ContestWire | undefined;
  if (withContest) {
    const parsedContest = parseContest(c.contest);
    if (!parsedContest.ok) return fail(parsedContest.error);
    contest = parsedContest.contest;
  }

  return {
    ok: true,
    cognition: {
      factsUsed,
      claimsReliedOn,
      claimsQuestioned,
      alternativesConsidered,
      selectedActionSummary,
      intendedPublicSignal,
      updatedRolePlan: str(c.updatedRolePlan),
      constraints,
      hypotheses,
      seatReads,
      coverStory,
      claimPlan,
      nextTurnPlan,
      newCommitments,
      ...(closedCommitments ? { closedCommitments } : {}),
      ...(social ? { social } : {}),
      ...(contest ? { contest } : {}),
    },
  };
}

/* ── Bounds ─────────────────────────────────────────────────────────────── */

/**
 * Bounds checked AFTER parsing, and never enforced by truncation.
 *
 * Silently trimming a model-owned semantic field would leave a ledger whose
 * contents nobody chose: half a sentence of evidence reads as a complete
 * thought. The pilot reports over-runs instead, so the limits can be
 * calibrated against what the model actually writes.
 */
export function checkCognitionBounds(
  c: FusedCognition,
  limits: CognitionLimitsV3 = L as unknown as CognitionLimitsV3,
): LimitViolation[] {
  const bad: LimitViolation[] = [];
  const conclusion: StructuredConclusion = {
    factsUsed: c.factsUsed,
    claimsReliedOn: c.claimsReliedOn,
    claimsQuestioned: c.claimsQuestioned,
    alternativesConsidered: c.alternativesConsidered,
    selectedActionSummary: c.selectedActionSummary,
    intendedPublicSignal: c.intendedPublicSignal,
    updatedRolePlan: c.updatedRolePlan,
  };
  bad.push(...validateConclusion(conclusion));

  bad.push(...checkCount("cognition.constraints", c.constraints, L.maxDerivedConstraints));
  for (const k of c.constraints) {
    bad.push(...checkChars(`constraint[${k.id}].statement`, k.statement, L.constraintStatementChars));
    bad.push(...checkCount(`constraint[${k.id}].premises`, k.premiseIds, L.maxPremisesPerConstraint));
  }
  bad.push(...checkCount("cognition.hypotheses", c.hypotheses, limits.maxHypotheses));
  bad.push(...checkMinCount("cognition.hypotheses", c.hypotheses, limits.minHypotheses));
  for (const h of c.hypotheses) {
    bad.push(...checkChars(`hypothesis[${h.id}].label`, h.label, L.hypothesisLabelChars));
    bad.push(...checkChars(`hypothesis[${h.id}].rationale`, h.rationale, L.hypothesisRationaleChars));
  }
  for (const r of c.seatReads) {
    bad.push(...checkCount(`seatRead[${r.seat}].evidenceFor`, r.evidenceFor, L.evidenceForPerSeat));
    bad.push(
      ...checkCount(`seatRead[${r.seat}].evidenceAgainst`, r.evidenceAgainst, L.evidenceAgainstPerSeat),
    );
    for (const [i, e] of r.evidenceFor.entries()) {
      bad.push(...checkChars(`seatRead[${r.seat}].evidenceFor[${i}]`, e, L.evidenceChars));
    }
    for (const [i, e] of r.evidenceAgainst.entries()) {
      bad.push(...checkChars(`seatRead[${r.seat}].evidenceAgainst[${i}]`, e, L.evidenceChars));
    }
    bad.push(
      ...checkChars(`seatRead[${r.seat}].lastChangeReason`, r.lastChangeReason, L.lastChangeReasonChars),
    );
  }
  bad.push(...checkChars("cognition.coverStory", c.coverStory, L.coverStoryChars));
  bad.push(...checkChars("cognition.claimPlan", c.claimPlan, L.claimPlanChars));
  bad.push(...checkChars("cognition.nextTurnPlan", c.nextTurnPlan, L.nextTurnPlanChars));
  bad.push(...checkCount("cognition.newCommitments", c.newCommitments, limits.maxPublicCommitments));
  for (const [i, m] of c.newCommitments.entries()) {
    bad.push(...checkChars(`cognition.newCommitments[${i}]`, m, L.commitmentChars));
  }
  if (c.social) bad.push(...checkSocialBounds(c.social, limits));
  if (c.contest) bad.push(...checkContestBounds(c.contest, limits));
  return bad;
}

/** Cross-field problems a size limit cannot express. */
export interface ProblemContext {
  readonly seat: Seat;
  readonly contest: ClaimContest;
  /** The team size this mission wants, or null outside a proposal. */
  readonly teamSize: number | null;
  readonly previousContest?: ContestModel | null;
  /** The speech being submitted, when this decision is one. */
  readonly speech?: ContestCheckInput["speech"];
}

export function cognitionProblems(
  c: FusedCognition,
  context?: ProblemContext,
): string[] {
  const social = c.social ? socialProblems(c.social) : [];
  // The contest checks need the referee's own claim record, which the caller
  // has and this function does not. Without it the block is still parsed and
  // bounded — only the structural cross-checks are skipped, and the one place
  // that matters (`llm-agent`) always supplies it.
  const contest =
    c.contest && context
      ? contestProblems(c.contest, {
          seat: context.seat,
          contest: context.contest,
          teamSize: context.teamSize,
          ...(context.previousContest !== undefined
            ? { previous: context.previousContest }
            : {}),
          ...(context.speech !== undefined ? { speech: context.speech } : {}),
        })
      : [];
  const conclusion: StructuredConclusion = {
    factsUsed: c.factsUsed,
    claimsReliedOn: c.claimsReliedOn,
    claimsQuestioned: c.claimsQuestioned,
    alternativesConsidered: c.alternativesConsidered,
    selectedActionSummary: c.selectedActionSummary,
    intendedPublicSignal: c.intendedPublicSignal,
    updatedRolePlan: c.updatedRolePlan,
  };
  return [...conclusionConsistency(conclusion).map((p) => p.detail), ...social, ...contest];
}

/* ── The reducer ────────────────────────────────────────────────────────── */

export interface ApplyResult {
  readonly ledger: EpistemicLedger;
  /** Premise ids that named nothing this seat may cite. */
  readonly premisesOverridden: number;
  /** Premise ids that resolved to a REAL referee fact. The M5.1 headline. */
  readonly premisesVerified: number;
  /** Premise ids that resolved to a claim — cited honestly, still not hard. */
  readonly premisesFromClaims: number;
  /** `closedCommitments` entries that matched no live promise. */
  readonly unmatchedClosures: number;
}

export interface ApplyOptions {
  /**
   * The authoritative id table for THIS seat at THIS moment.
   *
   * Optional only so the `prompt-0.3.0` path keeps its old behaviour, where
   * "verified" meant "the id is in `previous.publicFacts`, or the literal
   * string `own-role`". With a registry, the answer also covers derived referee
   * arithmetic and this seat's private facts — and, crucially, refuses another
   * seat's private ids.
   */
  readonly registry?: VisibleFactRegistry;
  readonly limits?: CognitionLimitsV3;
  /** The referee's own claim record. Required to fold a contest block. */
  readonly claimContest?: ClaimContest;
}

/**
 * Fold a validated cognition block into a seat's ledger.
 *
 * The only path from model output to a ledger. Note what happens to premises:
 * the model supplies ids and labels, and THIS function decides `verified` by
 * asking whether the id names a referee fact. A model cannot promote its own
 * assumption, because it is never asked to.
 */
export function applyFusedUpdate(
  previous: EpistemicLedger,
  observation: Observation,
  cognition: FusedCognition,
  atSequence: number,
  options: ApplyOptions = {},
): ApplyResult {
  const registry = options.registry;
  const limits = options.limits ?? (L as unknown as CognitionLimitsV3);
  const factIds = new Set(previous.publicFacts.map((f) => f.id));
  const claimIds = new Set(previous.claims.map((c) => c.id));
  // With a registry, it answers. Without one, the pre-M5.1 rule stands so a
  // 0.3.0 replay resolves premises exactly as it did when it ran.
  const verified = (id: string) =>
    registry
      ? isVerifiedPremise(registry, id)
      : factIds.has(id) || id === LEGACY_OWN_ROLE_ID;
  const isClaim = (id: string) =>
    registry ? registry.byId.get(id)?.kind === "claim" : claimIds.has(id);

  let premisesOverridden = 0;
  let premisesVerified = 0;
  let premisesFromClaims = 0;
  const constraints = cognition.constraints.map((k) => {
    const premises = k.premiseIds.map((id, i) => {
      const isVerified = verified(id);
      if (isVerified) premisesVerified += 1;
      else if (isClaim(id)) premisesFromClaims += 1;
      else premisesOverridden += 1;
      return { id, verified: isVerified, label: k.premiseLabels[i] ?? id };
    });
    return {
      id: k.id,
      statement: k.statement,
      premises,
      restsOnUnverified: premises.some((p) => !p.verified),
      provenance: { kind: "inference" as const, premises },
      atSequence,
    };
  });

  const hypotheses = cognition.hypotheses.map((h) => ({
    id: h.id,
    label: h.label,
    evilSeats: h.evilSeats.filter((s): s is Seat => SEATS.includes(s as Seat)),
    rationale: h.rationale,
    standing: h.standing,
    premises: [],
    provenance: { kind: "inference" as const, premises: [] },
  }));

  const dossiers: Partial<Record<Seat, Partial<SeatDossier>>> = {};
  for (const r of cognition.seatReads) {
    const seat = r.seat as Seat;
    const base = previous.dossiers[seat] ?? emptyDossier(seat);
    dossiers[seat] = {
      standing: r.standing,
      evidenceFor: r.evidenceFor.map((text) => ({
        text,
        provenance: { kind: "inference" as const, premises: [] },
        atSequence,
      })),
      evidenceAgainst: r.evidenceAgainst.map((text) => ({
        text,
        provenance: { kind: "inference" as const, premises: [] },
        atSequence,
      })),
      lastChangeReason: r.lastChangeReason,
      lastChangedAtSequence:
        r.standing === base.standing ? base.lastChangedAtSequence : atSequence,
    };
  }

  /* ── Commitment lifecycle ─────────────────────────────────────────────
   *
   * Closing one is an ACT now, not a side effect of an overflow. The old
   * `slice(-8)` dropped the oldest live promise whenever a ninth arrived,
   * which meant a seat could stop being accountable for its opening statement
   * simply by talking more. History is kept; only the ACTIVE list is capped,
   * and the cap now drops the oldest STILL-LIVE promise as a last resort.
   */
  let unmatchedClosures = 0;
  // Keyed by id where the answer gave one, by text where it did not. Matching
  // by id is the M5.3 repair: text equality produced three unmatched closures
  // in one M5.2 game, each one a promise the seat believed it had discharged
  // and the ledger kept holding it to.
  const byId = new Map<string, "fulfilled" | "obsolete" | "withdrawn">();
  const byText = new Map<string, "fulfilled" | "obsolete" | "withdrawn">();
  for (const entry of cognition.closedCommitments ?? []) {
    if (entry.id) byId.set(entry.id, entry.resolution);
    else if (entry.text) byText.set(entry.text, entry.resolution);
  }
  const existing = withCommitmentIds(previous.self.publicCommitments);
  const carried: PublicCommitment[] = existing.map((c) => {
    const resolution = byId.get(c.id) ?? byText.get(c.text);
    const live = c.withdrawnAtSequence === null && (c.resolvedAtSequence ?? null) === null;
    if (!resolution || !live) return c;
    byId.delete(c.id);
    byText.delete(c.text);
    return {
      ...c,
      resolvedAtSequence: atSequence,
      resolution,
      withdrawnAtSequence: resolution === "withdrawn" ? atSequence : c.withdrawnAtSequence,
    };
  });
  unmatchedClosures = byId.size + byText.size;

  const commitments: PublicCommitment[] = [
    ...carried,
    ...cognition.newCommitments.map((text, i) => ({
      id: commitmentId(atSequence, i),
      text,
      atSequence,
      withdrawnAtSequence: null,
      resolvedAtSequence: null,
      resolution: null,
    })),
  ];
  const live = activeCommitments(commitments);
  if (live.length > limits.maxPublicCommitments) {
    // Oldest live promises retire first, and they retire as `obsolete` rather
    // than vanishing — the trace still says what happened to them.
    const retiring = new Set(live.slice(0, live.length - limits.maxPublicCommitments));
    for (const [i, c] of commitments.entries()) {
      if (retiring.has(c)) {
        commitments[i] = { ...c, resolvedAtSequence: atSequence, resolution: "obsolete" };
      }
    }
  }

  const social: SocialModel | null =
    cognition.social && registry
      ? applySocial(previous.seat, cognition.social, registry, atSequence)
      : previous.social;

  const contestModel: ContestModel | null =
    cognition.contest && registry && options.claimContest
      ? applyContest(
          previous.seat,
          cognition.contest,
          registry,
          options.claimContest,
          atSequence,
        )
      : previous.contest;

  const ledger = applyCognitionUpdate(previous, observation, {
    social,
    contest: contestModel,
    constraints,
    hypotheses,
    dossiers,
    self: {
      publicCommitments: commitments,
      rolePlan: cognition.updatedRolePlan ?? previous.self.rolePlan,
      intendedSignal: cognition.intendedPublicSignal,
      coverStory: cognition.coverStory,
      claimPlan: cognition.claimPlan,
      nextTurnPlan: cognition.nextTurnPlan,
      lastProcessedSequence: atSequence,
    },
  });

  return {
    ledger,
    premisesOverridden,
    premisesVerified,
    premisesFromClaims,
    unmatchedClosures,
  };
}
