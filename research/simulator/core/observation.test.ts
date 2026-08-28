import { describe, expect, it } from "vitest";
import { requiredFails, teamSize } from "@/lib/rules/avalon";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import {
  allObservations,
  drive,
  referenceDeal,
  swappedDeal,
} from "../fixtures/harness";
import {
  forbiddenKeyFindings,
  ladyResultHolders,
  memoryLikeObjects,
  privateRoleMentions,
} from "../fixtures/leak-scan";
import { observationFor, type Observation } from "./observation";
import type { GameState } from "./state";
import { SEATS, type Action, type Seat } from "./types";
import { knowledgeFor } from "./visibility";

/**
 * The leakage suite.
 *
 * `observationFor` is the entire information boundary, so this file is the
 * entire audit. Everything here is structural rather than textual: grepping a
 * serialised observation for "merlin" cannot work, because `game_start`
 * legitimately lists the deck and `game_end` legitimately reveals the deal.
 * What is checked instead is WHERE each fact appears and whether that path is
 * one this seat is entitled to.
 */

/** Paths at which a role name may legally appear outside the public log. */
const ALLOWED_ROLE_PATHS = [
  /^role$/,
  /^evilRoster\[\d+\]\.role$/,
  // A public claim to hold a role. Everyone heard it.
  /^position\.standingClaims\[\d+\]\.claimed$/,
];

function auditOne(observation: Observation, state: GameState): string[] {
  const problems: string[] = [];
  const seat = observation.seat;

  for (const finding of forbiddenKeyFindings(observation)) {
    problems.push(`seat ${seat}: ${finding.what} at ${finding.path}`);
  }

  const memories = memoryLikeObjects(observation);
  if (memories.length !== 1) {
    problems.push(`seat ${seat}: ${memories.length} memory objects reachable (${memories})`);
  }
  if (observation.memory !== state.memory[seat]) {
    problems.push(`seat ${seat}: memory is not this seat's own`);
  }

  for (const holder of ladyResultHolders(observation)) {
    if (holder !== seat) {
      problems.push(`seat ${seat}: can see a Lady result belonging to ${holder}`);
    }
  }

  for (const mention of privateRoleMentions(observation)) {
    if (!ALLOWED_ROLE_PATHS.some((pattern) => pattern.test(mention.path))) {
      problems.push(`seat ${seat}: role "${mention.role}" exposed at ${mention.path}`);
    }
  }

  if (observation.side === "good") {
    if (observation.evilRoster !== null) {
      problems.push(`seat ${seat}: a good seat can see the evil roster`);
    }
    if (observation.evilDiscussion.length > 0) {
      problems.push(`seat ${seat}: a good seat can hear the evil discussion`);
    }
  }

  const inAssassination =
    state.phase === "assassination_discuss" ||
    state.phase === "assassination_strike" ||
    state.phase === "terminal";
  if (observation.evilRoster !== null && !inAssassination) {
    problems.push(`seat ${seat}: the evil roster is visible in phase ${state.phase}`);
  }

  if (state.pending && state.pending.seat !== seat && observation.request !== null) {
    problems.push(`seat ${seat}: can see a request addressed to ${state.pending.seat}`);
  }

  if (JSON.stringify(observation.knowledge) !== JSON.stringify(knowledgeFor(state.deal, seat))) {
    problems.push(`seat ${seat}: knowledge does not match what the deal shows it`);
  }

  return problems;
}

/** Audit all ten seats at the current moment. */
function auditAll(state: GameState): string[] {
  return allObservations(state).flatMap((observation) => auditOne(observation, state));
}

/** Play a whole game, auditing every seat before every action and at the end. */
function auditedGame(
  seed: number,
  override?: (observation: Observation, state: GameState) => Action | undefined,
): { state: GameState; problems: string[] } {
  const problems: string[] = [];
  const { state } = drive({
    seed,
    profile: PROFILES.mixed,
    override: (observation, state) => {
      problems.push(...auditAll(state));
      return override?.(observation, state);
    },
  });
  problems.push(...auditAll(state));
  return { state, problems };
}

