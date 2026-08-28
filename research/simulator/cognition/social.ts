/**
 * Who is leading the table, and what this seat is going to do about it.
 *
 * WHY THIS EXISTS. The M5 pilot improved private reasoning and made the table
 * quieter: explicit engagement with somebody else's argument fell from 48% of
 * speeches to 21%. Ten seats each built a good private case and then said very
 * little to each other, and good never coordinated — no claim was made all
 * game, and evil won 3:0 without ever needing to break a coalition, because
 * there was never one to break.
 *
 * Real tables do not work like that. A focal player — often a claimed or merely
 * credible Percival — produces shared analysis, and loyal players conditionally
 * follow. That is a CONCLUSION about the table, so it belongs in the ledger
 * beside the seat reads, not in a free-text scratchpad.
 *
 * FOUR THINGS THIS DELIBERATELY IS NOT:
 *
 *   NOT A LEADER SCORE.  Nothing aggregates the ten social models. Each seat
 *                        keeps its own read, and two seats disagreeing about
 *                        who is focal is a legitimate table state — often the
 *                        interesting one. A global "true leader" would be a
 *                        referee fact nobody earned.
 *   NOT OBEDIENCE.       `follow` is one of four stances, every candidate
 *                        carries `reasonsToChallenge` beside `reasonsToFollow`,
 *                        and `conditionToReconsider` is required. A model that
 *                        cannot say what would make it stop following has not
 *                        decided to follow, it has deferred.
 *   NOT ROLE TRUTH.      `claimedRole` is what the seat SAID. The basis ids
 *                        resolve through the same registry premises do, so a
 *                        focal read resting on a claim is marked as resting on
 *                        a claim.
 *   NOT PUBLIC.          Seat-private, checkpointed with the rest of the
 *                        ledger, and excluded from the public replay by the
 *                        same field scan that excludes hypotheses.
 *
 * THE BRIDGE. `alignment` is what turns private analysis into a table-visible
 * move: it names the seat being followed or challenged, quotes the exact
 * proposition at issue, and states the public action. "I agree" is not an
 * alignment; "I take 8号's exclusion of 3 and will vote approve on 1/5/7/10"
 * is. See `SOCIAL_INSTRUCTION` for how that reaches the model.
 */

import { deepFreeze } from "../core/freeze";
import type { RoleType } from "@/lib/types/game";
import type { Seat } from "../core/types";
import { SEATS } from "../core/types";
import type { Fragment } from "../model/json-schema";
import { isVerifiedPremise, type VisibleFactRegistry } from "./fact-ids";
import {
  checkChars,
  checkCount,
  type CognitionLimitsV3,
  type LimitViolation,
} from "./limits";

/* ── Vocabulary ─────────────────────────────────────────────────────────── */

/** How much of the table's attention this seat is currently holding. */
export type Influence = "low" | "medium" | "high";

/**
 * How well what they say survives contact with the record.
 *
 * `contested` is its own value rather than a midpoint: a leader two people are
 * actively arguing with is in a different position from one nobody has tested,
 * and collapsing the two loses the distinction that decides whether following
 * costs anything.
 */
export type Credibility = "weak" | "contested" | "credible";

export type AlignmentStance =
  | "follow"
  | "conditional-follow"
  | "challenge"
  | "independent";

export const INFLUENCE_VALUES: readonly Influence[] = ["low", "medium", "high"];
export const CREDIBILITY_VALUES: readonly Credibility[] = [
  "weak",
  "contested",
  "credible",
];
export const ALIGNMENT_VALUES: readonly AlignmentStance[] = [
  "follow",
  "conditional-follow",
  "challenge",
  "independent",
];

/* ── The stored shape ───────────────────────────────────────────────────── */

