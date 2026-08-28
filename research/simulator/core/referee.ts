/**
 * The referee. It owns the rules, and it REJECTS.
 *
 * That is the one place this differs sharply from the app's own fold,
 * `deriveTimeline`, which is written for a human keeping notes at a real table
 * and therefore warns but never blocks — people mistype, and losing their
 * record would be worse than storing an odd one. Here an illegal action is
 * either a bug in an agent or a malformed model output, and accepting it would
 * silently produce games that are not this game. So every rule below throws,
 * and throws BEFORE writing anything: a rejected action leaves the state
 * exactly where it stood, so a caller can repair a malformed output and retry
 * without the game having half-moved.
 *
 * Everything the rulebook already states is imported from
 * `src/lib/rules/avalon.ts` rather than restated: team sizes 3/4/4/5/5, two
 * fail cards on the fourth quest, five rejections handing the game to evil,
 * three quests to win. A second copy of those tables would be a second source
 * of truth, and the first thing to drift.
 *
 * The state machine, in one place:
 *
 *   setup → reveal → opening_direction
 *     ↓
 *   ┌ discussion (10 speeches + the leader's close-and-propose) → vote ─┐
 *   │                                     │                             │
 *   │            rejected → next leader ──┘                             │
 *   │            passed → mission → resolve ────────────────────────────┘
 *   │                                       ↓
 *   │                    fails = 3 → terminal (evil)  ←─────────────────┐
 *   │                    lady due after quest 2/3/4 → lady_select        │
 *   │                                                → lady_announce     │
 *   │                    successes = 3 → assassination_reveal            │
 *   │                                     → assassination_discuss        │
 *   │                                     → assassination_strike         │
 *   └──────────────── otherwise, next quest ←───────────────────────────┘
 *
 *   five consecutive rejections → terminal (evil)
 *
 * Two orderings that are easy to get wrong and each have a test: a Lady check
 * owed after the quest that produced good's THIRD success happens BEFORE the
 * assassination; and evil reaching three failures ends the game at once, so a
 * check owed after that quest never happens.
 */

import { requiredFails, teamSize } from "@/lib/rules/avalon";
import { EVIL_ROLES, GOOD_ROLES, type RoleType } from "@/lib/types/game";
import type { SimConfig } from "../config/load";
import { loadConfig } from "../config/load";
import { setupFromSeed, sideOf, type Deal } from "./deal";
import { newGameId, type GameId } from "./game-id";
import type { GameEndReason, PrivateEvent, PublicEvent } from "./events";
import { deepFreeze, EMPTY, frozenAppend, frozenList } from "./freeze";
import {
  buildSpeakingOrder,
  directionForLadySide,
  isSeat,
  ladyHolderForSide,
  nextSeat,
} from "./order";
import { createState, rolesInPlay, type GameState, type MissionSlot } from "./state";
import { evilRoster } from "./visibility";
import {
  IllegalActionError,
  PLAYER_COUNT,
  SEATS,
  type Action,
  type Belief,
  type DecisionRequest,
  type PrivateMemoryPatch,
  type Seat,
  type Side,
  type Stance,
} from "./types";

const ALL_ROLES: readonly RoleType[] = [...GOOD_ROLES, ...EVIL_ROLES];

/* ── Speech length ─────────────────────────────────────────────────────── */

const WHITESPACE = /\s/u;

/**
 * Non-whitespace Unicode characters.
 *
 * Code points, not UTF-16 units, so an emoji or a rare CJK character counts
 * once rather than twice — otherwise the budget would silently differ by
 * script, which is a strange thing for a rule to do. Whitespace is free
 * because padding a speech with newlines is not saying more.
 *
 * Only `publicMessage` is measured. Structured fields (a tentative team, a
 * stance list, a claim, a memory patch) are not speech and do not compete with
 * it for room.
 */
export function speechLength(text: string): number {
  let n = 0;
  // Iterating the string yields code points, not UTF-16 units.
  for (const char of text) {
    if (!WHITESPACE.test(char)) n += 1;
  }
  return n;
}

