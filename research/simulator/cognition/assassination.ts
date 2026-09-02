/**
 * A bounded candidate ranking, before the one irreversible decision.
 *
 * WHAT THE M5.3 TERRA GAME DID. The Assassin picked seat 5, a loyal servant.
 * Merlin was seat 9. Reconstructing the exact prompt it was given (byte-exact,
 * `promptKey` verified) turned up two things, and only one of them is a model
 * mistake:
 *
 *   THE PROMPT WAS WRONG. Layer 7 told it 「第四节里已经给了你坏人这边的确切身份」
 *   and layer 6 did not contain them. `renderOwnPrivateFacts` never rendered
 *   `evilRoster` at all — not in `prompt-0.3.0`, not in any stack since — while
 *   `fact-ids.ts` cheerfully minted `p.roster` as a citable id. An id that is
 *   minted and never printed is precisely the M5.1 defect, repeated.
 *
 *   SO IT INFERRED THE FOURTH VILLAIN. It knew 2/3/7 from `p.team`, needed a
 *   fourth, and wrote 「1号 strong-evil：刺杀阶段已知其为坏人」. Seat 1 was loyal;
 *   Oberon was seat 4, whom it marked `strong-good`. It then ranked the
 *   remaining seats and chose the loudest organiser.
 *
 * AND THE CHOICE ITSELF WAS DEFENSIBLE. Seat 5 drove the two successful teams
 * and pushed the correct exclusions; every one of the four villains
 * independently named seat 5 in the council. What none of them weighed is that
 * a seat which organises loudly is at least as likely to be Percival, or a
 * loyal servant providing cover, as it is to be Merlin — and that Merlin, who
 * held the Lady and announced three times, had been DISCOUNTED for exactly the
 * behaviour that made him visible.
 *
 * SO THIS FILE ASKS FOR A RANKING, NOT A RULE. No heuristic here says "kill the
 * most accurate voter"; the accuracy signal is one axis among eight, and two of
 * the axes exist specifically to push back on it. What is required is that the
 * Assassin write down its candidates, the evidence for and against each, and a
 * confidence — before it names one.
 */

import type { Fragment } from "../model/json-schema";
import type { Seat } from "../core/types";
import { checkChars, type CognitionLimitsV3, type LimitViolation } from "./limits";

/* ── The axes ───────────────────────────────────────────────────────────── */

/**
 * The public behaviours a candidate assessment may cite.
 *
 * A CLOSED LIST, so the ranking is comparable across seats and games, and so
 * "what did the Assassin actually weigh" is a countable question rather than a
 * prose one. Two of them — `may-be-percival` and `loyal-cover` — exist to make
 * the obvious inference argue with itself.
 */
export type MerlinSignal =
  /** Rejected teams that later failed, or backed teams that later succeeded. */
  | "accurate-rejection"
  | "backed-clean-teams"
  /** Read the same way across rounds, as somebody with fixed information would. */
  | "knowledge-like-consistency"
  /** How it handled the true/false Percival contest. */
  | "claim-contest-handling"
  /** Stayed off the focal position on purpose. */
  | "avoided-the-focus"
  /** Confidence moved late, in a way information would explain. */
  | "late-confidence-shift"
  /** COUNTER-SIGNAL: a visible organiser is at least as likely to be Percival. */
  | "may-be-percival"
  /** COUNTER-SIGNAL: a loyal servant deliberately building Merlin cover. */
  | "loyal-cover"
  /**
   * M5.5. Was right about something BEFORE the Lady could have told them.
   *
   * The signal two live Assassins never looked for. Both discounted the true
   * Merlin because he had announced a Lady result, treating an alternative
   * explanation as a counter-argument — see `LadyAnalysis`.
   */
  | "accurate-before-lady"
  /** M5.5. A public Lady claim that the terminal roster contradicts. */
  | "lady-claim-contradicts-roster";

export const MERLIN_SIGNALS: readonly MerlinSignal[] = [
  "accurate-rejection",
  "backed-clean-teams",
  "knowledge-like-consistency",
  "claim-contest-handling",
  "avoided-the-focus",
  "late-confidence-shift",
  "may-be-percival",
  "loyal-cover",
  "accurate-before-lady",
  "lady-claim-contradicts-roster",
];

