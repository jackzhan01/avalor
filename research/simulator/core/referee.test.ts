import { describe, expect, it } from "vitest";
import { requiredFails, teamSize } from "@/lib/rules/avalon";
import { drive, referenceDeal, testConfig, textOfLength } from "../fixtures/harness";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import { applyAction, createGame, eligibleLadyTargets, speechLength } from "./referee";
import { nextSeat } from "./order";
import type { PublicEvent } from "./events";
import type { GameState } from "./state";
import { IllegalActionError, SEATS, type Action, type Seat } from "./types";

/* ── Helpers ───────────────────────────────────────────────────────────── */

function eventsOfType<T extends PublicEvent["type"]>(
  state: GameState,
  type: T,
): Extract<PublicEvent, { type: T }>[] {
  return state.log.filter((e) => e.type === type) as Extract<PublicEvent, { type: T }>[];
}

/**
 * Drive a game to an exact quest track by controlling only WHO gets on the car.
 *
 * A quest fails iff enough evil seats are aboard and play the card, so a team
 * of pure good seats is a guaranteed success (and, because the referee never
 * asks a good seat for a card, produces no mission request at all), and a team
 * carrying exactly `requiredFails` villains who all fail is a guaranteed
 * failure. That is the whole trick, and it needs no back door into the
 * referee.
 */
function scriptTrack(results: readonly ("success" | "fail")[]) {
  return (observation: { request: { kind: string } | null }, state: GameState): Action | undefined => {
    const request = observation.request;
    if (!request) return undefined;
    if (request.kind === "leader_close_and_propose") {
      const mission = state.missionNumber;
      const want = results[mission - 1] ?? "success";
      const size = teamSize(10, mission);
      const need = want === "fail" ? requiredFails(10, mission) : 0;
      const evils = state.deal.evilSeats.slice(0, need);
      const goods = state.deal.goodSeats.filter((s) => !evils.includes(s));
      return {
        kind: "leader_close_and_propose",
        publicMessage: "收尾，就这辆车。",
        team: [...evils, ...goods].slice(0, size),
      };
    }
    if (request.kind === "vote") return { kind: "vote", choice: "approve" };
    if (request.kind === "mission") return { kind: "mission", card: "fail" };
    return undefined;
  };
}

/* ── The opening ───────────────────────────────────────────────────────── */

describe("the opening direction is a decision, not a draw", () => {
  it("hands the Lady left and turns the table right", () => {
    const { state } = drive({
      seed: 1,
      deal: referenceDeal(),
      initialLeader: 5,
      override: (observation) =>
        observation.request?.kind === "choose_opening_direction"
          ? {
              kind: "choose_opening_direction",
              ladySide: "left",
              publicMessage: "往左给女神。",
            }
          : undefined,
      stopWhen: (s) => s.phase === "discussion",
    });

    expect(state.playDirection).toBe("right");
    expect(state.ladyHolder).toBe(6);
    expect(state.ladyHeldBy).toEqual([6]);
    const opening = eventsOfType(state, "opening_direction")[0];
    expect(opening.ladySide).toBe("left");
    expect(opening.playDirection).toBe("right");
    expect(opening.ladyHolder).toBe(6);
    expect(eventsOfType(state, "lady_assigned")[0].holder).toBe(6);
  });

  it("hands the Lady right and turns the table left", () => {
    const { state } = drive({
      seed: 1,
      deal: referenceDeal(),
      initialLeader: 5,
      override: (observation) =>
        observation.request?.kind === "choose_opening_direction"
          ? {
              kind: "choose_opening_direction",
              ladySide: "right",
              publicMessage: "往右给女神。",
            }
          : undefined,
      stopWhen: (s) => s.phase === "discussion",
    });

    expect(state.playDirection).toBe("left");
    expect(state.ladyHolder).toBe(4);
  });

  it("asks the seed's opening leader, and nobody else", () => {
    const state = createGame({ seed: 77, config: testConfig() });
    expect(state.pending).toEqual({
      kind: "choose_opening_direction",
      seat: state.initialLeader,
    });
    const wrongSeat = SEATS.find((s) => s !== state.initialLeader) as Seat;
    expect(() =>
      applyAction(state, wrongSeat, {
        kind: "choose_opening_direction",
        ladySide: "left",
        publicMessage: "不该我说话",
      }),
    ).toThrow(IllegalActionError);
  });
});