function requireWithinSpeechLimit(state: GameState, text: string, what: string): void {
  if (typeof text !== "string") {
    throw new IllegalActionError("bad_value", `${what} 必须是字符串`);
  }
  const limit = state.config.limits.speechCharLimit;
  const length = speechLength(text);
  if (length > limit) {
    // Rejected, never truncated: a clipped speech is a different speech, and
    // silently rewriting what a player said would corrupt the transcript the
    // whole experiment is about.
    throw new IllegalActionError(
      "speech_too_long",
      `${what} 有 ${length} 个非空白字符，上限是 ${limit}`,
    );
  }
}

/* ── Small validators ──────────────────────────────────────────────────── */

function requireSeat(value: unknown, what: string): Seat {
  if (!isSeat(value)) {
    throw new IllegalActionError("bad_seat", `${what} 不是合法座位：${String(value)}`);
  }
  return value;
}

function requireDistinctSeats(seats: readonly unknown[], what: string): Seat[] {
  if (!Array.isArray(seats)) {
    throw new IllegalActionError("bad_value", `${what} 必须是数组`);
  }
  const out: Seat[] = [];
  const seen = new Set<Seat>();
  for (const raw of seats) {
    const seat = requireSeat(raw, what);
    if (seen.has(seat)) {
      throw new IllegalActionError("duplicate_seat", `${what} 里 ${seat}号 出现了两次`);
    }
    seen.add(seat);
    out.push(seat);
  }
  return out;
}

/** The authoritative car: exact size for this quest, distinct real seats. */
function requireLegalTeam(state: GameState, raw: readonly unknown[]): Seat[] {
  const size = teamSize(PLAYER_COUNT, state.missionNumber);
  const team = requireDistinctSeats(raw, "上车名单");
  if (team.length !== size) {
    throw new IllegalActionError(
      "bad_team_size",
      `第 ${state.missionNumber} 轮要 ${size} 个人上车，给了 ${team.length} 个`,
    );
  }
  return team;
}

function requireUnit(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IllegalActionError("bad_value", `${what} 必须是有限数`);
  }
  return value;
}

function validateStances(stances: readonly Stance[] | undefined, speaker: Seat): void {
  if (!stances) return;
  if (!Array.isArray(stances)) {
    throw new IllegalActionError("bad_value", "stances 必须是数组");
  }
  for (const stance of stances) {
    const seat = requireSeat(stance?.seat, "stance.seat");
    if (seat === speaker) {
      throw new IllegalActionError("bad_seat", "不能给自己表态");
    }
    const valence = requireUnit(stance.valence, "stance.valence");
    const confidence = requireUnit(stance.confidence, "stance.confidence");
    if (valence < -1 || valence > 1) {
      throw new IllegalActionError("bad_value", "valence 必须在 -1 到 1 之间");
    }
    if (confidence < 0 || confidence > 1) {
      throw new IllegalActionError("bad_value", "confidence 必须在 0 到 1 之间");
    }
  }
}

function validateBeliefs(beliefs: readonly Belief[] | undefined): void {
  if (!beliefs) return;
  if (!Array.isArray(beliefs)) {
    throw new IllegalActionError("bad_value", "beliefs 必须是数组");
  }
  for (const belief of beliefs) {
    requireSeat(belief?.seat, "belief.seat");
    const p = requireUnit(belief.pEvil, "belief.pEvil");
    if (p < 0 || p > 1) {
      throw new IllegalActionError("bad_value", "pEvil 必须在 0 到 1 之间");
    }
  }
}

/**
 * Check a memory patch WITHOUT applying it.
 *
 * Called before any case-specific mutation, because `applyAction` promises
 * that a rejected action leaves the state exactly as it was. Validating the
 * patch at the point of application instead meant a malformed one could throw
 * after the vote had already been recorded — half a move, and a caller
 * repairing the output would then submit the rest of it twice.
 */
function validateMemoryPatch(patch: PrivateMemoryPatch | undefined): void {
  if (!patch) return;
  validateBeliefs(patch.beliefs);
  for (const field of ["intentions", "commitments"] as const) {
    const lines = patch[field];
    if (lines === undefined) continue;
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
      throw new IllegalActionError("bad_value", `${field} 必须是字符串数组`);
    }
  }
}

