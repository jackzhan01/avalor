/**
 * The protected secrets, derived by the system, and the detector that looks
 * for them in a finished public sentence.
 *
 * TWO THINGS LIVE HERE AND THEY DO DIFFERENT JOBS.
 *
 *   `protectedSecretsFor(observation)` reads the REFEREE'S OWN data — the
 *   seat's knowledge, its Lady results, its roster — and produces the concrete
 *   values that must not appear in public. It never reads a model-written
 *   field. The M5.2 pilot had the model record `informationToConceal` on every
 *   single turn, correctly, and then publish the pair anyway; a secret the
 *   speaker defines is a note, not a secret.
 *
 *   `findDisclosures(text, secrets, context)` is a BACKSTOP, and this file is
 *   explicit about that because overselling it would be the dangerous mistake.
 *   The real guarantee is structural and lives in `spokesperson.ts`: the seat
 *   that writes the public sentence never receives the pair, so it cannot
 *   paraphrase what it does not hold. This detector catches a leak that
 *   arrives some other way — a planner smuggling the pair through an intent
 *   field, a scripted client, a future stack that regresses. It is not, and is
 *   not claimed to be, a complete semantic filter for Chinese.
 *
 * WHY THE DETECTOR IS TWO TIERS. A single rule is either too loose or too
 * tight, and both failures are real:
 *
 *   TIER A — CLAUSE-EXACT. A clause that names exactly the pair and carries any
 *   pair-shaped cue is a disclosure. This is what 「7、9一梅林一莫甘娜」 and
 *   「我的两个候选是7号和9号」 and 「7、9中必有莫甘娜」 all are.
 *
 *   TIER B — PHRASE-ABSOLUTE. A handful of phrases have no innocent reading at
 *   all. 「一梅林一莫甘娜」 is not something a seat says about three people.
 *   Those fire wherever both pair seats appear in the message.
 *
 * Tier A alone would let a leak hide in a longer clause; a one-tier version of
 * Tier A without the size bound would refuse 「6、7、9 里可能有莫甘娜」, which
 * is an ordinary public inference from a failed team and must stay legal. The
 * milestone's own words: the goal is not to prevent strategic signalling.
 */

import type { RoleType } from "@/lib/types/game";
import type { PublicEvent } from "../core/events";
import type { Observation } from "../core/observation";
import type { Seat } from "../core/types";
import type { SecretClass } from "./classification";

/* ── What the system says is secret ─────────────────────────────────────── */

/**
 * The concrete protected values for one seat at one moment.
 *
 * Every field is `readonly` and every one of them comes from the observation.
 * There is deliberately no constructor that takes them as arguments — the only
 * way to get a `ProtectedSecrets` is to derive it from referee data.
 */
export interface ProtectedSecrets {
  readonly seat: Seat;
  readonly role: RoleType;
  /** Percival's two candidates, sorted. Empty for every other role. */
  readonly percivalPair: readonly Seat[];
  /** Merlin's complete visible evil, sorted. Empty for every other role. */
  readonly merlinVision: readonly Seat[];
  /** An evil seat's known teammates, sorted. Never includes Oberon. */
  readonly knownTeammates: readonly Seat[];
  /** The full roster, once the rules revealed it. Sorted seats only. */
  readonly evilRoster: readonly Seat[];
  /** What the Lady actually showed this seat. */
  readonly ladyTruths: readonly {
    readonly missionNumber: number;
    readonly target: Seat;
    readonly trueSide: "good" | "evil";
  }[];
}

const sorted = (seats: readonly Seat[]): readonly Seat[] => [...seats].sort((a, b) => a - b);

export function protectedSecretsFor(observation: Observation): ProtectedSecrets {
  const k = observation.knowledge;
  return {
    seat: observation.seat,
    role: observation.role,
    percivalPair: k.kind === "merlin_or_morgana" ? sorted(k.pair) : [],
    merlinVision: k.kind === "sees_evil" ? sorted(k.seats) : [],
    knownTeammates: k.kind === "knows_teammates" ? sorted(k.seats) : [],
    // Gated on the seat's OWN side as well as on the roster being present —
    // the same second lock `renderOwnPrivateFacts` uses, so a malformed
    // observation cannot turn this into a leak path on its own.
    evilRoster:
      observation.side === "evil" && observation.evilRoster
        ? sorted(observation.evilRoster.map((e) => e.seat))
        : [],
    ladyTruths: observation.ladyResults.map((r) => ({
      missionNumber: r.missionNumber,
      target: r.target,
      trueSide: r.trueSide,
    })),
  };
}

