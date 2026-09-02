/**
 * What a prompt version can do, declared once and read everywhere.
 *
 * WHY THIS FILE EXISTS. Every capability used to be re-derived at each call
 * site by comparing `config.promptVersion` against a historical constant:
 *
 *     const wantsContest = config.promptVersion === PROMPT_VERSION_CONTEST;
 *
 * That is correct exactly until a newer version is a superset of an older one —
 * and `prompt-0.5.0` is. The prompt BUILDER was taught about 0.5.0 and the
 * answer FOLDER was not, so for two completed live games the model was asked
 * for `social` and `contest`, answered them under a strict schema, and had both
 * blocks silently discarded: never validated, never folded into the ledger,
 * never rendered on the next turn, never recorded in telemetry. The `k…`
 * claim-contest ids were not minted either, so every citation of one came back
 * as an invented id. Nothing failed. The games completed and looked fine.
 *
 * The repair is not a better comparison. It is removing comparison from the
 * call sites entirely: a version DECLARES its capabilities here, and code asks
 * `capabilities.claimContest` instead of guessing from a string.
 *
 * NO LEXICOGRAPHIC COMPARISON, deliberately. `"prompt-0.10.0" < "prompt-0.5.0"`
 * is true as strings, and a scheme that happened to work for six versions and
 * then silently inverted would be a worse version of the bug this file fixes.
 * Every version is an explicit row. Adding one is a deliberate edit, and a
 * version nobody added is refused rather than guessed at.
 *
 * FROZEN ROWS ARE FROZEN. The five rows below 0.6.0 describe what four
 * completed live games actually ran. Changing one rewrites finished history.
 */

import { limitsFor, type CognitionLimitsV3 } from "../cognition/limits";
import {
  PROMPT_VERSION_COGNITIVE,
  PROMPT_VERSION_COGNITIVE_V2,
  PROMPT_VERSION_CONTEST,
  PROMPT_VERSION_DISCLOSURE,
  PROMPT_VERSION_LEGACY,
  PROMPT_VERSION_M54,
  PROMPT_VERSION_M55,
} from "./version";

/**
 * One prompt stack's feature set.
 *
 * Every field is a thing some code branches on. They are listed in the order
 * the milestones added them, and each says which milestone owns it, so a
 * reader can map a row to the design document that argued for it.
 */
export interface PromptCapabilities {
  readonly version: string;

  /* ── M5: the epistemic ledger ─────────────────────────────────────────── */
  /** The fused `cognition` block, the ledger in the prompt, fact tables. */
  readonly cognition: boolean;

  /* ── M5.1: provenance and coordination ────────────────────────────────── */
  /** Render canonical `[f…]`/`[c…]`/`[p…]` ids beside citable lines. */
  readonly citableFactIds: boolean;
  /** Ask for and fold the bounded social model. */
  readonly social: boolean;

  /* ── M5.2: the public claim contest ───────────────────────────────────── */
  /**
   * Ask for and fold the contest block, mint `k…` contest-event ids, render
   * the referee's claim-contest table, and offer 退水 in the speech schema.
   *
   * ONE FLAG for all five, because they are one feature: a stack that rendered
   * the table without minting the ids is exactly the broken state this file
   * was written to make impossible.
   */
  readonly claimContest: boolean;

  /* ── M5.3: disclosure safety ──────────────────────────────────────────── */
  /** Private planner + public spokesperson, with the firewall between them. */
  readonly twoStageSpeech: boolean;
  /** Close commitments by stable id rather than by exact-text equality. */
  readonly stableCommitmentIds: boolean;

