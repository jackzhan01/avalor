import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { requiredFails } from "@/lib/rules/avalon";
import { dealFromAssignment, type Deal } from "./deal";
import { observationFor } from "./observation";
import { applyAction, createGame } from "./referee";
import { SEATS, type Seat } from "./types";
import { REFERENCE_ASSIGNMENT, drive, testConfig } from "../fixtures/harness";
import {
  COORDINATION_PRIORITY,
  DESIGNATE_LOWEST_PRIORITY_FIRST,
  coordinationFor,
  coordinationViolation,
  orderedRiders,
  renderMissionCoordination,
} from "./evil-coordination";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { CognitionStore } from "../cognition/store";
import { buildSpokespersonPrompt, publicTableViewFor } from "../cognition/spokesperson";
import { channelForTask, sanitiseIntent } from "../cognition/firewall";
import { buildFactRegistry } from "../cognition/fact-ids";
import { claimContestFrom } from "../cognition/claim-contest";
import { claimsFrom, publicFactsFrom } from "../cognition/ledger";
import { personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_M54 } from "../prompts/version";
import type { CommunicationIntent } from "../cognition/intent";

/**
 * The evil mission-card coordination convention.
 *
 * WHAT IT IS FOR, in one measurement: seed 1's second mission produced THREE
 * fail cards on a four-person team that needed one. The referee then wrote
 * 「1–4 里至少有 3 个坏人」 into the public fact table, and good spent the rest
 * of the game organising around it. That is the evil team publishing its own
 * roster through the one channel nobody can dispute.
 *
 * WHAT IT IS NOT. It is not a referee rule — any fail card is still legal, and
 * `applyAction` still takes it. It is not a script — a designated rider may
 * play SUCCESS to hide. And it does not touch proposals, votes, speech, claims
 * or the assassination.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("coordination tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

/** Reference deal: 7 Morgana, 8 Assassin, 9 Mordred, 10 Oberon. */
const DEAL = dealWith({});

/**
 * The deal the two M5.3 live games actually ran, so the seed-1 R2 shape can be
 * checked against the seats it really involved.
 */
const LIVE_DEAL = dealFromAssignment({
  1: "loyal",
  2: "assassin",
  3: "mordred",
  4: "oberon",
  5: "loyal",
  6: "loyal",
  7: "morgana",
  8: "percival",
  9: "merlin",
  10: "loyal",
});

function coordination(seat: Seat, team: readonly Seat[], missionNumber = 1) {
  return coordinationFor({
    deal: DEAL,
    seat,
    team,
    missionNumber,
    failsRequired: requiredFails(10, missionNumber),
  });
}

/* ── The order ──────────────────────────────────────────────────────────── */

describe("固定优先级：刺客 → 莫甘娜 → 莫德雷德（数字大的先动）", () => {
  it("常量就是这三个，奥伯伦不在里面，而且是数字大的先动", () => {
    expect(COORDINATION_PRIORITY).toEqual({ mordred: 1, morgana: 2, assassin: 3 });
    expect(Object.keys(COORDINATION_PRIORITY)).not.toContain("oberon");
    // The direction. This one line is the whole correction, and it fails under
    // the previous implementation.
    expect(DESIGNATE_LOWEST_PRIORITY_FIRST).toBe(false);
  });

  it("排序只看身份，不看座位号", () => {
    // Seats 7 (Morgana, 2), 8 (Assassin, 3), 9 (Mordred, 1). Seat order is
    // 7,8,9; priority order is 8,7,9 — largest number first.
    expect(orderedRiders(DEAL, [7, 8, 9]).map((r) => r.seat)).toEqual([8, 7, 9]);
    expect(orderedRiders(DEAL, [9, 8, 7]).map((r) => r.seat)).toEqual([8, 7, 9]);
  });

  it("奥伯伦从来不进这份名单", () => {
    expect(orderedRiders(DEAL, [7, 8, 9, 10]).map((r) => r.seat)).toEqual([8, 7, 9]);
    expect(orderedRiders(DEAL, [10]).map((r) => r.seat)).toEqual([]);
  });
});