/* ── Reading seats out of Chinese ───────────────────────────────────────── */

/**
 * Every seat number a fragment names.
 *
 * Three forms, because the table writes all three: `7号`, a punctuated list
 * `7、9`, and the compressed run `57910` that the M5.2 pilot used constantly
 * for teams. The run is parsed left to right taking `10` before `1`, which is
 * what makes `57910` five-seven-nine-ten rather than five-seven-nine-one-zero.
 *
 * OVER-EXTRACTION IS THE SAFE DIRECTION FOR TIER B and the unsafe one for
 * Tier A, which is why Tier A also requires the set to be exactly the pair:
 * a stray number that inflates the set can only ever make Tier A quieter, and
 * Tier B does not look at set size at all.
 */
export function seatsNamedIn(text: string): readonly Seat[] {
  const found = new Set<Seat>();
  const push = (n: number) => {
    if (Number.isInteger(n) && n >= 1 && n <= 10) found.add(n as Seat);
  };

  // `7号`, `10号`
  for (const m of text.matchAll(/(\d{1,2})\s*号/g)) push(Number(m[1]));

  // Digit runs. `7、9`, `7,9`, `7 和 9`, and the compressed `57910`.
  for (const m of text.matchAll(/\d[\d、,，和跟与\s]*\d|\d/g)) {
    for (const chunk of m[0].split(/[、,，和跟与\s]+/)) {
      if (chunk.length === 0) continue;
      if (chunk.length <= 2) {
        push(Number(chunk));
        continue;
      }
      let i = 0;
      while (i < chunk.length) {
        if (chunk[i] === "1" && chunk[i + 1] === "0") {
          push(10);
          i += 2;
        } else {
          push(Number(chunk[i]));
          i += 1;
        }
      }
    }
  }
  return sorted([...found]);
}