export interface FocalCandidate {
  readonly seat: Seat;
  /** Public fact and claim ids this read is built on. Resolved, not trusted. */
  readonly basisIds: readonly string[];
  /** What they have CLAIMED to be, if anything. Never what they are. */
  readonly claimedRole: RoleType | null;
  readonly influence: Influence;
  readonly credibility: Credibility;
  /** The concrete thing they are currently asking the table to do. */
  readonly directive: string;
  readonly reasonsToFollow: readonly string[];
  readonly reasonsToChallenge: readonly string[];
  /** What would move this read. Required — see the header. */
  readonly conditionToReconsider: string;
  /**
   * Computed from `basisIds`, exactly as `DerivedConstraint` does it.
   *
   * A focal read built entirely on what somebody said about themselves is the
   * single most dangerous object in this file, and the only defence that
   * survives a persuasive model is one it cannot write.
   */
  readonly restsOnUnverified: boolean;
  readonly atSequence: number;
}

export interface Alignment {
  readonly stance: AlignmentStance;
  /** Null for `independent`; the seat being followed or challenged otherwise. */
  readonly focalSeat: Seat | null;
  /** The exact proposition being accepted or rejected. Not a summary of a mood. */
  readonly proposition: string;
  /** The strongest PUBLIC evidence for that proposition. */
  readonly strongestSupport: string;
  /** What this seat will actually do or say, in public. */
  readonly publicAction: string;
}

export interface CoalitionPlan {
  readonly coordinateWith: readonly Seat[];
  readonly proposedTeam: readonly Seat[] | null;
  readonly votingBloc: "approve" | "reject" | "undecided";
  readonly messageObjective: string;
  /** The strongest argument against this plan, which the plan must answer. */
  readonly strongestDissent: string;
}

export interface SocialModel {
  readonly seat: Seat;
  readonly focalCandidates: readonly FocalCandidate[];
  readonly alignment: Alignment | null;
  readonly coalitionPlan: CoalitionPlan | null;
  readonly atSequence: number;
}

export function emptySocialModel(seat: Seat): SocialModel {
  return deepFreeze({
    seat,
    focalCandidates: [],
    alignment: null,
    coalitionPlan: null,
    atSequence: 0,
  });
}

/* ── The wire shape ─────────────────────────────────────────────────────── */

export interface SocialWire {
  readonly focalCandidates: readonly {
    readonly seat: number;
    readonly basisIds: readonly string[];
    readonly claimedRole: string | null;
    readonly influence: Influence;
    readonly credibility: Credibility;
    readonly directive: string;
    readonly reasonsToFollow: readonly string[];
    readonly reasonsToChallenge: readonly string[];
    readonly conditionToReconsider: string;
  }[];
  readonly alignment: {
    readonly stance: AlignmentStance;
    readonly focalSeat: number | null;
    readonly proposition: string;
    readonly strongestSupport: string;
    readonly publicAction: string;
  };
  readonly coalitionPlan: {
    readonly coordinateWith: readonly number[];
    readonly proposedTeam: readonly number[] | null;
    readonly votingBloc: "approve" | "reject" | "undecided";
    readonly messageObjective: string;
    readonly strongestDissent: string;
  };
}

/**
 * The strict schema for the social block.
 *
 * `restsOnUnverified` is absent for the same reason `premiseVerified` is absent
 * from the cognition block: it is computed, and offering a model a field the
 * system overwrites is offering a field somebody will eventually trust.
 */