/* ── Discussion protocol ───────────────────────────────────────────────── */

describe("the discussion protocol", () => {
  function firstAttemptSpeeches(direction: "left" | "right") {
    const ladySide = direction === "left" ? "right" : "left";
    const { state } = drive({
      seed: 3,
      deal: referenceDeal(),
      initialLeader: 5,
      override: (observation) => {
        const request = observation.request;
        if (request?.kind === "choose_opening_direction") {
          return { kind: "choose_opening_direction", ladySide, publicMessage: "开局" };
        }
        // The eleventh turn is the combined close-and-propose, so the attempt
        // has to be played through it before all eleven speeches exist.
        if (request?.kind === "leader_close_and_propose") {
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: [1, 2, 3],
          };
        }
        return undefined;
      },
      stopWhen: (s) => s.phase === "vote",
    });
    return { state, speeches: eventsOfType(state, "speech") };
  }

  it("gives the leader two turns and every other seat one", () => {
    const { speeches } = firstAttemptSpeeches("left");
    expect(speeches).toHaveLength(11);
    const counts = new Map<Seat, number>();
    for (const s of speeches) counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1);
    expect(counts.get(5)).toBe(2);
    for (const seat of SEATS) if (seat !== 5) expect(counts.get(seat)).toBe(1);
    expect(speeches[0].slot).toBe("opening");
    expect(speeches[10].slot).toBe("closing");
    expect(speeches.slice(1, 10).every((s) => s.slot === "regular")).toBe(true);
  });

  it("runs from the adjacent seat in the play direction", () => {
    expect(firstAttemptSpeeches("left").speeches.map((s) => s.speaker)).toEqual([
      5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5,
    ]);
    expect(firstAttemptSpeeches("right").speeches.map((s) => s.speaker)).toEqual([
      5, 4, 3, 2, 1, 10, 9, 8, 7, 6, 5,
    ]);
  });

  it("keeps a tentative team separate from the authoritative one", () => {
    const { state } = drive({
      seed: 4,
      deal: referenceDeal(),
      initialLeader: 1,
      override: (observation) => {
        const request = observation.request;
        if (request?.kind === "choose_opening_direction") {
          return { kind: "choose_opening_direction", ladySide: "left", publicMessage: "开局" };
        }
        if (request?.kind === "speech") {
          return {
            kind: "speech",
            publicMessage: "我想带 1、2、3。",
            tentativeTeam: [1, 2, 3],
          };
        }
        if (request?.kind === "leader_close_and_propose") {
          // Said 1/2/3, actually takes 4/5/6. Both must survive in the log.
          return {
            kind: "leader_close_and_propose",
            publicMessage: "改主意了，我带 4、5、6。",
            team: [4, 5, 6],
          };
        }
        return undefined;
      },
      stopWhen: (s) => s.phase === "vote",
    });

    const speeches = eventsOfType(state, "speech");
    // The ten ordinary turns floated 1/2/3; the closing turn carries no
    // tentative team because it comes bundled with the authoritative one.
    expect(speeches.slice(0, 10).every((s) => s.tentativeTeam?.join() === "1,2,3")).toBe(true);
    expect(speeches[10].slot).toBe("closing");
    expect(speeches[10].tentativeTeam).toBeNull();
    expect(eventsOfType(state, "proposal")[0].team).toEqual([4, 5, 6]);
  });

  it("lets the leader say they cannot form a car", () => {
    const { state } = drive({
      seed: 4,
      deal: referenceDeal(),
      initialLeader: 1,
      override: (observation) => {
        const request = observation.request;
        if (request?.kind === "choose_opening_direction") {
          return { kind: "choose_opening_direction", ladySide: "left", publicMessage: "开局" };
        }
        if (request?.kind === "speech" && request.slot === "opening") {
          return { kind: "speech", publicMessage: "现在还组不出车。", noTeamYet: true };
        }
        return undefined;
      },
      stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
    });
    const opening = eventsOfType(state, "speech")[0];
    expect(opening.noTeamYet).toBe(true);
    expect(opening.tentativeTeam).toBeNull();
  });

  it("refuses a tentative team and a no-team claim at once", () => {
    expect(() =>
      drive({
        seed: 4,
        deal: referenceDeal(),
        override: (observation) => {
          const request = observation.request;
          if (request?.kind === "choose_opening_direction") {
            return { kind: "choose_opening_direction", ladySide: "left", publicMessage: "开局" };
          }
          if (request?.kind === "speech") {
            return {
              kind: "speech",
              publicMessage: "自相矛盾",
              noTeamYet: true,
              tentativeTeam: [1, 2, 3],
            };
          }
          return undefined;
        },
      }),
    ).toThrow(/还组不出车/);
  });
});

