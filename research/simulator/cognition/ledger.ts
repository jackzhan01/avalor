/**
 * The epistemic ledger: what a seat KNOWS, what it has been TOLD, and what it
 * has CONCLUDED — three different things, kept apart by the type system.
 *
 * WHY THIS EXISTS. Experiment 3 produced the best reasoning we have seen from
 * this table and still lost 0:3, and the private trace says why. Seat 6 built
 * a correct three-constraint deduction on two premises — "I am loyal" and
 * "seat 9's Lady announcement is true" — neither of which the table could
 * check. Evil did not out-argue it; evil attacked the premises, and the whole
 * structure fell over. Meanwhile the agents had no way to say "this is a fact"
 * versus "this is something a player said", because their only memory was a
 * free-text note field where both looked identical.
 *
 * So the ledger's central commitment:
 *
 *   A CLAIM NEVER BECOMES A FACT. There is no function here that promotes one,
 *   no field a model can write that lands in `PublicHardFact`, and no cast a
 *   caller can make without the compiler objecting. `deriveConstraint` demands
 *   premise references, and every premise carries its own `verified` flag, so
 *   a conclusion resting on an unverified claim is *labelled as such by
 *   construction* rather than by the model remembering to mention it.
 *
 * THREE OWNERS, and they never overlap:
 *
 *   REFEREE   public hard facts, private hard facts. Built from events only.
 *             No model output can create, amend or delete one.
 *   TABLE     public claims. Recorded verbatim as "seat N said X at seq S".
 *             Recording is not believing.
 *   MODEL     constraints, hypotheses, dossiers, self-state. All bounded by
 *             `COGNITION_LIMITS`, all carrying provenance.
 *
 * IMMUTABILITY is enforced at runtime with `deepFreeze`, for the same reason
 * `observation.ts` does it: `readonly` is a compile-time fiction and one cast
 * would let an agent rewrite its own history. Every update returns a NEW
 * ledger; nothing here mutates.
 *
 * STATUS: offline scaffolding. Nothing in the live CLI imports this file, and
 * `M5` is not activated for paid play. See `cognition/README.md`.
 */

import type { RoleType } from "@/lib/types/game";
import type { PublicEvent } from "../core/events";
import { deepFreeze } from "../core/freeze";
import type { Observation } from "../core/observation";
import type { LadyResult, PrivateKnowledge, Seat, Side } from "../core/types";
import {
  COGNITION_LIMITS as L,
  checkChars,
  checkCount,
  checkMinCount,
  type CognitionLimitsV3,
  type LimitViolation,
} from "./limits";
import type { ContestModel } from "./contest";
import type { SocialModel } from "./social";

/* ── Provenance ─────────────────────────────────────────────────────────── */

/**
 * Where a ledger item came from. Present on EVERY item, without exception.
 *
 * `referee` and `own-role` are the only two that may back a hard fact. The
 * others exist so that a downstream reader — a test, a reviewer, an evaluation
 * rubric — can ask "what is this resting on?" and get an answer that does not
 * require reading the model's prose.
 */
export type Provenance =
  /** A referee event. The only source of public hard fact. */
  | { readonly kind: "referee"; readonly sequence: number }
  /** The deal, delivered through `observation.knowledge`. Private hard fact. */
  | { readonly kind: "own-role" }
  /** A Lady result this seat personally received. Private hard fact. */
  | { readonly kind: "own-lady"; readonly sequence: number }
  /** Something a seat said. NOT evidence that it is true. */
  | { readonly kind: "table-claim"; readonly seat: Seat; readonly sequence: number }
  /** The model's own reasoning, citing premises. Never a hard fact. */
  | { readonly kind: "inference"; readonly premises: readonly PremiseRef[] };