/**
 * What holding the Lady does and does not explain about one candidate.
 *
 * WHY THIS EXISTS, in two games' worth of evidence. The M5.3 Terra Assassin and
 * the M5.4 Terra Assassin independently reached the same wrong conclusion by
 * the same route: the true Merlin held the Lady and announced with it, so his
 * accuracy was written off as 「可能来自湖中女神信息，不能单独当作梅林线索」 —
 * and he survived both times. Merlin was seat 9 in both games.
 *
 * THE REASONING ERROR IS NAMEABLE. "There is another explanation" is a reason
 * the evidence is not CONCLUSIVE. It is not a reason the evidence points the
 * other way. Treated as a counter-argument it produces a rule with a perverse
 * consequence — the Lady becomes a Merlin-proof vest — and worse, it is a rule
 * good players can exploit deliberately, which is exactly what a competent
 * Merlin should do and what neither Assassin considered.
 *
 * SO THE QUESTION IS ASKED IN PARTS. Each part is separately answerable from
 * the public record, and the one that does the work is `accurateBeforeLady`:
 * a correct read that PREDATES the check cannot have come from it.
 */
export interface LadyAnalysis {
  /** Did this candidate ever hold the Lady? */
  readonly heldLady: boolean;
  /** Did they publicly announce a result with it? */
  readonly announced: boolean;
  /**
   * Reads that were already right BEFORE they held it.
   *
   * The part the Lady cannot explain. Empty is a real answer and a meaningful
   * one — it says the accuracy really is all post-check.
   */
  readonly accurateBeforeLady: readonly string[];
  /** Reads the Lady result does explain. Honest bookkeeping, not a strike. */
  readonly explainedByLady: readonly string[];
  /**
   * Correct conclusions the Lady result does NOT cover.
   *
   * A Lady check names one seat. A player who read four seats correctly off one
   * check has three reads the check does not explain.
   */
  readonly beyondLadyResult: readonly string[];
  /**
   * Is the Lady CONVENIENT COVER for this candidate?
   *
   * The question that inverts the historical mistake: a Merlin who takes the
   * Lady buys a licence to be right in public. `true` makes the Lady a reason
   * to look harder, which is the opposite of how both live games used it.
   */
  readonly convenientCover: boolean;
  /**
   * Does their public Lady claim contradict the roster you were just shown?
   *
   * Only answerable in the assassination phase, and only there. A seat that
   * announced a known villain as good was lying or was Morgana-fed; either way
   * it is hard evidence about them and nothing to do with Merlin-ness.
   */
  readonly contradictsRoster: boolean;
}

export interface CandidateAssessment {
  readonly seat: Seat;
  /** Signals that point AT this seat. */
  readonly signals: readonly MerlinSignal[];
  /** One line each, with the public record behind them. */
  readonly evidence: readonly string[];
  /** What argues against it. REQUIRED — a candidate with none was not weighed. */
  readonly counterEvidence: readonly string[];
  readonly evidenceIds: readonly string[];
  /** M5.5. Required when the candidate ever held the Lady. */
  readonly lady?: LadyAnalysis | null;
  /** 0..1. Not a probability, a ranking key. */
  readonly confidence: number;
}

export interface AssassinationRanking {
  /** Every legal candidate this seat considered. At least two. */
  readonly candidates: readonly CandidateAssessment[];
  /** The chosen seat. Must be one of the candidates. */
  readonly target: Seat;
  /** Why this one rather than the runner-up. One line. */
  readonly why: string;
  /** What would have changed the answer. */
  readonly whatWouldChangeIt: string;
}

/* ── Schema ─────────────────────────────────────────────────────────────── */

export interface FragmentOptions {
  /** `prompt-0.7.0`: require the Lady analysis on every candidate. */
  readonly withLadyAnalysis?: boolean;
}