/* ── Speech length ─────────────────────────────────────────────────────── */

describe("the 220-character speech limit", () => {
  it("counts non-whitespace code points", () => {
    expect(speechLength("")).toBe(0);
    expect(speechLength("   \n\t  ")).toBe(0);
    expect(speechLength("我 是 三 号")).toBe(4);
    // One code point, not two UTF-16 units.
    expect(speechLength("😀")).toBe(1);
    expect(speechLength("　全角空格")).toBe(4);
  });

  function openingWith(message: string) {
    const state = createGame({ seed: 9, config: testConfig(), deal: referenceDeal() });
    const seat = state.pending!.seat;
    return () =>
      applyAction(state, seat, {
        kind: "choose_opening_direction",
        ladySide: "left",
        publicMessage: message,
      });
  }

  it("accepts exactly 220", () => {
    expect(openingWith(textOfLength(220))).not.toThrow();
  });

  it("rejects 221 rather than truncating it", () => {
    const state = createGame({ seed: 9, config: testConfig(), deal: referenceDeal() });
    const seat = state.pending!.seat;
    const before = state.log.length;
    let error: unknown;
    try {
      applyAction(state, seat, {
        kind: "choose_opening_direction",
        ladySide: "left",
        publicMessage: textOfLength(221),
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(IllegalActionError);
    expect((error as IllegalActionError).code).toBe("speech_too_long");
    // Nothing was written, and nothing was silently shortened. The state is
    // exactly where it was, so a caller can repair and retry.
    expect(state.log).toHaveLength(before);
    expect(state.playDirection).toBeNull();
  });

  it("ignores whitespace, so a padded speech is not penalised", () => {
    expect(openingWith(textOfLength(220).split("").join(" "))).not.toThrow();
  });

  it("gives the leader an independent budget for the closing speech", () => {
    const long = textOfLength(220);
    const { state } = drive({
      seed: 12,
      deal: referenceDeal(),
      initialLeader: 1,
      override: (observation) => {
        const request = observation.request;
        if (request?.kind === "choose_opening_direction") {
          return { kind: "choose_opening_direction", ladySide: "left", publicMessage: long };
        }
        if (request?.kind === "speech") {
          return { kind: "speech", publicMessage: long };
        }
        if (request?.kind === "leader_close_and_propose") {
          return {
            kind: "leader_close_and_propose",
            publicMessage: long,
            team: [1, 2, 3],
          };
        }
        return undefined;
      },
      stopWhen: (s) => s.phase === "vote",
    });
    const speeches = eventsOfType(state, "speech").filter((s) => s.speaker === 1);
    expect(speeches).toHaveLength(2);
    // 440 characters across two turns, both accepted, because the budgets do
    // not pool — and unused room does not carry over either.
    expect(speeches.every((s) => speechLength(s.publicMessage) === 220)).toBe(true);
  });

  it("applies to the Lady announcement and the evil discussion too", () => {
    const state = createGame({ seed: 5, config: testConfig(), deal: referenceDeal() });
    // Reach a Lady announcement through the ordinary path.
    const driven = drive({
      seed: 5,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
      stopWhen: (s) => s.phase === "lady_announce",
    });
    const holder = driven.state.pending!.seat;
    expect(() =>
      applyAction(driven.state, holder, {
        kind: "lady_announce",
        announced: "good",
        publicMessage: textOfLength(221),
      }),
    ).toThrow(/上限是 220/);
    void state;
  });
});

/* ── Proposals, votes, quests ──────────────────────────────────────────── */

describe("the leader's closing speech and car are one decision", () => {
  const close = (team: readonly Seat[], message = "收尾。"): Action => ({
    kind: "leader_close_and_propose",
    publicMessage: message,
    team,
  });

  it("asks the leader for both at once, and never asks separately", () => {
    const { state } = drive({
      seed: 6,
      deal: referenceDeal(),
      stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
    });
    expect(state.pending).toEqual({
      kind: "leader_close_and_propose",
      seat: state.leader,
      teamSize: 3,
    });
    // There is no separate propose request anywhere in the machine, so the
    // eleventh turn is the only place a car can enter the game.
    expect(state.speakingOrder[state.speechIndex].slot).toBe("closing");
  });

  it("publishes the closing speech and then the proposal, in that order", () => {
    const { state } = drive({
      seed: 6,
      deal: referenceDeal(),
      override: (observation) =>
        observation.request?.kind === "leader_close_and_propose"
          ? close([1, 2, 3], "就带这三个。")
          : undefined,
      stopWhen: (s) => s.phase === "vote",
    });
    const speech = eventsOfType(state, "speech").at(-1)!;
    const proposal = eventsOfType(state, "proposal")[0];
    expect(speech.slot).toBe("closing");
    expect(speech.publicMessage).toBe("就带这三个。");
    expect(proposal.team).toEqual([1, 2, 3]);
    // Two distinct public facts, and the speech comes first.
    expect(speech.sequence).toBeLessThan(proposal.sequence);
  });

  it("demands the mission's exact team size", () => {
    const { state } = drive({
      seed: 6,
      deal: referenceDeal(),
      stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
    });
    const leader = state.leader;
    expect(() => applyAction(state, leader, close([1, 2]))).toThrow(/要 3 个人上车/);
    expect(() => applyAction(state, leader, close([1, 2, 3, 4]))).toThrow(/要 3 个人上车/);
    expect(() => applyAction(state, leader, close([1, 2, 2]))).toThrow(IllegalActionError);
    expect(() =>
      applyAction(state, leader, close([1, 2, 11] as unknown as Seat[])),
    ).toThrow(IllegalActionError);
  });

  it("writes neither half when either half is illegal", () => {
    const { state } = drive({
      seed: 6,
      deal: referenceDeal(),
      stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
    });
    const before = state.log.length;
    const leader = state.leader;

    // A legal speech with an illegal car: the speech must not survive.
    expect(() => applyAction(state, leader, close([1, 2]))).toThrow();
    expect(state.log).toHaveLength(before);

    // A legal car with an over-long speech: the proposal must not survive.
    expect(() => applyAction(state, leader, close([1, 2, 3], textOfLength(221)))).toThrow(
      /上限是 220/,
    );
    expect(state.log).toHaveLength(before);
    expect(state.proposedTeam).toBeNull();
    expect(state.phase).toBe("discussion");
  });

  it("uses 3/4/4/5/5 across a full-length game", () => {
    const seen = new Map<number, number>();
    const { state } = drive({
      seed: 21,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          seen.set(s.missionNumber, observation.request.teamSize);
        }
        return scriptTrack(["success", "fail", "success", "fail", "fail"])(observation, s);
      },
    });
    expect([...seen.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 3],
      [2, 4],
      [3, 4],
      [4, 5],
      [5, 5],
    ]);
    expect(state.outcome?.winner).toBe("evil");
    expect(state.outcome?.reason).toBe("missions_evil");
  });
});

