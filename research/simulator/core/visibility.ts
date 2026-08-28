/**
 * What the deal legally shows each seat. The single definition.
 *
 * Two implementations of this already exist in the repository and they agree
 * with each other: `visionFor()` in `src/lib/rules/avalon.ts` (which tells the
 * notebook how many seats the user should be pointing at) and
 * `informationSets()` in `src/lib/decision/rollout.ts` (which builds the same
 * thing for a simulated player). This is a third, written here because
 * importing the second would pull the frozen decision graph into a research
 * tool — and `visibility.equivalence.test.ts` pins it against that second one
 * so the three cannot drift.
 *
 * The four asymmetries that make ten-player Avalon what it is, all of which
 * have a test:
 *
 *   OBERON is evil, sees nobody, and is seen by nobody on his own side.
 *   MORDRED is invisible to Merlin but fully visible to his teammates.
 *   PERCIVAL gets a pair and cannot tell which of the two is Merlin.
 *   NOBODY, before the assassination phase, learns another seat's exact role.
 *
 * That last one is why `PrivateKnowledge` has no variant carrying a role for
 * another seat. It is not a rule someone has to remember; it is unrepresentable.
 */

import type { RoleType } from "@/lib/types/game";
import type { Deal } from "./deal";
import { sideOf } from "./deal";
import type { PrivateKnowledge, Seat, Side } from "./types";

const ascending = (seats: readonly Seat[]): Seat[] => [...seats].sort((a, b) => a - b);

/**
 * The one function that reads the deal on a seat's behalf.
 *
 * Everything an agent is ever told about anyone else's identity flows through
 * here or through a Lady result. Auditing information leakage therefore means
 * auditing two functions, not a whole codebase.
 */
export function knowledgeFor(deal: Deal, seat: Seat): PrivateKnowledge {
  const role = deal.bySeat[seat];

  if (role === "merlin") {
    // Every evil except Mordred. At this table that is Morgana, the Assassin
    // and Oberon — Oberon included, which surprises people: he is hidden from
    // his own side, not from Merlin.
    const seen = deal.evilSeats.filter((s) => s !== deal.mordred);
    return { kind: "sees_evil", seats: ascending(seen) };
  }

  if (role === "percival") {
    const pair = ascending([deal.merlin, deal.morgana]);
    // Sorted, so the pair carries no ordering information whatsoever. Swapping
    // which of the two holds Merlin must produce an identical observation.
    return { kind: "merlin_or_morgana", pair: [pair[0], pair[1]] as const };
  }

  if (role === "morgana" || role === "mordred" || role === "assassin") {
    // The mutual-recognition circle, minus Oberon, minus yourself. Sides only:
    // which of the other two is the Assassin is not knowledge this seat has
    // until the assassination phase.
    const teammates = deal.evilSeats.filter(
      (s) => s !== seat && s !== deal.oberon,
    );
    return { kind: "knows_teammates", seats: ascending(teammates) };
  }

  // Loyal servants and Oberon.
  return { kind: "none" };
}

/** Which side a seat is actually on. Referee-only; never handed to an agent. */
export function sideOfSeat(deal: Deal, seat: Seat): Side {
  return sideOf(deal.bySeat[seat]);
}

export interface EvilRosterEntry {
  readonly seat: Seat;
  readonly role: RoleType;
}

/**
 * The exact evil role assignment, revealed to the evil team and to nobody else.
 *
 * Legal ONLY in the assassination phase. Before that the three
 * mutually-recognising villains know each other as "evil" and no more, and
 * Oberon does not know them at all. `observationFor` gates this on the phase;
 * this function only formats it.
 */
export function evilRoster(deal: Deal): EvilRosterEntry[] {
  return ascending(deal.evilSeats).map((seat) => ({
    seat,
    role: deal.bySeat[seat],
  }));
}

/**
 * A stable, human-readable rendering of a seat's hard knowledge.
 *
 * Used by the swap-invariance test, and later by the prompt's KNOWLEDGE layer.
 * It exists so that "Percival's view is identical under a Merlin/Morgana swap"
 * can be asserted on the exact bytes an agent would receive rather than on a
 * structural equality that a renderer might undo.
 */
export function renderKnowledge(knowledge: PrivateKnowledge): string {
  switch (knowledge.kind) {
    case "none":
      return "你的身份没有给你任何关于别人的信息。";
    case "sees_evil":
      return `你看到这些座位是坏人：${knowledge.seats.join("、")}号。你看不到他们各自的具体身份。`;
    case "knows_teammates":
      return `你的队友是：${knowledge.seats.join("、")}号。你不知道他们各自的具体身份。`;
    case "merlin_or_morgana":
      return `你看到 ${knowledge.pair.join("、")}号 这两个人，其中一个是梅林，另一个是莫甘娜，你分不清谁是谁。`;
  }
}