const LADY_FRAGMENT = (limits: CognitionLimitsV3): Fragment => ({
  type: ["object", "null"],
  additionalProperties: false,
  required: [
    "heldLady",
    "announced",
    "accurateBeforeLady",
    "explainedByLady",
    "beyondLadyResult",
    "convenientCover",
    "contradictsRoster",
  ],
  properties: {
    heldLady: { type: "boolean" },
    announced: { type: "boolean" },
    accurateBeforeLady: {
      type: "array",
      items: { type: "string", maxLength: limits.claimCaseChars * 3 },
      maxItems: 3,
    },
    explainedByLady: {
      type: "array",
      items: { type: "string", maxLength: limits.claimCaseChars * 3 },
      maxItems: 3,
    },
    beyondLadyResult: {
      type: "array",
      items: { type: "string", maxLength: limits.claimCaseChars * 3 },
      maxItems: 3,
    },
    convenientCover: { type: "boolean" },
    contradictsRoster: { type: "boolean" },
  },
});

export function assassinationFragment(
  limits: CognitionLimitsV3,
  options: FragmentOptions = {},
): Fragment {
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidates", "target", "why", "whatWouldChangeIt"],
    properties: {
      candidates: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "seat",
            "signals",
            "evidence",
            "counterEvidence",
            "evidenceIds",
            ...(options.withLadyAnalysis === true ? ["lady"] : []),
            "confidence",
          ],
          properties: {
            ...(options.withLadyAnalysis === true ? { lady: LADY_FRAGMENT(limits) } : {}),
            seat: { type: "integer", minimum: 1, maximum: 10 },
            signals: {
              type: "array",
              items: { type: "string", enum: [...MERLIN_SIGNALS] },
              minItems: 1,
              maxItems: 5,
            },
            evidence: {
              type: "array",
              items: { type: "string", maxLength: limits.claimCaseChars * 3 },
              minItems: 1,
              maxItems: 3,
            },
            counterEvidence: {
              type: "array",
              items: { type: "string", maxLength: limits.claimCaseChars * 3 },
              minItems: 1,
              maxItems: 3,
            },
            evidenceIds: { type: "array", items: { type: "string" }, maxItems: 4 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      target: { type: "integer", minimum: 1, maximum: 10 },
      why: { type: "string", minLength: 1, maxLength: limits.claimCaseChars * 3 },
      whatWouldChangeIt: { type: "string", maxLength: limits.claimConditionChars * 3 },
    },
  };
}

/* ── Structural checks ──────────────────────────────────────────────────── */

export interface AssassinationContext {
  readonly seat: Seat;
  /**
   * Seats this Assassin has been privately told are evil.
   *
   * NOT a list of forbidden targets. Naming one of them is legal by the rules
   * and the referee will take it — see the note on `assassinationProblems`. The
   * list exists so the system can rank them last, warn about them privately,
   * and count it afterwards if one is chosen anyway.
   */
  readonly knownEvil: readonly Seat[];
  /**
   * Seats that publicly announced a Lady result, and what they announced.
   *
   * From the PUBLIC LOG, so it is the same record the whole table saw. Present
   * only under `prompt-0.7.0`; when absent the Lady checks do not run and the
   * frozen stacks keep their exact behaviour.
   */
  readonly ladyAnnouncers?: ReadonlyMap<Seat, readonly { readonly target: Seat; readonly announced: "good" | "evil" }[]>;
  /** `prompt-0.7.0`: require and check the per-candidate Lady analysis. */
  readonly requireLadyAnalysis?: boolean;
}

/**
 * Is this seat one the Assassin already knows cannot be Merlin?
 *
 * Self included: he holds the Assassin card, so he is certain about himself in
 * exactly the way he is certain about the roster. The two are separated only
 * where the REFEREE separates them — it refuses a self-target outright
 * (`刺客不能刺自己`) and accepts a known-evil target.
 */
export function isKnownNotMerlin(seat: Seat, context: AssassinationContext): boolean {
  return seat === context.seat || context.knownEvil.includes(seat);
}

