/**
 * The notebook already records social evidence. This reads it out.
 *
 * Two event types are speaker-about-target claims and so map straight onto the
 * interface:
 *
 *   opinion     the 1-5 stance the user taps in, which is the whole point of
 *               the app and the reason this branch is worth anything at all
 *   lady_check  what the holder ANNOUNCED, which is a public claim and may be
 *               a lie — never what they actually saw, which is private and
 *               lives in the role_mark layer
 *
 * role_claim is left out on purpose. "I am Percival" is a claim about oneself,
 * not a stance toward another seat, and forcing it into speaker/target would
 * make it mean something it does not.
 *
 * Nothing here touches the private layer. A role_mark is what the USER knows,
 * not what the table was told, and mixing the two would put the answer into
 * the evidence.
 */

import type { GameEvent } from "@/lib/types/events";
import type { SocialChannel, SocialEvidence } from "./types";

/**
 * A recorded 1-5 stance, as a valence.
 *
 * 3 is an explicit "cannot read them" and maps to 0 — a real observation of no
 * lean. An unrecorded pair produces nothing at all, which is the difference
 * the whole data model is built around.
 */
export function valenceOfRating(rating: number): number {
  return (rating - 3) / 2;
}

/**
 * How much a stance is worth as evidence, before anything downstream weighs it.
 *
 * A recorded 3 says the speaker looked and saw nothing, which is worth
 * recording and worth almost nothing as evidence — so confidence tracks how
 * far from neutral the claim is, and valence carries the direction.
 */
function confidenceOfRating(rating: number): number {
  return 0.4 + 0.15 * Math.abs(rating - 3);
}

export function socialFromEvents(events: readonly GameEvent[]): SocialEvidence[] {
  const out: SocialEvidence[] = [];

  for (const event of events) {
    if (event.type === "opinion") {
      out.push({
        sequence: event.sequence,
        missionNumber: event.missionNumber,
        proposalNumber: event.proposalNumber,
        speakerId: event.speakerId,
        targetId: event.targetId,
        valence: valenceOfRating(event.rating),
        confidence: confidenceOfRating(event.rating),
        source: "rating",
        audience: null,
      });
      continue;
    }

    if (event.type === "lady_check") {
      // "unknown" means the holder said nothing we caught. That is an absence
      // of a claim, not a neutral one.
      if (event.announced === "unknown") continue;
      out.push({
        sequence: event.sequence,
        missionNumber: event.missionNumber,
        proposalNumber: event.proposalNumber,
        speakerId: event.holderId,
        targetId: event.targetId,
        valence: event.announced === "good" ? 1 : -1,
        // Louder than any rating: it is a formal declaration the table will
        // hold them to. Still not certain — holders lie.
        confidence: 0.9,
        source: "claim",
        audience: null,
      });
    }
  }

  return out.sort((a, b) => a.sequence - b.sequence);
}

/** The notebook itself, as a channel. */
export function recordedChannel(events: readonly GameEvent[]): SocialChannel {
  return {
    name: "recorded",
    source: "rating",
    evidence: () => socialFromEvents(events),
  };
}
