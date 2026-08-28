/**
 * Ten ledgers, one per seat, and no way to hand one to the wrong seat.
 *
 * The isolation is not a convention here — `LedgerStore.for(seat)` is the only
 * accessor, it stamps the seat into every ledger it returns, and `update()`
 * refuses an observation whose seat disagrees. A caller that wanted to give
 * seat 3 seat 7's memory would have to construct a ledger by hand and then
 * defeat `applyCognitionUpdate`'s own seat check.
 *
 * WHY A STORE RATHER THAN A FIELD ON THE AGENT. Checkpoint and resume. The
 * agent is rebuilt from scratch on a resume; the memory has to outlive it, and
 * it has to serialise into the checkpoint deterministically so that a resumed
 * game continues from the same ten minds rather than ten blank ones.
 *
 * WHAT IS SERIALISED. Only the model-owned halves. The referee halves are
 * re-derived from the observation on every access, exactly as
 * `applyCognitionUpdate` does — a checkpoint that stored facts could carry a
 * stale one forward, and a stale fact is worse than an absent one.
 */

import { deepFreeze } from "../core/freeze";
import type { Observation } from "../core/observation";
import { SEATS, type Seat } from "../core/types";
import {
  applyCognitionUpdate,
  emptyDossier,
  ledgerFrom,
  type ClaimAssessment,
  type DerivedConstraint,
  type EpistemicLedger,
  type Hypothesis,
  type SeatDossier,
  type SelfState,
} from "./ledger";
import type { ContestModel } from "./contest";
import type { SocialModel } from "./social";

/** Bumped when the persisted shape changes. Read by the checkpoint parser. */
/**
 * Bumped to @2 for the social model.
 *
 * A checkpoint written by @1 has no `social` field, and `restore` fills one in
 * rather than refusing — a paused `prompt-0.3.0` game must still resume, and it
 * never had a social model to lose. Refusing would strand a real artifact to
 * enforce a distinction that does not exist for it.
 */
export const LEDGER_STATE_SCHEMA = "avalon-ledger-state@3";
/** What earlier checkpoints say. Accepted, and upgraded on read. */
export const LEDGER_STATE_SCHEMA_V1 = "avalon-ledger-state@1";
export const LEDGER_STATE_SCHEMA_V2 = "avalon-ledger-state@2";
/** Every shape this version will restore from. */
export const ACCEPTED_LEDGER_SCHEMAS: readonly string[] = [
  LEDGER_STATE_SCHEMA,
  LEDGER_STATE_SCHEMA_V2,
  LEDGER_STATE_SCHEMA_V1,
];

/** The model-owned slice of one seat's ledger. The only part worth storing. */
export interface SeatCognitionState {
  readonly seat: Seat;
  readonly claimAssessments: readonly ClaimAssessment[];
  readonly constraints: readonly DerivedConstraint[];
  readonly hypotheses: readonly Hypothesis[];
  readonly dossiers: Readonly<Record<Seat, SeatDossier>>;
  readonly self: SelfState;
  /** Null on `prompt-0.3.0`, where nothing ever writes one. */
  readonly social: SocialModel | null;
  /** Null before `prompt-0.4.0`, where nothing ever writes one. */
  readonly contest: ContestModel | null;
}

export interface CognitionStoreState {
  readonly schema: typeof LEDGER_STATE_SCHEMA;
  readonly seats: readonly SeatCognitionState[];
}

/**
 * Per-seat persistent cognition.
 *
 * Deliberately holds only the model-owned slice, and rebuilds the full ledger
 * on demand from whatever observation is current. That is what makes a
 * resumed game continue from the same minds AND the same facts: the minds come
 * from here, the facts come from the referee, and neither can substitute for
 * the other.
 */
export class CognitionStore {
  private readonly state = new Map<Seat, SeatCognitionState>();

  constructor(restore?: CognitionStoreState) {
    for (const seat of SEATS) this.state.set(seat, blank(seat));
    if (restore) this.restore(restore);
  }

  /**
   * The seat's ledger, as of this observation.
   *
   * Facts always current, memory always this seat's own. Throws rather than
   * returning an empty ledger for an unknown seat, because a silent blank
   * would look like an agent that simply had nothing to remember.
   */
  for(observation: Observation): EpistemicLedger {
    const seat = observation.seat;
    const mine = this.state.get(seat);
    if (!mine) throw new Error(`no cognition state for ${seat}号`);

    const base = ledgerFrom(observation, SEATS);
    return applyCognitionUpdate(base, observation, {
      claimAssessments: mine.claimAssessments,
      constraints: mine.constraints,
      hypotheses: mine.hypotheses,
      dossiers: mine.dossiers,
      self: mine.self,
      social: mine.social ?? null,
      contest: mine.contest ?? null,
    });
  }

  /** Store the model-owned half of a ledger this seat produced. */
  put(ledger: EpistemicLedger): void {
    if (!this.state.has(ledger.seat)) {
      throw new Error(`cannot store cognition for unknown seat ${ledger.seat}`);
    }
    this.state.set(
      ledger.seat,
      deepFreeze({
        seat: ledger.seat,
        claimAssessments: [...ledger.claimAssessments],
        constraints: [...ledger.constraints],
        hypotheses: [...ledger.hypotheses],
        dossiers: { ...ledger.dossiers },
        self: { ...ledger.self },
        social: ledger.social,
        contest: ledger.contest,
      }),
    );
  }