/**
 * What is structurally wrong. Never "you picked the wrong seat".
 *
 * The one that does real work is `counterEvidence`: a candidate listed with
 * evidence and nothing against it has not been assessed, it has been asserted.
 * That is the check that would have caught the Terra game's ranking, where the
 * runner-up carried no counter-argument at all.
 *
 * WHAT IS DELIBERATELY NOT HERE: a refusal to name a seat the Assassin knows is
 * evil. An earlier version of this file made that a structural error, and that
 * was a category mistake. Naming a known villain is legal — the referee takes
 * it and ends the game — and it is a MISTAKE, one of the most instructive an
 * Assassin can make. This is a research simulator: refusing it would delete the
 * observation and replace it with a repaired game whose record says a mistake
 * that happened did not happen.
 *
 * The evil card convention is different, and the difference is the whole test.
 * That one is an explicit house constraint the table owner created, so the
 * simulator enforces it. Assassination competence is not a house constraint; it
 * is the thing being measured. So this class of error is handled the way an
 * observation should be: warned about privately (`ASSASSINATION_INSTRUCTION`),
 * ranked last by `orderedCandidates`, allowed, and counted afterwards as
 * `knownEvilAssassinationTarget`.
 *
 * The self-target check stays, and only because the REFEREE refuses a
 * self-target. A structural check that mirrors a referee rule is a referee
 * rule; one that invents a rule is a thumb on the scale.
 */
export function assassinationProblems(
  ranking: AssassinationRanking,
  context: AssassinationContext,
): string[] {
  const problems: string[] = [];

  if (ranking.candidates.length < 2) {
    problems.push("candidates 至少要有两个 —— 只列一个不是排序，是断言");
  }

  const seen = new Set<Seat>();
  for (const c of ranking.candidates) {
    if (seen.has(c.seat)) problems.push(`candidates 里 ${c.seat}号 出现了两次`);
    seen.add(c.seat);
    // Mirrors the referee, which refuses `刺客不能刺自己`.
    if (c.seat === context.seat) problems.push("不能把自己列为候选 —— 裁判不接受刺自己");
    if (c.counterEvidence.length === 0) {
      problems.push(`${c.seat}号 没有 counterEvidence —— 一个没有反面的候选是断言，不是评估`);
    }
    problems.push(...ladyProblems(c, context));
  }

  if (!seen.has(ranking.target)) {
    problems.push(`target ${ranking.target}号 不在 candidates 里 —— 最终目标必须是被排过序的人之一`);
  }
  if (ranking.why.trim().length === 0) {
    problems.push("why 不能为空：为什么是他，而不是第二名？");
  }
  return problems;
}

/**
 * The candidates as the RECORD shows them: known-evil seats last.
 *
 * The system's own ordering, applied when the ranking is rendered or stored, so
 * a seat that cannot be Merlin never appears at the top of a ranking whatever
 * confidence the model gave it. It changes the presentation, not the decision —
 * `ranking.target` is passed through untouched by everything in this file.
 *
 * Within each group the order is by confidence, descending, and ties keep the
 * model's own order. A stable sort matters: two candidates at 0.5 should not
 * swap places between two runs of the same game.
 */