  /* ── M5.4 ─────────────────────────────────────────────────────────────── */
  /** Public speech carries natural Chinese, never machine evidence ids. */
  readonly naturalPublicSpeech: boolean;
  /** The private evil mission-card coordination convention. */
  readonly evilCoordination: boolean;
  /** Structured proposal/vote evaluation after a mission result. */
  readonly voteDiscipline: boolean;
  /** A bounded private candidate ranking before the assassination target. */
  readonly assassinRanking: boolean;
  /**
   * Render the revealed evil roster into the seat's own private-facts layer.
   *
   * A REPAIR, and it needs a capability of its own because the four frozen
   * stacks must keep their exact bytes. `renderOwnPrivateFacts` has never
   * rendered `evilRoster` — not once, in any cognitive version — while
   * `fact-ids.ts` minted `p.roster` as a citable id and the assassination task
   * text told the Assassin 「第四节里已经给了你坏人这边的确切身份」. It had not.
   *
   * The M5.3 Terra Assassin therefore reasoned from `p.team` (three seats,
   * Oberon excluded), inferred a fourth villain from public evidence, and got
   * it wrong — it marked a loyal seat `strong-evil` and Oberon `strong-good`.
   */
  readonly evilRosterRendered: boolean;

  /* ── M5.5 ─────────────────────────────────────────────────────────────── */
  /**
   * Ask for the coordination block ONLY when this seat actually has one.
   *
   * Under 0.6.0 the block was gated on the version alone while the coordination
   * SECTION was gated on `observation.missionCoordination`. Oberon therefore
   * received a required field whose description says 「`designated` 抄第四节里
   * 给你的指定状态」 with no such section in his prompt — the same shape as the
   * M5.4 roster defect, and worse than a wasted field: the field's existence
   * tells him a sabotage convention exists among players who do not know him.
   */
  readonly coordinationFieldGated: boolean;
  /**
   * Every evidence/premise array element must be exactly one id that resolves.
   *
   * The live 0.6.0 game wrote eight elements holding several ids joined by
   * full-width delimiters (`"k4:claim】【、】【k45:claim"`), plus one padded with
   * U+FFFC. They passed the schema (any string) and then resolved as invented
   * ids — an unverified premise that looks like a citation.
   */
  readonly validatedEvidenceRefs: boolean;
  /** Lady possession is an alternative explanation, never counter-evidence. */
  readonly ladyNeutralAssassination: boolean;
  /** Refuse a public sentence that groups both real Percival candidates. */
  readonly pairGroupingBlocked: boolean;
  /** A standing claim stays standing; a purposeless re-claim is repaired. */
  readonly persistentClaims: boolean;
  /**
   * The `cognition` instruction carries no copyable id and names no private one.
   *
   * The frozen paragraph teaches the notation by SHOWING it — `[f12]`,
   * `[f.fail1]`, `[c33:role]`, `[p.pair]` — in the exact shape of a real citable
   * row. `[p.pair]` is not a placeholder: it is Percival's actual pair id, so an
   * instruction every seat receives both names a private id and hands over a
   * string that looks citable. 0.7.0 uses prose placeholders that cannot parse
   * as ids, so copying one is a bounded repair rather than a false premise.
   */
  readonly proseExampleIds: boolean;

  /** The field bounds this stack was run under. */
  readonly limits: CognitionLimitsV3;
}

const NONE: Omit<PromptCapabilities, "version" | "limits"> = {
  cognition: false,
  citableFactIds: false,
  social: false,
  claimContest: false,
  twoStageSpeech: false,
  stableCommitmentIds: false,
  naturalPublicSpeech: false,
  evilCoordination: false,
  voteDiscipline: false,
  assassinRanking: false,
  evilRosterRendered: false,
  coordinationFieldGated: false,
  validatedEvidenceRefs: false,
  ladyNeutralAssassination: false,
  pairGroupingBlocked: false,
  persistentClaims: false,
  proseExampleIds: false,
};

function row(
  version: string,
  on: Partial<Omit<PromptCapabilities, "version" | "limits">>,
): PromptCapabilities {
  return { version, ...NONE, ...on, limits: limitsFor(version) };
}

/**
 * The table. Six rows, five of them frozen.
 *
 * Each row is a SUPERSET of the one above it in practice, but nothing here
 * enforces or assumes that — the supersetting is a fact about how the stacks
 * were built, not a rule the lookup relies on. A future version that turns a
 * capability OFF is expressible, and would be read correctly.
 */
