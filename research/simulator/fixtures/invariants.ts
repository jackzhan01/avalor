/**
 * Everything a finished game must be true of, as a list of violations.
 *
 * Returning strings rather than throwing means a thousand-game sweep reports
 * WHICH seeds broke WHICH rule instead of stopping at the first one, and a
 * failure message names the rule rather than a line number.
 *
 * These are checked against the PUBLIC LOG wherever possible, not against the
 * referee's internal counters. Checking `state.fails === 3` would mostly
 * confirm that a variable was assigned; recomputing the quest track from the
 * events confirms that what the table saw and what the referee believed are
 * the same game.
 */

import { requiredFails, teamSize } from "@/lib/rules/avalon";
import type { PublicEvent } from "../core/events";
import { isPrivateType } from "../core/events";
import { nextSeat } from "../core/order";
import { speechLength } from "../core/referee";
import type { GameState } from "../core/state";
import { PLAYER_COUNT, SEATS, type Seat } from "../core/types";
import type { RecordedAction } from "../run/artifacts";

type Of<T extends PublicEvent["type"]> = Extract<PublicEvent, { type: T }>;

function pick<T extends PublicEvent["type"]>(state: GameState, type: T): Of<T>[] {
  return state.log.filter((e) => e.type === type) as Of<T>[];
}