export function socialFragment(limits: CognitionLimitsV3): Fragment {
  const seat: Fragment = { type: "integer", minimum: 1, maximum: 10 };
  return {
    type: "object",
    additionalProperties: false,
    required: ["focalCandidates", "alignment", "coalitionPlan"],
    properties: {
      focalCandidates: {
        type: "array",
        maxItems: limits.maxFocalCandidates,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "seat",
            "basisIds",
            "claimedRole",
            "influence",
            "credibility",
            "directive",
            "reasonsToFollow",
            "reasonsToChallenge",
            "conditionToReconsider",
          ],
          properties: {
            seat,
            basisIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: limits.maxFocalBasisIds,
            },
            claimedRole: { type: ["string", "null"] },
            influence: { type: "string", enum: [...INFLUENCE_VALUES] },
            credibility: { type: "string", enum: [...CREDIBILITY_VALUES] },
            directive: { type: "string", minLength: 1 },
            reasonsToFollow: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: limits.maxFocalReasons,
            },
            reasonsToChallenge: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: limits.maxFocalReasons,
            },
            conditionToReconsider: { type: "string", minLength: 1 },
          },
        },
      },
      alignment: {
        type: "object",
        additionalProperties: false,
        required: [
          "stance",
          "focalSeat",
          "proposition",
          "strongestSupport",
          "publicAction",
        ],
        properties: {
          stance: { type: "string", enum: [...ALIGNMENT_VALUES] },
          focalSeat: { type: ["integer", "null"], minimum: 1, maximum: 10 },
          proposition: { type: "string", minLength: 1 },
          strongestSupport: { type: "string", minLength: 1 },
          publicAction: { type: "string", minLength: 1 },
        },
      },
      coalitionPlan: {
        type: "object",
        additionalProperties: false,
        required: [
          "coordinateWith",
          "proposedTeam",
          "votingBloc",
          "messageObjective",
          "strongestDissent",
        ],
        properties: {
          coordinateWith: {
            type: "array",
            items: seat,
            maxItems: limits.maxCoordinateWith,
          },
          proposedTeam: { type: ["array", "null"], items: seat, maxItems: 10 },
          votingBloc: { type: "string", enum: ["approve", "reject", "undecided"] },
          messageObjective: { type: "string", minLength: 1 },
          strongestDissent: { type: "string", minLength: 1 },
        },
      },
    },
  };
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

export type SocialParse =
  | { readonly ok: true; readonly social: SocialWire }
  | { readonly ok: false; readonly error: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? [...(v as string[])] : null;
const seatArray = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "number" && SEATS.includes(x as Seat))
    ? [...(v as number[])]
    : null;

/**
 * Field-specific errors, for the same reason `parseCognition` gives them: a
 * repair note saying "invalid" costs a whole request and teaches nothing.
 */