/** A pointer to whatever a constraint rests on, with its verification status. */
export interface PremiseRef {
  readonly id: string;
  /**
   * True only for referee events and this seat's own role knowledge.
   *
   * Deliberately stored on the REFERENCE rather than looked up: a constraint
   * carried into a prompt must be readable on its own, and a premise whose
   * status has to be resolved elsewhere is a premise that will be quoted
   * without its caveat.
   */
  readonly verified: boolean;
  /** Short human label, for the prompt. Bounded. */
  readonly label: string;
}

/* ── 1. Public hard facts ───────────────────────────────────────────────── */

/**
 * Referee events, restated as a fact table. REFEREE-OWNED.
 *
 * Not a copy of the log for its own sake: the log is a sequence of things that
 * happened, and this is the subset a player reasons over, in a shape that a
 * constraint can cite by id. `publicFactsFrom` is the only constructor and it
 * takes events, so there is no path from a model response to this type.
 */
export type PublicHardFact =
  | {
      readonly kind: "mission_result";
      readonly id: string;
      readonly provenance: Provenance;
      readonly missionNumber: number;
      readonly team: readonly Seat[];
      readonly result: "success" | "fail";
      readonly failCount: number;
    }
  | {
      readonly kind: "vote";
      readonly id: string;
      readonly provenance: Provenance;
      readonly missionNumber: number;
      readonly attempt: number;
      readonly team: readonly Seat[];
      readonly votes: Readonly<Record<Seat, "approve" | "reject">>;
      readonly result: "passed" | "rejected";
    }
  | {
      readonly kind: "proposal";
      readonly id: string;
      readonly provenance: Provenance;
      readonly missionNumber: number;
      readonly attempt: number;
      readonly leader: Seat;
      readonly team: readonly Seat[];
    }
  | {
      readonly kind: "lady_announcement";
      readonly id: string;
      readonly provenance: Provenance;
      /**
       * What the holder SAID. The announcement being public is a fact; the
       * announcement being TRUE is not, which is why this also appears as a
       * claim. A seat that reasons from `announced` as if it were the truth is
       * making the mistake seat 6 made in Experiment 3.
       */
      readonly holder: Seat;
      readonly target: Seat;
      readonly announced: Side;
    }
  | {
      readonly kind: "lady_transfer";
      readonly id: string;
      readonly provenance: Provenance;
      readonly from: Seat;
      readonly to: Seat;
    }
  | {
      readonly kind: "leader_change";
      readonly id: string;
      readonly provenance: Provenance;
      readonly from: Seat;
      readonly to: Seat;
      readonly reason: "rejection" | "mission";
    }
  | {
      readonly kind: "assassination_target";
      readonly id: string;
      readonly provenance: Provenance;
      readonly assassin: Seat;
      readonly target: Seat;
    }
  | {
      readonly kind: "game_end";
      readonly id: string;
      readonly provenance: Provenance;
      readonly winner: Side;
      readonly reason: string;
      /** The reveal. Public by rule, and only at the very end. */
      readonly reveal: Readonly<Record<Seat, RoleType>>;
    };

/* ── 2. Private hard facts ──────────────────────────────────────────────── */

/** What the rules gave THIS seat. REFEREE-OWNED. */
export interface PrivateHardFacts {
  readonly seat: Seat;
  readonly role: RoleType;
  readonly side: Side;
  readonly knowledge: PrivateKnowledge;
  /** Lady results this seat personally received. Permanent, never amendable. */
  readonly ladyResults: readonly LadyResult[];
  /** Non-null only once the assassination phase has revealed it. */
  readonly evilRoster: readonly { readonly seat: Seat; readonly role: RoleType }[] | null;
  readonly provenance: Provenance;
}

/* ── 3. Public claims ───────────────────────────────────────────────────── */

/**
 * Something a seat asserted. TABLE-OWNED.
 *
 * The `verified` field is deliberately absent rather than defaulted to false:
 * a claim has no verification status at all, and giving it one invites code
 * that flips it. What CAN change is the model's assessment, which lives in
 * `ClaimAssessment` and is a separate, model-owned object.
 */