describe("voting", () => {
  it("needs a strict majority, so 5-5 is a rejection", () => {
    const approvers = new Set<Seat>([1, 2, 3, 4, 5]);
    const { state } = drive({
      seed: 8,
      deal: referenceDeal(),
      override: (observation) =>
        observation.request?.kind === "vote"
          ? {
              kind: "vote",
              choice: approvers.has(observation.seat) ? "approve" : "reject",
            }
          : undefined,
      stopWhen: (s) => s.log.some((e) => e.type === "vote"),
    });
    const vote = eventsOfType(state, "vote")[0];
    expect(vote.approvals).toBe(5);
    expect(vote.result).toBe("rejected");
  });

  it("passes at six", () => {
    const approvers = new Set<Seat>([1, 2, 3, 4, 5, 6]);
    const { state } = drive({
      seed: 8,
      deal: referenceDeal(),
      override: (observation) =>
        observation.request?.kind === "vote"
          ? {
              kind: "vote",
              choice: approvers.has(observation.seat) ? "approve" : "reject",
            }
          : undefined,
      stopWhen: (s) => s.log.some((e) => e.type === "vote"),
    });
    expect(eventsOfType(state, "vote")[0].result).toBe("passed");
  });

  it("keeps every vote hidden until all ten are in", () => {
    const { state } = drive({
      seed: 8,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "vote" && Object.keys(s.pendingVotes).length === 4,
    });
    // Four seats have voted; the table knows nothing.
    expect(Object.keys(state.pendingVotes)).toHaveLength(4);
    expect(eventsOfType(state, "vote")).toHaveLength(0);
  });

  it("refuses a second vote from the same seat", () => {
    const { state } = drive({
      seed: 8,
      deal: referenceDeal(),
      stopWhen: (s) => s.phase === "vote" && Object.keys(s.pendingVotes).length === 1,
    });
    const alreadyVoted = Number(Object.keys(state.pendingVotes)[0]) as Seat;
    expect(() => applyAction(state, alreadyVoted, { kind: "vote", choice: "approve" })).toThrow(
      IllegalActionError,
    );
  });

  it("hands evil the game after five consecutive rejections", () => {
    const { state } = drive({
      seed: 15,
      deal: referenceDeal(),
      agents: scriptedTable({ seed: 15, profile: PROFILES.contrarian }),
    });
    expect(state.outcome).toMatchObject({ winner: "evil", reason: "rejection_limit" });
    const votes = eventsOfType(state, "vote");
    expect(votes).toHaveLength(5);
    expect(votes.every((v) => v.result === "rejected")).toBe(true);
    expect(state.missionNumber).toBe(1);
    // Four rotations: the fifth rejection ends it before the car moves again.
    expect(eventsOfType(state, "leader_change")).toHaveLength(4);
  });

  it("rotates the leader in the fixed play direction", () => {
    const { state } = drive({
      seed: 15,
      deal: referenceDeal(),
      agents: scriptedTable({ seed: 15, profile: PROFILES.contrarian }),
    });
    const direction = state.playDirection!;
    for (const change of eventsOfType(state, "leader_change")) {
      expect(change.to).toBe(nextSeat(change.from, direction));
    }
  });
});

