/**
 * The one and only door between the referee's state and an agent.
 *
 * `observationFor(state, seat)` is the entire information boundary. No other
 * function hands a `GameState` to anything that plays, and the leakage suite
 * exists to prove it: auditing what a language model can see means auditing
 * this file, `visibility.ts`, and nothing else.
 *
 * Three things are excluded here that a careless implementation would include,
 * and each is a real leak rather than a theoretical one:
 *
 *   THE PENDING REQUEST OF ANOTHER SEAT. Mission-card requests only ever go to
 *   evil players — good players are pre-filled by the referee precisely so
 *   they are never offered an illegal choice. So publishing "the referee is
 *   waiting on seat 7 for a mission card" would announce that seat 7 is evil.
 *   `request` is therefore self-only, and null for everyone else.
 *
 *   PENDING VOTES. They are collected one seat at a time for determinism, but
 *   there is no path from an observation to `state.pendingVotes`; the table
 *   learns every vote at once, from the `vote` event.
 *
 *   MISSION CARDS. Not before resolution and not after. The public
 *   `mission_result` carries the count, which is public by rule, and never who
 *   played what.
 *
 * The same discipline the notebook keeps with `isPrivateEvent`, and the same
 * one `publicView` keeps for the rollout: a simulated player reasoning from a
 * posterior that contains somebody else's sight is not playing this game.
 *
 * AN OBSERVATION IS AN IMMUTABLE SNAPSHOT AT ONE SEQUENCE. `readonly` is a
 * compile-time fiction — one cast and an agent could push onto the array it
 * was handed — so the guarantee is enforced at runtime with `Object.freeze`,
 * and it is a real guarantee in two directions:
 *
 *   a retained observation NEVER gains a later event, because every array in
 *   `GameState` grows by replacement rather than mutation (see `freeze.ts`),
 *   so the array this snapshot points at is never written to again;
 *
 *   an attempted write through a cast throws (ES modules are strict mode) and
 *   the authoritative state is untouched either way.
 *
 * That is why the log can be handed over by reference with no copy: it is not
 * shared MUTABLE state, it is a shared immutable value. Copying it at every
 * observation would be O(history) half a million times in the sweep and would
 * buy nothing the freeze does not already give.
 */

import { requiredFails, teamSize } from "@/lib/rules/avalon";
import type { RoleType } from "@/lib/types/game";
import { sideOf } from "./deal";
import type { PublicEvent } from "./events";
import { deepFreeze } from "./freeze";
import type { SpeechTurn } from "./order";
import { seatsUntilLead } from "./order";
import type { GameState, MissionSlot, Phase, TentativeTeam } from "./state";
import { PLAYER_COUNT } from "./types";
import type {
  DecisionRequest,
  LadyResult,
  PlayDirection,
  PrivateKnowledge,
  PrivateMemory,
  RoleClaim,
  Seat,
  Side,
} from "./types";
import { evilRoster, knowledgeFor, type EvilRosterEntry } from "./visibility";
import { coordinationFor, type MissionCoordination } from "./evil-coordination";

/** Everything about WHERE this seat is, as opposed to what it knows. */
export interface PositionView {
  readonly phase: Phase;
  readonly seat: Seat;
  /** Absolute seat numbers of the two neighbours. Fixed for the whole game. */
  readonly leftNeighbor: Seat;
  readonly rightNeighbor: Seat;
  readonly leader: Seat;
  /** Fixed at the opening; null only before the opening leader has chosen. */
  readonly playDirection: PlayDirection | null;

  /** The eleven turns of this attempt: leader, nine others, leader again. */
  readonly speakingOrder: readonly SpeechTurn[];
  readonly speechIndex: number;
  /** Distinct seats that have already spoken this attempt, in turn order. */
  readonly alreadySpoken: readonly Seat[];

  /** Leadership rotations until this seat holds the car. 0 if it already does. */
  readonly seatsUntilILead: number;

  readonly missionNumber: number;
  readonly attempt: number;
  readonly rejectionStreak: number;
  readonly successes: number;
  readonly fails: number;
  readonly missionTrack: readonly MissionSlot[];
  readonly teamSizeThisMission: number;
  readonly failsRequiredThisMission: 1 | 2;

  /** 意向车 floated in speeches this attempt. Not the authoritative team. */
  readonly tentativeTeams: readonly TentativeTeam[];
  /** The authoritative team, once the leader has put it on the table. */
  readonly proposedTeam: readonly Seat[] | null;

  readonly ladyHolder: Seat | null;
  /** Everyone who has ever held the token. Public — the transfers were public. */
  readonly ladyHeldBy: readonly Seat[];
  readonly ladyChecksDone: number;

  readonly standingClaims: readonly RoleClaim[];
}

export interface EvilDiscussionLine {
  readonly sequence: number;
  readonly speaker: Seat;
  readonly message: string;
}

export interface Observation {
  readonly seat: Seat;
  readonly role: RoleType;
  readonly side: Side;

  /** HARD. From the deal, at reveal. Never amendable by anything an agent does. */
  readonly knowledge: PrivateKnowledge;
  /** HARD. What the Lady actually showed THIS seat. Permanent. */
  readonly ladyResults: readonly LadyResult[];

  /** The complete public history, shared by every seat, in sequence order. */
  readonly publicLog: readonly PublicEvent[];
  readonly position: PositionView;