export type PublicClaim =
  | {
      readonly kind: "role_claim";
      readonly id: string;
      readonly provenance: Provenance;
      readonly seat: Seat;
      readonly claimed: RoleType;
      readonly sinceSequence: number;
      /** Set when a later claim by the same seat supersedes this one. */
      readonly retractedAtSequence: number | null;
    }
  | {
      readonly kind: "lady_claim";
      readonly id: string;
      readonly provenance: Provenance;
      readonly seat: Seat;
      readonly target: Seat;
      readonly announced: Side;
    }
  | {
      readonly kind: "alignment_claim";
      readonly id: string;
      readonly provenance: Provenance;
      readonly seat: Seat;
      readonly asserted: Side;
    }
  | {
      readonly kind: "assertion";
      readonly id: string;
      readonly provenance: Provenance;
      readonly seat: Seat;
      /** MODEL-OWNED text: the agent's own paraphrase of what was asserted. */
      readonly summary: string;
    };

/** The model's read on one claim. Separate object, separate owner. */
export interface ClaimAssessment {
  readonly claimId: string;
  readonly stance: "accepted" | "questioned" | "rejected" | "untested";
  readonly reasonChars: string;
}

/* ── 4. Derived constraints ─────────────────────────────────────────────── */

/**
 * Something the agent worked out. MODEL-OWNED, and never promotable.
 *
 * `restsOnUnverified` is COMPUTED from the premises rather than supplied, so a
 * model cannot assert that its conclusion is solid. That is the whole
 * mechanism: Experiment 3's seat 6 would have been forced to carry
 * "restsOnUnverified: true" into every prompt where it repeated its deduction.
 */
export interface DerivedConstraint {
  readonly id: string;
  readonly statement: string;
  readonly premises: readonly PremiseRef[];
  /** Computed. `deriveConstraint` is the only constructor. */
  readonly restsOnUnverified: boolean;
  readonly provenance: Provenance;
  readonly atSequence: number;
}

export function deriveConstraint(input: {
  readonly id: string;
  readonly statement: string;
  readonly premises: readonly PremiseRef[];
  readonly atSequence: number;
}): DerivedConstraint {
  return deepFreeze({
    id: input.id,
    statement: input.statement,
    premises: [...input.premises],
    // Not a field the model fills in. One unverified premise makes the whole
    // conclusion unverified, and no amount of confident phrasing changes it.
    restsOnUnverified: input.premises.some((p) => !p.verified),
    provenance: { kind: "inference", premises: [...input.premises] },
    atSequence: input.atSequence,
  });
}

/* ── 5. Alternative hypotheses ──────────────────────────────────────────── */

/**
 * Categorical only, on purpose.
 *
 * The removed data-informed strategy catalog put probabilities in prompts and
 * that was rejected; a `pEvil: 0.62` in a ledger is the same mistake wearing a
 * different hat. Five buckets are enough to act on and cheap to keep honest —
 * and crucially, a bucket cannot be multiplied by another bucket, so nothing
 * downstream can quietly grow into a probability model nobody sanctioned.
 */
export type Confidence =
  | "strong-good"
  | "lean-good"
  | "unresolved"
  | "lean-evil"
  | "strong-evil";

export const CONFIDENCE_VALUES: readonly Confidence[] = [
  "strong-good",
  "lean-good",
  "unresolved",
  "lean-evil",
  "strong-evil",
];

/** One coherent world. At least two must coexist. MODEL-OWNED. */
export interface Hypothesis {
  readonly id: string;
  readonly label: string;
  /** Seats this world says are evil. Not a probability, a configuration. */
  readonly evilSeats: readonly Seat[];
  readonly rationale: string;
  readonly standing: Confidence;
  readonly premises: readonly PremiseRef[];
  readonly provenance: Provenance;
}

/* ── 6. Per-seat dossier ────────────────────────────────────────────────── */

export interface DossierEvidence {
  readonly text: string;
  readonly provenance: Provenance;
  readonly atSequence: number;
}