  /** Deterministic: seats in ascending order, always. */
  export(): CognitionStoreState {
    return deepFreeze({
      schema: LEDGER_STATE_SCHEMA,
      seats: SEATS.map((seat) => this.state.get(seat) ?? blank(seat)),
    });
  }

  private restore(saved: CognitionStoreState): void {
    const version = String(saved.schema);
    if (!ACCEPTED_LEDGER_SCHEMAS.includes(version)) {
      throw new Error(
        `认知状态 schema 是 ${version}，这个版本只认 ${ACCEPTED_LEDGER_SCHEMAS.join(" / ")}`,
      );
    }
    for (const entry of saved.seats) {
      if (!SEATS.includes(entry.seat)) {
        throw new Error(`认知状态里有非法座位 ${String(entry.seat)}`);
      }
      // Re-stamped rather than trusted: a hand-edited checkpoint must not be
      // able to file seat 7's memory under seat 3.
      // `social` fills in rather than being required: an @1 checkpoint has none
      // and never could have. Re-stamping the seat is the part that matters.
      this.state.set(
        entry.seat,
        deepFreeze({
          ...entry,
          seat: entry.seat,
          social: entry.social ?? null,
          contest: entry.contest ?? null,
        }),
      );
    }
  }

  /** Whether any seat has written anything. Used by telemetry and tests. */
  isEmpty(): boolean {
    return SEATS.every((seat) => {
      const s = this.state.get(seat);
      return (
        !s ||
        (s.constraints.length === 0 &&
          s.hypotheses.length === 0 &&
          s.social === null &&
          s.contest === null &&
          s.self.lastProcessedSequence === 0)
      );
    });
  }
}

function blank(seat: Seat): SeatCognitionState {
  const dossiers = {} as Record<Seat, SeatDossier>;
  for (const other of SEATS) dossiers[other] = emptyDossier(other);
  return deepFreeze({
    seat,
    claimAssessments: [],
    constraints: [],
    hypotheses: [],
    dossiers,
    self: {
      seat,
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

/* ── Telemetry ──────────────────────────────────────────────────────────── */

/** Per-field utilisation, for calibrating limits after the first pilot. */
export interface CognitionUtilisation {
  readonly seat: Seat;
  readonly constraints: number;
  readonly unverifiedConstraints: number;
  readonly hypotheses: number;
  readonly dossierEntries: number;
  readonly commitments: number;
  readonly maxEvidenceChars: number;
  readonly maxConstraintChars: number;
  readonly rolePlanChars: number;
  /* ── Social, 0.3.1 only. Zero on the older stack, which writes none. ──── */
  readonly focalCandidates: number;
  readonly unverifiedFocalReads: number;
  readonly alignmentStance: string | null;
  readonly followsSeat: number | null;
  readonly coalitionSize: number;
  /* ── Claim contest, 0.4.0 only. ──────────────────────────────────────── */
  readonly ownClaimStatus: string | null;
  readonly claimantAssessments: number;
  readonly unverifiedClaimReads: number;
  readonly rivalPlans: number;
  readonly claimAct: string | null;
  readonly contestStance: string | null;
}

const contentLength = (text: string) => [...text].filter((ch) => !/\s/.test(ch)).length;

export function utilisationOf(ledger: EpistemicLedger): CognitionUtilisation {
  const evidence = SEATS.flatMap((seat) => {
    const d = ledger.dossiers[seat];
    return d ? [...d.evidenceFor, ...d.evidenceAgainst] : [];
  });
  return {
    seat: ledger.seat,
    constraints: ledger.constraints.length,
    unverifiedConstraints: ledger.constraints.filter((c) => c.restsOnUnverified).length,
    hypotheses: ledger.hypotheses.length,
    dossierEntries: evidence.length,
    commitments: ledger.self.publicCommitments.filter((c) => c.withdrawnAtSequence === null).length,
    maxEvidenceChars: Math.max(0, ...evidence.map((e) => contentLength(e.text))),
    maxConstraintChars: Math.max(0, ...ledger.constraints.map((c) => contentLength(c.statement))),
    rolePlanChars: contentLength(ledger.self.rolePlan),
    focalCandidates: ledger.social?.focalCandidates.length ?? 0,
    unverifiedFocalReads:
      ledger.social?.focalCandidates.filter((f) => f.restsOnUnverified).length ?? 0,
    alignmentStance: ledger.social?.alignment?.stance ?? null,
    followsSeat: ledger.social?.alignment?.focalSeat ?? null,
    coalitionSize: ledger.social?.coalitionPlan?.coordinateWith.length ?? 0,
    ownClaimStatus: ledger.contest?.ownClaimStrategy?.currentStatus ?? null,
    claimantAssessments: ledger.contest?.claimantAssessments.length ?? 0,
    unverifiedClaimReads:
      ledger.contest?.claimantAssessments.filter((a) => a.restsOnUnverified).length ?? 0,
    rivalPlans: ledger.contest?.rivalPlans.length ?? 0,
    claimAct: ledger.contest?.publicClaimMove?.act ?? null,
    contestStance: ledger.contest?.alignment?.stance ?? null,
  };
}
