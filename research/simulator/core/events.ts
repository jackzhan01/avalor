/**
 * The two event streams, and why there have to be two.
 *
 * The public log is the game as the table saw it. Every seat receives all of
 * it, always, and it is the only history a prompt renders. The private log is
 * what the referee showed to somebody in particular — a Lady result, the evil
 * team's final reveal, their closing discussion — and each entry names its
 * audience.
 *
 * This mirrors the notebook's own discipline: `PRIVATE_TYPES` and
 * `isPrivateEvent` in `src/lib/types/events.ts` exist so the private layer can
 * be stripped whole, because "5号说3号是坏人" and "我知道3号是坏人" sitting in
 * one undifferentiated stream would make any downstream analysis look
 * brilliant while actually reading the answers. Same reasoning, same shape.
 *
 * ORDERING is by `sequence` only. There is no timestamp field anywhere in
 * either stream, which is a stronger version of the repo rule that timestamps
 * are display-only: here they do not exist, so they cannot be sorted by.
 */

import type { RoleType } from "@/lib/types/game";
import type { LadySide, PlayDirection, Seat, Side, SpeechSlot, Stance } from "./types";

export interface EventBase {
  /** Per-game counter: starts at 1, monotonic, never reused, never renumbered. */
  readonly sequence: number;
  readonly missionNumber: number;
  /** Which proposal attempt within the mission, 1-based. */
  readonly attempt: number;
}

export type PublicEvent = EventBase &
  (
    | {
        readonly type: "game_start";
        readonly playerCount: 10;
        /** Which roles are in the deck. NOT who holds them. */
        readonly rolesInPlay: readonly RoleType[];
        readonly initialLeader: Seat;
        /**
         * NOTE the absence of a seed.
         *
         * The seed plus this code deterministically produces the deal, so a
         * seed sitting in the opening event would let anyone holding the public
         * replay reconstruct every role before reading the final reveal — which
         * is exactly the ordering guarantee the public artifact is supposed to
         * make. The seed lives in the private research trace instead.
         */
      }
    | {
        readonly type: "opening_direction";
        readonly leader: Seat;
        readonly ladySide: LadySide;
        readonly playDirection: PlayDirection;
        readonly ladyHolder: Seat;
        readonly publicMessage: string;
      }
    | { readonly type: "lady_assigned"; readonly holder: Seat }
    | {
        readonly type: "speech";
        readonly speaker: Seat;
        readonly slot: SpeechSlot;
        readonly publicMessage: string;
        /** 意向车. A speech act; the authoritative team is the `proposal` event. */
        readonly tentativeTeam: readonly Seat[] | null;
        readonly noTeamYet: boolean;
        readonly claim: RoleType | null;
        /**
         * Present, and true, only on a speech that withdrew a standing claim.
         *
         * Absent otherwise — including on every speech in every game played
         * before this field existed, which is what keeps those replays
         * byte-identical.
         */
        readonly retractClaim?: boolean;
        readonly stances: readonly Stance[];
      }
    | { readonly type: "proposal"; readonly leader: Seat; readonly team: readonly Seat[] }
    | {
        readonly type: "vote";
        /** Every seat, revealed at once. Never written before all ten are in. */
        readonly votes: Readonly<Record<Seat, "approve" | "reject">>;
        readonly approvals: number;
        readonly result: "passed" | "rejected";
      }
    | {
        readonly type: "mission_result";
        readonly team: readonly Seat[];
        readonly result: "success" | "fail";
        /**
         * How many fail cards came back. Public by rule.
         *
         * WHO played them is not, and no event carries that: the referee's
         * `missionCards` never leaves the referee.
         */
        readonly failCount: number;
      }
    | {
        readonly type: "leader_change";
        readonly from: Seat;
        readonly to: Seat;
        readonly reason: "rejection" | "mission";
      }
    | {
        readonly type: "lady_announced";
        readonly holder: Seat;
        readonly target: Seat;
        /** What the holder SAID. May be a lie; the truth is in the private log. */
        readonly announced: Side;
        readonly publicMessage: string;
      }
    | { readonly type: "lady_transferred"; readonly from: Seat; readonly to: Seat }
    | {
        readonly type: "assassination_target";
        readonly assassin: Seat;
        readonly target: Seat;
      }
    | {
        readonly type: "game_end";
        readonly winner: Side;
        readonly reason: GameEndReason;
        /** The only place the full deal is ever public. */
        readonly reveal: Readonly<Record<Seat, RoleType>>;
      }
  );

export type PublicEventType = PublicEvent["type"];

export type GameEndReason =
  | "missions_evil"
  | "rejection_limit"
  | "assassin_hit"
  | "assassin_missed";

/**
 * Private events. Each names exactly who may see it.
 *
 * `audience` is a list rather than a single seat because the evil reveal and
 * the assassination discussion are heard by four seats. The same field exists
 * on the repo's `SocialEvidence` for the same reason, and with the same
 * meaning: absence from the list means it did not happen, as far as you know.
 */
export type PrivateEvent = EventBase &
  (
    | {
        readonly type: "lady_result";
        readonly audience: readonly Seat[];
        readonly holder: Seat;
        readonly target: Seat;
        /** The truth. Permanent. Never amendable by anything an agent submits. */
        readonly trueSide: Side;
      }
    | {
        readonly type: "evil_reveal";
        readonly audience: readonly Seat[];
        readonly roster: readonly { readonly seat: Seat; readonly role: RoleType }[];
      }
    | {
        readonly type: "evil_discussion";
        readonly audience: readonly Seat[];
        readonly speaker: Seat;
        readonly message: string;
      }
  );

export type PrivateEventType = PrivateEvent["type"];

export const PRIVATE_EVENT_TYPES: readonly PrivateEventType[] = [
  "lady_result",
  "evil_reveal",
  "evil_discussion",
];

/**
 * A public event must never carry a private type.
 *
 * Trivial, and worth having as a function so the invariant test reads as an
 * assertion about the design rather than about a string literal.
 */
export function isPrivateType(type: string): type is PrivateEventType {
  return (PRIVATE_EVENT_TYPES as readonly string[]).includes(type);
}