/* ── Designation, the cases the milestone names ─────────────────────────── */

describe("指定出牌人", () => {
  it("**刺客 + 莫甘娜 + 莫德雷德 同在一辆一票车：只有刺客被指定**", () => {
    // The table owner's rule: the largest priority number owns the sabotage
    // decision. Fails under the previous (reversed) implementation, which
    // designated Mordred.
    const team: Seat[] = [7, 8, 9, 5];
    const assassin = coordination(8, team)!;
    expect(assassin.failsRequired).toBe(1);
    expect(assassin.designatedCount).toBe(1);
    expect(assassin.designated).toBe(true);
    expect(assassin.riders.map((r) => r.seat)).toEqual([8, 7, 9]);
    expect(coordination(7, team)!.designated).toBe(false);
    expect(coordination(9, team)!.designated).toBe(false);
  });

  it("莫甘娜 + 刺客：刺客被指定，莫甘娜不是", () => {
    const team: Seat[] = [7, 8, 5];
    expect(coordination(8, team)!.designated).toBe(true);
    expect(coordination(7, team)!.designated).toBe(false);
  });

  it("莫甘娜 + 莫德雷德，没有刺客：只有莫甘娜被指定", () => {
    const team: Seat[] = [7, 9, 5];
    expect(coordination(7, team)!.designated).toBe(true);
    expect(coordination(9, team)!.designated).toBe(false);
  });

  it("莫德雷德单独一个：他就是指定出牌人", () => {
    const team: Seat[] = [9, 5, 6];
    const c = coordination(9, team)!;
    expect(c.designated).toBe(true);
    expect(c.riders).toHaveLength(1);
  });

  it("刺客单独一个：他就是指定出牌人", () => {
    const team: Seat[] = [8, 5, 6];
    expect(coordination(8, team)!.designated).toBe(true);
  });

  it("**两票车：数字最大的两个被指定 —— 刺客与莫甘娜，莫德雷德不是**", () => {
    // Mission 4 in a ten-player game needs two fails.
    const team: Seat[] = [7, 8, 9, 5, 6];
    const assassin = coordination(8, team, 4)!;
    expect(assassin.failsRequired).toBe(2);
    expect(assassin.designatedCount).toBe(2);
    expect(assassin.designated).toBe(true);
    expect(coordination(7, team, 4)!.designated).toBe(true);
    // Mordred, priority 1, is the reserve.
    expect(coordination(9, team, 4)!.designated).toBe(false);
  });

  it("互认坏人比需要的失败票还少：他们全部被指定", () => {
    const team: Seat[] = [9, 5, 6, 1, 2];
    const c = coordination(9, team, 4)!;
    // Mordred alone is designated even though he is priority 1: there is
    // nobody higher to take the decision.
    expect(c.failsRequired).toBe(2);
    expect(c.riders).toHaveLength(1);
    expect(c.designatedCount).toBe(1);
    expect(c.designated).toBe(true);
  });
});

/* ── What the convention refuses, and what it leaves alone ──────────────── */

describe("违规判定", () => {
  it("非指定的互认坏人出 fail = 具名违规", () => {
    const team: Seat[] = [7, 8, 9, 5];
    const v = coordinationViolation(coordination(9, team), "fail");
    expect(v).not.toBeNull();
    expect(v).toContain("坏人协调违规");
    expect(v).toContain("8号");
    expect(v).toContain("刺客 → 莫甘娜 → 莫德雷德");
    expect(v).toContain("改出 success");
  });

  it("非指定的出 success = 合规", () => {
    const team: Seat[] = [7, 8, 9, 5];
    expect(coordinationViolation(coordination(9, team), "success")).toBeNull();
  });

  it("**指定出牌人可以故意出 success 来藏自己**", () => {
    // The convention makes a line available; it does not remove one.
    const team: Seat[] = [8, 5, 6];
    const c = coordination(8, team)!;
    expect(c.designated).toBe(true);
    expect(coordinationViolation(c, "success")).toBeNull();
    expect(coordinationViolation(c, "fail")).toBeNull();
  });

  it("没有协调上下文的座位，怎么出都不违规", () => {
    // Oberon and every good seat. The referee still governs legality.
    expect(coordinationViolation(null, "fail")).toBeNull();
    expect(coordinationViolation(null, "success")).toBeNull();
  });
});