describe("quests", () => {
  it("needs two fail cards on the fourth, and one everywhere else", () => {
    expect(requiredFails(10, 4)).toBe(2);
    for (const mission of [1, 2, 3, 5]) expect(requiredFails(10, mission)).toBe(1);
  });

  it("survives a single fail card on the fourth quest", () => {
    const { state } = drive({
      seed: 31,
      deal: referenceDeal(),
      override: (observation, s) => {
        const request = observation.request;
        if (request?.kind === "leader_close_and_propose" && s.missionNumber === 4) {
          // Exactly one villain aboard, so one card comes back and the quest
          // still holds — the rule that makes the fourth quest different.
          const team = [s.deal.evilSeats[0], ...s.deal.goodSeats].slice(0, 5);
          return { kind: "leader_close_and_propose", publicMessage: "收尾。", team };
        }
        return scriptTrack(["success", "fail", "success"])(observation, s);
      },
      stopWhen: (s) => s.missionTrack[3] !== "pending",
    });
    const fourth = eventsOfType(state, "mission_result").find((e) => e.missionNumber === 4)!;
    expect(fourth.failCount).toBe(1);
    expect(fourth.result).toBe("success");
  });

  it("sinks on two", () => {
    const { state } = drive({
      seed: 31,
      deal: referenceDeal(),
      override: scriptTrack(["success", "fail", "success", "fail"]),
      stopWhen: (s) => s.missionTrack[3] !== "pending",
    });
    const fourth = eventsOfType(state, "mission_result").find((e) => e.missionNumber === 4)!;
    expect(fourth.failCount).toBe(2);
    expect(fourth.result).toBe("fail");
  });

  it("publishes the count but never who played what", () => {
    const { state } = drive({
      seed: 33,
      deal: referenceDeal(),
      override: scriptTrack(["fail", "fail", "fail"]),
    });
    for (const event of eventsOfType(state, "mission_result")) {
      expect(Object.keys(event).sort()).toEqual(
        ["attempt", "failCount", "missionNumber", "result", "sequence", "team", "type"].sort(),
      );
    }
    // And the referee's own record is emptied once the quest resolves.
    expect(Object.keys(state.missionCards)).toHaveLength(0);
  });

  it("never asks a good seat for a card", () => {
    const requests: Seat[] = [];
    const { state } = drive({
      seed: 44,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "mission") requests.push(observation.seat);
        return scriptTrack(["fail", "fail", "fail"])(observation, s);
      },
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const seat of requests) expect(state.deal.evilSeats).toContain(seat);
  });

  /**
   * White-box on purpose. The referee pre-fills good cards precisely so this
   * situation cannot arise through the front door, but the guard still has to
   * exist — a future change to who gets asked must not be able to legalise a
   * good player failing a quest.
   */
  it("rejects a fail card from a good seat if one ever arrived", () => {
    const { state } = drive({
      seed: 44,
      deal: referenceDeal(),
      override: scriptTrack(["fail"]),
      stopWhen: (s) => s.phase === "mission",
    });
    const goodAboard = (state.proposedTeam ?? []).find((seat) =>
      state.deal.goodSeats.includes(seat),
    )!;
    delete state.missionCards[goodAboard];
    state.pending = { kind: "mission", seat: goodAboard };

    let error: unknown;
    try {
      applyAction(state, goodAboard, { kind: "mission", card: "fail" });
    } catch (err) {
      error = err;
    }
    expect((error as IllegalActionError).code).toBe("good_cannot_fail");
    expect(state.missionCards[goodAboard]).toBeUndefined();

    // The legal card is accepted.
    expect(() =>
      applyAction(state, goodAboard, { kind: "mission", card: "success" }),
    ).not.toThrow();
  });

  it("refuses a card from a seat that is not aboard", () => {
    const { state } = drive({
      seed: 44,
      deal: referenceDeal(),
      override: scriptTrack(["fail"]),
      stopWhen: (s) => s.phase === "mission",
    });
    const asked = state.pending!.seat;
    const notAboard = SEATS.find((s) => !(state.proposedTeam ?? []).includes(s))!;
    state.pending = { kind: "mission", seat: notAboard };
    expect(() => applyAction(state, notAboard, { kind: "mission", card: "fail" })).toThrow(
      /不在车上/,
    );
    void asked;
  });
});