/** Everything the agent has noticed about one seat over time. MODEL-OWNED. */
export interface SeatDossier {
  readonly seat: Seat;
  /** Claim ids, not copies. The claims live once, in `claims`. */
  readonly claimIds: readonly string[];
  /** Public fact ids for proposals this seat led. */
  readonly proposalIds: readonly string[];
  /** How this seat voted, by public fact id. */
  readonly votes: readonly { readonly factId: string; readonly vote: "approve" | "reject" }[];
  /** Missions this seat rode, by public fact id. */
  readonly missionIds: readonly string[];
  /** Times this seat engaged another seat's argument, and whether it moved. */
  readonly responses: readonly {
    readonly toSeat: Seat;
    readonly atSequence: number;
    readonly moved: boolean;
  }[];
  readonly contradictions: readonly DossierEvidence[];
  /** Who this seat has repeatedly voted with. Cheap coalition signal. */
  readonly votesWith: readonly Seat[];
  readonly evidenceFor: readonly DossierEvidence[];
  readonly evidenceAgainst: readonly DossierEvidence[];
  readonly standing: Confidence;
  readonly lastChangedAtSequence: number;
  readonly lastChangeReason: string;
}

/* ── 7. Agent self-state ────────────────────────────────────────────────── */

/**
 * Why a commitment stopped being live.
 *
 * Three outcomes rather than one, because they mean different things to a
 * reader of the trace: a promise kept, a promise the game made moot, and a
 * promise broken. Collapsing them would make "did this seat keep its word"
 * unanswerable, which is most of what a commitment list is for.
 */
export type CommitmentResolution = "fulfilled" | "obsolete" | "withdrawn";

export interface PublicCommitment {
  readonly text: string;
  readonly atSequence: number;
  /** Set when the agent has publicly gone back on it. Honesty about drift. */
  readonly withdrawnAtSequence: number | null;
  /**
   * Set when the commitment left the ACTIVE list, whatever the reason.
   *
   * Added in `prompt-0.3.1`. Before it, the active list was capped by a
   * `slice(-8)` that silently dropped the OLDEST promise — so a seat could
   * quietly stop being accountable for its opening statement by making eight
   * more. Closing one is now something the model does on purpose and the trace
   * records.
   */
  readonly resolvedAtSequence?: number | null;
  readonly resolution?: CommitmentResolution | null;
}

/** Still binding: not withdrawn, not resolved. The list the prompt renders. */
export function activeCommitments(
  commitments: readonly PublicCommitment[],
): readonly PublicCommitment[] {
  return commitments.filter(
    (c) => c.withdrawnAtSequence === null && (c.resolvedAtSequence ?? null) === null,
  );
}

/** The agent's own plan. MODEL-OWNED, and private forever. */
export interface SelfState {
  readonly seat: Seat;
  readonly publicCommitments: readonly PublicCommitment[];
  /** The role-specific long game. See `expert-playbook-draft.md`. */
  readonly rolePlan: string;
  readonly intendedSignal: string;
  /** What this seat wants the table to believe about it. Evil and good alike. */
  readonly coverStory: string;
  readonly claimPlan: string;
  readonly nextTurnPlan: string;
  /** Everything up to here has been ingested. Drives incremental updates. */
  readonly lastProcessedSequence: number;
}

/* ── The ledger ─────────────────────────────────────────────────────────── */

export interface EpistemicLedger {
  readonly schema: typeof LEDGER_SCHEMA;
  readonly seat: Seat;
  readonly atSequence: number;

  /* Referee-owned. */
  readonly publicFacts: readonly PublicHardFact[];
  readonly privateFacts: PrivateHardFacts;

  /* Table-owned. */
  readonly claims: readonly PublicClaim[];