/* ── Oberon stays independent ───────────────────────────────────────────── */

describe("奥伯伦", () => {
  it("拿不到任何协调上下文", () => {
    const team: Seat[] = [7, 8, 9, 10];
    expect(coordination(10, team)).toBeNull();
  });

  it("互认的坏人也不会从名单里知道他在车上", () => {
    const team: Seat[] = [7, 8, 9, 10];
    for (const seat of [7, 8, 9] as Seat[]) {
      const c = coordination(seat, team)!;
      expect(c.riders.map((r) => r.seat)).not.toContain(10);
      expect(JSON.stringify(c)).not.toContain("oberon");
      expect(renderMissionCoordination(c)).not.toContain("10号");
    }
  });

  it("**他仍然可以自己多出一张失败票 —— 这是故意保留的**", () => {
    // Nothing suppresses it, and the designated rider is warned that the count
    // may come out higher than agreed.
    const team: Seat[] = [7, 8, 9, 10];
    expect(coordinationViolation(coordination(10, team), "fail")).toBeNull();
    expect(renderMissionCoordination(coordination(8, team)!)).toContain(
      "结算出来的失败票可能比你们商定的多",
    );
  });
});

/* ── The seed-1 R2 shape ────────────────────────────────────────────────── */

describe("seed 1 的第二轮那个形状不会再出现三张失败票", () => {
  it("**1、2、3、4 上车时：刺客指定，莫德雷德必须出成功，奥伯伦独立**", () => {
    // The historical shape: seats 1(loyal) 2(assassin) 3(mordred) 4(oberon) on
    // a mission needing one fail. All three villains sabotaged, and the
    // resulting `f.fail2` told the table 1–4 held at least three of them.
    const team: Seat[] = [1, 2, 3, 4];
    expect(requiredFails(10, 2)).toBe(1);

    const live = (seat: Seat) =>
      coordinationFor({
        deal: LIVE_DEAL,
        seat,
        team,
        missionNumber: 2,
        failsRequired: requiredFails(10, 2),
      });

    // seat 2 Assassin: designated; may choose FAIL or SUCCESS.
    const assassin = live(2)!;
    expect(assassin.designated).toBe(true);
    expect(assassin.riders.map((r) => r.seat)).toEqual([2, 3]);
    expect(coordinationViolation(assassin, "fail")).toBeNull();
    expect(coordinationViolation(assassin, "success")).toBeNull();

    // seat 3 Mordred: non-designated; must play SUCCESS.
    const mordred = live(3)!;
    expect(mordred.designated).toBe(false);
    expect(coordinationViolation(mordred, "fail")).not.toBeNull();
    expect(coordinationViolation(mordred, "success")).toBeNull();

    // Oberon is untouched — he may still add one, and the fail count may come
    // out at two rather than the one the convention arranged.
    expect(live(4)).toBeNull();
    expect(coordinationViolation(live(4), "fail")).toBeNull();
  });
});

/* ── Isolation: who may see it ──────────────────────────────────────────── */