/* ── Lady of the Lake ──────────────────────────────────────────────────── */

describe("the Lady of the Lake", () => {
  it("is used only after quests two, three and four", () => {
    const { state } = drive({
      seed: 51,
      deal: referenceDeal(),
      override: scriptTrack(["success", "fail", "success", "fail", "fail"]),
    });
    const announcements = eventsOfType(state, "lady_announced");
    expect(announcements).toHaveLength(3);
    expect(announcements.map((e) => e.missionNumber)).toEqual([2, 3, 4]);
    expect(state.ladyChecks).toBe(3);
  });

  it("shows the holder a true side, and only a side", () => {
    const { state } = drive({
      seed: 52,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
    });
    for (const result of state.privateLog.filter((e) => e.type === "lady_result")) {
      if (result.type !== "lady_result") continue;
      const truth = state.deal.evilSeats.includes(result.target) ? "evil" : "good";
      expect(result.trueSide).toBe(truth);
      // A side, never a role. Percival being shown "morgana" would end the game.
      expect(Object.keys(result)).not.toContain("role");
      expect(["good", "evil"]).toContain(result.trueSide);
    }
  });

  it("keeps the private result out of the public log", () => {
    const { state } = drive({
      seed: 52,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
    });
    expect(state.privateLog.some((e) => e.type === "lady_result")).toBe(true);
    expect(state.log.some((e) => (e as { type: string }).type === "lady_result")).toBe(false);
  });

  it("lets the holder lie in public without touching the truth", () => {
    const { state } = drive({
      seed: 53,
      deal: referenceDeal(),
      override: (observation, s) => {
        if (observation.request?.kind === "lady_announce") {
          const latest = observation.ladyResults[observation.ladyResults.length - 1];
          return {
            kind: "lady_announce",
            announced: latest.trueSide === "good" ? "evil" : "good",
            publicMessage: "我说的是反话。",
          };
        }
        return scriptTrack(["success", "success", "success"])(observation, s);
      },
    });

    const announcements = eventsOfType(state, "lady_announced");
    expect(announcements.length).toBeGreaterThan(0);
    for (const said of announcements) {
      const truth = state.deal.evilSeats.includes(said.target) ? "evil" : "good";
      expect(said.announced).not.toBe(truth);
      // The private record still says what was actually shown.
      const record = state.ladyResults[said.holder].find((r) => r.target === said.target)!;
      expect(record.trueSide).toBe(truth);
    }
  });

  it("passes the token to the examined seat", () => {
    const { state } = drive({
      seed: 54,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
    });
    const transfers = eventsOfType(state, "lady_transferred");
    const announcements = eventsOfType(state, "lady_announced");
    expect(transfers).toHaveLength(announcements.length);
    transfers.forEach((transfer, i) => {
      expect(transfer.from).toBe(announcements[i].holder);
      expect(transfer.to).toBe(announcements[i].target);
    });
    expect(state.ladyHolder).toBe(transfers[transfers.length - 1].to);
  });

  it("will not examine the holder or anyone who has held the token", () => {
    const { state } = drive({
      seed: 55,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
      stopWhen: (s) => s.phase === "lady_select" && s.ladyChecks === 1,
    });
    const holder = state.pending!.seat;
    const eligible = eligibleLadyTargets(state);
    expect(eligible).not.toContain(holder);
    for (const past of state.ladyHeldBy) expect(eligible).not.toContain(past);
    expect(state.ladyHeldBy.length).toBeGreaterThanOrEqual(2);

    expect(() => applyAction(state, holder, { kind: "lady_select", target: holder })).toThrow(
      /不能被验/,
    );
    const past = state.ladyHeldBy.find((s) => s !== holder)!;
    expect(() => applyAction(state, holder, { kind: "lady_select", target: past })).toThrow(
      /不能被验/,
    );
  });

  it("never gives the token to the same seat twice", () => {
    for (let seed = 60; seed < 90; seed += 1) {
      const { state } = drive({ seed, deal: referenceDeal(), profile: PROFILES.passiveEvil });
      expect(new Set(state.ladyHeldBy).size).toBe(state.ladyHeldBy.length);
    }
  });

  /**
   * The ordering that is easy to get backwards: good's third success does not
   * end the game, and a Lady check owed after that same quest happens BEFORE
   * the assassin decides.
   */
  it("resolves a due check before the assassination", () => {
    const { state } = drive({
      seed: 56,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
    });
    expect(state.successes).toBe(3);
    const thirdQuestCheck = eventsOfType(state, "lady_announced").find(
      (e) => e.missionNumber === 3,
    );
    expect(thirdQuestCheck).toBeDefined();
    const strike = eventsOfType(state, "assassination_target")[0];
    expect(strike).toBeDefined();
    expect(thirdQuestCheck!.sequence).toBeLessThan(strike.sequence);
    // Two checks, after quests two and three, and neither after the game ended.
    expect(state.ladyChecks).toBe(2);
  });

  it("is skipped entirely when evil takes the third quest", () => {
    const { state } = drive({
      seed: 57,
      deal: referenceDeal(),
      override: scriptTrack(["fail", "fail", "fail"]),
    });
    expect(state.outcome).toMatchObject({ winner: "evil", reason: "missions_evil" });
    // A check was owed after quest two and happened; the one owed after quest
    // three never does, because the game was already over.
    expect(state.ladyChecks).toBe(1);
    expect(eventsOfType(state, "lady_announced").map((e) => e.missionNumber)).toEqual([2]);
  });
});