export function checkInvariants(
  state: GameState,
  actions: readonly RecordedAction[] = [],
): string[] {
  const bad: string[] = [];
  const say = (message: string) => bad.push(message);

  /* ── The game ended, once, legally ─────────────────────────────────── */

  if (!state.outcome) say("game has no outcome");
  if (state.pending !== null) say("game ended with a pending request");
  if (state.phase !== "terminal") say(`game ended in phase ${state.phase}`);

  const ends = pick(state, "game_end");
  if (ends.length !== 1) say(`${ends.length} game_end events`);
  if (ends.length === 1 && state.log[state.log.length - 1] !== ends[0]) {
    say("game_end is not the last public event");
  }
  if (ends.length === 1) {
    for (const seat of SEATS) {
      if (ends[0].reveal[seat] !== state.deal.bySeat[seat]) {
        say(`final reveal disagrees with the deal at seat ${seat}`);
      }
    }
  }

  /* ── Ordering ──────────────────────────────────────────────────────── */

  const sequences = [...state.log, ...state.privateLog].map((e) => e.sequence);
  const sorted = [...sequences].sort((a, b) => a - b);
  if (new Set(sequences).size !== sequences.length) say("a sequence number was reused");
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      say(`sequence numbers are not 1..n (found ${sorted[i]} at index ${i})`);
      break;
    }
  }
  for (let i = 1; i < state.log.length; i += 1) {
    if (state.log[i].sequence <= state.log[i - 1].sequence) {
      say("the public log is not in ascending sequence order");
      break;
    }
  }

  /* ── The two streams stay separate ─────────────────────────────────── */

  for (const event of state.log) {
    if (isPrivateType(event.type)) say(`private event ${event.type} reached the public log`);
    if ("audience" in event) say(`public event ${event.type} carries an audience`);
  }

  /* ── Votes ─────────────────────────────────────────────────────────── */

  for (const vote of pick(state, "vote")) {
    const cast = SEATS.map((seat) => vote.votes[seat]);
    if (cast.some((choice) => choice !== "approve" && choice !== "reject")) {
      say(`vote at ${vote.sequence} is missing a seat`);
      continue;
    }
    const approvals = cast.filter((choice) => choice === "approve").length;
    if (approvals !== vote.approvals) say(`vote at ${vote.sequence} miscounted approvals`);
    const expected = approvals * 2 > PLAYER_COUNT ? "passed" : "rejected";
    if (vote.result !== expected) {
      say(`vote at ${vote.sequence}: ${approvals}/10 should be ${expected}`);
    }
  }

  /* ── Proposals and quests ──────────────────────────────────────────── */

  for (const proposal of pick(state, "proposal")) {
    const size = teamSize(PLAYER_COUNT, proposal.missionNumber);
    if (proposal.team.length !== size) {
      say(`proposal at ${proposal.sequence}: ${proposal.team.length} aboard, want ${size}`);
    }
    if (new Set(proposal.team).size !== proposal.team.length) {
      say(`proposal at ${proposal.sequence} has a duplicate seat`);
    }
  }

  let successes = 0;
  let fails = 0;
  const quests = pick(state, "mission_result");
  for (const quest of quests) {
    const need = requiredFails(PLAYER_COUNT, quest.missionNumber);
    const expected = quest.failCount >= need ? "fail" : "success";
    if (quest.result !== expected) {
      say(`quest ${quest.missionNumber}: ${quest.failCount} cards should be ${expected}`);
    }
    if (quest.team.length !== teamSize(PLAYER_COUNT, quest.missionNumber)) {
      say(`quest ${quest.missionNumber} ran with the wrong team size`);
    }
    const evilsAboard = quest.team.filter((s) => state.deal.evilSeats.includes(s)).length;
    if (quest.failCount > evilsAboard) {
      say(`quest ${quest.missionNumber}: ${quest.failCount} cards from ${evilsAboard} villains`);
    }
    if (quest.result === "success") successes += 1;
    else fails += 1;
  }
  if (successes !== state.successes || fails !== state.fails) {
    say("the public quest track disagrees with the referee's count");
  }
  if (quests.length > 5) say(`${quests.length} quests were played`);
  const questNumbers = quests.map((q) => q.missionNumber);
  if (questNumbers.join() !== questNumbers.map((_, i) => i + 1).join()) {
    say(`quests ran out of order: ${questNumbers.join(",")}`);
  }

  /* ── Leadership ────────────────────────────────────────────────────── */

  const direction = state.playDirection;
  if (!direction) say("no play direction was ever fixed");
  if (direction) {
    for (const change of pick(state, "leader_change")) {
      if (change.to !== nextSeat(change.from, direction)) {
        say(`leader moved ${change.from}→${change.to}, which is not ${direction}`);
      }
    }
  }

  /* ── Speeches ──────────────────────────────────────────────────────── */

  const attempts = new Map<string, Of<"speech">[]>();
  for (const speech of pick(state, "speech")) {
    if (speechLength(speech.publicMessage) > state.config.limits.speechCharLimit) {
      say(`speech at ${speech.sequence} is over the limit`);
    }
    const key = `${speech.missionNumber}:${speech.attempt}`;
    const list = attempts.get(key) ?? [];
    list.push(speech);
    attempts.set(key, list);
  }
  for (const [key, speeches] of attempts) {
    if (speeches.length !== PLAYER_COUNT + 1) {
      say(`attempt ${key} had ${speeches.length} speeches, want ${PLAYER_COUNT + 1}`);
      continue;
    }
    const leader = speeches[0].speaker;
    if (speeches[0].slot !== "opening") say(`attempt ${key} did not open with the leader`);
    if (speeches[PLAYER_COUNT].slot !== "closing" || speeches[PLAYER_COUNT].speaker !== leader) {
      say(`attempt ${key} did not close with the leader`);
    }
    if (direction) {
      let seat: Seat = leader;
      for (let i = 1; i < PLAYER_COUNT; i += 1) {
        seat = nextSeat(seat, direction);
        if (speeches[i].speaker !== seat) {
          say(`attempt ${key} spoke out of order at turn ${i}`);
          break;
        }
      }
    }
  }

  /* ── Lady of the Lake ──────────────────────────────────────────────── */

  const announcements = pick(state, "lady_announced");
  const transfers = pick(state, "lady_transferred");
  if (announcements.length > 3) say(`${announcements.length} Lady checks`);
  if (transfers.length !== announcements.length) say("a Lady check did not pass the token");
  for (const said of announcements) {
    if (![2, 3, 4].includes(said.missionNumber)) {
      say(`a Lady check ran after quest ${said.missionNumber}`);
    }
  }
  if (new Set(state.ladyHeldBy).size !== state.ladyHeldBy.length) {
    say("a seat held the Lady token twice");
  }
  const assigned = pick(state, "lady_assigned");
  if (assigned.length !== 1) say(`${assigned.length} initial Lady assignments`);
  if (assigned.length === 1 && state.ladyHeldBy[0] !== assigned[0].holder) {
    say("the Lady chain does not start at the assigned holder");
  }
  // Each check examined somebody who had never held the token before.
  const held = new Set<Seat>(assigned.length ? [assigned[0].holder] : []);
  for (const said of announcements) {
    if (held.has(said.target)) say(`Lady examined ${said.target}, who had already held it`);
    if (said.holder === said.target) say("Lady examined its own holder");
    held.add(said.target);
  }
  for (const [seat, results] of Object.entries(state.ladyResults)) {
    for (const result of results) {
      if (result.holder !== Number(seat)) say(`a Lady result is filed under the wrong seat`);
      const truth = state.deal.evilSeats.includes(result.target) ? "evil" : "good";
      if (result.trueSide !== truth) say("a Lady result does not match the deal");
    }
  }

  /* ── Endings ───────────────────────────────────────────────────────── */

  const strike = pick(state, "assassination_target")[0];
  const outcome = state.outcome;
  if (outcome) {
    if (outcome.reason === "missions_evil" && fails !== 3) {
      say(`evil won on quests with ${fails} failures`);
    }
    if (outcome.reason === "missions_evil" && outcome.winner !== "evil") {
      say("missions_evil did not give evil the win");
    }
    if (outcome.reason === "rejection_limit") {
      if (state.rejectionStreak !== 5) say("rejection_limit without five rejections");
      if (outcome.winner !== "evil") say("rejection_limit did not give evil the win");
    }
    if (outcome.reason === "assassin_hit" || outcome.reason === "assassin_missed") {
      if (successes !== 3) say(`assassination reached with ${successes} successes`);
      if (!strike) say("an assassination outcome with no strike event");
      if (strike) {
        if (strike.assassin !== state.deal.assassin) say("somebody else took the shot");
        const hit = state.deal.bySeat[strike.target] === "merlin";
        if (hit !== (outcome.reason === "assassin_hit")) say("the strike was scored wrongly");
        if (outcome.winner !== (hit ? "evil" : "good")) say("the assassination winner is wrong");
      }
    }
    if (!strike && successes >= 3 && outcome.reason !== "rejection_limit") {
      say("good reached three quests without an assassination");
    }
  }

  /* ── Who was asked for what ────────────────────────────────────────── */

  for (const entry of actions) {
    if (entry.action.kind === "mission") {
      if (!state.deal.evilSeats.includes(entry.seat)) {
        say(`good seat ${entry.seat} was asked for a quest card`);
      }
      if (entry.action.card === "fail" && !state.deal.evilSeats.includes(entry.seat)) {
        say(`good seat ${entry.seat} played a fail card`);
      }
    }
    if (entry.action.kind === "assassinate" && entry.seat !== state.deal.assassin) {
      say(`seat ${entry.seat} took the assassination shot`);
    }
  }

  return bad;
}
