/**
 * What the table said, in a form nothing downstream has to guess at.
 *
 * Five rounds of structured work established that the public log — who rode
 * what, who voted how, what came back — cannot reproduce how well real good
 * leaders pick. A leader who spends every bit of that log perfectly still puts
 * evils on his round-five car at 0.565 of chance, where real leaders manage
 * 0.450. The missing information is not missing structure. It is the room.
 *
 * This is the interface for putting the room back. It is deliberately not a
 * model: it says what a piece of social evidence IS, not how to weigh it, so
 * that ratings typed in by hand, structured accusations, a language model
 * reading a transcript, and a synthetic generator for controlled experiments
 * can all populate the same shape and be compared on equal terms.
 *
 * Two properties are load-bearing and must not be optimised away.
 *
 * ACTOR-AWARE. Every piece names who expressed it. A read is not a fact about
 * a seat; it is a claim by one seat about another, and who made it matters as
 * much as what it says.
 *
 * TIME-AWARE. Every piece carries the sequence it landed at, and evidence is
 * only ever read as of a moment. A policy that can see round-five table talk
 * while deciding a round-two car is not modelling a player, and this interface
 * makes that mistake expressible only on purpose.
 *
 * Both are the same discipline the event log already keeps: append-only,
 * ordered by `sequence` and never by wall-clock, and never overwritten.
 */

/** Where a piece of evidence came from. Kept so channels can be ablated. */
export type SocialSource =
  /** A 1-5 stance the user typed into the notebook. */
  | "rating"
  /** A structured support/accusation the user recorded as an event. */
  | "claim"
  /** Extracted from dialogue by a language model. */
  | "dialogue"
  /** Generated for a controlled experiment. */
  | "synthetic";

/**
 * One seat's expressed stance toward another, at one moment.
 *
 * `valence` runs -1 (hardest accusation) to +1 (strongest defence), with 0
 * meaning an explicit "cannot read them" — which is NOT the same as silence.
 * Silence is the absence of a record, exactly as in the notebook, where a
 * blank cell and a recorded 3 are different facts.
 */
export interface SocialEvidence {
  /** Ordering. Same clock as the event log: monotonic, never reused. */
  readonly sequence: number;
  readonly missionNumber: number;
  readonly proposalNumber?: number;
  /** The seat expressing it. */
  readonly speakerId: string;
  /** The seat it is about. Never equal to `speakerId`. */
  readonly targetId: string;
  /** -1 accusation to +1 defence. */
  readonly valence: number;
  /**
   * How much this reading itself should be trusted, 0 to 1.
   *
   * Separate from `valence` on purpose. A model that is sure someone sounded
   * mildly suspicious is a different claim from one that is unsure whether
   * they sounded very suspicious, and collapsing the two loses the difference
   * exactly where a language channel is least reliable.
   */
  readonly confidence: number;
  readonly source: SocialSource;
  /**
   * Which seats could observe this. `null` means the whole table.
   *
   * Almost all table talk is public, so `null` is the common case. The field
   * exists because whispered reads, side conversations and anything a future
   * private channel produces must not silently become common knowledge.
   */
  readonly audience: readonly string[] | null;
}

/** Could this seat have observed this? */
export function visibleTo(evidence: SocialEvidence, seat: string): boolean {
  return evidence.audience === null || evidence.audience.includes(seat);
}

/**
 * An append-only store of social evidence, read as of a moment.
 *
 * The only way to get evidence out is to say who is looking and when, which
 * is what keeps the information boundary from leaking by accident.
 */
export class SocialLedger {
  private readonly entries: SocialEvidence[] = [];

  add(evidence: SocialEvidence): void {
    if (evidence.speakerId === evidence.targetId) {
      throw new Error("social evidence cannot point at its own speaker");
    }
    this.entries.push(evidence);
  }

  addAll(evidence: Iterable<SocialEvidence>): void {
    for (const one of evidence) this.add(one);
  }

  /** Everything, in sequence order. For export and for tests, not for policies. */
  all(): readonly SocialEvidence[] {
    return [...this.entries].sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * What `seat` could have observed at or before `upTo`.
   *
   * A policy must go through here. Passing a sequence from later in the game
   * is the one way to cheat with this interface, and it has to be written down
   * to happen.
   */
  observedBy(seat: string, upTo: number): SocialEvidence[] {
    return this.entries
      .filter((e) => e.sequence <= upTo && visibleTo(e, seat))
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** What the whole table could have observed at or before `upTo`. */
  publicUpTo(upTo: number): SocialEvidence[] {
    return this.entries
      .filter((e) => e.sequence <= upTo && e.audience === null)
      .sort((a, b) => a.sequence - b.sequence);
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * A source of social evidence for one game.
 *
 * Implementations are free to be a lookup over recorded events, a call into a
 * language model, or a random number generator. Nothing downstream may care
 * which, which is the whole point of naming the shape before building any of
 * them.
 */
export interface SocialChannel {
  readonly name: string;
  readonly source: SocialSource;
  /** Everything this channel produces for the game, already time-stamped. */
  evidence(): Iterable<SocialEvidence>;
}
