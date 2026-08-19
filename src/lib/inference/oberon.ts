/**
 * What Oberon's blindness implies about which evil seat he is.
 *
 * He knows exactly one thing the others do not have to reason about: he is
 * evil. What he does NOT know is who his teammates are — and they do not know
 * him either. So his likelihoods must not condition on the evil composition of
 * a team, because that is precisely the fact he cannot observe.
 *
 * The corpus shows the blindness directly. Off the car, in games containing
 * him, approve rate by whether the car actually carried another evil:
 *
 *                    carried one   carried none   difference
 *   Oberon              0.449         0.475         0.026
 *   ordinary evil       0.433         0.415        -0.018
 *   loyal               0.384         0.496         0.112
 *
 * The loyal swings on the table's read; the ordinary evil swings the other way
 * on having a teammate aboard. Oberon is flat. That flatness IS the signature,
 * and it is why his rate here is a single number rather than one per bucket:
 * two nearly-equal buckets would still encode a dependence he does not have.
 *
 * Two more, both his own decisions rather than reactions:
 *
 *   riding a car he is on      0.762 against an ordinary evil's 0.705 — it is
 *                              the only car he KNOWS carries an evil.
 *   leading, other evils on
 *   his team, against chance   0.779 against an ordinary evil's 0.726 and a
 *                              loyal's 0.697 — he avoids them least of anyone,
 *                              because he cannot see them to avoid.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import type { Hypothesis } from "./types";
import { evilOnTeam } from "./hypotheses";

/** One rate, not two: he cannot see what would separate them. */
const OBERON_OFF = 0.459;
const OBERON_ABOARD = 0.762;
/** The ordinary evil he is being told apart from, measured on the same games. */
const EVIL_OFF = { dirty: 0.433, clean: 0.415 };
const EVIL_ABOARD = 0.705;

const OBERON_SELF = 0.85;
const EVIL_SELF = 0.865;
const OBERON_LOADING = 0.779;
const EVIL_LOADING = 0.726;

/** Shared with the side layer's proposal term, for the same reason. */
const PROPOSAL_SHRINK = 3;

/**
 * Per-evil-seat log-evidence for being Oberon, against an ordinary evil.
 *
 * One map per world rather than per casting: which evil seat is Oberon does
 * not change what any OTHER seat could see, so unlike Merlin's Mordred there
 * is nothing here that depends on the rest of the assignment.
 */
export function oberonEvidence(
  events: GameEvent[],
  game: GameRecord,
  hypothesis: Hypothesis,
): Map<string, number> {
  const timeline = deriveTimeline(events, game);
  const pool = game.players.length - 1;
  const out = new Map<string, number>();
  for (const seat of hypothesis.evil) out.set(seat, 0);

  for (const proposalId of timeline.proposalOrder) {
    const proposal = timeline.proposalsById.get(proposalId);
    if (!proposal) continue;
    const team = proposal.event.teamPlayerIds;
    const evilAboard = evilOnTeam(hypothesis, team);

    if (proposal.vote) {
      for (const [seatId, choice] of Object.entries(proposal.vote.votes)) {
        if (choice !== "approve" && choice !== "reject") continue;
        const current = out.get(seatId);
        if (current === undefined) continue;
        const approved = choice === "approve";
        const aboard = team.includes(seatId);

        const asOberon = aboard ? OBERON_ABOARD : OBERON_OFF;
        // What the layer below charged: an evil who CAN see his teammates.
        const asEvil = aboard
          ? EVIL_ABOARD
          : evilAboard - (aboard ? 1 : 0) > 0
            ? EVIL_OFF.dirty
            : EVIL_OFF.clean;

        out.set(
          seatId,
          current +
            Math.log(
              (approved ? asOberon : 1 - asOberon) /
                (approved ? asEvil : 1 - asEvil),
            ),
        );
      }
    }

    const leader = proposal.event.leaderId;
    const current = out.get(leader);
    if (current === undefined) continue;
    const rode = team.includes(leader);
    let delta = Math.log(
      (rode ? OBERON_SELF : 1 - OBERON_SELF) /
        (rode ? EVIL_SELF : 1 - EVIL_SELF),
    );

    const rest = hypothesis.evil.filter((id) => id !== leader);
    const slots = team.length - (rode ? 1 : 0);
    if (rest.length > 0 && slots > 0 && pool > 0) {
      const chance = slots / pool;
      const qO = Math.min(0.98, OBERON_LOADING * chance);
      const qE = Math.min(0.98, EVIL_LOADING * chance);
      const j = rest.filter((id) => team.includes(id)).length;
      delta +=
        j * Math.log(qO / qE) +
        (rest.length - j) * Math.log((1 - qO) / (1 - qE));
    }
    out.set(leader, current + delta / PROPOSAL_SHRINK);
  }

  return out;
}