  /* Model-owned, all bounded. */
  readonly claimAssessments: readonly ClaimAssessment[];
  readonly constraints: readonly DerivedConstraint[];
  readonly hypotheses: readonly Hypothesis[];
  readonly dossiers: Readonly<Record<Seat, SeatDossier>>;
  readonly self: SelfState;
  /**
   * Who this seat thinks is leading the table, and what it is doing about it.
   *
   * Null on the `prompt-0.3.0` path: that stack never asks for one, and an
   * empty model would be indistinguishable from a seat that read the table and
   * found nobody focal. See `social.ts`.
   */
  readonly social: SocialModel | null;
  /**
   * Where this seat stands in the fight over Percival, and what it makes of
   * everyone else's claims.
   *
   * Null on every stack before `prompt-0.4.0`: those never ask for one, and an
   * empty model would be indistinguishable from a seat that looked at the
   * contest and concluded nothing. See `contest.ts`.
   */
  readonly contest: ContestModel | null;
}

export const LEDGER_SCHEMA = "avalon-epistemic-ledger@1";

/* ── Construction from an observation ───────────────────────────────────── */

const factId = (event: PublicEvent, suffix = ""): string =>
  `f${event.sequence}${suffix ? `:${suffix}` : ""}`;

/**
 * Turn the public log into a fact table. REFEREE INPUT ONLY.
 *
 * Speeches are deliberately NOT facts. "Seat 4 spoke" is true but useless;
 * what was said is a claim and is handled by `claimsFrom`. Keeping the two
 * apart here is what makes the separation structural rather than a convention
 * the prompt asks the model to respect.
 */
export function publicFactsFrom(log: readonly PublicEvent[]): PublicHardFact[] {
  const facts: PublicHardFact[] = [];
  // The `vote` event carries the tally but not the roster — the team is on the
  // `proposal` that preceded it. Carried forward here so a vote fact is
  // self-contained: "who voted how on WHICH team" is the question a dossier
  // asks, and answering it should not require a second lookup at read time.
  let lastProposedTeam: readonly Seat[] = [];
  for (const event of log) {
    if (event.type === "proposal") lastProposedTeam = event.team;
    const provenance: Provenance = { kind: "referee", sequence: event.sequence };
    switch (event.type) {
      case "mission_result":
        facts.push({
          kind: "mission_result",
          id: factId(event),
          provenance,
          missionNumber: event.missionNumber,
          team: [...event.team],
          result: event.result,
          failCount: event.failCount,
        });
        break;
      case "vote":
        facts.push({
          kind: "vote",
          id: factId(event),
          provenance,
          missionNumber: event.missionNumber,
          attempt: event.attempt,
          team: [...lastProposedTeam],
          votes: { ...event.votes },
          result: event.result,
        });
        break;
      case "proposal":
        facts.push({
          kind: "proposal",
          id: factId(event),
          provenance,
          missionNumber: event.missionNumber,
          attempt: event.attempt,
          leader: event.leader,
          team: [...event.team],
        });
        break;
      case "lady_announced":
        facts.push({
          kind: "lady_announcement",
          id: factId(event),
          provenance,
          holder: event.holder,
          target: event.target,
          announced: event.announced,
        });
        break;
      case "lady_transferred":
        facts.push({
          kind: "lady_transfer",
          id: factId(event),
          provenance,
          from: event.from,
          to: event.to,
        });
        break;
      case "leader_change":
        facts.push({
          kind: "leader_change",
          id: factId(event),
          provenance,
          from: event.from,
          to: event.to,
          reason: event.reason,
        });
        break;
      case "assassination_target":
        facts.push({
          kind: "assassination_target",
          id: factId(event),
          provenance,
          assassin: event.assassin,
          target: event.target,
        });
        break;
      case "game_end":
        facts.push({
          kind: "game_end",
          id: factId(event),
          provenance,
          winner: event.winner,
          reason: event.reason,
          reveal: { ...event.reveal },
        });
        break;
      default:
        // game_start, opening_direction, lady_assigned, speech: either setup
        // or table talk. Neither is a fact a constraint should cite.
        break;
    }
  }
  return facts;
}

