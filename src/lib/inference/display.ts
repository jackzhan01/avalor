/**
 * Turning a posterior into something readable on a 63px circle.
 *
 * Modelled on how a go engine reports itself: EVERY point gets a number, all
 * the time. An earlier version of this file hid any figure that hadn't moved
 * far enough from the baseline, on the theory that a flat table was noise.
 * That was wrong in a specific way worth recording, because it is a mistake
 * this kind of feature invites:
 *
 *   "Everyone is 40%" IS information. It says the record cannot yet separate
 *   these seats — which is a real, useful, hard-won fact. Blanking it doesn't
 *   remove noise, it removes an answer and leaves the user unable to tell
 *   "no information" apart from "not computed". The app already refuses to
 *   conflate those two states everywhere else (空白 ≠ 中立); this layer has no
 *   business reintroducing the confusion.
 *
 * What DOES need care is the anchor. A go player knows 50% is even; nobody
 * knows offhand that a 9-player Avalon table starts at 33%. So the baseline
 * governs COLOUR rather than visibility: seats near where they started stay
 * neutral grey, and only genuine departure earns red or green. The number is
 * always there; the paint is what's earned.
 */

import { evilCount } from "@/lib/rules/avalon";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, RoleType } from "@/lib/types/game";
import type { RoleInference, SideInference } from "./types";

/**
 * How much confidence a seat needs before it is worth COLOURING.
 *
 * Gates paint only — the number is printed either way, so "12%" still appears,
 * just in grey. Keeps the eye off differences too small to act on without
 * hiding them.
 */
export const MIN_CONFIDENCE = 0.12;

export interface SeatSignal {
  /**
   * HOW SURE, not "chance of being evil".
   *
   * The distinction came out of a real misreading: a seat proven good showed
   * "0%", which reads as "nothing known" when it is in fact the strongest
   * statement available. Pairing the number with a direction fixes it — green
   * 100% is "certainly good", red 100% is "certainly evil", and grey 0% is the
   * genuinely empty case. As a bonus the scale now has a real zero: 0% means
   * "you have learned nothing about this seat", which is exactly true at the
   * start of a game and no longer looks like a verdict.
   */
  text: string;
  /** Which way the confidence points. */
  direction: "evil" | "good" | "none";
  /** 0…1. Distance from "knowing nothing" toward certainty. */
  confidence: number;
  /** Set only when the seat is that side in EVERY surviving world. */
  proven: "evil" | "good" | null;
  /** Below this the seat is drawn grey — a hint too faint to point anywhere. */
  significant: boolean;
}

const NOTHING: SeatSignal = {
  text: "—",
  direction: "none",
  confidence: 0,
  proven: null,
  significant: false,
};

/** The share of the table that is evil — where every seat starts. */
export function baselineEvil(game: GameRecord): number {
  return evilCount(game.playerCount) / game.playerCount;
}

export function seatSignal(
  side: SideInference,
  game: GameRecord,
  playerId: string,
): SeatSignal {
  if (side.contradictory) return NOTHING;
  // The weighted estimate is what gets shown — it is the one that moves when
  // people vote, which is most of what happens in a game. Proofs are read off
  // the unweighted count, so certainty never rests on an assumption.
  const weighted = side.evilProbability.get(playerId);
  const counted = side.evilFrequency.get(playerId);
  if (weighted === undefined || counted === undefined) return NOTHING;

  // Proof comes from the count; the figure shown comes from the weights. They
  // are already snapped to agree exactly at 0 and 1 in `side.ts`.
  const proven = counted === 1 ? "evil" : counted === 0 ? "good" : null;
  const p = weighted;

  const base = baselineEvil(game);
  const departure = p - base;
  // Normalised against the room left in that direction, so "half way from the
  // baseline to certainty" reads the same whatever the table size.
  const lean =
    departure >= 0
      ? base < 1
        ? departure / (1 - base)
        : 0
      : base > 0
        ? departure / base
        : 0;

  const confidence = Math.abs(lean);
  // A seat sitting exactly on the baseline computes to a lean of ~1e-17 rather
  // than 0, because 1/3 is not representable in binary — enough to make an
  // untouched table claim a direction it has no basis for.
  const EPSILON = 1e-9;
  return {
    text: `${Math.round(confidence * 100)}%`,
    direction:
      confidence < EPSILON ? "none" : lean > 0 ? "evil" : "good",
    confidence,
    proven,
    significant: confidence >= MIN_CONFIDENCE,
  };
}

/**
 * "How likely is THIS seat to be THIS role."
 *
 * A different question from the side signal, and reported differently on
 * purpose. Sides are two-directional — certainly-good is as useful as
 * certainly-evil. A role is one-directional: knowing someone is probably NOT
 * Merlin is worth almost nothing, since almost nobody is. So this returns the
 * probability straight, with no baseline subtraction and no notion of leaning
 * the other way.
 */