/* ── What an observation is ────────────────────────────────────────────── */

describe("an observation carries this seat and no other", () => {
  it("names its own seat, role and side", () => {
    const { state } = drive({ seed: 1, deal: referenceDeal(), stopWhen: (s) => s.phase === "vote" });
    const observation = observationFor(state, 7);
    expect(observation.seat).toBe(7);
    expect(observation.role).toBe("morgana");
    expect(observation.side).toBe("evil");
  });

  it("gives every seat the same public log", () => {
    const { state } = drive({
      seed: 2,
      deal: referenceDeal(),
      stopWhen: (s) => s.missionTrack[0] !== "pending",
    });
    const logs = allObservations(state).map((o) => o.publicLog);
    for (const log of logs) expect(log).toBe(logs[0]);
  });

  it("reports position: neighbours, leader, direction, distance to leading", () => {
    const { state } = drive({
      seed: 3,
      deal: referenceDeal(),
      initialLeader: 5,
      override: (observation) =>
        observation.request?.kind === "choose_opening_direction"
          ? { kind: "choose_opening_direction", ladySide: "left", publicMessage: "开局" }
          : undefined,
      stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
    });
    const observation = observationFor(state, 1);
    expect(observation.position.leftNeighbor).toBe(2);
    expect(observation.position.rightNeighbor).toBe(10);
    expect(observation.position.leader).toBe(5);
    expect(observation.position.playDirection).toBe("right");
    // Play runs right from seat 5, so seat 1 leads after 5→4→3→2→1.
    expect(observation.position.seatsUntilILead).toBe(4);
    expect(observationFor(state, 5).position.seatsUntilILead).toBe(0);
  });

  it("reports the speaking order and who has already spoken", () => {
    const { state } = drive({
      seed: 3,
      deal: referenceDeal(),
      initialLeader: 5,
      override: (observation) =>
        observation.request?.kind === "choose_opening_direction"
          ? { kind: "choose_opening_direction", ladySide: "right", publicMessage: "开局" }
          : undefined,
      stopWhen: (s) => s.phase === "discussion" && s.speechIndex === 4,
    });
    const observation = observationFor(state, 2);
    expect(observation.position.speakingOrder.map((t) => t.seat)).toEqual([
      5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5,
    ]);
    expect(observation.position.speechIndex).toBe(4);
    expect(observation.position.alreadySpoken).toEqual([5, 6, 7, 8]);
  });

  it("reports the quest track and this quest's requirements", () => {
    const { state } = drive({
      seed: 4,
      deal: referenceDeal(),
      stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
    });
    const position = observationFor(state, 1).position;
    expect(position.teamSizeThisMission).toBe(teamSize(10, 1));
    expect(position.failsRequiredThisMission).toBe(requiredFails(10, 1));
    expect(position.missionTrack).toEqual(["pending", "pending", "pending", "pending", "pending"]);
  });

  it("hands a request only to the seat it is addressed to", () => {
    const { state } = drive({ seed: 5, deal: referenceDeal(), stopWhen: (s) => s.phase === "vote" });
    const asked = state.pending!.seat;
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      if (seat === asked) expect(observation.request).not.toBeNull();
      else expect(observation.request).toBeNull();
    }
  });

  /**
   * The subtlest leak in the whole design, and the reason `request` is
   * self-only: the referee pre-fills good players' quest cards, so a mission
   * request is only ever addressed to a villain. Publishing "the referee is
   * waiting on seat 7" would announce that seat 7 is evil.
   */
  it("does not let a mission request name a villain to the table", () => {
    const { state } = drive({
      seed: 6,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          const team = [s.deal.evilSeats[0], ...s.deal.goodSeats].slice(0, 3);
          return { kind: "leader_close_and_propose", publicMessage: "收尾。", team };
        }
        if (observation.request?.kind === "vote") return { kind: "vote", choice: "approve" };
        return undefined;
      },
      stopWhen: (s) => s.phase === "mission",
    });
    expect(state.deal.evilSeats).toContain(state.pending!.seat);
    for (const seat of SEATS) {
      if (seat === state.pending!.seat) continue;
      expect(observationFor(state, seat).request).toBeNull();
    }
  });
});