/**
 * Turn the public log into claims. TABLE INPUT ONLY.
 *
 * A Lady announcement appears BOTH here and in `publicFactsFrom`, and that is
 * the point rather than a duplication bug: "seat 9 announced good about seat 6"
 * is a fact, "seat 6 is good" is a claim, and Experiment 3 lost partly because
 * one agent collapsed the two.
 */
export function claimsFrom(log: readonly PublicEvent[]): PublicClaim[] {
  const claims: PublicClaim[] = [];
  const latestRoleClaim = new Map<Seat, number>();

  for (const event of log) {
    if (event.type === "lady_announced") {
      claims.push({
        kind: "lady_claim",
        id: `c${event.sequence}:lady`,
        provenance: { kind: "table-claim", seat: event.holder, sequence: event.sequence },
        seat: event.holder,
        target: event.target,
        announced: event.announced,
      });
      continue;
    }
    if (event.type !== "speech") continue;
    if (event.claim) {
      const previous = latestRoleClaim.get(event.speaker);
      if (previous !== undefined) {
        // A seat that claims again has superseded its earlier claim. Recorded
        // as a retraction rather than by deleting history — the fact that it
        // changed is itself evidence.
        const index = claims.findIndex(
          (c) => c.kind === "role_claim" && c.seat === event.speaker && c.retractedAtSequence === null,
        );
        if (index >= 0) {
          const old = claims[index] as Extract<PublicClaim, { kind: "role_claim" }>;
          claims[index] = { ...old, retractedAtSequence: event.sequence };
        }
      }
      latestRoleClaim.set(event.speaker, event.sequence);
      claims.push({
        kind: "role_claim",
        id: `c${event.sequence}:role`,
        provenance: { kind: "table-claim", seat: event.speaker, sequence: event.sequence },
        seat: event.speaker,
        claimed: event.claim,
        sinceSequence: event.sequence,
        retractedAtSequence: null,
      });
    }
  }
  return claims;
}

/** Private hard facts, straight from the observation. REFEREE INPUT ONLY. */
export function privateFactsFrom(observation: Observation): PrivateHardFacts {
  return {
    seat: observation.seat,
    role: observation.role,
    side: observation.side,
    knowledge: observation.knowledge,
    ladyResults: [...observation.ladyResults],
    // Roster is evil-only by rule (see `observation.ts`). Restated here so a
    // hand-built observation cannot hand a good seat the answer sheet.
    evilRoster:
      observation.side === "evil" && observation.evilRoster
        ? [...observation.evilRoster]
        : null,
    provenance: { kind: "own-role" },
  };
}

/** An empty dossier. The model fills it; the shape is fixed here. */
export function emptyDossier(seat: Seat): SeatDossier {
  return {
    seat,
    claimIds: [],
    proposalIds: [],
    votes: [],
    missionIds: [],
    responses: [],
    contradictions: [],
    votesWith: [],
    evidenceFor: [],
    evidenceAgainst: [],
    standing: "unresolved",
    lastChangedAtSequence: 0,
    lastChangeReason: "",
  };
}

/**
 * Build a ledger from an observation, with the model-owned parts empty.
 *
 * The referee-derived halves are complete and correct at this point; the
 * interpretive halves are blank and stay blank until a model fills them. That
 * split is why a fresh ledger is safe to hand to any seat: it contains exactly
 * what `observationFor` already decided that seat may see.
 */
export function ledgerFrom(observation: Observation, seats: readonly Seat[]): EpistemicLedger {
  const dossiers = {} as Record<Seat, SeatDossier>;
  for (const seat of seats) dossiers[seat] = emptyDossier(seat);

  return deepFreeze({
    schema: LEDGER_SCHEMA,
    seat: observation.seat,
    atSequence: observation.publicLog.length,
    publicFacts: publicFactsFrom(observation.publicLog),
    privateFacts: privateFactsFrom(observation),
    claims: claimsFrom(observation.publicLog),
    claimAssessments: [],
    constraints: [],
    hypotheses: [],
    dossiers,
    self: {
      seat: observation.seat,
      publicCommitments: [],
      rolePlan: "",
      intendedSignal: "",
      coverStory: "",
      claimPlan: "",
      nextTurnPlan: "",
      lastProcessedSequence: 0,
    },
    social: null,
    contest: null,
  });
}