/* ── Assassination ─────────────────────────────────────────────────────── */

describe("the assassination", () => {
  function playToAssassination(seed: number) {
    return drive({
      seed,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
    });
  }

  it("reveals exact evil roles to all four villains, Oberon included", () => {
    const { state } = playToAssassination(70);
    const reveal = state.privateLog.find((e) => e.type === "evil_reveal");
    expect(reveal).toBeDefined();
    if (reveal?.type !== "evil_reveal") throw new Error("unreachable");
    expect([...reveal.audience].sort((a, b) => a - b)).toEqual(
      [...state.deal.evilSeats].sort((a, b) => a - b),
    );
    expect(reveal.audience).toContain(state.deal.oberon);
    expect(reveal.roster.map((r) => r.role).sort()).toEqual(
      ["assassin", "mordred", "morgana", "oberon"].sort(),
    );
  });

  it("gives each villain one message, in seat order, Oberon included", () => {
    const { state } = playToAssassination(70);
    const lines = state.privateLog.filter((e) => e.type === "evil_discussion");
    expect(lines).toHaveLength(4);
    const speakers = lines.map((e) => (e.type === "evil_discussion" ? e.speaker : 0));
    expect(speakers).toEqual([...state.deal.evilSeats].sort((a, b) => a - b));
    expect(speakers).toContain(state.deal.oberon);
  });

  it("keeps the evil discussion out of the public log", () => {
    const { state } = playToAssassination(70);
    expect(state.log.some((e) => (e as { type: string }).type === "evil_discussion")).toBe(
      false,
    );
    expect(state.log.some((e) => (e as { type: string }).type === "evil_reveal")).toBe(false);
  });

  it("lets only the assassin strike, and not at himself", () => {
    const { state } = drive({
      seed: 71,
      deal: referenceDeal(),
      override: scriptTrack(["success", "success", "success"]),
      stopWhen: (s) => s.phase === "assassination_strike",
    });
    expect(state.pending).toEqual({ kind: "assassinate", seat: state.deal.assassin });
    expect(() =>
      applyAction(state, state.deal.assassin, {
        kind: "assassinate",
        target: state.deal.assassin,
      }),
    ).toThrow(/不能刺自己/);
  });

  it("hands evil the game when it finds Merlin", () => {
    const { state } = drive({
      seed: 72,
      deal: referenceDeal(),
      override: (observation, s) =>
        observation.request?.kind === "assassinate"
          ? { kind: "assassinate", target: s.deal.merlin }
          : scriptTrack(["success", "success", "success"])(observation, s),
    });
    expect(state.outcome).toMatchObject({ winner: "evil", reason: "assassin_hit" });
    expect(state.outcome?.assassinTarget).toBe(state.deal.merlin);
  });

  it("leaves good the winner when it does not", () => {
    const { state } = drive({
      seed: 72,
      deal: referenceDeal(),
      override: (observation, s) =>
        observation.request?.kind === "assassinate"
          ? {
              kind: "assassinate",
              target: s.deal.goodSeats.find((seat) => seat !== s.deal.merlin)!,
            }
          : scriptTrack(["success", "success", "success"])(observation, s),
    });
    expect(state.outcome).toMatchObject({ winner: "good", reason: "assassin_missed" });
  });

  it("reveals the whole deal in the final event, and only there", () => {
    const { state } = playToAssassination(73);
    const end = eventsOfType(state, "game_end")[0];
    expect(end.reveal).toEqual(state.deal.bySeat);
    const others = state.log.filter((e) => e.type !== "game_end");
    expect(others.some((e) => "reveal" in e)).toBe(false);
  });
});

