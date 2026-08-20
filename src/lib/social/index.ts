/**
 * Social evidence. Import from here, not from the files beneath.
 *
 * What the table said, in a shape that does not care who or what produced it —
 * a rating tapped into the notebook, a lady-of-the-lake announcement, a
 * language model reading a transcript, or a generator with a quality dial.
 *
 * Nothing in this directory knows about beliefs, particles or policies. The
 * consumer decides how to weigh evidence; this only says what evidence is, who
 * expressed it, who could hear it, and when.
 */

export type { SocialEvidence, SocialChannel, SocialSource } from "./types";
export { SocialLedger, visibleTo } from "./types";
export { EvilOdds, evilLogOdds, type AggregateOptions } from "./aggregate";
export { socialFromEvents, recordedChannel, valenceOfRating } from "./from-events";
export { syntheticChannel, syntheticRound, type SyntheticOptions } from "./synthetic";