/**
 * Apply an agent's edit to its OWN memory, and nothing else.
 *
 * There is no branch here that could touch `ladyResults`, the deal, or another
 * seat's memory — which is the type-level separation between hard knowledge
 * and soft belief made operational. A persona that becomes convinced a seat is
 * good cannot overwrite what the Lady of the Lake actually showed, because no
 * code path exists that would let it.
 */
function applyMemoryPatch(
  state: GameState,
  seat: Seat,
  patch: PrivateMemoryPatch | undefined,
): void {
  if (!patch) return;
  const current = state.memory[seat];
  state.memory[seat] = deepFreeze({
    version: current.version + 1,
    beliefs: patch.beliefs ? [...patch.beliefs] : current.beliefs,
    intentions: patch.intentions ? [...patch.intentions] : current.intentions,
    commitments: patch.commitments ? [...patch.commitments] : current.commitments,
    lastUpdatedSequence: state.sequence,
  });
}

/* ── Emitting ──────────────────────────────────────────────────────────── */

/**
 * Omit that distributes over a union.
 *
 * Plain `Omit` on a union collapses it to the keys every member shares — here
 * that would leave nothing but `type`, and every emit call would fail an
 * excess-property check. The notebook's `EventPatch` hit exactly this and
 * carries the same helper, as does `rollout.ts`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type EventMeta = "sequence" | "missionNumber" | "attempt";
type PublicBody = DistributiveOmit<PublicEvent, EventMeta>;
type PrivateBody = DistributiveOmit<PrivateEvent, EventMeta>;

/**
 * Append one public event.
 *
 * `frozenAppend` builds a NEW frozen array rather than pushing. That is what
 * lets an observation hand the log out by reference: the array a retained
 * observation points at is never written to again, so it can never gain a
 * future event. See `freeze.ts`.
 */
function emit(state: GameState, body: PublicBody): void {
  state.sequence += 1;
  state.log = frozenAppend(state.log, {
    ...body,
    sequence: state.sequence,
    missionNumber: state.missionNumber,
    attempt: state.attempt,
  } as PublicEvent);
}

function emitPrivate(state: GameState, body: PrivateBody): void {
  state.sequence += 1;
  state.privateLog = frozenAppend(state.privateLog, {
    ...body,
    sequence: state.sequence,
    missionNumber: state.missionNumber,
    attempt: state.attempt,
  } as PrivateEvent);
}

/** Every pending request is frozen, because observations hand it out directly. */
function setPending(state: GameState, request: DecisionRequest): void {
  state.pending = deepFreeze(request);
}

/* ── Lady eligibility ──────────────────────────────────────────────────── */

/**
 * Who the current holder may examine.
 *
 * Two separate rules, kept as two separate filters because they are two
 * separate rules: you cannot examine yourself, and you cannot examine anyone
 * who has ever held the token. The holder is always in `ladyHeldBy`, so the
 * first filter is technically redundant — and kept, because a future change to
 * how the chain is recorded should not silently legalise self-examination.
 */
export function eligibleLadyTargets(state: GameState): Seat[] {
  const holder = state.ladyHolder;
  if (holder === null) return [];
  return SEATS.filter((seat) => seat !== holder && !state.ladyHeldBy.includes(seat));
}

/* ── Phase transitions ─────────────────────────────────────────────────── */

function startAttempt(state: GameState): void {
  if (state.playDirection === null) throw new Error("play direction not chosen yet");
  state.speakingOrder = frozenList(buildSpeakingOrder(state.leader, state.playDirection));
  state.speechIndex = 0;
  state.tentativeTeams = EMPTY;
  state.proposedTeam = null;
  state.pendingVotes = {};
  state.phase = "discussion";
}

function endGame(
  state: GameState,
  winner: Side,
  reason: GameEndReason,
  assassinTarget: Seat | null = null,
): void {
  emit(state, {
    type: "game_end",
    winner,
    reason,
    // The one and only place the deal becomes public.
    reveal: { ...state.deal.bySeat },
  });
  state.outcome = deepFreeze({ winner, reason, assassinTarget });
  state.phase = "terminal";
  state.pending = null;
}

