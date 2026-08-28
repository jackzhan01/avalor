import { describe, expect, it } from "vitest";
import { drive, referenceDeal } from "../fixtures/harness";
import { PROFILES } from "../agents/scripted-agent";
import { attemptMutation } from "./freeze";
import { observationFor, type Observation } from "./observation";
import { applyAction } from "./referee";
import type { GameState } from "./state";
import { SEATS, type Seat } from "./types";

/**
 * An observation is a snapshot, and this file attacks that claim.
 *
 * `readonly` is a compile-time fiction. Everything here casts it away exactly
 * the way an agent — or a repair loop patching a malformed model output —
 * could, and then asserts the two things that actually matter:
 *
 *   the authoritative state did not change;
 *   a snapshot taken earlier still says what it said.
 *
 * The assertions deliberately do NOT require the write to throw. In strict
 * mode it does, but "it threw" is not the property; "the game is unchanged" is.
 * `attemptMutation` swallows the throw so both halves get checked.
 */

/**
 * Cast away every readonly, the way a determined caller would.
 *
 * Going through `unknown` on purpose: the point of these tests is that the
 * TYPE system is not the boundary, so a helper that still respected it would
 * be testing nothing.
 */
function mutable(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function pauseMidGame(seed: number): { state: GameState; observation: Observation } {
  const { state } = drive({
    seed,
    deal: referenceDeal(),
    profile: PROFILES.mixed,
    stopWhen: (s) => s.missionTrack[0] !== "pending",
  });
  return { state, observation: observationFor(state, 3) };
}

describe("a retained observation does not follow the game forward", () => {
  it("keeps the public log it was built with", () => {
    const { state, observation } = pauseMidGame(11);
    const lengthWhenTaken = observation.publicLog.length;
    const sequenceWhenTaken = observation.publicLog.at(-1)!.sequence;
    expect(lengthWhenTaken).toBeGreaterThan(10);

    // Play on, a lot.
    drive({
      seed: 11,
      deal: referenceDeal(),
      profile: PROFILES.mixed,
      agents: undefined,
    });
    while (state.pending) {
      const seat = state.pending.seat;
      const fresh = observationFor(state, seat);
      const request = fresh.request!;
      applyAction(state, seat, actionFor(request, state));
    }

    expect(state.log.length).toBeGreaterThan(lengthWhenTaken);
    // The snapshot is exactly as long as it was, and ends where it ended.
    expect(observation.publicLog).toHaveLength(lengthWhenTaken);
    expect(observation.publicLog.at(-1)!.sequence).toBe(sequenceWhenTaken);
  });

  it("keeps its quest track, speaking order, claims and Lady chain", () => {
    const { state, observation } = pauseMidGame(12);
    const before = JSON.stringify({
      track: observation.position.missionTrack,
      order: observation.position.speakingOrder,
      claims: observation.position.standingClaims,
      heldBy: observation.position.ladyHeldBy,
      tentative: observation.position.tentativeTeams,
      memory: observation.memory,
      lady: observation.ladyResults,
    });

    while (state.pending) {
      const seat = state.pending.seat;
      applyAction(state, seat, actionFor(observationFor(state, seat).request!, state));
    }
    expect(state.outcome).not.toBeNull();

    expect(
      JSON.stringify({
        track: observation.position.missionTrack,
        order: observation.position.speakingOrder,
        claims: observation.position.standingClaims,
        heldBy: observation.position.ladyHeldBy,
        tentative: observation.position.tentativeTeams,
        memory: observation.memory,
        lady: observation.ladyResults,
      }),
    ).toBe(before);
  });

  it("does not gain a Lady result the seat obtained later", () => {
    // Snapshot taken before the first check; the seat has one afterwards.
    const { state } = drive({
      seed: 13,
      deal: referenceDeal(),
      profile: PROFILES.passiveEvil,
      stopWhen: (s) => s.phase === "lady_select",
    });
    const holder = state.pending!.seat;
    const before = observationFor(state, holder);
    expect(before.ladyResults).toHaveLength(0);

    const request = state.pending!;
    applyAction(state, holder, {
      kind: "lady_select",
      target: request.kind === "lady_select" ? request.eligible[0] : 1,
    });

    expect(state.ladyResults[holder]).toHaveLength(1);
    expect(before.ladyResults).toHaveLength(0);
    expect(observationFor(state, holder).ladyResults).toHaveLength(1);
  });
});

describe("an agent cannot write through its observation", () => {
  it("cannot push an event onto the public log", () => {
    const { state, observation } = pauseMidGame(21);
    const before = state.log.length;
    const fake = { type: "mission_result", sequence: 999 } as unknown;

    attemptMutation(() => (observation.publicLog as unknown[]).push(fake));
    attemptMutation(() => {
      (observation.publicLog as unknown[])[0] = fake;
    });

    expect(state.log).toHaveLength(before);
    expect(observation.publicLog).toHaveLength(before);
    expect(observation.publicLog).not.toContain(fake);
  });

  it("cannot edit an event already in the log", () => {
    const { state, observation } = pauseMidGame(22);
    const quest = observation.publicLog.find((e) => e.type === "mission_result");
    expect(quest).toBeDefined();
    const originalResult = quest!.type === "mission_result" ? quest!.result : null;

    attemptMutation(() => {
      mutable(quest!).result = "success";
      mutable(quest!).failCount = 0;
    });

    const live = state.log.find((e) => e.type === "mission_result")!;
    expect(live.type === "mission_result" ? live.result : null).toBe(originalResult);
  });

  it("cannot rewrite its own quest track, and so cannot rewrite the referee's", () => {
    const { state, observation } = pauseMidGame(23);
    const before = [...state.missionTrack];

    attemptMutation(() => {
      (observation.position.missionTrack as unknown[])[0] = "success";
    });
    attemptMutation(() => {
      mutable(observation.position).successes = 99;
    });

    expect([...state.missionTrack]).toEqual(before);
    expect(state.successes).not.toBe(99);
  });

  it("cannot enlarge its own knowledge", () => {
    const { state } = drive({
      seed: 24,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "vote",
    });
    // Seat 3 is a loyal servant: knowledge {kind:"none"} and nothing to add to.
    const loyal = observationFor(state, 3);
    expect(loyal.knowledge).toEqual({ kind: "none" });
    attemptMutation(() => {
      mutable(loyal).knowledge = { kind: "sees_evil", seats: [7, 8, 10] };
    });
    expect(observationFor(state, 3).knowledge).toEqual({ kind: "none" });

    // Merlin cannot append Mordred to the seats he was shown.
    const merlin = observationFor(state, 1);
    if (merlin.knowledge.kind !== "sees_evil") throw new Error("unreachable");
    attemptMutation(() => {
      (merlin.knowledge as unknown as { seats: Seat[] }).seats.push(9);
    });
    const fresh = observationFor(state, 1);
    if (fresh.knowledge.kind !== "sees_evil") throw new Error("unreachable");
    expect([...fresh.knowledge.seats]).toEqual([7, 8, 10]);
  });

  it("cannot write another seat's memory through its own", () => {
    const { state, observation } = pauseMidGame(25);
    const otherBefore = JSON.stringify(state.memory[7]);

    attemptMutation(() => {
      (observation.memory.intentions as string[]).push("注入");
    });
    attemptMutation(() => {
      mutable(observation.memory).beliefs = [{ seat: 7, pEvil: 0, note: "伪造" }];
    });

    expect(JSON.stringify(state.memory[7])).toBe(otherBefore);
    expect(state.memory[3].intentions).not.toContain("注入");
  });

  it("cannot forge a Lady result", () => {
    const { state } = drive({
      seed: 26,
      deal: referenceDeal(),
      profile: PROFILES.passiveEvil,
      stopWhen: (s) => s.ladyChecks === 1,
    });
    const holder = state.ladyHeldBy[0];
    const observation = observationFor(state, holder);
    const truth = JSON.stringify(state.ladyResults[holder]);

    attemptMutation(() => {
      (observation.ladyResults as unknown[]).push({
        sequence: 1,
        missionNumber: 1,
        holder,
        target: 1,
        trueSide: "evil",
      });
    });
    if (observation.ladyResults.length > 0) {
      attemptMutation(() => {
        mutable(observation.ladyResults[0]).trueSide = "evil";
      });
    }

    expect(JSON.stringify(state.ladyResults[holder])).toBe(truth);
  });

  it("cannot change what it is being asked to do", () => {
    const { state } = drive({
      seed: 27,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "vote",
    });
    const seat = state.pending!.seat;
    const observation = observationFor(state, seat);
    attemptMutation(() => {
      mutable(observation.request!).kind = "assassinate";
    });
    expect(state.pending!.kind).toBe("vote");
    expect(observationFor(state, seat).request!.kind).toBe("vote");
  });

  it("survives an attack on every field, at every seat, with the game intact", () => {
    const { state, actions } = drive({
      seed: 28,
      deal: referenceDeal(),
      profile: PROFILES.mixed,
      stopWhen: (s) => s.missionTrack[1] !== "pending",
    });
    const before = JSON.stringify({
      log: state.log,
      privateLog: state.privateLog,
      memory: state.memory,
      lady: state.ladyResults,
      track: state.missionTrack,
      claims: state.standingClaims,
    });

    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      for (const key of Object.keys(observation)) {
        attemptMutation(() => {
          mutable(observation)[key] = null;
        });
      }
      for (const key of Object.keys(observation.position)) {
        attemptMutation(() => {
          mutable(observation.position)[key] = null;
        });
      }
      attemptMutation(() => (observation.evilDiscussion as unknown[]).push({}));
      attemptMutation(() => (observation.position.ladyHeldBy as unknown[]).push(1));
      attemptMutation(() => (observation.position.standingClaims as unknown[]).push({}));
      attemptMutation(() => (observation.position.tentativeTeams as unknown[]).push({}));
      attemptMutation(() => (observation.position.speakingOrder as unknown[]).push({}));
      attemptMutation(() => (observation.position.alreadySpoken as unknown[]).push(1));
    }

    expect(
      JSON.stringify({
        log: state.log,
        privateLog: state.privateLog,
        memory: state.memory,
        lady: state.ladyResults,
        track: state.missionTrack,
        claims: state.standingClaims,
      }),
    ).toBe(before);
    expect(actions.length).toBeGreaterThan(0);
  });
});