export function orderedCandidates(
  ranking: AssassinationRanking,
  context: AssassinationContext,
): readonly CandidateAssessment[] {
  return ranking.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ka = isKnownNotMerlin(a.c.seat, context) ? 1 : 0;
      const kb = isKnownNotMerlin(b.c.seat, context) ? 1 : 0;
      if (ka !== kb) return ka - kb;
      if (a.c.confidence !== b.c.confidence) return b.c.confidence - a.c.confidence;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/**
 * Did the Assassin name somebody it already knew could not be Merlin?
 *
 * A STRATEGIC ERROR, and the only thing this function does is name it. Nothing
 * downstream may use the answer to change, block, or repair the target.
 */
export function knownEvilTargeted(
  ranking: AssassinationRanking,
  context: AssassinationContext,
): boolean {
  return context.knownEvil.includes(ranking.target);
}

/**
 * Phrases that say "the Lady explains it" and nothing else.
 *
 * A CLOSED LIST of the shapes both live Assassins actually wrote, matched
 * against the WHOLE counter-evidence line rather than searched inside it: a
 * line that mentions the Lady AND says something else survives, because the
 * problem is never mentioning the Lady — it is having no other argument.
 */
const LADY_ONLY_MARKERS: readonly string[] = [
  "女神",
  "湖中女神",
  "验人",
  "查验",
  "lady",
  "Lady",
];

/** Does this one line rest on nothing but Lady possession? */
export function isLadyOnlyCounterEvidence(line: string): boolean {
  const mentionsLady = LADY_ONLY_MARKERS.some((m) => line.includes(m));
  if (!mentionsLady) return false;
  // Something the Lady CANNOT explain is a real argument even in a sentence
  // that also mentions her. These are the phrases that mark one.
  const carriesMore = [
    "之前",
    "更早",
    "在拿到",
    "拿到之前",
    "不止",
    "还",
    "另外",
    "也",
    "与此无关",
    "解释不了",
    "覆盖不了",
    "超出",
  ].some((m) => line.includes(m));
  return !carriesMore;
}

/**
 * What is wrong with one candidate's Lady reasoning.
 *
 * TWO CHECKS, and neither of them says who to kill:
 *
 *   THE ANALYSIS MUST BE PRESENT for a candidate who held the Lady. Absent, the
 *   model has not been asked the question that both live games got wrong.
 *
 *   THE LADY ALONE IS NOT A COUNTER-ARGUMENT. If every counter-evidence line
 *   for a candidate reduces to "they had Lady information", the assessment is
 *   refused — not because the conclusion is wrong, but because the reasoning
 *   has no content: an alternative explanation is a reason the evidence is
 *   inconclusive, never a reason it points the other way.
 */
function ladyProblems(c: CandidateAssessment, context: AssassinationContext): string[] {
  if (context.requireLadyAnalysis !== true) return [];
  const problems: string[] = [];
  const announced = context.ladyAnnouncers?.get(c.seat) ?? [];
  const held = announced.length > 0;

  if (held && (c.lady === null || c.lady === undefined)) {
    problems.push(
      `${c.seat}号 公开宣布过验人结果，但你没有填 lady —— ` +
        "拿过女神的人必须单独回答那几个问题，不能一句「他有别的信息来源」带过",
    );
  }
  if (c.lady && held && !c.lady.heldLady) {
    problems.push(`${c.seat}号 的 lady.heldLady 是 false，但公开记录里他宣布过验人结果`);
  }
  if (c.lady && c.lady.heldLady && !held) {
    problems.push(`${c.seat}号 的 lady.heldLady 是 true，但公开记录里他没有宣布过验人结果`);
  }

  const lines = c.counterEvidence.filter((l) => l.trim().length > 0);
  if (lines.length > 0 && lines.every(isLadyOnlyCounterEvidence)) {
    problems.push(
      `${c.seat}号 的 counterEvidence 全部只说「他有女神信息」—— ` +
        "那是另一种解释，不是反面证据。拿过女神不会让一个人更不像梅林；" +
        "要压低他，得说出女神解释不了的那部分。",
    );
  }
  return problems;
}

export function checkAssassinationBounds(
  ranking: AssassinationRanking,
  limits: CognitionLimitsV3,
): LimitViolation[] {
  const out: LimitViolation[] = [
    ...checkChars("assassination.why", ranking.why, limits.claimCaseChars),
    ...checkChars(
      "assassination.whatWouldChangeIt",
      ranking.whatWouldChangeIt,
      limits.claimConditionChars,
    ),
  ];
  for (const [i, c] of ranking.candidates.entries()) {
    for (const [j, e] of c.evidence.entries()) {
      out.push(...checkChars(`assassination.candidates[${i}].evidence[${j}]`, e, limits.claimCaseChars));
    }
    for (const [j, e] of c.counterEvidence.entries()) {
      out.push(
        ...checkChars(`assassination.candidates[${i}].counterEvidence[${j}]`, e, limits.claimCaseChars),
      );
    }
    if (c.lady) {
      const lady = c.lady;
      const each = (name: string, lines: readonly string[]) => {
        for (const [j, e] of lines.entries()) {
          out.push(...checkChars(`assassination.candidates[${i}].lady.${name}[${j}]`, e, limits.claimCaseChars));
        }
      };
      each("accurateBeforeLady", lady.accurateBeforeLady);
      each("explainedByLady", lady.explainedByLady);
      each("beyondLadyResult", lady.beyondLadyResult);
    }
  }
  return out;
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

export type AssassinationParse =
  | { readonly ok: true; readonly ranking: AssassinationRanking }
  | { readonly ok: false; readonly error: string };

export function parseAssassination(raw: unknown): AssassinationParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "assassination 必须是一个对象" };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.candidates)) {
    return { ok: false, error: "assassination.candidates 必须是数组" };
  }
  const candidates: CandidateAssessment[] = [];
  for (const [i, item] of (o.candidates as unknown[]).entries()) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: `assassination.candidates[${i}] 不是对象` };
    }
    const c = item as Record<string, unknown>;
    const seat = c.seat;
    if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 1 || seat > 10) {
      return { ok: false, error: `assassination.candidates[${i}].seat 必须是 1-10` };
    }
    const arr = (k: string) =>
      Array.isArray(c[k]) && (c[k] as unknown[]).every((x) => typeof x === "string")
        ? (c[k] as string[])
        : null;
    const signals = arr("signals");
    const evidence = arr("evidence");
    const counter = arr("counterEvidence");
    const ids = arr("evidenceIds");
    if (!signals || !evidence || !counter || !ids) {
      return { ok: false, error: `assassination.candidates[${i}] 的字符串数组字段不合法` };
    }
    for (const s of signals) {
      if (!(MERLIN_SIGNALS as readonly string[]).includes(s)) {
        return {
          ok: false,
          error: `assassination.candidates[${i}].signals 里的 ${s} 不在允许的信号表里`,
        };
      }
    }
    const confidence = c.confidence;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      return { ok: false, error: `assassination.candidates[${i}].confidence 必须在 0 到 1 之间` };
    }
    // `lady` is OPTIONAL at the parser, required by the schema under 0.7.0 and
    // checked by `assassinationProblems`. Three layers rather than one because
    // the frozen stacks must still parse: a 0.6.0 answer has no `lady`, and a
    // parser that demanded it would refuse to read four completed games.
    const ladyRaw = c.lady;
    let lady: LadyAnalysis | null = null;
    if (ladyRaw !== undefined && ladyRaw !== null) {
      if (typeof ladyRaw !== "object" || Array.isArray(ladyRaw)) {
        return { ok: false, error: `assassination.candidates[${i}].lady 必须是对象或 null` };
      }
      const l = ladyRaw as Record<string, unknown>;
      const strs = (k: string) =>
        Array.isArray(l[k]) && (l[k] as unknown[]).every((x) => typeof x === "string")
          ? (l[k] as string[])
          : null;
      const before = strs("accurateBeforeLady");
      const explained = strs("explainedByLady");
      const beyond = strs("beyondLadyResult");
      if (
        typeof l.heldLady !== "boolean" ||
        typeof l.announced !== "boolean" ||
        typeof l.convenientCover !== "boolean" ||
        typeof l.contradictsRoster !== "boolean" ||
        !before ||
        !explained ||
        !beyond
      ) {
        return { ok: false, error: `assassination.candidates[${i}].lady 的字段不合法` };
      }
      lady = {
        heldLady: l.heldLady,
        announced: l.announced,
        accurateBeforeLady: before,
        explainedByLady: explained,
        beyondLadyResult: beyond,
        convenientCover: l.convenientCover,
        contradictsRoster: l.contradictsRoster,
      };
    }

    candidates.push({
      seat: seat as Seat,
      signals: signals as MerlinSignal[],
      evidence,
      counterEvidence: counter,
      evidenceIds: ids,
      lady,
      confidence,
    });
  }
  const target = o.target;
  if (typeof target !== "number" || !Number.isInteger(target) || target < 1 || target > 10) {
    return { ok: false, error: "assassination.target 必须是 1-10" };
  }
  return {
    ok: true,
    ranking: {
      candidates,
      target: target as Seat,
      why: typeof o.why === "string" ? o.why : "",
      whatWouldChangeIt: typeof o.whatWouldChangeIt === "string" ? o.whatWouldChangeIt : "",
    },
  };
}