function resolveVote(state: GameState): void {
  const votes = {} as Record<Seat, "approve" | "reject">;
  let approvals = 0;
  for (const seat of SEATS) {
    const choice = state.pendingVotes[seat];
    if (choice === undefined) throw new Error(`resolveVote with seat ${seat} missing`);
    votes[seat] = choice;
    if (choice === "approve") approvals += 1;
  }
  // Strict majority. At ten seats 5-5 is a rejection, which is the rule and
  // also what `rollout.ts` implements as `approvals * 2 > seats.length`.
  const passed = approvals * 2 > PLAYER_COUNT;

  emit(state, {
    type: "vote",
    votes,
    approvals,
    result: passed ? "passed" : "rejected",
  });
  state.pendingVotes = {};

  if (passed) {
    state.rejectionStreak = 0;
    startMissionPhase(state);
    return;
  }

  state.rejectionStreak += 1;
  if (state.rejectionStreak >= 5) {
    endGame(state, "evil", "rejection_limit");
    return;
  }

  const from = state.leader;
  state.leader = nextSeat(state.leader, state.playDirection!);
  emit(state, { type: "leader_change", from, to: state.leader, reason: "rejection" });
  state.attempt += 1;
  startAttempt(state);
}

/**
 * Enter the quest, filling in the good players' cards without asking them.
 *
 * A loyal servant has no legal choice — the rules do not let good fail a
 * quest — so being asked would present an illegal option, and a model shown an
 * illegal option will eventually take it. Only evil seats aboard get a
 * request.
 */
function startMissionPhase(state: GameState): void {
  const team = state.proposedTeam;
  if (!team) throw new Error("mission phase with no team");
  state.missionCards = {};
  for (const seat of team) {
    if (sideOf(state.deal.bySeat[seat]) === "good") state.missionCards[seat] = "success";
  }
  state.phase = "mission";
}

function resolveMission(state: GameState): void {
  const team = state.proposedTeam;
  if (!team) throw new Error("resolveMission with no team");

  let failCount = 0;
  for (const seat of team) {
    if (state.missionCards[seat] === "fail") failCount += 1;
  }
  const need = requiredFails(PLAYER_COUNT, state.missionNumber);
  const result: "success" | "fail" = failCount >= need ? "fail" : "success";

  emit(state, {
    type: "mission_result",
    team: [...team],
    result,
    // The count is public by rule; WHO played each card is not, and no event
    // carries it. `missionCards` never leaves the referee.
    failCount,
  });

  const track: MissionSlot[] = [...state.missionTrack];
  track[state.missionNumber - 1] = result;
  state.missionTrack = frozenList(track);
  if (result === "success") state.successes += 1;
  else state.fails += 1;

  state.missionCards = {};
  state.proposedTeam = null;
  state.rejectionStreak = 0;

  // Evil reaching three failures ends it at once — before any Lady check that
  // would otherwise have been owed.
  if (state.fails >= 3) {
    endGame(state, "evil", "missions_evil");
    return;
  }

  // A check is owed after quests two, three and four. Which means a check owed
  // after the quest that produced good's third success runs BEFORE the
  // assassination — the game is not over until Merlin has survived it.
  const ladyDue =
    state.missionNumber >= 2 && state.missionNumber <= 4 && state.ladyChecks < 3;
  if (ladyDue && state.ladyHolder !== null) {
    state.phase = "lady_select";
    return;
  }

  afterLady(state);
}

function afterLady(state: GameState): void {
  if (state.successes >= 3) {
    state.phase = "assassination_reveal";
    return;
  }
  state.missionNumber += 1;
  state.attempt = 1;
  const from = state.leader;
  state.leader = nextSeat(state.leader, state.playDirection!);
  emit(state, { type: "leader_change", from, to: state.leader, reason: "mission" });
  startAttempt(state);
}

/* ── The driver ────────────────────────────────────────────────────────── */