/* ── General ───────────────────────────────────────────────────────────── */

describe("the referee rejects rather than warns", () => {
  it("refuses an action from the wrong seat", () => {
    const { state } = drive({ seed: 80, deal: referenceDeal(), stopWhen: (s) => s.phase === "vote" });
    const wrong = SEATS.find((s) => s !== state.pending!.seat)!;
    expect(() => applyAction(state, wrong, { kind: "vote", choice: "approve" })).toThrow(
      IllegalActionError,
    );
  });

  it("refuses an action of the wrong kind", () => {
    const { state } = drive({ seed: 80, deal: referenceDeal(), stopWhen: (s) => s.phase === "vote" });
    expect(() =>
      applyAction(state, state.pending!.seat, {
        kind: "leader_close_and_propose",
        publicMessage: "不该我说",
        team: [1, 2, 3],
      }),
    ).toThrow(IllegalActionError);
  });

  it("refuses anything at all once the game is over", () => {
    const { state } = drive({
      seed: 81,
      deal: referenceDeal(),
      override: scriptTrack(["fail", "fail", "fail"]),
    });
    expect(state.pending).toBeNull();
    expect(() => applyAction(state, 1, { kind: "vote", choice: "approve" })).toThrow(
      /已经结束/,
    );
  });

  it("numbers events monotonically across both streams and never reuses one", () => {
    const { state } = drive({
      seed: 82,
      deal: referenceDeal(),
      override: scriptTrack(["success", "fail", "success", "fail", "fail"]),
    });
    const sequences = [...state.log, ...state.privateLog]
      .map((e) => e.sequence)
      .sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(1);
    expect(sequences[sequences.length - 1]).toBe(state.sequence);
    // No timestamps exist to sort by, which is the strongest form of the
    // repository's "order by sequence, never by clock" rule.
    expect(state.log.some((e) => "timestamp" in e)).toBe(false);
  });
});