describe("这份私有结构不会到别人手上", () => {
  const config = testConfig({
    promptVersion: PROMPT_VERSION_M54,
    cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
    experiment: {
      personaMode: "heterogeneous-rotated",
      strategyProfile: "expert-disclosure-safe",
    },
  });

  /** A game stopped with a team on the table, so coordination is live. */
  function withTeam() {
    const { state } = drive({
      seed: 4,
      deal: DEAL,
      config,
      stopWhen: (s) => s.proposedTeam !== null,
    });
    return state;
  }

  it("好人与奥伯伦的观测里是 null", () => {
    const state = withTeam();
    for (const seat of SEATS) {
      const o = observationFor(state, seat);
      const role = DEAL.bySeat[seat];
      if (role === "loyal" || role === "merlin" || role === "percival" || role === "oberon") {
        expect(o.missionCoordination, `${seat}号 ${role}`).toBeNull();
      }
    }
  });

  it("规划者提示里只有被授予的那个座位看得到这一层", () => {
    const state = withTeam();
    const team = state.proposedTeam!;
    for (const seat of SEATS) {
      const o = observationFor(state, seat);
      if (!o.request) continue;
      const built = buildCognitivePrompt({
        observation: o,
        persona: personaById("ledger"),
        strategy: strategyById("expert-disclosure-safe"),
        ledger: new CognitionStore().for(o),
        config,
      });
      const has = built.user.includes("坏人出牌协调");
      const entitled =
        o.missionCoordination !== null && team.includes(seat);
      expect(has, `${seat}号 ${DEAL.bySeat[seat]}`).toBe(entitled);
    }
  });

  it("公开发言者的提示里绝不会有它", () => {
    const state = withTeam();
    for (const seat of SEATS) {
      const o = observationFor(state, seat);
      const registry = buildFactRegistry(
        publicFactsFrom(o.publicLog),
        claimsFrom(o.publicLog),
        o,
        claimContestFrom(o.publicLog),
      );
      const intent: CommunicationIntent = {
        channel: "table-public",
        publicGoal: "说明这一票",
        targetSeats: [],
        selectedClaimAction: "stay-hidden",
        requestedTeam: null,
        requestedVote: "none",
        publicBasisIds: [],
        publicProposition: "这一辆车按公开记录看还缺依据",
        desiredTableEffect: "先把标准定下来",
      };
      const { intent: sanitised } = sanitiseIntent({
        intent,
        observation: o,
        registry,
        persona: personaById("ledger"),
        taskId: "speech-regular",
        taskChannel: channelForTask("speech-regular"),
      });
      const built = buildSpokespersonPrompt({
        view: publicTableViewFor(o),
        intent: sanitised,
        persona: personaById("ledger"),
        taskId: "speech-regular",
        speechCharLimit: 220,
        selectedAction: "",
        naturalSpeech: true,
      });
      const whole = `${built.system}\n${built.user}`;
      expect(whole, `${seat}`).not.toContain("坏人出牌协调");
      expect(whole).not.toContain("指定出牌人");
      expect(whole).not.toContain("莫德雷德");
    }
  });

  it("旧版本的提示里完全没有这一层", () => {
    const old = testConfig({
      promptVersion: "prompt-0.4.0",
      cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
      experiment: {
        personaMode: "heterogeneous-rotated",
        strategyProfile: "expert-claim-contest",
      },
    });
    const { state } = drive({
      seed: 4,
      deal: DEAL,
      config: old,
      stopWhen: (s) => s.proposedTeam !== null,
    });
    for (const seat of SEATS) {
      const o = observationFor(state, seat);
      if (!o.request) continue;
      const built = buildCognitivePrompt({
        observation: o,
        persona: personaById("ledger"),
        strategy: strategyById("expert-claim-contest"),
        ledger: new CognitionStore().for(o),
        config: old,
      });
      expect(built.user).not.toContain("坏人出牌协调");
    }
  });

  it("公开日志里没有任何协调痕迹", () => {
    const { state } = drive({ seed: 4, deal: DEAL, config, maxActions: 400 });
    const serialised = JSON.stringify(state.log);
    // NOT "mordred": `game_start` legitimately lists the deck and `game_end`
    // legitimately reveals it. Role names in the public log are the thing the
    // leak scanner's header warns about grepping for. What must be absent is
    // the COORDINATION structure.
    for (const word of ["坏人出牌协调", "指定出牌人", "designated", "coordination", "riders"]) {
      expect(serialised, word).not.toContain(word);
    }
  });
});

/* ── The rendered layer ─────────────────────────────────────────────────── */