/**
 * Run every referee-only transition until an action is required, or the game
 * is over. Sets `state.pending` and returns.
 */
function advance(state: GameState): void {
  for (let guard = 0; guard < 1000; guard += 1) {
    if (state.outcome) {
      state.phase = "terminal";
      state.pending = null;
      return;
    }

    switch (state.phase) {
      case "setup": {
        emit(state, {
          type: "game_start",
          playerCount: 10,
          rolesInPlay: rolesInPlay(state.deal),
          initialLeader: state.initialLeader,
        });
        state.phase = "reveal";
        break;
      }

      case "reveal": {
        // Nothing public happens here. Each seat's legal sight is a function of
        // the deal and is computed on demand by `knowledgeFor`, so there is no
        // reveal event to emit and nothing to leak.
        state.phase = "opening_direction";
        break;
      }

      case "opening_direction": {
        setPending(state, {
          kind: "choose_opening_direction",
          seat: state.initialLeader,
        });
        return;
      }

      case "discussion": {
        const turn = state.speakingOrder[state.speechIndex];
        if (!turn) throw new Error("discussion ran past its speaking order");
        if (turn.slot === "closing") {
          // The leader's second turn is not a speech request. Closing and
          // choosing the car are ONE decision — see LeaderCloseAndProposeAction.
          setPending(state, {
            kind: "leader_close_and_propose",
            seat: turn.seat,
            teamSize: teamSize(PLAYER_COUNT, state.missionNumber),
          });
        } else {
          setPending(state, { kind: "speech", seat: turn.seat, slot: turn.slot });
        }
        return;
      }

      case "vote": {
        // Collected one at a time in ascending seat order, which keeps the
        // request stream deterministic. Nothing anyone submitted is visible to
        // anyone until all ten are in: `observationFor` has no path to
        // `pendingVotes`.
        const waiting = SEATS.find((seat) => state.pendingVotes[seat] === undefined);
        if (waiting !== undefined) {
          setPending(state, { kind: "vote", seat: waiting });
          return;
        }
        resolveVote(state);
        break;
      }

      case "mission": {
        const team = state.proposedTeam ?? [];
        const waiting = [...team]
          .sort((a, b) => a - b)
          .find((seat) => state.missionCards[seat] === undefined);
        if (waiting !== undefined) {
          setPending(state, { kind: "mission", seat: waiting });
          return;
        }
        resolveMission(state);
        break;
      }

      case "lady_select": {
        if (state.ladyHolder === null) throw new Error("lady_select with no holder");
        setPending(state, {
          kind: "lady_select",
          seat: state.ladyHolder,
          eligible: eligibleLadyTargets(state),
        });
        return;
      }

      case "lady_announce": {
        if (state.ladyHolder === null) throw new Error("lady_announce with no holder");
        setPending(state, { kind: "lady_announce", seat: state.ladyHolder });
        return;
      }

      case "assassination_reveal": {
        // The exact evil roles become mutually known here and nowhere earlier.
        // Oberon is in the audience: he played the whole game blind, and he
        // takes part in this discussion.
        const audience = [...state.deal.evilSeats].sort((a, b) => a - b);
        emitPrivate(state, {
          type: "evil_reveal",
          audience,
          roster: evilRoster(state.deal),
        });
        state.evilRolesRevealed = true;
        state.evilDiscussIndex = 0;
        state.phase = "assassination_discuss";
        break;
      }

      case "assassination_discuss": {
        const order = [...state.deal.evilSeats].sort((a, b) => a - b);
        if (state.evilDiscussIndex < order.length) {
          setPending(state, {
            kind: "evil_discuss",
            seat: order[state.evilDiscussIndex],
          });
          return;
        }
        state.phase = "assassination_strike";
        break;
      }

      case "assassination_strike": {
        setPending(state, { kind: "assassinate", seat: state.deal.assassin });
        return;
      }

      case "terminal": {
        state.pending = null;
        return;
      }
    }
  }
  throw new Error("referee failed to reach a decision point — this is a bug");
}