/** Clauses, for scoping Tier A. Chinese sentence punctuation, never `、`. */
function clausesOf(text: string): string[] {
  return text
    .split(/[。；;！!？?，,\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

const sameSet = (a: readonly Seat[], b: readonly Seat[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/* ── The cue vocabularies ───────────────────────────────────────────────── */

/**
 * Pair-shaped cues. Tier A: a clause naming exactly the pair plus any of these.
 *
 * Deliberately broad, because Tier A is already narrowed by the exact-set
 * requirement — a clause that names precisely those two seats and then says
 * anything about Merlin, Morgana or candidacy is the disclosure.
 */
const PAIR_CUES: readonly RegExp[] = [
  /梅林/,
  /莫甘娜/,
  /候选/,
  /这两个人?里/,
  /两个人?中/,
  /二选一/,
];

/**
 * Phrases with no innocent reading. Tier B: both pair seats anywhere.
 *
 * Each one asserts the PAIR STRUCTURE itself — that these are the two the
 * rules handed somebody. A seat that has not been handed a pair has no reason
 * to produce any of them, and a seat that has been handed one is publishing it.
 */
const PAIR_ABSOLUTE: readonly RegExp[] = [
  /一梅林一莫甘娜/,
  /一个是?梅林[，,、]?\s*一个是?莫甘娜/,
  /一个是?莫甘娜[，,、]?\s*一个是?梅林/,
  /我的(两个)?候选/,
  /我(的)?候选对/,
  /我看到的(那)?两个/,
  /我看见的(那)?两个/,
  /规则给我的(那)?两个/,
  /(必|一定)(有|是)一个莫甘娜/,
];

/** Merlin's vision, asserted as knowledge rather than as inference. */
const VISION_CUES: readonly RegExp[] = [
  /我(知道|清楚|确定|看得?见|看到|能看见)/,
  /(都|全)是坏人/,
  /(三个|这几个)(都|全)?是坏人/,
  /我的视野/,
];

/** An evil seat quoting its roster. */
const ROSTER_CUES: readonly RegExp[] = [
  /我的?(队友|同伴|同伙)/,
  /我们(三|四|这边|一伙|是一)/,
  /和我一(边|伙|队)/,
  /坏人(名单|是这|就是这)/,
];

/** A first-person Lady verification result stated in ordinary speech. */
const LADY_CUES: readonly RegExp[] = [
  /我(验|查|看)(了|过)?/,
  /(验|查)人?(的)?结果/,
  /女神(告诉|给)我/,
];

/**
 * Schema field names and prompt furniture. Copying any of these into a public
 * sentence means private structure reached the table verbatim.
 */
const COGNITION_TOKENS: readonly string[] = [
  "premiseIds",
  "factsUsed",
  "claimsReliedOn",
  "claimsQuestioned",
  "alternativesConsidered",
  "selectedActionSummary",
  "intendedPublicSignal",
  "updatedRolePlan",
  "hypotheses",
  "seatReads",
  "coverStory",
  "claimPlan",
  "nextTurnPlan",
  "newCommitments",
  "closedCommitments",
  "focalCandidates",
  "coalitionPlan",
  "ownClaimStrategy",
  "claimantAssessments",
  "rivalPlans",
  "publicClaimMove",
  "informationToConceal",
  "candidatePairStory",
  "riskOfOverattacking",
  "distinctionTest",
  "publicBasisIds",
  "factsThatMustRemainPrivate",
  "communicationIntent",
  "cognition",
  "## 共同规则",
  "## 私下的思考流程",
  "## 只有你知道的硬信息",
  "你实际看到的东西",
  "身份与合法信息类型",
];

/* ── Findings ───────────────────────────────────────────────────────────── */

export interface Disclosure {
  readonly secretClass: SecretClass;
  /** Which rule fired. Stable, so a test can assert the exact one. */
  readonly rule: string;
  /** The clause or phrase that triggered it. PRIVATE — never shown to a model. */
  readonly evidence: string;
  readonly detail: string;
}

export interface DisclosureContext {
  /**
   * The one act that declassifies a Lady result, and only its own value.
   *
   * `true` exactly when the answer being validated IS the `lady_announce`
   * action. Ordinary speech never sets it, which is what stops a seat from
   * publishing a verification through a sentence rather than through the move.
   */
  readonly isLadyAnnouncement: boolean;
  /** The evil council phases. Roster talk is legal only inside them. */
  readonly isEvilCouncil: boolean;
  /** The public log, so a repeated announcement is not counted twice. */
  readonly publicLog: readonly PublicEvent[];
}

/**
 * Everything in `text` that discloses one of `secrets`.
 *
 * Returns findings rather than a boolean so the audit record can say WHICH
 * class leaked and which rule caught it — a count of rejections that cannot
 * say what was rejected is not something a reviewer can act on.
 */
export function findDisclosures(
  text: string,
  secrets: ProtectedSecrets,
  context: DisclosureContext,
): readonly Disclosure[] {
  const out: Disclosure[] = [];
  const named = seatsNamedIn(text);
  const clauses = clausesOf(text);

  /* ── The pair ─────────────────────────────────────────────────────────── */
  const pair = secrets.percivalPair;
  if (pair.length === 2) {
    const bothNamed = pair.every((s) => named.includes(s));
    if (bothNamed) {
      for (const rule of PAIR_ABSOLUTE) {
        const m = rule.exec(text);
        if (m) {
          out.push({
            secretClass: "private-percival-pair",
            rule: `pair-absolute:${rule.source}`,
            evidence: m[0],
            detail: `公开发言里出现了候选对结构本身的说法，而 ${pair.join("、")}号 两个人都被点名了`,
          });
          break;
        }
      }
    }
    for (const clause of clauses) {
      const clauseSeats = seatsNamedIn(clause);
      if (!sameSet(clauseSeats, pair)) continue;
      const cue = PAIR_CUES.find((r) => r.test(clause));
      if (cue) {
        out.push({
          secretClass: "private-percival-pair",
          rule: `pair-clause:${cue.source}`,
          evidence: clause,
          detail: `一个分句正好只点了 ${pair.join("、")}号 这两个人，并且谈到了梅林／莫甘娜／候选`,
        });
      }
    }
  }

  /* ── Merlin's vision ──────────────────────────────────────────────────── */
  const vision = secrets.merlinVision;
  if (vision.length > 0) {
    for (const clause of clauses) {
      const clauseSeats = seatsNamedIn(clause);
      if (!sameSet(clauseSeats, vision)) continue;
      const cue = VISION_CUES.find((r) => r.test(clause));
      if (cue) {
        out.push({
          secretClass: "private-merlin-vision",
          rule: `vision-clause:${cue.source}`,
          evidence: clause,
          detail: `一个分句正好点了完整视野 ${vision.join("、")}号，并且说成是已知而不是推理`,
        });
      }
    }
  }

  /* ── The roster ───────────────────────────────────────────────────────── */
  if (!context.isEvilCouncil) {
    for (const set of [secrets.knownTeammates, secrets.evilRoster]) {
      if (set.length === 0) continue;
      for (const clause of clauses) {
        const clauseSeats = seatsNamedIn(clause);
        if (!sameSet(clauseSeats, set)) continue;
        const cue = ROSTER_CUES.find((r) => r.test(clause));
        if (cue) {
          out.push({
            secretClass: "private-evil-roster",
            rule: `roster-clause:${cue.source}`,
            evidence: clause,
            detail: `一个分句正好点了 ${set.join("、")}号，并且把他们说成自己人`,
          });
        }
      }
    }
  }

  /* ── The Lady ─────────────────────────────────────────────────────────── */
  if (!context.isLadyAnnouncement && secrets.ladyTruths.length > 0) {
    const alreadyAnnounced = new Set(
      context.publicLog
        .filter(
          (e): e is Extract<PublicEvent, { type: "lady_announced" }> =>
            e.type === "lady_announced" && e.holder === secrets.seat,
        )
        .map((e) => e.target),
    );
    for (const clause of clauses) {
      const cue = LADY_CUES.find((r) => r.test(clause));
      if (!cue) continue;
      const clauseSeats = seatsNamedIn(clause);
      for (const truth of secrets.ladyTruths) {
        // A seat may keep referring to an announcement it already made in the
        // legal way. What it may not do is publish a verification through
        // ordinary speech in the first place.
        if (alreadyAnnounced.has(truth.target)) continue;
        if (!clauseSeats.includes(truth.target)) continue;
        out.push({
          secretClass: "private-lady-result",
          rule: `lady-unannounced:${cue.source}`,
          evidence: clause,
          detail:
            `${truth.target}号 的验人结果只能通过 lady_announce 这个合法动作公开，` +
            `普通发言不解密它`,
        });
      }
    }
  }

  /* ── Structure that should never be spoken ────────────────────────────── */
  for (const token of COGNITION_TOKENS) {
    if (text.includes(token)) {
      out.push({
        secretClass: "private-cognition",
        rule: `cognition-token:${token}`,
        evidence: token,
        detail: "私有 schema 字段名或提示层标题被原样抄进了公开发言",
      });
    }
  }

  // Private fact ids, in any of the shapes the prompt renders them.
  for (const m of text.matchAll(/\[?\bp\.[a-zA-Z0-9]+\]?/g)) {
    out.push({
      secretClass: "private-cognition",
      rule: "private-fact-id",
      evidence: m[0],
      detail: "私有事实 id 出现在公开发言里",
    });
  }
  if (/\bown-role\b/.test(text)) {
    out.push({
      secretClass: "private-cognition",
      rule: "private-fact-id",
      evidence: "own-role",
      detail: "私有事实 id 出现在公开发言里",
    });
  }

  return out;
}

/** Does this text disclose anything at all? The boolean the firewall wants. */
export function disclosesAnything(
  text: string,
  secrets: ProtectedSecrets,
  context: DisclosureContext,
): boolean {
  return findDisclosures(text, secrets, context).length > 0;
}
