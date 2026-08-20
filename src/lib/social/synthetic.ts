/**
 * A table that talks, with a dial on how well it reads people.
 *
 * This exists to answer one question before any language model is built: how
 * good would the room have to be for a simulated table to pick cars the way a
 * real one does? The public log tops out at 0.565 evil loading on round five
 * where real leaders reach 0.450, so SOME amount of extra information is
 * needed. Sweeping a synthetic channel says how much, in a unit that a later
 * real channel can be measured against.
 *
 * The generator is deliberately crude and deliberately honest about it. Good
 * seats get a noisy true signal; evil seats know exactly who their teammates
 * are and shade their stances to protect them. Nobody's stance depends on
 * anything they could not know.
 */

import type { SocialChannel, SocialEvidence } from "./types";

export interface SyntheticOptions {
  seats: readonly string[];
  /** Ground truth, used ONLY to generate what people say — never read back. */
  evilSeats: ReadonlySet<string>;
  /**
   * How well a good seat reads the room, 0 to 1.
   *
   * The correlation between a stance and the truth. At 0 the table is talking
   * noise; at 1 everyone is Merlin. This is the dial the study sweeps.
   *
   * An array gives one value per round, because a real table does not read
   * strangers on the opening car as well as it reads them on the fifth.
   */
  quality: number | readonly number[];
  /**
   * How hard an evil seat works to protect a teammate, 0 to 1.
   *
   * Kept separate from `quality` because the two are not the same knob: a
   * table can be perceptive and its evils clumsy, or the reverse.
   */
  deception?: number;
  /** Stances per speaker per round. Fewer than n-1 means they pick favourites. */
  perRound?: number;
  rng: () => number;
}

function normal(rng: () => number): number {
  // Box-Muller. The tail matters here: a table's worst read of the game is
  // usually the one that decides it.
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const clamp = (x: number) => Math.min(1, Math.max(-1, x));

/**
 * Stances for one round.
 *
 * Sequence numbers are `round * 1000 + index`, which keeps them ordered and
 * well clear of any real event log they might sit beside.
 */
export function syntheticRound(
  round: number,
  options: SyntheticOptions,
): SocialEvidence[] {
  const { seats, evilSeats, rng } = options;
  const quality = Array.isArray(options.quality)
    ? (options.quality[Math.min(round, options.quality.length) - 1] ?? 0)
    : (options.quality as number);
  const deception = options.deception ?? 0.6;
  const perRound = options.perRound ?? seats.length - 1;
  const out: SocialEvidence[] = [];
  let index = 0;

  for (const speaker of seats) {
    const speakerEvil = evilSeats.has(speaker);
    const targets = seats.filter((s) => s !== speaker);
    // Who they choose to talk about is itself uninformative here; a real
    // channel would have plenty to say about it.
    for (let i = targets.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [targets[i], targets[j]] = [targets[j], targets[i]];
    }

    for (const target of targets.slice(0, perRound)) {
      const targetEvil = evilSeats.has(target);
      // +1 for good, -1 for evil: the direction an accurate stance points.
      const truth = targetEvil ? -1 : 1;

      let valence: number;
      let confidence: number;
      if (speakerEvil) {
        // He knows. He shades toward defending his own and accusing the rest,
        // damped so he is not simply an inverted oracle.
        valence = clamp(-deception * truth + Math.sqrt(1 - deception * deception) * normal(rng) * 0.5);
        confidence = 0.5 + 0.2 * rng();
      } else {
        // Quality is the correlation with truth; the rest is noise.
        valence = clamp(
          quality * truth + Math.sqrt(Math.max(0, 1 - quality * quality)) * normal(rng) * 0.6,
        );
        confidence = 0.4 + 0.3 * Math.abs(valence);
      }

      out.push({
        sequence: round * 1000 + index,
        missionNumber: round,
        speakerId: speaker,
        targetId: target,
        valence,
        confidence,
        source: "synthetic",
        audience: null,
      });
      index += 1;
    }
  }

  return out;
}

export function syntheticChannel(
  options: SyntheticOptions & { rounds?: number },
): SocialChannel {
  const rounds = options.rounds ?? 5;
  return {
    name: `synthetic q=${JSON.stringify(options.quality)}`,
    source: "synthetic",
    *evidence() {
      for (let r = 1; r <= rounds; r += 1) yield* syntheticRound(r, options);
    },
  };
}