/**
 * Narrow a pending request to the kind we already checked it is.
 *
 * `applyAction` compares `action.kind` against `pending.kind` at the top, but
 * comparing two discriminants narrows neither union for the compiler, so the
 * one branch that needs the request's payload asks for it explicitly.
 */
function expectRequest<K extends DecisionRequest["kind"]>(
  pending: DecisionRequest,
  kind: K,
): Extract<DecisionRequest, { kind: K }> {
  if (pending.kind !== kind) {
    throw new IllegalActionError("wrong_kind", `内部状态不一致：期望 ${kind}`);
  }
  return pending as Extract<DecisionRequest, { kind: K }>;
}

/* ── Public API ────────────────────────────────────────────────────────── */

export interface CreateGameOptions {
  readonly seed: number;
  readonly config?: SimConfig;
  readonly runId?: string;
  /**
   * The public game id. Defaults to a fresh random UUID; tests pass a fixed
   * one. It is never derived from the seed — that derivation is what made the
   * old `gameLabel` a way to recover the deal.
   */
  readonly gameId?: GameId;
  /** Override the dealt roles. Fixtures and tests only. */
  readonly deal?: Deal;
  readonly initialLeader?: Seat;
}

/**
 * A game seeded and standing at its first decision: the opening leader's
 * choice of direction.
 */
export function createGame(options: CreateGameOptions): GameState {
  const setup = setupFromSeed(options.seed);
  const state = createState({
    // NOT derived from the seed. The run id travels in the PUBLIC replay, and
    // a seed there would let a reader reconstruct the deal before the final
    // reveal. A batch supplies its own ids; see `run/artifacts.ts`.
    runId: options.runId ?? "sim",
    gameId: options.gameId ?? newGameId(),
    seed: options.seed,
    config: options.config ?? loadConfig(),
    deal: options.deal ?? setup.deal,
    initialLeader: options.initialLeader ?? setup.initialLeader,
  });
  advance(state);
  return state;
}

/**
 * Submit one seat's action.
 *
 * Throws `IllegalActionError` on anything the rules do not allow, having
 * mutated nothing.
 */
