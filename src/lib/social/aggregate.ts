/**
 * Turning what people said into something a belief can absorb.
 *
 * The output is a log-likelihood ratio per seat: how much more likely the talk
 * is if that seat is evil than if it is good. That is deliberately the same
 * currency the frozen belief factors already speak, so social evidence enters
 * the posterior the way a vote or a fail card does, rather than being blended
 * into the answer afterwards. The old rollout did the blending, which is why
 * its cue could sharpen a read the leaders never used.
 *
 * This is a REFERENCE aggregator, not part of the interface. A language
 * channel may well want its own; the point of `SocialEvidence` is that it can
 * have one without anything else changing.
 */

import type { SocialEvidence } from "./types";

export interface AggregateOptions {
  /**
   * Per-speaker weight, typically 1 − P(speaker is evil).
   *
   * Talk is not testimony. An accusation from a seat the table already
   * distrusts is worth less, and without this the channel hands evil players a
   * free lever: accuse loudly and the posterior moves.
   */
  credibility?: ReadonlyMap<string, number>;
  /** Log-odds per unit of valence × confidence × credibility. */
  strength?: number;
  /**
   * Multiplier per mission of age.
   *
   * Round-one reads are mostly noise and everyone knows it; by round four the
   * same words mean more. Below 1 this fades old talk rather than letting it
   * accumulate into false certainty.
   */
  decay?: number;
  /** Cap on the absolute log-odds any one seat can accumulate. */
  ceiling?: number;
}

const DEFAULTS = {
  strength: 0.35,
  decay: 0.85,
  ceiling: 2.5,
} as const;

/**
 * Running per-seat log-odds, fed evidence as a game unfolds.
 *
 * Incremental because the alternative — re-reading the whole ledger at every
 * decision — costs a sort per proposal, and a simulator makes millions of
 * them. Absorbing is order-independent, so the two agree.
 */
export class EvilOdds {
  private readonly odds = new Map<string, number>();
  private readonly options: Required<AggregateOptions>;

  constructor(options: AggregateOptions = {}) {
    this.options = {
      credibility: options.credibility ?? new Map(),
      strength: options.strength ?? DEFAULTS.strength,
      decay: options.decay ?? DEFAULTS.decay,
      ceiling: options.ceiling ?? DEFAULTS.ceiling,
    };
  }

  /**
   * Add evidence, aged relative to `now`.
   *
   * `now` is the mission currently being played, so a piece from mission 1
   * absorbed during mission 4 is discounted three rounds' worth. Absorbing the
   * same piece twice double-counts it; callers walk the ledger once.
   *
   * Credibility may be passed per call, because who the table trusts changes
   * as the game goes and the belief that decides it is the caller's.
   */
  absorb(
    evidence: Iterable<SocialEvidence>,
    now: number,
    credibility: ReadonlyMap<string, number> = this.options.credibility,
  ): void {
    const { strength, decay } = this.options;
    for (const one of evidence) {
      const trust = credibility.get(one.speakerId) ?? 1;
      if (trust <= 0) continue;
      const age = Math.max(0, now - one.missionNumber);
      // Negative valence is an accusation, and an accusation is evidence FOR
      // the target being evil — hence the sign flip.
      const delta =
        -one.valence *
        one.confidence *
        trust *
        strength *
        Math.pow(decay, age);
      this.odds.set(one.targetId, (this.odds.get(one.targetId) ?? 0) + delta);
    }
  }

  /** Log-likelihood ratio for this seat being evil, clipped. */
  get(seat: string): number {
    const raw = this.odds.get(seat) ?? 0;
    const { ceiling } = this.options;
    return Math.min(ceiling, Math.max(-ceiling, raw));
  }

  /** Every seat that has been spoken about, clipped. */
  snapshot(): Map<string, number> {
    const out = new Map<string, number>();
    for (const seat of this.odds.keys()) out.set(seat, this.get(seat));
    return out;
  }
}

/** One-shot convenience for harnesses that have the whole ledger already. */
export function evilLogOdds(
  evidence: Iterable<SocialEvidence>,
  now: number,
  options: AggregateOptions = {},
): Map<string, number> {
  const odds = new EvilOdds(options);
  odds.absorb(evidence, now);
  return odds.snapshot();
}
