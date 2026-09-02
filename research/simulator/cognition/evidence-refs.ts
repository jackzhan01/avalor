/**
 * One id per citation slot, and it has to exist.
 *
 * WHAT THE LIVE 0.6.0 GAME WROTE. Eight array elements across 191 requests held
 * several ids packed into one string with full-width delimiters:
 *
 *     "k4:claim】【、】【k45:claim"
 *     "f.fail1】【：】【“】【f.fail2"
 *     "k64:side:2】【、】【k64:side:4"
 *
 * plus one note padded with a run of U+FFFC OBJECT REPLACEMENT CHARACTER. Every
 * one passed the schema, because the schema says `string`. Every one then
 * resolved as an invented id.
 *
 * WHY THAT IS WORSE THAN A TYPO. `restsOnUnverified` is computed from whether
 * the premises resolve, and the whole ledger design rests on that flag being
 * true. A premise the model cited HONESTLY — the ids were real, it just wrote
 * them in one box — comes back unverified, so a conclusion that actually stood
 * on referee facts gets recorded as standing on nothing. The seat then reads
 * its own record next turn and sees a caveat that is not true.
 *
 * NO SPLITTING, NO NORMALISING. It would be four lines to split on 、 and 【】
 * and recover the ids, and that is exactly what this file refuses to do. A
 * repair that guesses produces a citation the model did not write; if the
 * separator convention shifts, the guess quietly changes meaning and nothing
 * fails. The model is asked again, with a bounded note describing the SHAPE it
 * got wrong and never the content it wrote.
 *
 * THE NOTE IS SAFE TO FEED BACK. Unlike a disclosure refusal, a malformed id is
 * a shape: "element 2 of `factsUsed` held more than one id". Naming that back
 * carries nothing private and lets the next attempt actually do better — the
 * same distinction `machine-ids.ts` draws for public speech.
 */

import type { VisibleFactRegistry } from "./fact-ids";
import { resolvePremiseId } from "./fact-ids";

/* ── What malformed looks like ──────────────────────────────────────────── */

export type MalformedKind =
  /** More than one id in a single element, however they were joined. */
  | "multiple-ids"
  /** Full-width brackets, quotes or delimiters around or between ids. */
  | "full-width-delimiter"
  /** U+FFFC and friends — replacement/format characters, not text. */
  | "replacement-character"
  /** Leading or trailing whitespace, or an empty element. */
  | "blank"
  /** One well-formed-looking id that names nothing in this seat's registry. */
  | "unresolvable";

export interface MalformedRef {
  /** Which array, e.g. `factsUsed` or `constraints[1].premiseIds`. */
  readonly field: string;
  readonly index: number;
  readonly kind: MalformedKind;
  /**
   * The offending element.
   *
   * PRIVATE. Recorded in the trace for a human reviewer and never rendered into
   * a prompt, a repair note or a public message — see `repairNote`, which
   * describes the shape and quotes nothing.
   */
  readonly raw: string;
}

/* ── The shapes ─────────────────────────────────────────────────────────── */

/**
 * One id, as `fact-ids.ts` mints them.
 *
 * Deliberately a shape test rather than a registry lookup: an element holding
 * two well-formed ids is malformed even if both would resolve, and an element
 * holding one badly-formed id is malformed even if it happens to be unique.
 */
const ONE_ID = /^(?:f\d+|f\.(?:now|fail\d+|cmp\d+x\d+)|c\d+:[a-z]+|k\d+:[a-z]+(?::\d+)?|p\.[a-z]+\d*|own-role)$/;

