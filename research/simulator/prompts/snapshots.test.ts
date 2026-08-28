import { describe, expect, it } from "vitest";
import { observationFor } from "../core/observation";
import { drive, referenceDeal } from "../fixtures/harness";
import { capturePrompts, promptFor, seatOfRole } from "../fixtures/prompt-fixtures";
import type { RoleType } from "../core/types";

/**
 * Golden prompts.
 *
 * A snapshot here is a REVIEW GATE, not a proof: it makes any change to what a
 * model is told show up as a reviewable diff rather than as a quiet shift in
 * results between two runs. That is all it does, so every snapshot below sits
 * next to an explicit assertion about the legal visibility it is supposed to
 * demonstrate — `leakage.test.ts` carries the sharp invariance tests, and
 * nothing here is allowed to stand in for them.
 *
 * Note the first run of this file CREATES the snapshots and therefore passes
 * trivially. The explicit assertions are what carry weight until a human has
 * read the generated `__snapshots__` file once.
 */

const ROLES: readonly RoleType[] = [
  "merlin",
  "percival",
  "loyal",
  "morgana",
  "assassin",
  "mordred",
  "oberon",
];

function revealPromptFor(role: RoleType, ladySide: "left" | "right") {
  const seat = seatOfRole(role);
  const { state } = drive({
    seed: 1,
    deal: referenceDeal(),
    initialLeader: seat,
    stopWhen: (s) => s.phase === "opening_direction",
  });
  void ladySide;
  return promptFor(observationFor(state, seat));
}

describe("every role's opening prompt", () => {
  for (const role of ROLES) {
    it(`${role} sees exactly what the rules give it`, () => {
      const prompt = revealPromptFor(role, "left");
      expect(prompt.fullText).toMatchSnapshot();

      // The explicit half. A snapshot alone would happily preserve a leak.
      const seat = seatOfRole(role);
      expect(prompt.fullText).toContain(`你是 ${seat}号`);
      expect(prompt.taskId).toBe("opening-direction");
      // Nothing has happened yet, so the transcript holds only the opening.
      expect(prompt.fullText).toContain("[#1]");
      expect(prompt.fullText).not.toContain("[#2]");

      switch (role) {
        case "merlin":
          // Three villains, and Mordred (seat 9) is not one of them.
          expect(prompt.fullText).toContain("你看到这些座位是坏人：7、8、10号");
          expect(prompt.fullText).not.toContain("坏人：7、8、9");
          break;
        case "percival":
          expect(prompt.fullText).toContain("1、7号 这两个人");
          expect(prompt.fullText).toContain("你分不清谁是谁");
          break;
        case "loyal":
        case "oberon":
          expect(prompt.fullText).toContain("你的身份没有给你任何关于别人的信息");
          break;
        case "morgana":
          expect(prompt.fullText).toContain("你的队友是：8、9号");
          break;
        case "assassin":
          expect(prompt.fullText).toContain("你的队友是：7、9号");
          break;
        case "mordred":
          expect(prompt.fullText).toContain("你的队友是：7、8号");
          break;
      }
      // Nobody is told the evil roster before the assassination.
      expect(prompt.fullText).not.toContain("刺杀环节的互认");
    });
  }
});

describe("every decision kind", () => {
  const { prompts } = capturePrompts();

  for (const taskId of [...prompts.keys()].sort()) {
    it(`${taskId} asks for the right shape`, () => {
      const prompt = prompts.get(taskId)!;
      expect(prompt.fullText).toMatchSnapshot();

      expect(prompt.schema.id).toBe(taskId);
      expect(prompt.fullText).toContain("## 七、现在要你做的事");
      expect(prompt.fullText).toContain("只输出这样一个 JSON 对象");
      // The example is real JSON, so a model has something unambiguous to copy.
      expect(() => JSON.parse(JSON.stringify(prompt.schema.example))).not.toThrow();
    });
  }
});

describe("both opening directions", () => {
  function afterDirection(ladySide: "left" | "right") {
    const { state } = drive({
      seed: 8,
      deal: referenceDeal(),
      initialLeader: 5,
      override: (observation) =>
        observation.request?.kind === "choose_opening_direction"
          ? { kind: "choose_opening_direction", ladySide, publicMessage: "开局。" }
          : undefined,
      stopWhen: (s) => s.phase === "discussion" && s.speechIndex === 1,
    });
    return promptFor(observationFor(state, state.pending!.seat));
  }

  it("left: the Lady goes left and play runs right", () => {
    const prompt = afterDirection("left");
    expect(prompt.fullText).toMatchSnapshot();
    expect(prompt.fullText).toContain("轮转方向：往右（座位号 −1）");
    expect(prompt.fullText).toContain("交给左手边的 6号");
    // After the leader at 5, play running right reaches seat 4.
    expect(prompt.layers[4].text).toContain("→4号");
  });

  it("right: the Lady goes right and play runs left", () => {
    const prompt = afterDirection("right");
    expect(prompt.fullText).toMatchSnapshot();
    expect(prompt.fullText).toContain("轮转方向：往左（座位号 +1）");
    expect(prompt.fullText).toContain("交给右手边的 4号");
    expect(prompt.layers[4].text).toContain("→6号");
  });
});

describe("a seat holding a private Lady result", () => {
  it("is the only one told the truth", () => {
    const { state } = drive({
      seed: 71,
      deal: referenceDeal(),
      override: (observation, s) => {
        const request = observation.request;
        if (request?.kind === "leader_close_and_propose") {
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: s.deal.goodSeats.slice(0, request.teamSize),
          };
        }
        if (request?.kind === "vote") return { kind: "vote", choice: "approve" };
        if (request?.kind === "lady_announce") {
          // Announce the OPPOSITE, so the prompt and the public log disagree.
          const latest = observation.ladyResults[observation.ladyResults.length - 1];
          return {
            kind: "lady_announce",
            announced: latest.trueSide === "good" ? "evil" : "good",
            publicMessage: "我说反话。",
          };
        }
        return undefined;
      },
      stopWhen: (s) => s.phase === "lady_announce",
    });

    const holder = state.pending!.seat;
    const prompt = promptFor(observationFor(state, holder));
    expect(prompt.fullText).toMatchSnapshot();

    const truth = state.ladyResults[holder].at(-1)!;
    expect(prompt.taskId).toBe("lady-announce");
    expect(prompt.fullText).toContain("湖中女神私下告诉你的");
    expect(prompt.fullText).toContain(
      `你验了 ${truth.target}号，裁判给你的真实答案是：**${truth.trueSide === "good" ? "好人" : "坏人"}**`,
    );
    expect(prompt.fullText).toContain("**你可以说谎。**");
  });
});
