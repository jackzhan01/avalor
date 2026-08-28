/**
 * Every bound on a model-owned field, in one place.
 *
 * M5 gives the agent a memory. A memory the model writes into and nothing
 * trims is a prompt that grows without a ceiling, and the first two paid games
 * already showed what an unbounded budget does: the run does not degrade, it
 * dies. So every field the model may write has a count limit AND a character
 * limit, both declared here rather than scattered across the schema, because a
 * limit that lives beside its field is a limit nobody can audit as a whole.
 *
 * REFEREE-OWNED FIELDS ARE NOT BOUNDED HERE and must never be. Mission
 * results, votes, proposals and Lady announcements are facts; dropping one to
 * save characters would make the agent's picture of the game wrong rather than
 * smaller. Only interpretations are capped — see `context-pack.ts` for the
 * compaction rules that make that distinction structural.
 *
 * TWO TABLES, and the split is deliberate. `COGNITION_LIMITS` is what the
 * completed M5 pilot ran under and is FROZEN: its numbers are recorded in that
 * game's manifest, and a game whose limits cannot be rebuilt from a checkout is
 * a game nobody can reproduce. `COGNITION_LIMITS_V2` below carries the two
 * numbers the pilot showed were too tight, plus the social-model bounds that
 * did not exist when it ran. `limitsFor(promptVersion)` picks between them.
 */

/**
 * Caps on what the model may write into its own cognitive state.
 *
 * FROZEN AT `prompt-0.3.0`. Do not edit a number here — add it to
 * `COGNITION_LIMITS_V2`. See the note above.
 */
export const COGNITION_LIMITS = {
  /* ── Per-seat dossier ────────────────────────────────────────────────── */
  /** Evidence entries kept for one seat, each side of the ledger. */
  evidenceForPerSeat: 6,
  evidenceAgainstPerSeat: 6,
  /** One evidence line. Long enough for "R2 上车后否了自己提的车", not an essay. */
  evidenceChars: 80,
  /** Recorded contradictions per seat. */
  contradictionsPerSeat: 4,
  contradictionChars: 100,
  /** Why the read on this seat last moved. */
  lastChangeReasonChars: 120,

  /* ── Hypotheses ──────────────────────────────────────────────────────── */
  /** Coexisting worlds. Two is the point; six is a model stalling. */
  maxHypotheses: 4,
  minHypotheses: 2,
  hypothesisLabelChars: 60,
  hypothesisRationaleChars: 200,

  /* ── Derived constraints ─────────────────────────────────────────────── */
  maxDerivedConstraints: 12,
  constraintStatementChars: 140,
  /** Premises one constraint may cite. More than this is not a deduction. */
  maxPremisesPerConstraint: 6,

  /* ── Claims ──────────────────────────────────────────────────────────── */
  /** Claims tracked at once. The referee's own `standingClaims` is unbounded. */
  maxTrackedClaims: 24,
  claimSummaryChars: 120,

  /* ── Self-state ──────────────────────────────────────────────────────── */
  maxPublicCommitments: 8,
  commitmentChars: 120,
  rolePlanChars: 400,
  coverStoryChars: 200,
  claimPlanChars: 200,
  intendedSignalChars: 160,
  nextTurnPlanChars: 200,

  /* ── The structured conclusion returned with every action ────────────── */
  maxFactsUsed: 10,
  maxClaimsReliedOn: 6,
  maxClaimsQuestioned: 6,
  maxAlternativesConsidered: 4,
  minAlternativesConsidered: 2,
  alternativeChars: 120,
  selectedActionSummaryChars: 160,

  /* ── Bounded summaries of older argument ─────────────────────────────── */
  maxArgumentSummaries: 12,
  argumentSummaryChars: 180,
} as const;

export type CognitionLimits = typeof COGNITION_LIMITS;

/**
 * The `prompt-0.3.1` table. Everything above is FROZEN at `prompt-0.3.0`.
 *
 * The completed M5 pilot ran against the numbers above and recorded them in its
 * manifest; editing one in place would make that game unbuildable from a
 * checkout, which is the same failure a temporary edit to `default.json` would
 * cause. So the pilot's numbers stay where they are and the new ones live here.
 *
 * WHAT MOVED, and what the pilot measured:
 *
 *   maxHypotheses        4 → 6   every seat sat at 4/4 at its peak. A ceiling
 *                                that is reached by everybody is not a guard
 *                                rail, it is a cap on the thing being studied.
 *   maxPublicCommitments 8 → 12  likewise 8/8, and the overflow was silently
 *                                dropping the OLDEST promise. See
 *                                `CommitmentResolution`: closing one is now an
 *                                explicit act rather than a side effect of a
 *                                slice.
 *
 * Evidence and constraint bounds are deliberately UNCHANGED: they peaked at
 * 21% and 33%. Moving a limit nothing came near would be a change nobody could
 * point at a measurement for.
 */
export const COGNITION_LIMITS_V2 = {
  ...COGNITION_LIMITS,

  maxHypotheses: 6,
  maxPublicCommitments: 12,

  /* ── The bounded social model, new in 0.3.1 ──────────────────────────── */
  /** Focal players tracked at once. Three is a table reading the room; ten is a dossier. */
  maxFocalCandidates: 3,
  /** Public fact/claim ids backing one focal read. */
  maxFocalBasisIds: 4,
  focalDirectiveChars: 120,
  maxFocalReasons: 3,
  focalReasonChars: 80,
  focalReconsiderChars: 120,
  /** The exact proposition being accepted or rejected. One sentence. */
  alignmentPropositionChars: 160,
  alignmentSupportChars: 160,
  alignmentPublicActionChars: 160,
  maxCoordinateWith: 4,
  coalitionObjectiveChars: 140,
  coalitionDissentChars: 160,
  /** Commitments closed in one turn. */
  maxClosedCommitments: 6,
} as const;