/** Anything that only appears when several ids were packed into one box. */
const FULL_WIDTH = /[【】｛｝＜＞（）“”‘’、，；：｜]/u;
/** Replacement and format characters. Never part of an id anybody minted. */
const REPLACEMENT = /[\uFFFC\uFFFD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u;
/** Two or more id-looking runs in one element, whatever sits between them. */
const ID_LIKE = /(?:f\d+|f\.[a-z0-9]+|c\d+:[a-z]+|k\d+:[a-z]+|p\.[a-z]+\d*)/g;

/**
 * Why this one element is malformed, or null.
 *
 * ORDER MATTERS, and it is the order a human would want in a bug report: the
 * structural faults first, then resolution. An element with two ids and a
 * full-width comma is reported as `multiple-ids`, because that is the thing to
 * fix; saying `full-width-delimiter` would send the model to reformat rather
 * than to split.
 */
export function classifyRef(raw: string, registry: VisibleFactRegistry): MalformedKind | null {
  if (raw.trim().length === 0 || raw !== raw.trim()) return "blank";
  if (REPLACEMENT.test(raw)) return "replacement-character";
  const idLike = raw.match(ID_LIKE) ?? [];
  if (idLike.length > 1) return "multiple-ids";
  if (FULL_WIDTH.test(raw)) return "full-width-delimiter";
  if (!ONE_ID.test(raw)) return "unresolvable";
  return resolvePremiseId(registry, raw).status === "unknown" ? "unresolvable" : null;
}

/* ── Sweeping a whole cognition block ───────────────────────────────────── */

/**
 * Every citation array a fused cognition block can carry.
 *
 * A FLAT LIST rather than a walk over the object, because a walk would pick up
 * whatever field is added next and start rejecting it silently. Adding a
 * citation array to the schema should require adding it here, visibly.
 */
export interface CitationSource {
  readonly field: string;
  readonly values: readonly string[];
}

export function citationSources(cognition: unknown): CitationSource[] {
  const c = cognition as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return [];
  const out: CitationSource[] = [];
  const push = (field: string, v: unknown) => {
    if (Array.isArray(v)) out.push({ field, values: v.filter((x): x is string => typeof x === "string") });
  };

  push("factsUsed", c.factsUsed);
  push("claimsReliedOn", c.claimsReliedOn);
  push("claimsQuestioned", c.claimsQuestioned);

  for (const [i, item] of arr(c.constraints).entries()) {
    push(`constraints[${i}].premiseIds`, rec(item).premiseIds);
  }
  for (const [i, item] of arr(c.seatReads).entries()) {
    push(`seatReads[${i}].evidenceIds`, rec(item).evidenceIds);
  }
  const social = rec(c.social);
  for (const [i, item] of arr(social.focalCandidates).entries()) {
    push(`social.focalCandidates[${i}].basisIds`, rec(item).basisIds);
  }
  const contest = rec(c.contest);
  for (const [i, item] of arr(contest.claimantAssessments).entries()) {
    push(`contest.claimantAssessments[${i}].premiseIds`, rec(item).premiseIds);
  }
  push("contest.alignment.evidenceIds", rec(contest.alignment).evidenceIds);
  push("contest.publicClaimMove.evidenceIds", rec(contest.publicClaimMove).evidenceIds);
  return out;
}

function arr(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Every malformed element in one block, in the order a reader would find them. */
export function malformedRefs(
  cognition: unknown,
  registry: VisibleFactRegistry,
  extra: readonly CitationSource[] = [],
): MalformedRef[] {
  const out: MalformedRef[] = [];
  for (const source of [...citationSources(cognition), ...extra]) {
    for (const [index, raw] of source.values.entries()) {
      const kind = classifyRef(raw, registry);
      if (kind) out.push({ field: source.field, index, kind, raw });
    }
  }
  return out;
}

/* ── The bounded repair note ────────────────────────────────────────────── */

const WHY: Readonly<Record<MalformedKind, string>> = {
  "multiple-ids": "这一格里塞了不止一个 id —— 一格一个，多的另起一格",
  "full-width-delimiter": "这一格里有全角括号或标点 —— id 里不该有它们",
  "replacement-character": "这一格里有占位/控制字符 —— 重新写一遍这个 id",
  blank: "这一格是空的，或者前后带空白",
  unresolvable: "这一格里的 id 在你这一回合的事实表里查不到 —— 只能引你看得到的",
};

/**
 * What to tell the model, describing SHAPE and never content.
 *
 * Quotes nothing it wrote. The field name and the index are enough to point at
 * the box, and the box's content is the one thing that must not come back — an
 * unresolvable id may be another seat's private id, and echoing it would turn
 * a citation mistake into a probe.
 */
export function malformedRefsNote(hits: readonly MalformedRef[]): string {
  const lines = [
    "",
    "## ⚠ 上一次的证据 id 有格式问题",
    "",
    "**每一格只能放一个 id，而且必须是你这一回合的事实表里真的有的那一个。**",
    "",
  ];
  for (const h of hits.slice(0, 6)) {
    lines.push(`- \`${h.field}\` 第 ${h.index + 1} 格：${WHY[h.kind]}`);
  }
  if (hits.length > 6) lines.push(`- …另有 ${hits.length - 6} 处同类问题`);
  lines.push(
    "",
    "引不到就**留空**。空的证据数组是诚实的；一个查不到的 id 会让这条结论被记成没有依据。",
  );
  return lines.join("\n");
}

/** One line for the error channel. Also quotes nothing. */
export function malformedRefsSummary(hits: readonly MalformedRef[]): string {
  const first = hits[0];
  if (!first) return "";
  return (
    `evidence_ref_malformed：${first.field} 第 ${first.index + 1} 格 ${first.kind}` +
    (hits.length > 1 ? `（共 ${hits.length} 处）` : "")
  );
}

/* ── The metric ─────────────────────────────────────────────────────────── */

export interface MalformedEvidenceMetric {
  readonly total: number;
  readonly byKind: Readonly<Record<MalformedKind, number>>;
  readonly fields: readonly string[];
}

export function malformedEvidenceReference(
  hits: readonly MalformedRef[],
): MalformedEvidenceMetric {
  const byKind: Record<MalformedKind, number> = {
    "multiple-ids": 0,
    "full-width-delimiter": 0,
    "replacement-character": 0,
    blank: 0,
    unresolvable: 0,
  };
  for (const h of hits) byKind[h.kind] += 1;
  return {
    total: hits.length,
    byKind,
    fields: [...new Set(hits.map((h) => h.field))],
  };
}