/* ── Hard knowledge ────────────────────────────────────────────────────── */

describe("hard knowledge is what the deal showed, and nothing more", () => {
  it("matches the visibility matrix for every seat", () => {
    const { state } = drive({ seed: 7, deal: referenceDeal(), stopWhen: (s) => s.phase === "vote" });
    expect(observationFor(state, 1).knowledge).toEqual({ kind: "sees_evil", seats: [7, 8, 10] });
    expect(observationFor(state, 2).knowledge).toEqual({
      kind: "merlin_or_morgana",
      pair: [1, 7],
    });
    expect(observationFor(state, 3).knowledge).toEqual({ kind: "none" });
    expect(observationFor(state, 7).knowledge).toEqual({
      kind: "knows_teammates",
      seats: [8, 9],
    });
    expect(observationFor(state, 10).knowledge).toEqual({ kind: "none" });
  });

  it("renders Percival's view identically when Merlin and Morgana swap", () => {
    const forward = drive({ seed: 8, deal: referenceDeal(), stopWhen: (s) => s.phase === "vote" });
    const reversed = drive({ seed: 8, deal: swappedDeal(), stopWhen: (s) => s.phase === "vote" });
    expect(JSON.stringify(observationFor(reversed.state, 2).knowledge)).toBe(
      JSON.stringify(observationFor(forward.state, 2).knowledge),
    );
  });

  it("gives Oberon nothing during normal play", () => {
    const { state } = drive({
      seed: 9,
      deal: referenceDeal(),
      profile: PROFILES.mixed,
      stopWhen: (s) => s.missionTrack[1] !== "pending",
    });
    const oberon = observationFor(state, 10);
    expect(oberon.knowledge).toEqual({ kind: "none" });
    expect(oberon.evilRoster).toBeNull();
    expect(oberon.evilDiscussion).toEqual([]);
  });

  it("brings Oberon into the reveal and the discussion at the assassination", () => {
    const { state } = drive({
      seed: 10,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: s.deal.goodSeats.slice(0, teamSize(10, s.missionNumber)),
          };
        }
        if (observation.request?.kind === "vote") return { kind: "vote", choice: "approve" };
        return undefined;
      },
      stopWhen: (s) => s.phase === "assassination_strike",
    });
    const oberon = observationFor(state, state.deal.oberon);
    expect(oberon.evilRoster).not.toBeNull();
    expect(oberon.evilRoster!.map((e) => e.role).sort()).toEqual(
      ["assassin", "mordred", "morgana", "oberon"].sort(),
    );
    expect(oberon.evilDiscussion).toHaveLength(4);
    // And a good seat still sees nothing of it.
    const merlin = observationFor(state, state.deal.merlin);
    expect(merlin.evilRoster).toBeNull();
    expect(merlin.evilDiscussion).toEqual([]);
  });

  it("keeps a Lady result with its holder", () => {
    const { state } = drive({
      seed: 11,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: s.deal.goodSeats.slice(0, teamSize(10, s.missionNumber)),
          };
        }
        if (observation.request?.kind === "vote") return { kind: "vote", choice: "approve" };
        return undefined;
      },
    });
    const withResults = SEATS.filter((s) => state.ladyResults[s].length > 0);
    expect(withResults.length).toBeGreaterThan(0);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      expect(observation.ladyResults).toEqual(state.ladyResults[seat]);
      for (const result of observation.ladyResults) expect(result.holder).toBe(seat);
    }
  });
});

/* ── The sweep ─────────────────────────────────────────────────────────── */