export function roleSignal(
  roles: RoleInference,
  role: RoleType,
  playerId: string,
): { text: string; probability: number } | null {
  if (roles.contradictory) return null;
  const p = roles.byRole.get(role)?.get(playerId);
  if (p === undefined) return null;
  return { text: `${Math.round(p * 100)}%`, probability: p };
}

/**
 * Why a role read is still flat — because "17% each" is a real answer and the
 * UI should say which kind of nothing it is.
 *
 * A user hit exactly this: round four, plenty recorded, every seat still at
 * 17%, and no way to tell a broken feature from an honest "cannot say". The
 * engine already knows which it is, so withholding that was the actual defect.
 *
 * The distinction that matters most here is the third one. Merlin gives
 * himself away by WAVING CLEAN CARS THROUGH — that is his strong tell
 * (likelihood ratio 1.36 against a loyal follower), while his behaviour on a
 * dirty car is nearly indistinguishable (0.91). So when every car so far has
 * carried an evil, he has never had the chance to show his hand, and no amount
 * of further recording will change that until a clean car goes up. Telling the
 * user "keep recording" there would be a lie; the honest line names the
 * missing ingredient.
 */
export type FlatReason =
  | { kind: "confident" }
  | { kind: "no_votes" }
  | { kind: "no_clean_car" }
  | { kind: "votes_uninformative" }
  | { kind: "not_applicable" };

export function explainFlatRole(
  roles: RoleInference,
  side: SideInference,
  events: GameEvent[],
  game: GameRecord,
  role: RoleType,
): FlatReason {
  if (roles.contradictory) return { kind: "not_applicable" };
  // Only the sighted roles are read off behaviour at all; for the others a
  // flat spread is simply what the rules leave over, not a missing ingredient.
  if (role !== "merlin" && role !== "percival") return { kind: "not_applicable" };
  const bits = roles.entropyByRole.get(role);
  if (bits === undefined) return { kind: "not_applicable" };

  const row = roles.byRole.get(role);
  if (!row) return { kind: "not_applicable" };
  const live = [...row.values()].filter((p) => p > 0.0001);
  if (live.length === 0) return { kind: "not_applicable" };
  // Flat = entropy within a whisker of uniform over the live candidates.
  const uniform = Math.log2(live.length);
  if (bits < uniform - 0.12) return { kind: "confident" };

  // Which ingredient is missing? Judged on the most likely world, which is all
  // the user is being shown anyway.
  const best = side.surviving[0];
  if (!best) return { kind: "not_applicable" };

  let offSeatVotes = 0;
  let cleanCars = 0;
  const timeline = deriveTimeline(events, game);
  for (const id of timeline.proposalOrder) {
    const proposal = timeline.proposalsById.get(id);
    if (!proposal?.vote) continue;
    const team = proposal.event.teamPlayerIds;
    if (!team.some((seat) => best.isEvil(seat))) cleanCars += 1;
    for (const [playerId, choice] of Object.entries(proposal.vote.votes)) {
      if (choice !== "approve" && choice !== "reject") continue;
      if (!team.includes(playerId)) offSeatVotes += 1;
    }
  }

  if (offSeatVotes === 0) return { kind: "no_votes" };
  if (cleanCars === 0) return { kind: "no_clean_car" };
  return { kind: "votes_uninformative" };
}

/** The same, as the sentence shown under the table. */
export function flatReasonText(reason: FlatReason, role: RoleType): string | null {
  const name = role === "merlin" ? "梅林" : "派";
  switch (reason.kind) {
    case "no_votes":
      return `还没记票型 —— ${name}是靠投票暴露的，记了才认得出`;
    case "no_clean_car":
      return `每辆车都有坏人 —— ${name}是靠「放行干净车」暴露的，等一辆干净车上去才看得出`;
    case "votes_uninformative":
      return `票型还看不出差别 —— 大家投得太一致`;
    default:
      return null;
  }
}

/**
 * One line of context, and it carries more weight than it looks.
 *
 * A bare "17%" in green is genuinely ambiguous — the colour says "leans good"
 * while the number counts the opposite thing, and a real user read it as "only
 * 17% good" rather than "17% likely to be evil". Both halves therefore have to
 * be stated: WHAT the number counts, and WHERE the neutral point sits (33% here
 * is what 50% is on a go board).
 */
export function summarise(side: SideInference, game: GameRecord): string {
  if (side.contradictory) {
    return "记录里有矛盾 —— 没有任何身份组合能同时满足";
  }
  const anchor = `数字＝是坏人的可能，平均 ${Math.round(baselineEvil(game) * 100)}%`;
  if (side.surviving.length === 1) return `只剩一种可能了（${anchor}）`;
  if (side.surviving.length === side.total) {
    return `${side.total} 种可能，还没排除任何一种 · ${anchor}`;
  }
  return `${side.total} → 还剩 ${side.surviving.length} 种 · ${anchor}`;
}