export function parseSocial(raw: unknown): SocialParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "缺少 social 对象" };
  }
  const s = raw as Record<string, unknown>;
  const fail = (error: string): SocialParse => ({ ok: false, error });

  if (!Array.isArray(s.focalCandidates)) return fail("social.focalCandidates 必须是数组");
  const focalCandidates: SocialWire["focalCandidates"][number][] = [];
  for (const [i, item] of (s.focalCandidates as unknown[]).entries()) {
    if (!item || typeof item !== "object") return fail(`social.focalCandidates[${i}] 不是对象`);
    const f = item as Record<string, unknown>;
    const seat = typeof f.seat === "number" ? f.seat : null;
    if (seat === null || !SEATS.includes(seat as Seat)) {
      return fail(`social.focalCandidates[${i}].seat 必须是 1-10`);
    }
    const basisIds = strArray(f.basisIds);
    if (!basisIds) return fail(`social.focalCandidates[${i}].basisIds 必须是字符串数组`);
    if (basisIds.length === 0) {
      // A focal read with no public basis is a hunch about a person, and the
      // whole point of this block is that following somebody is a decision
      // whose grounds can be re-examined later.
      return fail(
        `social.focalCandidates[${i}] 没有列出 basisIds —— 说不出他凭哪条公开记录成为焦点，就还没到能跟的程度`,
      );
    }
    const influence = str(f.influence);
    if (!influence || !(INFLUENCE_VALUES as readonly string[]).includes(influence)) {
      return fail(`social.focalCandidates[${i}].influence 必须是 ${INFLUENCE_VALUES.join(" / ")}`);
    }
    const credibility = str(f.credibility);
    if (!credibility || !(CREDIBILITY_VALUES as readonly string[]).includes(credibility)) {
      return fail(
        `social.focalCandidates[${i}].credibility 必须是 ${CREDIBILITY_VALUES.join(" / ")}`,
      );
    }
    const directive = str(f.directive);
    if (!directive) return fail(`social.focalCandidates[${i}].directive 不能为空`);
    const conditionToReconsider = str(f.conditionToReconsider);
    if (!conditionToReconsider) {
      return fail(
        `social.focalCandidates[${i}].conditionToReconsider 不能为空 —— 说不出什么会让你改主意，就不是判断`,
      );
    }
    focalCandidates.push({
      seat,
      basisIds,
      claimedRole: str(f.claimedRole),
      influence: influence as Influence,
      credibility: credibility as Credibility,
      directive,
      reasonsToFollow: strArray(f.reasonsToFollow) ?? [],
      reasonsToChallenge: strArray(f.reasonsToChallenge) ?? [],
      conditionToReconsider,
    });
  }

  const a = s.alignment;
  if (!a || typeof a !== "object") return fail("social.alignment 必须是对象");
  const al = a as Record<string, unknown>;
  const stance = str(al.stance);
  if (!stance || !(ALIGNMENT_VALUES as readonly string[]).includes(stance)) {
    return fail(`social.alignment.stance 必须是 ${ALIGNMENT_VALUES.join(" / ")}`);
  }
  const focalSeat = typeof al.focalSeat === "number" ? al.focalSeat : null;
  if (focalSeat !== null && !SEATS.includes(focalSeat as Seat)) {
    return fail("social.alignment.focalSeat 必须是 1-10 或 null");
  }
  if (stance !== "independent" && focalSeat === null) {
    return fail(
      `social.alignment.stance 是 ${stance}，就必须点名 focalSeat —— 跟谁、驳谁，牌桌要能对上号`,
    );
  }
  const proposition = str(al.proposition);
  if (!proposition) {
    return fail("social.alignment.proposition 不能为空 —— 要写清你接受或拒绝的**那一句话**");
  }
  const strongestSupport = str(al.strongestSupport);
  if (strongestSupport === null) return fail("social.alignment.strongestSupport 必须是字符串");
  const publicAction = str(al.publicAction);
  if (!publicAction) {
    return fail("social.alignment.publicAction 不能为空 —— 别人要能据此和你配合");
  }

  const c = s.coalitionPlan;
  if (!c || typeof c !== "object") return fail("social.coalitionPlan 必须是对象");
  const cp = c as Record<string, unknown>;
  const coordinateWith = seatArray(cp.coordinateWith);
  if (!coordinateWith) return fail("social.coalitionPlan.coordinateWith 必须是座位数组");
  const proposedTeam = cp.proposedTeam === null ? null : seatArray(cp.proposedTeam);
  if (cp.proposedTeam !== null && !proposedTeam) {
    return fail("social.coalitionPlan.proposedTeam 必须是座位数组或 null");
  }
  const votingBloc = str(cp.votingBloc);
  if (!votingBloc || !["approve", "reject", "undecided"].includes(votingBloc)) {
    return fail("social.coalitionPlan.votingBloc 必须是 approve / reject / undecided");
  }
  const strongestDissent = str(cp.strongestDissent);
  if (!strongestDissent) {
    return fail(
      "social.coalitionPlan.strongestDissent 不能为空 —— 说不出最强的反对意见，就是没有处理它",
    );
  }

  return {
    ok: true,
    social: {
      focalCandidates,
      alignment: {
        stance: stance as AlignmentStance,
        focalSeat,
        proposition,
        strongestSupport,
        publicAction,
      },
      coalitionPlan: {
        coordinateWith,
        proposedTeam,
        votingBloc: votingBloc as "approve" | "reject" | "undecided",
        messageObjective: str(cp.messageObjective) ?? "",
        strongestDissent,
      },
    },
  };
}

/* ── Bounds ─────────────────────────────────────────────────────────────── */