describe("nothing leaks, at any moment of any game", () => {
  it("survives a full game audited before every action", () => {
    const { problems } = auditedGame(101);
    expect(problems).toEqual([]);
  });

  it("survives games that end every way the rules allow", () => {
    const endings = new Set<string>();
    const problems: string[] = [];

    for (const [seed, profile] of [
      [201, PROFILES.mixed],
      [202, PROFILES.agreeable],
      [203, PROFILES.contrarian],
      [204, PROFILES.passiveEvil],
      [205, PROFILES.truthfulLeft],
      [206, PROFILES.lyingRight],
    ] as const) {
      const { state } = drive({
        seed,
        agents: scriptedTable({ seed, profile }),
        override: (_observation, s) => {
          problems.push(...auditAll(s));
          return undefined;
        },
      });
      problems.push(...auditAll(state));
      endings.add(state.outcome!.reason);
    }

    expect(problems).toEqual([]);
    expect(endings.size).toBeGreaterThanOrEqual(3);
  });

  it("keeps pending votes invisible while they are being collected", () => {
    for (let taken = 1; taken <= 9; taken += 1) {
      const { state } = drive({
        seed: 300 + taken,
        deal: referenceDeal(),
        stopWhen: (s) => s.phase === "vote" && Object.keys(s.pendingVotes).length === taken,
      });
      expect(Object.keys(state.pendingVotes)).toHaveLength(taken);
      expect(auditAll(state)).toEqual([]);
      // And no vote event exists yet for anyone to read.
      const proposals = state.log.filter((e) => e.type === "proposal").length;
      const votes = state.log.filter((e) => e.type === "vote").length;
      expect(votes).toBe(proposals - 1);
    }
  });

  it("keeps quest cards invisible while they are being collected", () => {
    const { state } = drive({
      seed: 400,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          // Two villains aboard, so there is a moment with one card in and one out.
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: [...s.deal.evilSeats.slice(0, 2), s.deal.goodSeats[0]],
          };
        }
        if (observation.request?.kind === "vote") return { kind: "vote", choice: "approve" };
        return undefined;
      },
      stopWhen: (s) => s.phase === "mission" && Object.keys(s.missionCards).length === 2,
    });
    expect(auditAll(state)).toEqual([]);
    expect(state.log.some((e) => e.type === "mission_result")).toBe(false);
  });

  it("never exposes another seat's memory, even after everyone has written one", () => {
    const { state } = drive({
      seed: 500,
      deal: referenceDeal(),
      profile: PROFILES.mixed,
      stopWhen: (s) => s.missionTrack[1] !== "pending",
    });
    const written = SEATS.filter((s) => state.memory[s].version > 0);
    expect(written.length).toBeGreaterThan(0);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      expect(memoryLikeObjects(observation)).toHaveLength(1);
      expect(observation.memory).toBe(state.memory[seat]);
    }
  });

  /**
   * A memory patch is the only thing an agent can write, and it must not be
   * able to reach hard knowledge. There is no code path that would let it —
   * this asserts the behaviour that follows from that.
   */
  it("cannot overwrite a Lady result with a belief", () => {
    const { state } = drive({
      seed: 600,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: s.deal.goodSeats.slice(0, teamSize(10, s.missionNumber)),
          };
        }
        if (observation.request?.kind === "vote") return { kind: "vote", choice: "approve" };
        if (observation.request?.kind === "lady_announce") {
          const latest = observation.ladyResults[observation.ladyResults.length - 1];
          return {
            kind: "lady_announce",
            announced: latest.trueSide === "good" ? "evil" : "good",
            publicMessage: "反着说",
            // A belief that contradicts the truth, written at full confidence.
            memoryPatch: {
              beliefs: [
                {
                  seat: latest.target,
                  pEvil: latest.trueSide === "good" ? 1 : 0,
                  note: "我坚信",
                },
              ],
            },
          };
        }
        return undefined;
      },
    });

    for (const seat of SEATS) {
      for (const result of state.ladyResults[seat]) {
        const truth = state.deal.evilSeats.includes(result.target) ? "evil" : "good";
        expect(result.trueSide).toBe(truth);
      }
    }
  });
});