/* ── Update ─────────────────────────────────────────────────────────────── */

/**
 * The only shape a model may write. Note what is ABSENT: there is no field for
 * public facts or private facts, so the type system refuses a model that tries.
 */
export interface CognitionUpdate {
  readonly claimAssessments?: readonly ClaimAssessment[];
  readonly constraints?: readonly DerivedConstraint[];
  readonly hypotheses?: readonly Hypothesis[];
  readonly dossiers?: Partial<Record<Seat, Partial<SeatDossier>>>;
  readonly self?: Partial<Omit<SelfState, "seat">>;
  readonly social?: SocialModel | null;
  readonly contest?: ContestModel | null;
}

/**
 * Apply a model update, re-deriving the referee halves from the observation.
 *
 * Deliberately NOT a merge of two ledgers. The referee-owned halves are
 * rebuilt from the current observation every time, so a stale or tampered
 * interpretation cannot carry an outdated fact forward — the facts are always
 * exactly what the referee says now, and the model's contribution is layered
 * on top rather than mixed in.
 */
export function applyCognitionUpdate(
  previous: EpistemicLedger,
  observation: Observation,
  update: CognitionUpdate,
): EpistemicLedger {
  if (observation.seat !== previous.seat) {
    throw new Error(
      `ledger for ${previous.seat}号 was handed ${observation.seat}号's observation`,
    );
  }

  const dossiers = {} as Record<Seat, SeatDossier>;
  for (const key of Object.keys(previous.dossiers)) {
    const seat = Number(key) as Seat;
    const patch = update.dossiers?.[seat];
    dossiers[seat] = patch
      ? { ...previous.dossiers[seat], ...patch, seat }
      : previous.dossiers[seat];
  }

  return deepFreeze({
    schema: LEDGER_SCHEMA,
    seat: previous.seat,
    atSequence: observation.publicLog.length,
    // Rebuilt, not carried. See the note above.
    publicFacts: publicFactsFrom(observation.publicLog),
    privateFacts: privateFactsFrom(observation),
    claims: claimsFrom(observation.publicLog),
    claimAssessments: update.claimAssessments
      ? [...update.claimAssessments]
      : previous.claimAssessments,
    constraints: update.constraints ? [...update.constraints] : previous.constraints,
    hypotheses: update.hypotheses ? [...update.hypotheses] : previous.hypotheses,
    dossiers,
    self: { ...previous.self, ...update.self, seat: previous.seat },
    social: update.social !== undefined ? update.social : previous.social,
    contest: update.contest !== undefined ? update.contest : previous.contest,
  });
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/**
 * Every bound and every invariant, as a list of violations.
 *
 * Reports rather than throws, so a test naming twelve problems is one failure
 * with twelve lines instead of twelve runs.
 */
export function validateLedger(
  ledger: EpistemicLedger,
  limits: CognitionLimitsV3 = L as unknown as CognitionLimitsV3,
): LimitViolation[] {
  const bad: LimitViolation[] = [];
  const push = (v: readonly LimitViolation[]) => bad.push(...v);

  push(checkCount("claims", ledger.claims.slice(0, L.maxTrackedClaims + 1), L.maxTrackedClaims));
  push(checkCount("constraints", ledger.constraints, L.maxDerivedConstraints));
  push(checkCount("hypotheses", ledger.hypotheses, limits.maxHypotheses));
  // The floor matters as much as the ceiling: a single hypothesis is the
  // premature lock-in the playbook is trying to prevent.
  if (ledger.constraints.length > 0 || ledger.hypotheses.length > 0) {
    push(checkMinCount("hypotheses", ledger.hypotheses, L.minHypotheses));
  }

  for (const constraint of ledger.constraints) {
    push(
      checkChars(
        `constraint[${constraint.id}].statement`,
        constraint.statement,
        L.constraintStatementChars,
      ),
    );
    push(
      checkCount(
        `constraint[${constraint.id}].premises`,
        constraint.premises,
        L.maxPremisesPerConstraint,
      ),
    );
  }

  for (const hypothesis of ledger.hypotheses) {
    push(checkChars(`hypothesis[${hypothesis.id}].label`, hypothesis.label, L.hypothesisLabelChars));
    push(
      checkChars(
        `hypothesis[${hypothesis.id}].rationale`,
        hypothesis.rationale,
        L.hypothesisRationaleChars,
      ),
    );
  }

  for (const key of Object.keys(ledger.dossiers)) {
    const seat = Number(key) as Seat;
    const d = ledger.dossiers[seat];
    push(checkCount(`dossier[${seat}].evidenceFor`, d.evidenceFor, L.evidenceForPerSeat));
    push(checkCount(`dossier[${seat}].evidenceAgainst`, d.evidenceAgainst, L.evidenceAgainstPerSeat));
    push(checkCount(`dossier[${seat}].contradictions`, d.contradictions, L.contradictionsPerSeat));
    push(checkChars(`dossier[${seat}].lastChangeReason`, d.lastChangeReason, L.lastChangeReasonChars));
    for (const [i, e] of d.evidenceFor.entries()) {
      push(checkChars(`dossier[${seat}].evidenceFor[${i}]`, e.text, L.evidenceChars));
    }
    for (const [i, e] of d.evidenceAgainst.entries()) {
      push(checkChars(`dossier[${seat}].evidenceAgainst[${i}]`, e.text, L.evidenceChars));
    }
    for (const [i, e] of d.contradictions.entries()) {
      push(checkChars(`dossier[${seat}].contradictions[${i}]`, e.text, L.contradictionChars));
    }
  }

  const s = ledger.self;
  // The CAP is on what is still binding. A resolved promise stays in the list
  // as history — that is how "did this seat keep its word" stays answerable —
  // but it no longer occupies a slot.
  push(
    checkCount(
      "self.publicCommitments",
      activeCommitments(s.publicCommitments),
      limits.maxPublicCommitments,
    ),
  );
  for (const [i, c] of s.publicCommitments.entries()) {
    push(checkChars(`self.publicCommitments[${i}]`, c.text, L.commitmentChars));
  }
  push(checkChars("self.rolePlan", s.rolePlan, L.rolePlanChars));
  push(checkChars("self.coverStory", s.coverStory, L.coverStoryChars));
  push(checkChars("self.claimPlan", s.claimPlan, L.claimPlanChars));
  push(checkChars("self.intendedSignal", s.intendedSignal, L.intendedSignalChars));
  push(checkChars("self.nextTurnPlan", s.nextTurnPlan, L.nextTurnPlanChars));

  return bad;
}

/** Constraints whose conclusions are only as good as somebody's word. */
export function unverifiedConstraints(ledger: EpistemicLedger): readonly DerivedConstraint[] {
  return ledger.constraints.filter((c) => c.restsOnUnverified);
}

/** A premise reference for a referee fact — the only verified public kind. */
export function premiseFromFact(fact: PublicHardFact, label: string): PremiseRef {
  return { id: fact.id, verified: true, label };
}

/** A premise reference for something somebody said. Never verified. */
export function premiseFromClaim(claim: PublicClaim, label: string): PremiseRef {
  return { id: claim.id, verified: false, label };
}

/** A premise reference for this seat's own role knowledge. Verified, private. */
export function premiseFromOwnRole(label: string): PremiseRef {
  return { id: "own-role", verified: true, label };
}