  /**
   * Exact evil roles. Non-null ONLY for an evil seat, and ONLY once the
   * assassination phase has revealed them. Before that nobody — Merlin
   * included — knows any other seat's exact role.
   */
  readonly evilRoster: readonly EvilRosterEntry[] | null;
  /** The evil team's closing discussion. Empty for every good seat, always. */
  readonly evilDiscussion: readonly EvilDiscussionLine[];

  /**
   * The private evil mission-card coordination context. HOUSE CONVENTION.
   *
   * Non-null ONLY for a mutually aware evil seat (Mordred / Morgana /
   * Assassin) that is on the CURRENT proposed team. Null for every good seat,
   * null for Oberon — who is not mutually aware and must not be — and null for
   * an evil seat not riding this mission.
   *
   * It never mentions Oberon, so a designated rider cannot learn from it that
   * a fourth villain is aboard. See `core/evil-coordination.ts` for why the
   * order is fixed and why Oberon's extra fail card is deliberate.
   *
   * RENDERED only under a prompt version that declares `evilCoordination`;
   * the field is populated regardless, so the gate a reader has to check is
   * the capability, not two different code paths.
   */
  readonly missionCoordination: MissionCoordination | null;

  /** SOFT. This seat's own notes, and only its own. */
  readonly memory: PrivateMemory;

  /** What this seat is being asked for right now, or null if it is not its turn. */
  readonly request: DecisionRequest | null;
}

function wrapSeat(n: number): Seat {
  const zeroBased = (((n - 1) % PLAYER_COUNT) + PLAYER_COUNT) % PLAYER_COUNT;
  return (zeroBased + 1) as Seat;
}

function spokenSoFar(order: readonly SpeechTurn[], index: number): Seat[] {
  const out: Seat[] = [];
  for (let i = 0; i < index && i < order.length; i += 1) {
    const seat = order[i].seat;
    if (!out.includes(seat)) out.push(seat);
  }
  return out;
}

/**
 * Build one seat's view of the game.
 *
 * Callable for any seat at any time — the leakage tests sweep all ten after
 * every action — and it never mutates the state. The result is deep-frozen
 * before it is returned; `deepFreeze` stops at anything already frozen, so the
 * walk costs O(what this call built) rather than O(history).
 */
export function observationFor(state: GameState, seat: Seat): Observation {
  const role = state.deal.bySeat[seat];
  const side = sideOf(role);
  const direction = state.playDirection;

  const position: PositionView = {
    phase: state.phase,
    seat,
    leftNeighbor: wrapSeat(seat + 1),
    rightNeighbor: wrapSeat(seat - 1),
    leader: state.leader,
    playDirection: direction,

    speakingOrder: state.speakingOrder,
    speechIndex: state.speechIndex,
    alreadySpoken: spokenSoFar(state.speakingOrder, state.speechIndex),

    seatsUntilILead: direction ? seatsUntilLead(seat, state.leader, direction) : 0,

    missionNumber: state.missionNumber,
    attempt: state.attempt,
    rejectionStreak: state.rejectionStreak,
    successes: state.successes,
    fails: state.fails,
    missionTrack: state.missionTrack,
    teamSizeThisMission: teamSize(PLAYER_COUNT, state.missionNumber),
    failsRequiredThisMission: requiredFails(PLAYER_COUNT, state.missionNumber),

    tentativeTeams: state.tentativeTeams,
    proposedTeam: state.proposedTeam,

    ladyHolder: state.ladyHolder,
    ladyHeldBy: state.ladyHeldBy,
    ladyChecksDone: state.ladyChecks,

    standingClaims: state.standingClaims,
  };

  const isEvil = side === "evil";

  // Gated on BOTH the seat's side and the phase. Either alone would be a leak:
  // an evil seat must not see the roster early, and a good seat must not see
  // it at all.
  const rosterVisible =
    isEvil &&
    state.evilRolesRevealed &&
    (state.phase === "assassination_discuss" ||
      state.phase === "assassination_strike" ||
      state.phase === "terminal");

  const evilDiscussion: EvilDiscussionLine[] = [];
  // Good seats never enter this loop at all, so there is no path by which one
  // could receive an empty-but-present transcript and infer its existence.
  if (isEvil) {
    for (const event of state.privateLog) {
      if (event.type !== "evil_discussion") continue;
      if (!event.audience.includes(seat)) continue;
      evilDiscussion.push({
        sequence: event.sequence,
        speaker: event.speaker,
        message: event.message,
      });
    }
  }

  return deepFreeze({
    seat,
    role,
    side,
    knowledge: knowledgeFor(state.deal, seat),
    // Frozen in the referee when the check was recorded, and replaced rather
    // than appended to, so this snapshot cannot gain a later check.
    ladyResults: state.ladyResults[seat],
    publicLog: state.log,
    position,
    evilRoster: rosterVisible ? evilRoster(state.deal) : null,
    evilDiscussion,
    missionCoordination: state.proposedTeam
      ? coordinationFor({
          deal: state.deal,
          seat,
          team: state.proposedTeam,
          missionNumber: state.missionNumber,
          failsRequired: requiredFails(PLAYER_COUNT, state.missionNumber),
        })
      : null,
    memory: state.memory[seat],
    // Self-only. See the header: a mission-card request names an evil seat.
    request: state.pending && state.pending.seat === seat ? state.pending : null,
  }) as Observation;
}