export function applyAction(state: GameState, seat: Seat, action: Action): void {
  const pending = state.pending;
  if (!pending) {
    throw new IllegalActionError("wrong_phase", "这局已经结束了，没有待办动作");
  }
  if (seat !== pending.seat) {
    throw new IllegalActionError(
      "wrong_seat",
      `现在轮到 ${pending.seat}号，不是 ${seat}号`,
    );
  }
  if (action?.kind !== pending.kind) {
    throw new IllegalActionError(
      "wrong_kind",
      `现在要的是 ${pending.kind}，收到的是 ${String(action?.kind)}`,
    );
  }
  // Every field an action carries is checked before anything is written, so a
  // rejection leaves the game exactly where it stood.
  validateMemoryPatch(action.memoryPatch);

  switch (action.kind) {
    case "choose_opening_direction": {
      if (action.ladySide !== "left" && action.ladySide !== "right") {
        throw new IllegalActionError("bad_value", "ladySide 只能是 left 或 right");
      }
      requireWithinSpeechLimit(state, action.publicMessage, "开局发言");

      const direction = directionForLadySide(action.ladySide);
      const holder = ladyHolderForSide(seat, action.ladySide);
      state.playDirection = direction;
      state.ladyHolder = holder;
      state.ladyHeldBy = frozenList([holder]);

      emit(state, {
        type: "opening_direction",
        leader: seat,
        ladySide: action.ladySide,
        playDirection: direction,
        ladyHolder: holder,
        publicMessage: action.publicMessage,
      });
      emit(state, { type: "lady_assigned", holder });

      applyMemoryPatch(state, seat, action.memoryPatch);
      startAttempt(state);
      break;
    }

    case "speech": {
      requireWithinSpeechLimit(state, action.publicMessage, "发言");
      const noTeamYet = action.noTeamYet === true;
      let tentative: Seat[] | null = null;
      if (action.tentativeTeam != null) {
        if (noTeamYet) {
          throw new IllegalActionError(
            "tentative_team_conflict",
            "说了「还组不出车」就不能同时给出意向车",
          );
        }
        tentative = requireDistinctSeats(action.tentativeTeam, "意向车");
        if (tentative.length > PLAYER_COUNT) {
          throw new IllegalActionError("bad_team_size", "意向车人数超过桌上人数");
        }
      }
      if (action.claim != null && !ALL_ROLES.includes(action.claim)) {
        throw new IllegalActionError("bad_value", `不认识的身份声称：${action.claim}`);
      }
      // 退水. Two rules, both structural rather than stylistic: you cannot
      // withdraw a claim you never made, and withdrawing while simultaneously
      // making a new one is not a retraction — it is a change of claim, which
      // `recordClaim` already handles by superseding.
      const retracting = action.retractClaim === true;
      if (retracting) {
        if (action.claim != null) {
          throw new IllegalActionError(
            "claim_conflict",
            "同一次发言不能既退水又声称新身份 —— 改口直接给新的 claim 就行",
          );
        }
        if (!state.standingClaims.some((c) => c.seat === seat)) {
          throw new IllegalActionError(
            "no_claim_to_retract",
            `${seat}号 现在没有成立的身份声称，退不了水`,
          );
        }
      }
      validateStances(action.stances, seat);
      const speechRequest = expectRequest(pending, "speech");

      emit(state, {
        type: "speech",
        speaker: seat,
        slot: speechRequest.slot,
        publicMessage: action.publicMessage,
        tentativeTeam: tentative,
        noTeamYet,
        claim: action.claim ?? null,
        // Written only when true. An always-present `false` would change the
        // bytes of every replayed speech in every game recorded before this.
        ...(retracting ? { retractClaim: true as const } : {}),
        stances: action.stances ? [...action.stances] : [],
      });

      if (tentative || noTeamYet) {
        state.tentativeTeams = frozenAppend(state.tentativeTeams, {
          seat,
          team: tentative,
          noTeamYet,
        });
      }
      if (action.claim != null) {
        state.standingClaims = recordClaim(state, seat, action.claim);
      }
      if (retracting) {
        // `standingClaims` means what is STANDING. The claim itself is not
        // deleted — it is in the log forever, with the retraction after it —
        // which is what lets a reader ask "what did they say before they took
        // it back" and get an answer.
        state.standingClaims = frozenList(
          state.standingClaims.filter((c) => c.seat !== seat),
        );
      }

      applyMemoryPatch(state, seat, action.memoryPatch);
      state.speechIndex += 1;
      break;
    }

    case "leader_close_and_propose": {
      // Both halves validated before either is published. A car that fails the
      // size check must not leave a closing speech behind in the log.
      requireWithinSpeechLimit(state, action.publicMessage, "收尾发言");
      const team = requireLegalTeam(state, action.team);

      emit(state, {
        type: "speech",
        speaker: seat,
        slot: "closing",
        publicMessage: action.publicMessage,
        tentativeTeam: null,
        noTeamYet: false,
        claim: null,
        stances: [],
      });
      state.proposedTeam = frozenList(team);
      emit(state, { type: "proposal", leader: seat, team: [...team] });

      applyMemoryPatch(state, seat, action.memoryPatch);
      state.speechIndex += 1;
      state.phase = "vote";
      break;
    }

    case "vote": {
      if (action.choice !== "approve" && action.choice !== "reject") {
        throw new IllegalActionError("bad_value", "票只能是 approve 或 reject");
      }
      if (state.pendingVotes[seat] !== undefined) {
        throw new IllegalActionError("already_submitted", `${seat}号 已经投过票了`);
      }
      state.pendingVotes[seat] = action.choice;
      applyMemoryPatch(state, seat, action.memoryPatch);
      break;
    }

    case "mission": {
      const team = state.proposedTeam ?? [];
      if (!team.includes(seat)) {
        throw new IllegalActionError("not_on_team", `${seat}号 不在车上`);
      }
      if (action.card !== "success" && action.card !== "fail") {
        throw new IllegalActionError("bad_value", "任务牌只能是 success 或 fail");
      }
      // Checked before "already submitted" so the more specific rule is the one
      // reported: good players are pre-filled, and the interesting failure is
      // that one tried to fail a quest, not that it spoke twice.
      if (action.card === "fail" && sideOf(state.deal.bySeat[seat]) === "good") {
        throw new IllegalActionError("good_cannot_fail", "好人不能出坏票");
      }
      if (state.missionCards[seat] !== undefined) {
        throw new IllegalActionError("already_submitted", `${seat}号 的任务牌已经出过了`);
      }
      state.missionCards[seat] = action.card;
      applyMemoryPatch(state, seat, action.memoryPatch);
      break;
    }

    case "lady_select": {
      const target = requireSeat(action.target, "验人目标");
      const eligible = eligibleLadyTargets(state);
      if (!eligible.includes(target)) {
        throw new IllegalActionError(
          "lady_ineligible",
          `${target}号 不能被验：自己或者拿过令牌的人不能验`,
        );
      }
      // The truth, taken straight from the deal and written to the private
      // stream. It is a SIDE and never a role — the Lady shows loyalty, not
      // identity — and nothing downstream can amend it.
      const trueSide: Side = sideOf(state.deal.bySeat[target]);
      state.ladyPending = deepFreeze({ target, trueSide });
      emitPrivate(state, {
        type: "lady_result",
        audience: [seat],
        holder: seat,
        target,
        trueSide,
      });
      state.ladyResults[seat] = frozenAppend(state.ladyResults[seat], {
        sequence: state.sequence,
        missionNumber: state.missionNumber,
        holder: seat,
        target,
        trueSide,
      });
      applyMemoryPatch(state, seat, action.memoryPatch);
      state.phase = "lady_announce";
      break;
    }

    case "lady_announce": {
      const check = state.ladyPending;
      if (!check) throw new Error("lady_announce with no pending check");
      if (action.announced !== "good" && action.announced !== "evil") {
        throw new IllegalActionError("bad_value", "只能宣布 good 或 evil");
      }
      requireWithinSpeechLimit(state, action.publicMessage, "验人宣布");

      // What was said. It may contradict `check.trueSide`, and the private
      // record above is untouched by this — which is the whole point of
      // separating the two events.
      emit(state, {
        type: "lady_announced",
        holder: seat,
        target: check.target,
        announced: action.announced,
        publicMessage: action.publicMessage,
      });
      emit(state, { type: "lady_transferred", from: seat, to: check.target });

      state.ladyHolder = check.target;
      if (!state.ladyHeldBy.includes(check.target)) {
        state.ladyHeldBy = frozenAppend(state.ladyHeldBy, check.target);
      }
      state.ladyChecks += 1;
      state.ladyPending = null;

      applyMemoryPatch(state, seat, action.memoryPatch);
      afterLady(state);
      break;
    }

    case "evil_discuss": {
      requireWithinSpeechLimit(state, action.message, "坏人密谈");
      emitPrivate(state, {
        type: "evil_discussion",
        audience: [...state.deal.evilSeats].sort((a, b) => a - b),
        speaker: seat,
        message: action.message,
      });
      applyMemoryPatch(state, seat, action.memoryPatch);
      state.evilDiscussIndex += 1;
      break;
    }

    case "assassinate": {
      const target = requireSeat(action.target, "刺杀目标");
      if (target === seat) {
        throw new IllegalActionError("bad_target", "刺客不能刺自己");
      }
      emit(state, { type: "assassination_target", assassin: seat, target });
      applyMemoryPatch(state, seat, action.memoryPatch);
      const hit = state.deal.bySeat[target] === "merlin";
      endGame(state, hit ? "evil" : "good", hit ? "assassin_hit" : "assassin_missed", target);
      break;
    }
  }

  advance(state);
}

/**
 * A later claim supersedes an earlier one, the way the notebook's opinion
 * chain does: the current value is the newest, and the older ones stay in the
 * public log rather than being erased.
 */
function recordClaim(state: GameState, seat: Seat, claimed: RoleType) {
  const claim = { seat, claimed, sinceSequence: state.sequence };
  const others = state.standingClaims.filter((c) => c.seat !== seat);
  return frozenList([...others, claim]);
}