const TABLE: Readonly<Record<string, PromptCapabilities>> = Object.freeze({
  /** Experiments 2 and 3. Seven layers, no ledger. */
  [PROMPT_VERSION_LEGACY]: row(PROMPT_VERSION_LEGACY, {}),

  /** M5 pilot (`g-a0b76ac9`). Ledger, but no rendered ids — the M5.1 defect. */
  [PROMPT_VERSION_COGNITIVE]: row(PROMPT_VERSION_COGNITIVE, { cognition: true }),

  /** M5.1. Never run live. */
  [PROMPT_VERSION_COGNITIVE_V2]: row(PROMPT_VERSION_COGNITIVE_V2, {
    cognition: true,
    citableFactIds: true,
    social: true,
  }),

  /** M5.2 pilot (`g-6ebccca0`). */
  [PROMPT_VERSION_CONTEST]: row(PROMPT_VERSION_CONTEST, {
    cognition: true,
    citableFactIds: true,
    social: true,
    claimContest: true,
  }),

  /**
   * M5.3 paired pilots (`g-dde11045` Terra, `g-826f0c52` Luna).
   *
   * This row is what those two games SHOULD have run. They ran with the
   * builder honouring `social` and `claimContest` and the folder ignoring
   * both — see the file header. The row is written as designed rather than as
   * executed, because it describes the stack, and the defect is recorded in
   * the artifacts and in `README-M5.4.md` rather than by falsifying the table.
   */
  [PROMPT_VERSION_DISCLOSURE]: row(PROMPT_VERSION_DISCLOSURE, {
    cognition: true,
    citableFactIds: true,
    social: true,
    claimContest: true,
    twoStageSpeech: true,
    stableCommitmentIds: true,
  }),

  /**
   * M5.4 pilot (`g-4a461bf1`, Terra, seed 1, good/assassin_missed, $11.5167).
   *
   * FROZEN. That game is on disk and its prompts must stay rebuildable, which
   * is the whole reason M5.5's five changes are a new row rather than edits to
   * this one — three of them change a prompt this game actually sent.
   */
  [PROMPT_VERSION_M54]: row(PROMPT_VERSION_M54, {
    cognition: true,
    citableFactIds: true,
    social: true,
    claimContest: true,
    twoStageSpeech: true,
    stableCommitmentIds: true,
    naturalPublicSpeech: true,
    evilCoordination: true,
    voteDiscipline: true,
    assassinRanking: true,
    evilRosterRendered: true,
  }),

  /** M5.5. Never run live. */
  [PROMPT_VERSION_M55]: row(PROMPT_VERSION_M55, {
    cognition: true,
    citableFactIds: true,
    social: true,
    claimContest: true,
    twoStageSpeech: true,
    stableCommitmentIds: true,
    naturalPublicSpeech: true,
    evilCoordination: true,
    voteDiscipline: true,
    assassinRanking: true,
    evilRosterRendered: true,
    coordinationFieldGated: true,
    validatedEvidenceRefs: true,
    ladyNeutralAssassination: true,
    pairGroupingBlocked: true,
    persistentClaims: true,
    proseExampleIds: true,
  }),
});

export class UnknownPromptVersionError extends Error {
  constructor(readonly promptVersion: string) {
    super(
      `promptVersion ${promptVersion} 没有在 prompts/capabilities.ts 里声明能力。` +
        `已知的是 ${Object.keys(TABLE).join(" / ")}。` +
        `新版本必须显式加一行 —— 不猜、不按字符串比大小。`,
    );
    this.name = "UnknownPromptVersionError";
  }
}

/**
 * What this version can do.
 *
 * THROWS on an unknown version rather than returning a safe default. A default
 * would be the same failure as before in a new costume: a stack whose features
 * were half-on, running to completion, producing artifacts that look fine.
 * `config/load.ts` already validates `promptVersion`, so reaching this throw
 * means somebody added a version and forgot the row — which is exactly when a
 * loud failure is cheapest.
 */
export function capabilitiesFor(promptVersion: string): PromptCapabilities {
  const found = TABLE[promptVersion];
  if (!found) throw new UnknownPromptVersionError(promptVersion);
  return found;
}

export function isKnownPromptVersion(promptVersion: string): boolean {
  return promptVersion in TABLE;
}

/** Every declared version, in table order. For tests and documentation. */
export const DECLARED_PROMPT_VERSIONS: readonly string[] = Object.keys(TABLE);