/* ── The instruction ────────────────────────────────────────────────────── */

/**
 * The Lady half of the instruction. `prompt-0.7.0` only.
 *
 * States the reasoning rule in the one form that survives being read quickly:
 * an alternative explanation weakens the INFERENCE, it does not argue the other
 * way. Everything else follows from that sentence.
 */
export const LADY_INSTRUCTION = [
  "",
  "### 关于湖中女神：这是最容易犯的一个错",
  "",
  "**拿过女神、或者当众宣布过验人结果，本身既不是梅林的证据，也不是他不是梅林的证据。**",
  "它是**另一种解释**：解释他为什么会说对。",
  "「他有别的信息来源」说明的是「这条证据不够硬」，**不是「所以他更可能不是梅林」**。",
  "把它当反面证据用，等于宣布「拿过女神的人不会被刺」—— 而一个会打的梅林正好会去抢女神。",
  "",
  "所以每个**宣布过验人结果**的候选，都要单独填 `lady`：",
  "",
  "- `heldLady` / `announced`：他拿过、宣布过没有。",
  "- `accurateBeforeLady`：**他在拿到女神之前就已经说对的那些**。",
  "  女神解释不了这一部分 —— 这是整块里最重的一格。",
  "- `explainedByLady`：确实能被那次验人结果解释掉的部分。",
  "- `beyondLadyResult`：**一次验人只点一个人。** 他读对了四个人，多出来的三个不算在内。",
  "- `convenientCover`：女神是不是正好给了他一层掩护？梅林抢女神就是为了这个。",
  "- `contradictsRoster`：他公开宣布的结果，和你刚拿到的坏人名单对不对得上？",
  "  对不上就是关于**他**的硬信息，和梅林不梅林无关。",
  "",
  "**只写「他有女神信息」的 counterEvidence 会被打回。** 要压低一个人，",
  "得说出女神解释不了的那一部分。",
].join("\n");