/**
 * Widened to `number` on purpose.
 *
 * The literal types (`maxHypotheses: 6`) are exactly what a version selector
 * must not promise — `limitsFor("prompt-0.3.0")` returns 4 for that field, and
 * a signature claiming 6 would be a lie the compiler enforces.
 */
export type CognitionLimitsV2 = {
  readonly [K in keyof typeof COGNITION_LIMITS_V2]: number;
};

/**
 * Either table, by prompt version.
 *
 * Widened to the V2 type on purpose: V2 is a superset, so code that reads a
 * social bound gets a number for both versions and the 0.3.0 path simply never
 * renders the fields those numbers bound. The alternative — a union the caller
 * must narrow — would put a version check at every read site.
 */
/**
 * The `prompt-0.4.0` table: everything V2 has, plus the claim contest.
 *
 * The V2 numbers are carried unchanged. M5.1 has not run live, so there is no
 * measurement that would justify moving one — and moving a limit with no
 * measurement behind it is exactly what put `maxOutputTokens` at 20,000.
 *
 * The new bounds are first drafts and say so. The contest block is the biggest
 * single addition to the response since the cognition block itself, and the
 * scripted projection in `scripts/m5-2-review.ts` is what a human checks them
 * against before any of it is paid for.
 */
export const COGNITION_LIMITS_V3 = {
  ...COGNITION_LIMITS_V2,

  /* ── The seat's own claim strategy ───────────────────────────────────── */
  claimBenefitChars: 140,
  claimRiskChars: 140,
  claimTriggerChars: 140,
  candidatePairStoryChars: 180,
  leadershipObjectiveChars: 140,
  concealmentCostChars: 140,
  maxConsistencyObligations: 4,
  consistencyObligationChars: 120,

  /* ── Reads on other claimants ────────────────────────────────────────── */
  /** Claimants assessed at once. Ten seats could all claim; three at once is a real contest. */
  maxClaimantAssessments: 4,
  maxClaimPremiseIds: 4,
  claimCaseChars: 140,
  maxClaimCases: 3,
  maxClaimContradictions: 3,
  claimContradictionChars: 120,
  maxClaimPredictions: 3,
  claimPredictionChars: 100,
  claimConditionChars: 120,

  /* ── The rival plan, when this seat is itself claiming ───────────────── */
  maxRivalPlans: 2,
  rivalReasonChars: 140,
  rivalCaseChars: 160,
  rivalDefenceChars: 160,
  rivalResponseChars: 160,
  rivalRiskChars: 140,
  distinctionTestChars: 160,

  /* ── The public move ─────────────────────────────────────────────────── */
  maxMoveTargets: 3,
  publicPropositionChars: 180,
  maxMoveEvidenceIds: 4,
  concealChars: 140,
} as const;

export type CognitionLimitsV3 = {
  readonly [K in keyof typeof COGNITION_LIMITS_V3]: number;
};

/**
 * Either table, by prompt version.
 *
 * Widened to the newest type on purpose: each table is a superset of the last,
 * so code that reads a contest bound gets a number for every version, and the
 * older stacks simply never render the fields those numbers bound. The
 * alternative — a union the caller must narrow — would put a version check at
 * every read site.
 */
export function limitsFor(promptVersion: string): CognitionLimitsV3 {
  if (promptVersion === "prompt-0.4.0") return COGNITION_LIMITS_V3;
  if (promptVersion === "prompt-0.3.1") {
    return { ...COGNITION_LIMITS_V3, ...COGNITION_LIMITS_V2 };
  }
  return { ...COGNITION_LIMITS_V3, ...COGNITION_LIMITS_V2, ...COGNITION_LIMITS };
}

/**
 * Token budgets for one packed prompt.
 *
 * `hardCeiling` is the contract already enforced in `core/input-limit.ts` and
 * is repeated rather than re-derived: a second number that could drift from
 * the first is worse than a duplicated constant.
 *
 * `softTarget` is where compaction STARTS, not where it is forced. The gap
 * between the two is deliberate headroom — a design that only compacts at the
 * ceiling has no margin for the one prompt that grows faster than expected,
 * and that prompt is always the late-game one that matters most.
 */
export const CONTEXT_BUDGET = {
  /** Never exceeded. A pack over this must pause, not truncate silently. */
  hardCeilingTokens: 250_000,
  /** Compaction engages above this. Conservative, i.e. pessimistically estimated. */
  softTargetTokens: 60_000,
} as const;

/** Non-whitespace character count, the same unit the speech limit uses. */
export function contentChars(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n += 1;
  return n;
}

export interface LimitViolation {
  readonly path: string;
  readonly limit: number;
  readonly actual: number;
  readonly kind: "count" | "chars";
}

/** Reports rather than throws, so a validator can list every problem at once. */
export function checkChars(
  path: string,
  text: string,
  limit: number,
): LimitViolation[] {
  const actual = contentChars(text);
  return actual > limit ? [{ path, limit, actual, kind: "chars" }] : [];
}

export function checkCount(
  path: string,
  items: readonly unknown[],
  limit: number,
): LimitViolation[] {
  return items.length > limit
    ? [{ path, limit, actual: items.length, kind: "count" }]
    : [];
}

export function checkMinCount(
  path: string,
  items: readonly unknown[],
  minimum: number,
): LimitViolation[] {
  return items.length < minimum
    ? [{ path, limit: minimum, actual: items.length, kind: "count" }]
    : [];
}