describe("渲染出来的私有协调层", () => {
  it("指定的人看到「由你决定」，非指定的看到「出 success」", () => {
    const team: Seat[] = [7, 8, 9, 5];
    expect(renderMissionCoordination(coordination(8, team)!)).toContain("你是这一轮的指定出牌人");
    expect(renderMissionCoordination(coordination(9, team)!)).toContain(
      "你不是指定出牌人 —— 出 success",
    );
  });

  it("说清了这条约定只管这一张牌", () => {
    const c = coordination(8, [7, 8, 9, 5])!;
    const text = renderMissionCoordination(c);
    expect(text).toContain("只管这一张牌");
    expect(text).toContain("发车、投票、发言、跳身份、退水、刺杀");
  });

  it("给出了理由，而不只是命令", () => {
    const text = renderMissionCoordination(coordination(9, [7, 8, 9, 5])!);
    expect(text).toContain("多出来的失败票不是更狠，是在公开报数");
    expect(text).toContain("刺客 → 莫甘娜 → 莫德雷德");
  });
});

/* ── The direction, pinned ──────────────────────────────────────────────── */

describe("方向回归：这些在翻转之前的实现下全部会红", () => {
  it("三个身份齐全的一票车：刺客第一，莫德雷德最后", () => {
    const riders = orderedRiders(DEAL, [7, 8, 9]);
    expect(riders.map((r) => r.role)).toEqual(["assassin", "morgana", "mordred"]);
    expect(riders.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("每一种两人组合，被指定的都是数字大的那个", () => {
    const cases: readonly [Seat, Seat, Seat][] = [
      // [seat A, seat B, expected designated]
      [8, 7, 8], // assassin vs morgana
      [8, 9, 8], // assassin vs mordred
      [7, 9, 7], // morgana vs mordred
    ];
    for (const [a, b, expected] of cases) {
      const team: Seat[] = [a, b, 5];
      expect(coordination(a, team)!.designated, `${a} vs ${b}`).toBe(a === expected);
      expect(coordination(b, team)!.designated, `${b} vs ${a}`).toBe(b === expected);
    }
  });

  it("两票车、三个身份齐全：指定的是刺客与莫甘娜", () => {
    const team: Seat[] = [7, 8, 9, 5, 6];
    const designated = coordination(8, team, 4)!
      .riders.filter((r) => r.designated)
      .map((r) => r.role);
    expect(designated).toEqual(["assassin", "morgana"]);
  });

  it("**历史三失败的形状被堵死了**：刺客与莫德雷德不可能重复出牌", () => {
    // seed 1's R2: seats 1(loyal) 2(assassin) 3(mordred) 4(oberon), one fail
    // needed, three played. Under the convention only ONE mutually aware rider
    // may decide, so the duplicate is refused.
    const team: Seat[] = [1, 2, 3, 4];
    const live = (seat: Seat) =>
      coordinationFor({
        deal: LIVE_DEAL,
        seat,
        team,
        missionNumber: 2,
        failsRequired: requiredFails(10, 2),
      });
    const designatedSeats = live(2)!.riders.filter((r) => r.designated).map((r) => r.seat);
    expect(designatedSeats).toEqual([2]);
    // The most fails the mutually aware riders can produce is one.
    expect(live(3)!.designated).toBe(false);
    expect(coordinationViolation(live(3), "fail")).not.toBeNull();
  });

  it("**但两张失败票仍然可能** —— 刺客加奥伯伦", () => {
    const team: Seat[] = [1, 2, 3, 4];
    const live = (seat: Seat) =>
      coordinationFor({
        deal: LIVE_DEAL,
        seat,
        team,
        missionNumber: 2,
        failsRequired: requiredFails(10, 2),
      });
    // The Assassin is designated and may fail.
    expect(coordinationViolation(live(2), "fail")).toBeNull();
    // Oberon has no context at all, so nothing constrains him.
    expect(live(4)).toBeNull();
    expect(coordinationViolation(live(4), "fail")).toBeNull();
    // Which is two, not three.
  });
});