export function checkSocialBounds(
  s: SocialWire,
  limits: CognitionLimitsV3,
): LimitViolation[] {
  const bad: LimitViolation[] = [];
  bad.push(...checkCount("social.focalCandidates", s.focalCandidates, limits.maxFocalCandidates));
  for (const f of s.focalCandidates) {
    bad.push(...checkCount(`focal[${f.seat}].basisIds`, f.basisIds, limits.maxFocalBasisIds));
    bad.push(...checkChars(`focal[${f.seat}].directive`, f.directive, limits.focalDirectiveChars));
    bad.push(
      ...checkCount(`focal[${f.seat}].reasonsToFollow`, f.reasonsToFollow, limits.maxFocalReasons),
    );
    bad.push(
      ...checkCount(
        `focal[${f.seat}].reasonsToChallenge`,
        f.reasonsToChallenge,
        limits.maxFocalReasons,
      ),
    );
    for (const [i, r] of [...f.reasonsToFollow, ...f.reasonsToChallenge].entries()) {
      bad.push(...checkChars(`focal[${f.seat}].reasons[${i}]`, r, limits.focalReasonChars));
    }
    bad.push(
      ...checkChars(
        `focal[${f.seat}].conditionToReconsider`,
        f.conditionToReconsider,
        limits.focalReconsiderChars,
      ),
    );
  }
  bad.push(
    ...checkChars(
      "social.alignment.proposition",
      s.alignment.proposition,
      limits.alignmentPropositionChars,
    ),
  );
  bad.push(
    ...checkChars(
      "social.alignment.strongestSupport",
      s.alignment.strongestSupport,
      limits.alignmentSupportChars,
    ),
  );
  bad.push(
    ...checkChars(
      "social.alignment.publicAction",
      s.alignment.publicAction,
      limits.alignmentPublicActionChars,
    ),
  );
  bad.push(
    ...checkCount(
      "social.coalitionPlan.coordinateWith",
      s.coalitionPlan.coordinateWith,
      limits.maxCoordinateWith,
    ),
  );
  bad.push(
    ...checkChars(
      "social.coalitionPlan.messageObjective",
      s.coalitionPlan.messageObjective,
      limits.coalitionObjectiveChars,
    ),
  );
  bad.push(
    ...checkChars(
      "social.coalitionPlan.strongestDissent",
      s.coalitionPlan.strongestDissent,
      limits.coalitionDissentChars,
    ),
  );
  return bad;
}

/** Cross-field problems a size limit cannot express. */
export function socialProblems(s: SocialWire): string[] {
  const problems: string[] = [];
  const a = s.alignment;
  if (a.stance !== "independent" && a.focalSeat !== null) {
    const known = s.focalCandidates.some((f) => f.seat === a.focalSeat);
    if (!known) {
      problems.push(
        `alignment.focalSeat 是 ${a.focalSeat}号，但 focalCandidates 里没有他 —— 跟或驳一个你没在读的人`,
      );
    }
  }
  const seats = s.focalCandidates.map((f) => f.seat);
  if (new Set(seats).size !== seats.length) {
    problems.push("focalCandidates 里有重复座位");
  }
  for (const f of s.focalCandidates) {
    if (f.reasonsToFollow.length === 0 && f.reasonsToChallenge.length === 0) {
      problems.push(`focal[${f.seat}] 既没有跟的理由也没有驳的理由 —— 那他不是焦点`);
    }
  }
  return problems;
}

/* ── Applying ───────────────────────────────────────────────────────────── */

/**
 * Fold a validated social block into a seat's model.
 *
 * The one-way valve, again: the model supplies `basisIds` and this function
 * decides `restsOnUnverified` by asking the registry. Same mechanism as
 * `applyFusedUpdate`, same reason.
 */
