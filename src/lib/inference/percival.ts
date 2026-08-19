/**
 * What Percival's pair implies about which seat he is.
 *
 * His information set is not a set of evils, it is an unordered PAIR: one of
 * these two is Merlin and the other is Morgana, and he cannot tell which. So
 * everything here is a function of HOW MANY of the pair are on a team, never
 * of which one — which is what makes the model symmetric in the pair by
 * construction rather than by a correction applied afterwards. Any preference
 * between the two seats has to arrive from public behaviour scored elsewhere.
 *
 * The corpus shows the pair logic directly. Off the car, approve rate:
 *
 *                        Percival   a loyal facing the same car
 *   neither candidate      0.433      0.439
 *   exactly one            0.451      0.415
 *   both                   0.250      0.347
 *
 * Both aboard means Morgana is certainly aboard, and he rejects far harder
 * than the table does. Exactly one he trusts slightly MORE than the table —
 * he knows that seat is a coin flip between Merlin and Morgana rather than an
 * unknown, and the other candidate is accounted for.
 *
 * As leader it is sharper, and strategic:
 *
 *   takes neither           0.228      0.312
 *   takes exactly one       0.706      0.605
 *   takes both              0.066      0.083
 *
 * He deliberately takes exactly one. It is a hedge worth naming: a 50% chance
 * of carrying Merlin, and if the quest fails he has learned which of the two
 * is Morgana.
 *
 * Every number below is a RATIO against a loyal in the same bucket, so the
 * shared part — the table's read, which the side layer already charged for —
 * cancels, and only the pair effect is added.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";


type Bucket = "none" | "one" | "both";

/** Approve rate from off the car, by how many of the pair it carries. */
const PERCIVAL_VOTE: Record<Bucket, number> = {
  none: 0.433,
  one: 0.451,
  both: 0.25,
};
/** A loyal facing the same car. The ratio of the two is the pair effect. */
const LOYAL_VOTE: Record<Bucket, number> = {
  none: 0.439,
  one: 0.415,
  both: 0.347,
};

/** P(Percival's team lands in this bucket) / P(a loyal's does). */
const LEAD_RATIO: Record<Bucket, number> = {
  none: 0.228 / 0.312,
  one: 0.706 / 0.605,
  both: 0.066 / 0.083,
};

/** Shared with the side layer's proposal term, for the same reason. */
const PROPOSAL_SHRINK = 3;

const bucketOf = (count: number): Bucket =>
  count === 0 ? "none" : count === 1 ? "one" : "both";

/**
 * Per-seat log-evidence for being Percival, indexed by the candidate pair.
 *
 * The key is the two seats sorted, because the pair is unordered to him: a
 * casting that swaps Merlin and Morgana between those seats gives Percival
 * exactly the same observation, and must give the same evidence.
 */
/**
 * Per-seat log-evidence for being Percival, for EVERY unordered pair of seats.
 *
 * Computed once per game rather than once per hypothesis, because it does not
 * depend on one: how many of a pair are aboard is a fact about the team, not
 * about who is evil. The caller looks up the pair its casting happens to name.
 * At ten seats that is 45 pairs instead of 45 recomputed inside each of 210
 * worlds.
 *
 * The key is the two seats sorted, because the pair is unordered to him: a
 * casting that swaps Merlin and Morgana between those seats gives Percival the
 * same observation, and must give the same evidence.
 */
export function percivalEvidence(
  events: GameEvent[],
  game: GameRecord,
): Map<string, Map<string, Map<string, number>>> {
  const timeline = deriveTimeline(events, game);
  const seats = game.players.map((p) => p.id);

  const proposals = timeline.proposalOrder
    .map((id) => timeline.proposalsById.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  // Nested rather than keyed by a joined string: this is looked up once per
  // legal casting, 151,200 times in a ten-player game, and building a key
  // there cost more than the lookup. Both orders point at the SAME inner map,
  // which is the symmetry made structural.
  const out = new Map<string, Map<string, Map<string, number>>>();
  const put = (a: string, b: string, value: Map<string, number>) => {
    let row = out.get(a);
    if (!row) out.set(a, (row = new Map()));
    row.set(b, value);
  };

  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i];
      const b = seats[j];
      const perSeat = new Map<string, number>();
      // Percival cannot be one of the two he is looking at.
      for (const seat of seats) if (seat !== a && seat !== b) perSeat.set(seat, 0);

      for (const proposal of proposals) {
        const team = proposal.event.teamPlayerIds;
        const bucket = bucketOf(
          (team.includes(a) ? 1 : 0) + (team.includes(b) ? 1 : 0),
        );

        if (proposal.vote) {
          for (const [seatId, choice] of Object.entries(proposal.vote.votes)) {
            if (choice !== "approve" && choice !== "reject") continue;
            if (team.includes(seatId)) continue;
            const current = perSeat.get(seatId);
            if (current === undefined) continue;
            // Whichever way the vote went, against a loyal facing the same
            // car — so the shared table read cancels and only the pair shows.
            const approved = choice === "approve";
            const asPercival = approved
              ? PERCIVAL_VOTE[bucket]
              : 1 - PERCIVAL_VOTE[bucket];
            const asLoyal = approved
              ? LOYAL_VOTE[bucket]
              : 1 - LOYAL_VOTE[bucket];
            perSeat.set(seatId, current + Math.log(asPercival / asLoyal));
          }
        }

        const leader = proposal.event.leaderId;
        const current = perSeat.get(leader);
        if (current === undefined) continue;
        perSeat.set(
          leader,
          current + Math.log(LEAD_RATIO[bucket]) / PROPOSAL_SHRINK,
        );
      }

      put(a, b, perSeat);
      put(b, a, perSeat);
    }
  }

  return out;
}