export const ASSASSINATION_INSTRUCTION = [
  "### 指认之前，先填 `assassination` —— 一个有界的候选排序",
  "",
  "**至少两个候选**，每一个都要有正反两面。填结论，不写推理过程。",
  "",
  "每个候选：",
  "",
  "- `seat`：候选座位。**不能是你自己** —— 裁判不接受刺自己。",
  "- `signals`：从下面八项里选，最多五个 ——",
  "  `accurate-rejection`（否掉的车后来真的挂了）、",
  "  `backed-clean-teams`（保过的车后来真的成了）、",
  "  `knowledge-like-consistency`（好几轮读法一致，像手上有固定信息）、",
  "  `claim-contest-handling`（他怎么处理真假派西维尔之争）、",
  "  `avoided-the-focus`（刻意不当那个带节奏的人）、",
  "  `late-confidence-shift`（后期信心变化，而且信息能解释这个变化）、",
  "  **`may-be-percival`（他可能是派西维尔而不是梅林）**、",
  "  **`loyal-cover`（他可能是个忠臣在故意做梅林掩护）**、",
  "  **`accurate-before-lady`（他在拿到女神之前就已经说对了）**、",
  "  **`lady-claim-contradicts-roster`（他公开宣布的验人结果和坏人名单对不上）**。",
  "- `evidence` / `counterEvidence`：**两边都必须有。**",
  "  一个只有正面、没有反面的候选，你没有评估过它，只是断言了它。",
  "- `evidenceIds`：公开事实 id。",
  "- `confidence`：0 到 1，用来排序。",
  "",
  "最后 `target`（必须是候选之一）、`why`（为什么是他不是第二名）、",
  "`whatWouldChangeIt`（什么会让你改选）。",
  "",
  "**最后两个信号是专门用来和前面那些吵架的。** 场上最会组织、判断最准的那个人，",
  "同样可能是派西维尔，或者一个在替梅林挡枪的忠臣 —— 真梅林往往恰恰不是最显眼的那个。",
  "**没有「刺最准的那个」这条规则。** 准确度只是这张表里的两项。",
  "",
  "**第四节里给了你自己人的确切名单。那些人不可能是梅林。**",
  "指认他们里的任何一个，裁判会照单全收、当场结算，然后你们输 —— ",
  "**这一刀是整局唯一一次机会，不能撤回、不能重来。**",
  "所以名单上的人排在候选最后面；要么别写进候选，要么就得写清楚",
  "为什么一个你亲眼见过身份的人还值得占掉这一刀。",
].join("\n");