export function applySocial(
  seat: Seat,
  wire: SocialWire,
  registry: VisibleFactRegistry,
  atSequence: number,
): SocialModel {
  return deepFreeze({
    seat,
    focalCandidates: wire.focalCandidates.map((f) => ({
      seat: f.seat as Seat,
      basisIds: [...f.basisIds],
      claimedRole: (f.claimedRole as RoleType | null) ?? null,
      influence: f.influence,
      credibility: f.credibility,
      directive: f.directive,
      reasonsToFollow: [...f.reasonsToFollow],
      reasonsToChallenge: [...f.reasonsToChallenge],
      conditionToReconsider: f.conditionToReconsider,
      restsOnUnverified: f.basisIds.some((id) => !isVerifiedPremise(registry, id)),
      atSequence,
    })),
    alignment: {
      stance: wire.alignment.stance,
      focalSeat: (wire.alignment.focalSeat as Seat | null) ?? null,
      proposition: wire.alignment.proposition,
      strongestSupport: wire.alignment.strongestSupport,
      publicAction: wire.alignment.publicAction,
    },
    coalitionPlan: {
      coordinateWith: wire.coalitionPlan.coordinateWith as Seat[],
      proposedTeam: (wire.coalitionPlan.proposedTeam as Seat[] | null) ?? null,
      votingBloc: wire.coalitionPlan.votingBloc,
      messageObjective: wire.coalitionPlan.messageObjective,
      strongestDissent: wire.coalitionPlan.strongestDissent,
    },
    atSequence,
  });
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

const INFLUENCE_LABEL: Readonly<Record<Influence, string>> = {
  low: "影响力小",
  medium: "有一定影响力",
  high: "影响力大",
};

const CREDIBILITY_LABEL: Readonly<Record<Credibility, string>> = {
  weak: "站不住",
  contested: "有人在驳",
  credible: "目前站得住",
};

const STANCE_LABEL: Readonly<Record<AlignmentStance, string>> = {
  follow: "跟",
  "conditional-follow": "有条件地跟",
  challenge: "驳",
  independent: "自己走",
};

/** The social model as the seat reads it back next turn. */
export function renderSocial(model: SocialModel | null): string {
  if (!model) return "";
  const hasContent =
    model.focalCandidates.length > 0 || model.alignment !== null || model.coalitionPlan !== null;
  if (!hasContent) return "";

  const lines: string[] = ["## 你对牌桌的读（只有你看得到）"];

  if (model.focalCandidates.length > 0) {
    lines.push("", "### 现在谁在带节奏");
    for (const f of model.focalCandidates) {
      const mark = f.restsOnUnverified ? "【依据里有未证实的】" : "【依据都是裁判记录】";
      lines.push(
        `- ${f.seat}号 ${INFLUENCE_LABEL[f.influence]}，${CREDIBILITY_LABEL[f.credibility]}` +
          (f.claimedRole ? `，自称 ${f.claimedRole}` : "") +
          `　${mark}`,
      );
      lines.push(`    他要牌桌做的：${f.directive}`);
      if (f.reasonsToFollow.length > 0) lines.push(`    可以跟：${f.reasonsToFollow.join("；")}`);
      if (f.reasonsToChallenge.length > 0) {
        lines.push(`    可以驳：${f.reasonsToChallenge.join("；")}`);
      }
      lines.push(`    什么会让你改：${f.conditionToReconsider}`);
    }
  }

  const a = model.alignment;
  if (a) {
    lines.push("", "### 你上一步的站位");
    lines.push(
      `- ${STANCE_LABEL[a.stance]}${a.focalSeat !== null ? ` ${a.focalSeat}号` : ""}：${a.proposition}`,
    );
    if (a.strongestSupport) lines.push(`    最强的支持依据：${a.strongestSupport}`);
    lines.push(`    你打算公开做的：${a.publicAction}`);
  }

  const c = model.coalitionPlan;
  if (c) {
    lines.push("", "### 你的联盟计划");
    if (c.coordinateWith.length > 0) lines.push(`- 想拉上：${c.coordinateWith.join("、")}号`);
    if (c.proposedTeam) lines.push(`- 想推的车：${c.proposedTeam.join("、")}号`);
    lines.push(`- 票的方向：${c.votingBloc}`);
    if (c.messageObjective) lines.push(`- 这次发言要达成：${c.messageObjective}`);
    lines.push(`- 必须回答的最强反对：${c.strongestDissent}`);
  }

  return lines.join("\n");
}
