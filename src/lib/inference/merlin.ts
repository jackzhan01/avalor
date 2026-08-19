/**
 * What Merlin's own eyes imply about which seat he is.
 *
 * The point is not that Merlin behaves differently. It is that he SEES
 * differently, and everything else follows from that. So the features here are
 * derived from his information set rather than from the true assignment: a car
 * is "dirty" to Merlin only if it carries an evil HE can see, and Mordred is
 * not one of them.
 *
 * That distinction is not a theory, it is visible in the corpus. Merlin's
 * approve rate on a car off which he is standing, in games that contain
 * Mordred:
 *
 *     carries an evil he can see        0.332
 *     carries ONLY Mordred              0.651     ← reads as nearly clean
 *     carries no evil at all            0.734
 *
 * A loyal facing those same three cars runs 0.399 / 0.473 / 0.522 — much
 * flatter, because all he has is the table's read. Pooling Mordred in with the
 * other evils, which is what a behaviour-class model does, would score Merlin
 * as suspicious of a car he has no reason to distrust, and then conclude he is
 * not Merlin.
 *
 * The same holds when he leads: he puts a visible evil on his own team at
 * 0.365 of the rate chance would give, against a loyal's 0.712.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import type { Hypothesis } from "./types";

/** Approve rate from outside the car, by what the actor can see on it. */
const MERLIN_VOTE = { seen: 0.332, unseen: 0.651, clean: 0.734 };
/**
 * The baseline this is scored against: an ordinary good player, in the two
 * buckets the side layer can actually tell apart. `tainted` pools seen and
 * unseen because that is all the layer below knows.
 */
const LOYAL_VOTE = { tainted: 0.408, clean: 0.522 };

/** Rides his own car. */
const MERLIN_SELF = 0.906;
const LOYAL_SELF = 0.923;
/** Evils he can see, as a multiple of the rate a blind pick would give. */
const MERLIN_LOADING = 0.365;
const LOYAL_LOADING = 0.712;

/**
 * Shared with the side layer's proposal term, and for the same reason: the
 * choice of team and the reaction to it are two readings of one fact.
 */
const PROPOSAL_SHRINK = 3;

/** log C(n, k). */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let result = 0;
  for (let i = 0; i < k; i++) result += Math.log((n - i) / (i + 1));
  return result;
}

/**
 * Per-seat log-evidence for being Merlin, indexed by which seat holds Mordred.
 *
 * The outer key is the Mordred seat, or "" for a game without him — because
 * "what Merlin can see" is not determined until the role assignment says who
 * Mordred is, and the layer above enumerates exactly that.
 *
 * Values are log-ratios against an ordinary good player, so they compose with
 * the side layer's score rather than replacing it.
 */
export function merlinEvidence(
  events: GameEvent[],
  game: GameRecord,
  hypothesis: Hypothesis,
): Map<string, Map<string, number>> {
  const timeline = deriveTimeline(events, game);
  const goodSeats = game.players
    .map((p) => p.id)
    .filter((id) => !hypothesis.isEvil(id));
  const pool = game.players.length - 1;

  const proposals = timeline.proposalOrder
    .map((id) => timeline.proposalsById.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const out = new Map<string, Map<string, number>>();
  // "" covers a game with no Mordred: everything evil is visible.
  const mordredOptions = ["", ...hypothesis.evil];

  for (const mordred of mordredOptions) {
    const perSeat = new Map<string, number>();
    for (const seat of goodSeats) perSeat.set(seat, 0);

    for (const proposal of proposals) {
      const team = proposal.event.teamPlayerIds;
      const evilsAboard = team.filter((id) => hypothesis.isEvil(id));
      const visibleAboard = evilsAboard.filter((id) => id !== mordred);
      const bucket =
        visibleAboard.length > 0
          ? "seen"
          : evilsAboard.length > 0
            ? "unseen"
            : "clean";
      // What the layer below already charged for this seat's vote.
      const baseKey = evilsAboard.length > 0 ? "tainted" : "clean";

      if (proposal.vote) {
        for (const [seatId, choice] of Object.entries(proposal.vote.votes)) {
          if (choice !== "approve" && choice !== "reject") continue;
          // Aboard, everyone votes their own interest and the roles look alike.
          if (team.includes(seatId)) continue;
          if (!perSeat.has(seatId)) continue;
          const approved = choice === "approve";
          const asMerlin = approved
            ? MERLIN_VOTE[bucket]
            : 1 - MERLIN_VOTE[bucket];
          const asLoyal = approved
            ? LOYAL_VOTE[baseKey]
            : 1 - LOYAL_VOTE[baseKey];
          perSeat.set(seatId, perSeat.get(seatId)! + Math.log(asMerlin / asLoyal));
        }
      }

      const leader = proposal.event.leaderId;
      if (!perSeat.has(leader)) continue;
      const rode = team.includes(leader);
      let delta = Math.log(
        (rode ? MERLIN_SELF : 1 - MERLIN_SELF) /
          (rode ? LOYAL_SELF : 1 - LOYAL_SELF),
      );

      // How many of the evils HE can see he took, against a blind pick.
      const visible = hypothesis.evil.filter((id) => id !== mordred);
      const slots = team.length - (rode ? 1 : 0);
      if (visible.length > 0 && slots > 0 && pool > 0) {
        const chance = slots / pool;
        const qM = Math.min(0.98, MERLIN_LOADING * chance);
        const qL = Math.min(0.98, LOYAL_LOADING * chance);
        const j = visible.filter((id) => team.includes(id)).length;
        const k = visible.length;
        // The binomial coefficient is the same either way and cancels.
        delta +=
          j * Math.log(qM / qL) + (k - j) * Math.log((1 - qM) / (1 - qL));
      }
      perSeat.set(leader, perSeat.get(leader)! + delta / PROPOSAL_SHRINK);
    }

    out.set(mordred, perSeat);
  }

  return out;
}

export { logChoose as _logChoose };