describe("the snapshot is still a plain value", () => {
  it("serialises and round-trips", () => {
    const { observation } = pauseMidGame(31);
    const text = JSON.stringify(observation);
    expect(text.length).toBeGreaterThan(100);
    const parsed = JSON.parse(text);
    expect(parsed.seat).toBe(observation.seat);
    expect(parsed.publicLog).toHaveLength(observation.publicLog.length);
  });

  it("is frozen all the way down", () => {
    const { observation } = pauseMidGame(32);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.position)).toBe(true);
    expect(Object.isFrozen(observation.publicLog)).toBe(true);
    expect(Object.isFrozen(observation.publicLog[0])).toBe(true);
    expect(Object.isFrozen(observation.position.missionTrack)).toBe(true);
    expect(Object.isFrozen(observation.memory)).toBe(true);
    expect(Object.isFrozen(observation.knowledge)).toBe(true);
  });

  it("does not hand out the referee's own working arrays", () => {
    // The public log IS shared by reference, and that is safe precisely because
    // the referee replaces it rather than mutating it — asserted here by
    // watching the identity change on the next append.
    const { state, observation } = pauseMidGame(33);
    const held = observation.publicLog;
    expect(held).toBe(state.log);
    const seat = state.pending!.seat;
    applyAction(state, seat, actionFor(observationFor(state, seat).request!, state));
    expect(state.log).not.toBe(held);
    expect(held.length).toBeLessThan(state.log.length);
  });
});

/* ── A minimal legal action for any request, so a test can play a game out ── */

function actionFor(
  request: NonNullable<Observation["request"]>,
  state: GameState,
): Parameters<typeof applyAction>[2] {
  switch (request.kind) {
    case "choose_opening_direction":
      return { kind: "choose_opening_direction", ladySide: "left", publicMessage: "开局" };
    case "speech":
      return { kind: "speech", publicMessage: "过。" };
    case "leader_close_and_propose":
      return {
        kind: "leader_close_and_propose",
        publicMessage: "收尾。",
        team: SEATS.slice(0, request.teamSize),
      };
    case "vote":
      return { kind: "vote", choice: "approve" };
    case "mission":
      return { kind: "mission", card: "success" };
    case "lady_select":
      return { kind: "lady_select", target: request.eligible[0] };
    case "lady_announce":
      return { kind: "lady_announce", announced: "good", publicMessage: "好人。" };
    case "evil_discuss":
      return { kind: "evil_discuss", message: "刺谁。" };
    case "assassinate":
      return {
        kind: "assassinate",
        target: SEATS.find((s) => s !== state.deal.assassin)!,
      };
  }
}
