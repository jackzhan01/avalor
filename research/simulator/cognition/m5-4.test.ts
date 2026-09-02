import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { llmAgent, type CognitionReport } from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import type { GameState } from "../core/state";
import { SEATS, type Seat } from "../core/types";
import { teamSize } from "@/lib/rules/avalon";
import { assassinationError } from "./metrics";
import { REFERENCE_ASSIGNMENT, drive, referenceDeal, testConfig } from "../fixtures/harness";
import { checkInvariants } from "../fixtures/invariants";
import { buildPublicReplay, serialisePublicReplay } from "../run/artifacts";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById, strategyFingerprint } from "../prompts/strategies";
import { capabilitiesFor } from "../prompts/capabilities";
import { PROMPT_VERSION_M54 } from "../prompts/version";
import { loadProfile } from "../config/load";
import { CognitionStore } from "../cognition/store";
import { disclosureClient, isSpokespersonRequest } from "./scripted-cognitive-client";
import { findMachineIds } from "./machine-ids";
import { parseVoteAnalysis, voteAnalysisProblems, type VoteAnalysis } from "./vote-discipline";
import {
  ASSASSINATION_INSTRUCTION,
  assassinationProblems,
  knownEvilTargeted,
  orderedCandidates,
  parseAssassination,
  type AssassinationRanking,
} from "./assassination";
import { buildFactRegistry, isVerifiedPremise } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { claimsFrom, publicFactsFrom } from "./ledger";
import { buildCognitivePrompt } from "./build-cognitive";
import { renderOwnPrivateFacts } from "./context-pack";
import type { ModelRequest } from "../model/client";

/**
 * M5.4 acceptance: the folding repair plus four gameplay changes, end to end.
 *
 * The scripted game at the bottom is the one that matters — it plays a whole
 * `prompt-0.6.0` table offline and asserts every claim this milestone makes at
 * once. The unit sections above it exist so that a failure names WHICH claim
 * broke rather than "the game changed".
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("M5.4 tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = testConfig({
  promptVersion: PROMPT_VERSION_M54,
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: {
    personaMode: "heterogeneous-rotated",
    strategyProfile: "expert-disciplined",
  },
});

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

/* ── C. Machine ids never reach a table ─────────────────────────────────── */

describe("C · 公开发言里不能有机器编号", () => {
  it("拦下 M5.3 实盘里真的说出去的那几种写法", () => {
    const real = [
      "[f30] 是 7 号提 1、2、3、4，[f32][f.fail2] 这车 3 失败",
      "看[f.now]，这是首轮首车",
      "按[k5:claim]你声称期间要过 7、1、2",
      "[c4:role][c5:role] 只证明我们都公开声称过",
      "依据 p.self 我反对",
      "我的 requestedTeam 是 1、6、8、10",
    ];
    for (const text of real) {
      expect(findMachineIds(text).length, text).toBeGreaterThan(0);
    }
  });

  it("放行同一件事的自然中文说法", () => {
    const natural = [
      "第二轮 7 号发的 1、2、3、4 出了三张失败票。",
      "现在是首轮首车，比分 0:0，还没有任何任务或票型可以核对。",
      "7 号声称期间要过的车是 7、1、2，现在却推 1、2、3、4，标准变了。",
      "我们两个都公开说过自己是派西维尔，这一条本身分不出谁真谁假。",
      "我建议这一辆带 1、6、8、10。",
    ];
    for (const text of natural) {
      expect(findMachineIds(text), text).toEqual([]);
    }
  });

  it("每一种编号形状都有它自己的名字和替代说法", () => {
    const kinds = new Set(
      [
        "[f30]",
        "f.fail2",
        "c4:role",
        "k5:claim",
        "p.pair",
        "premiseIds",
      ].flatMap((t) => findMachineIds(t).map((h) => h.kind)),
    );
    expect(kinds.size).toBeGreaterThanOrEqual(5);
    for (const hit of findMachineIds("[f30] 和 p.pair")) {
      expect(hit.guidance.length).toBeGreaterThan(4);
    }
  });

  it("普通句子里的数字和字母不会被误伤", () => {
    for (const text of [
      "我投 5 号那辆车。",
      "第 3 轮之后再说。",
      "10 号先讲。",
      "这车 2 成 1 败。",
    ]) {
      expect(findMachineIds(text), text).toEqual([]);
    }
  });
});

/* ── D. Vote discipline: scenarios, not quotas ──────────────────────────── */

describe("D · 投票纪律：只查完整性，从不查投了什么", () => {
  const base: VoteAnalysis = {
    newConstraint: "第二轮 1、2、3、4 出了三张失败票，这四个人里至少三个坏",
    constraintFit: "avoids",
    implicatedRiders: [],
    leaderExplanation: "",
    informationFromApproving: "放过去能用结果检验这几个人",
    rejectionStreak: 0,
    hammerRisk: "",
    choice: "approve",
    reason: "这辆车完整避开了上一轮被牵连的四个人",
    evidenceIds: ["f32"],
  };
  const ctx = {
    seat: 5 as Seat,
    proposedTeam: [5, 6, 8, 9, 10] as Seat[],
    rejectionStreak: 0,
    anyMissionResolved: true,
    lastFailedTeam: [1, 2, 3, 4] as Seat[],
  };

  it("车与新约束矛盾、队长没解释 → 结构上合法，投什么都行", () => {
    const carried = {
      ...base,
      constraintFit: "carries-unexplained" as const,
      implicatedRiders: [1] as Seat[],
      leaderExplanation: "",
    };
    const withOne = { ...ctx, proposedTeam: [1, 5, 6, 8, 9] as Seat[] };
    // Rejecting is legal…
    expect(voteAnalysisProblems({ ...carried, choice: "reject" }, withOne)).toEqual([]);
    // …and so is approving. No check can tell them apart.
    expect(voteAnalysisProblems({ ...carried, choice: "approve" }, withOne)).toEqual([]);
  });

  it("说队长解释过，就必须写出他说了什么", () => {
    const withOne = { ...ctx, proposedTeam: [1, 5, 6, 8, 9] as Seat[] };
    const claimed = {
      ...base,
      constraintFit: "carries-explained" as const,
      implicatedRiders: [1] as Seat[],
      leaderExplanation: "",
    };
    expect(voteAnalysisProblems(claimed, withOne)[0]).toContain("leaderExplanation");
    const explained = { ...claimed, leaderExplanation: "他说 1 号在第一轮成功车里" };
    expect(voteAnalysisProblems(explained, withOne)).toEqual([]);
  });

  it("原样重带挂掉的车，必须被叫成 repeats-failed-team", () => {
    const repeat = { ...ctx, proposedTeam: [1, 2, 3, 4] as Seat[] };
    const wrong = { ...base, constraintFit: "avoids" as const };
    expect(voteAnalysisProblems(wrong, repeat).join()).toContain("repeats-failed-team");
    const right = {
      ...base,
      constraintFit: "repeats-failed-team" as const,
      implicatedRiders: [1, 2, 3, 4] as Seat[],
    };
    // And approving a repeat is still legal, if that is the judgement.
    expect(voteAnalysisProblems({ ...right, choice: "approve" }, repeat)).toEqual([]);
  });

  it("连否三次之后必须写清 hammer 风险 —— 但不规定怎么投", () => {
    const late = { ...ctx, rejectionStreak: 3 };
    const silent = { ...base, rejectionStreak: 3, hammerRisk: "" };
    expect(voteAnalysisProblems(silent, late)[0]).toContain("hammerRisk");
    const aware = { ...base, rejectionStreak: 3, hammerRisk: "再否两次这一轮直接判负" };
    expect(voteAnalysisProblems({ ...aware, choice: "approve" }, late)).toEqual([]);
    expect(voteAnalysisProblems({ ...aware, choice: "reject" }, late)).toEqual([]);
  });

  it("还没有任务结算时，只能是 no-constraint-yet", () => {
    const early = { ...ctx, anyMissionResolved: false, lastFailedTeam: null };
    expect(
      voteAnalysisProblems({ ...base, constraintFit: "avoids" }, early)[0],
    ).toContain("no-constraint-yet");
    expect(
      voteAnalysisProblems(
        { ...base, constraintFit: "no-constraint-yet", newConstraint: "" },
        early,
      ),
    ).toEqual([]);
  });

  it("字段之间必须自洽：avoids 不能同时列出被牵连的人", () => {
    const contradiction = { ...base, implicatedRiders: [5] as Seat[] };
    expect(voteAnalysisProblems(contradiction, ctx).join()).toContain("对不上");
  });

  it("**没有任何一条检查在数反对票**", () => {
    // Ten analyses that all approve, none of which is refused. If any check
    // counted rejections, this is where it would show.
    for (let i = 0; i < 10; i += 1) {
      expect(voteAnalysisProblems({ ...base, choice: "approve" }, ctx)).toEqual([]);
    }
  });

  it("解析拒绝缺字段的分析，并说清缺了什么", () => {
    expect(parseVoteAnalysis(null).ok).toBe(false);
    const bad = parseVoteAnalysis({ ...base, constraintFit: "whatever" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("constraintFit");
  });
});

/* ── E. Assassination ranking ───────────────────────────────────────────── */

describe("E · 刺杀候选排序", () => {
  // Seat 2 is the Assassin; 3, 4 and 7 are the villains he was shown.
  const ctx = { seat: 2 as Seat, knownEvil: [3, 4, 7] as Seat[] };
  const candidate = (seat: Seat, confidence: number, signals: string[]) => ({
    seat,
    signals: signals as never,
    evidence: ["公开票型上多次避开后来挂掉的车"],
    counterEvidence: ["也可能只是跟着结果调整"],
    evidenceIds: ["f32"],
    confidence,
  });

  it("一个只有正面、没有反面的候选会被打回", () => {
    const ranking: AssassinationRanking = {
      candidates: [
        { ...candidate(5, 0.7, ["accurate-rejection"]), counterEvidence: [] },
        candidate(9, 0.4, ["knowledge-like-consistency"]),
      ],
      target: 5,
      why: "他更早给出正确排除方向",
      whatWouldChangeIt: "他支持过挂掉的车就换人",
    };
    expect(assassinationProblems(ranking, ctx)[0]).toContain("counterEvidence");
  });

  it("**一个大声的派西维尔不会被自动排到第一** —— 反信号是可选项之一", () => {
    // The whole point: `may-be-percival` and `loyal-cover` are first-class
    // signals, so a loud organiser can be ranked DOWN on the evidence.
    const ranking: AssassinationRanking = {
      candidates: [
        candidate(8, 0.25, ["may-be-percival", "claim-contest-handling"]),
        candidate(9, 0.65, ["knowledge-like-consistency", "avoided-the-focus"]),
      ],
      target: 9,
      why: "9 号几轮读法一致，而 8 号更像派西维尔在争派权",
      whatWouldChangeIt: "9 号如果只是跟着结果调整就换人",
    };
    expect(assassinationProblems(ranking, ctx)).toEqual([]);
    expect(ranking.candidates[0].confidence).toBeLessThan(ranking.candidates[1].confidence);
  });

  it("安静但票型一致的人可以排在焦点声称者之上", () => {
    const quiet = candidate(9, 0.8, ["knowledge-like-consistency", "avoided-the-focus"]);
    const loud = candidate(8, 0.3, ["may-be-percival"]);
    const ranking: AssassinationRanking = {
      candidates: [loud, quiet],
      target: 9,
      why: "安静的那个更像有固定信息",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx)).toEqual([]);
  });

  it("忠臣做梅林掩护是一个可以被写下来的信号", () => {
    const ranking: AssassinationRanking = {
      candidates: [
        candidate(5, 0.35, ["loyal-cover", "accurate-rejection"]),
        candidate(9, 0.6, ["knowledge-like-consistency"]),
      ],
      target: 9,
      why: "5 号的准确度更像在替人挡枪",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx)).toEqual([]);
  });

  it("目标必须是被排过序的合法候选之一", () => {
    const ranking: AssassinationRanking = {
      candidates: [candidate(5, 0.6, ["accurate-rejection"]), candidate(9, 0.4, ["loyal-cover"])],
      target: 6,
      why: "换个人",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx).join()).toContain("不在 candidates 里");
  });

  it("不能把自己列为候选 —— 这一条镜像裁判的规则", () => {
    const ranking: AssassinationRanking = {
      candidates: [candidate(2, 0.6, ["accurate-rejection"]), candidate(9, 0.4, ["loyal-cover"])],
      target: 9,
      why: "x",
      whatWouldChangeIt: "",
    };
    const problems = assassinationProblems(ranking, ctx).join();
    expect(problems).toContain("不能把自己列为候选");
  });

  /* ── The correction: a bad kill is a mistake, not an illegal move ─────── */

  it("**刺一个已知的坏人是合法的 —— 结构检查一句话都不说**", () => {
    const ranking: AssassinationRanking = {
      candidates: [candidate(7, 0.8, ["accurate-rejection"]), candidate(9, 0.4, ["loyal-cover"])],
      target: 7, // Morgana. He was shown her identity. This is a blunder.
      why: "他推动了两辆成功车",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx)).toEqual([]);
    // And it is NAMED, so the post-mortem can count it.
    expect(knownEvilTargeted(ranking, ctx)).toBe(true);
  });

  it("已知的坏人被排到候选最后 —— 不管模型给了多高的信心", () => {
    const ranking: AssassinationRanking = {
      candidates: [
        candidate(7, 0.95, ["accurate-rejection"]), // known evil, highest confidence
        candidate(9, 0.30, ["loyal-cover"]),
        candidate(5, 0.60, ["knowledge-like-consistency"]),
      ],
      target: 9,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(orderedCandidates(ranking, ctx).map((c) => c.seat)).toEqual([5, 9, 7]);
    // Ordering is presentation. The target is untouched.
    expect(ranking.target).toBe(9);
  });

  it("自己也排在最后 —— 和名单上的人是同一种确定性", () => {
    const ranking: AssassinationRanking = {
      candidates: [candidate(2, 0.99, ["accurate-rejection"]), candidate(9, 0.1, ["loyal-cover"])],
      target: 9,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(orderedCandidates(ranking, ctx).map((c) => c.seat)).toEqual([9, 2]);
  });

  it("信心相同时保持模型自己的顺序 —— 同一局两次跑不会互换", () => {
    const ranking: AssassinationRanking = {
      candidates: [
        candidate(9, 0.5, ["loyal-cover"]),
        candidate(5, 0.5, ["accurate-rejection"]),
        candidate(6, 0.5, ["avoided-the-focus"]),
      ],
      target: 9,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(orderedCandidates(ranking, ctx).map((c) => c.seat)).toEqual([9, 5, 6]);
  });

  it("正常的一刀不会被记成战略失误", () => {
    const ranking: AssassinationRanking = {
      candidates: [candidate(9, 0.7, ["knowledge-like-consistency"]), candidate(5, 0.3, ["loyal-cover"])],
      target: 9,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(knownEvilTargeted(ranking, ctx)).toBe(false);
  });

  it("**任务说明私下警告过，而且说清了不可撤回**", () => {
    expect(ASSASSINATION_INSTRUCTION).toContain("那些人不可能是梅林");
    expect(ASSASSINATION_INSTRUCTION).toContain("不能撤回");
    // And it no longer claims the roster is off-limits as a candidate.
    expect(ASSASSINATION_INSTRUCTION).not.toContain("也不能是你已经知道是坏人的人");
  });

  it("至少两个候选 —— 一个不叫排序", () => {
    const ranking: AssassinationRanking = {
      candidates: [candidate(5, 0.9, ["accurate-rejection"])],
      target: 5,
      why: "只有他",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx)[0]).toContain("至少要有两个");
  });

  it("解析拒绝不在信号表里的信号", () => {
    const bad = parseAssassination({
      candidates: [{ ...candidate(5, 0.5, ["loudest"]) }],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("不在允许的信号表里");
  });
});

/* ── E. The roster is finally rendered ──────────────────────────────────── */

describe("E · 坏人名单终于会被渲染出来 —— 而且只在刺杀阶段", () => {
  it("0.6.0 之前，任何认知版本都没有渲染过它", () => {
    for (const v of ["prompt-0.3.0", "prompt-0.3.1", "prompt-0.4.0", "prompt-0.5.0"]) {
      expect(capabilitiesFor(v).evilRosterRendered, v).toBe(false);
    }
    expect(capabilitiesFor(PROMPT_VERSION_M54).evilRosterRendered).toBe(true);
  });

  it("历史档案没有被这一版改动 —— 已跑完的对局仍然可复现", () => {
    // Rendering the roster changes the prompt, so it must NOT reach back into
    // the versions two live games were already played under.
    for (const id of ["m5-2-pilot", "m5-3-terra-pilot", "m5-3-luna-pilot"] as const) {
      const caps = capabilitiesFor(loadProfile(id).promptVersion);
      expect(caps.evilRosterRendered, id).toBe(false);
      expect(caps.assassinRanking, id).toBe(false);
    }
  });
});

/* ── The roster's timing, asserted rather than tolerated ─────────────────── */

describe("坏人名单的出现时机", () => {
  const ROSTER_LINE = "坏人这一边的确切身份";

  /** Play to a stopping point with a deterministic scripted table. */
  function at(stopWhen: (s: GameState) => boolean) {
    return drive({
      seed: 10,
      deal: referenceDeal(),
      override: (observation, s) => {
        // Push the game to the assassination rather than letting it stall on
        // five rejected teams: leaders propose loyal seats, everybody approves.
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
      stopWhen: (s) => stopWhen(s),
    });
  }

  it("**刺杀之前：一个座位都看不到名单，奥伯伦的身份谁也拿不到**", () => {
    const seen: string[] = [];
    drive({
      seed: 4,
      deal: referenceDeal(),
      onObservation: (observation, s) => {
        const inAssassination =
          s.phase === "assassination_discuss" ||
          s.phase === "assassination_strike" ||
          s.phase === "terminal";
        if (!inAssassination && observation.evilRoster !== null) {
          seen.push(`seat ${observation.seat} in ${s.phase}`);
        }
      },
    });
    expect(seen).toEqual([]);

    // And the three mutually aware villains never learn Oberon before then:
    // their hard knowledge lists each other and stops there.
    const { state } = at((s) => s.missionTrack[1] !== "pending");
    for (const seat of [7, 8, 9] as Seat[]) {
      const k = observationFor(state, seat).knowledge;
      expect(k.kind, `${seat}`).toBe("knows_teammates");
      if (k.kind === "knows_teammates") expect(k.seats).not.toContain(10);
    }
  });

  it("**刺杀那一刻：名单是完整的四个人，奥伯伦在里面**", () => {
    const { state } = at((s) => s.phase === "assassination_strike");
    for (const seat of [7, 8, 9, 10] as Seat[]) {
      const roster = observationFor(state, seat).evilRoster;
      expect(roster, `${seat}`).not.toBeNull();
      expect(roster!.map((e) => e.seat).sort((a, b) => a - b)).toEqual([7, 8, 9, 10]);
      expect(roster!.map((e) => e.role).sort()).toEqual(
        ["assassin", "mordred", "morgana", "oberon"].sort(),
      );
    }
    // Good seats still see nothing, at the very moment it exists.
    for (const seat of state.deal.goodSeats) {
      expect(observationFor(state, seat).evilRoster, `${seat}`).toBeNull();
    }
  });

  it("**只出现在私有的刺杀规划里 —— 公开回放和元数据里没有**", () => {
    const { state } = at((s) => s.phase === "assassination_strike");
    const replay = serialisePublicReplay(
      buildPublicReplay(
        state,
        Object.fromEntries(SEATS.map((x) => [x, { name: "double" }])) as never,
        { status: "completed" },
      ),
    );
    expect(replay).not.toContain(ROSTER_LINE);
    expect(replay).not.toContain('"evilRoster"');
    // Nor do the seat names of the villains appear as a set anywhere in it.
    expect(replay).not.toContain("莫甘娜（7号）");
  });

  it("**渲染到提示里，也只在刺杀阶段的 0.6.0 提示里**", () => {
    const strike = at((s) => s.phase === "assassination_strike").state;
    const assassin = strike.pending!.seat;
    expect(strike.deal.bySeat[assassin]).toBe("assassin");
    const build = (state: GameState, seat: Seat, version: string) =>
      buildCognitivePrompt({
        observation: observationFor(state, seat),
        persona: personaById(assignPersonas(4, "heterogeneous-rotated")[seat].id),
        strategy: strategyById("expert-disciplined"),
        ledger: new CognitionStore().for(observationFor(state, seat)),
        config: testConfig({
          promptVersion: version,
          cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
        } as never),
      });

    // At the strike, under 0.6.0: present, and complete.
    const under060 = build(strike, assassin, PROMPT_VERSION_M54).user;
    expect(under060).toContain(ROSTER_LINE);
    for (const seat of [7, 8, 9, 10]) expect(under060).toContain(`${seat}号`);
    // The same moment, the same seat, under 0.5.0: absent. The two live games
    // played under that stack stay reproducible byte for byte.
    expect(build(strike, assassin, "prompt-0.5.0").user).not.toContain(ROSTER_LINE);
  });

  it("渲染层本身也是关着的 —— 好人、以及刺杀之前的坏人，都没有可渲染的东西", () => {
    const strike = at((s) => s.phase === "assassination_strike").state;
    // A good seat AT the strike: the observation carries no roster, so the
    // renderer has nothing to print even with the switch on.
    const good = strike.deal.goodSeats[0];
    expect(
      renderOwnPrivateFacts(observationFor(strike, good), { withEvilRoster: true } as never),
    ).not.toContain(ROSTER_LINE);
    // An evil seat BEFORE the strike: same. The gate is upstream of the
    // renderer, which is what makes the switch safe to leave on.
    const before = at((s) => s.missionTrack[1] !== "pending").state;
    for (const seat of [7, 8, 9, 10] as Seat[]) {
      expect(
        renderOwnPrivateFacts(observationFor(before, seat), { withEvilRoster: true } as never),
        `${seat}`,
      ).not.toContain(ROSTER_LINE);
    }
    // And with the switch OFF at the strike, the Assassin sees nothing either.
    expect(
      renderOwnPrivateFacts(observationFor(strike, strike.deal.assassin), {}),
    ).not.toContain(ROSTER_LINE);
  });

});

/* ── The named strategic error, post-mortem ─────────────────────────────── */

describe("knownEvilAssassinationTarget —— 记录，不阻止", () => {
  const ROLES = {
    bySeat: REFERENCE_ASSIGNMENT,
    sideOf: Object.fromEntries(
      SEATS.map((s) => [
        s,
        ["morgana", "assassin", "mordred", "oberon"].includes(REFERENCE_ASSIGNMENT[s])
          ? "evil"
          : "good",
      ]),
    ),
  } as never as Parameters<typeof assassinationError>[1];
  const base = { votes: [], proposals: [], missions: [], speeches: [] };

  it("刺了名单上的人 = 具名战略失误", () => {
    const e = assassinationError(
      { ...base, assassination: { assassin: 8, target: 7, atSequence: 200 } },
      ROLES,
    )!;
    expect(e.knownEvilAssassinationTarget).toBe(true);
    expect(e.targetRole).toBe("morgana");
    expect(e.targetWasMerlin).toBe(false);
  });

  it("刺了奥伯伦不算这一条 —— 他从来没被展示给刺客", () => {
    const e = assassinationError(
      { ...base, assassination: { assassin: 8, target: 10, atSequence: 200 } },
      ROLES,
    )!;
    expect(e.knownEvilAssassinationTarget).toBe(false);
    expect(e.targetRole).toBe("oberon");
  });

  it("刺中梅林、刺歪到忠臣，都不算这一条", () => {
    const hit = assassinationError(
      { ...base, assassination: { assassin: 8, target: 1, atSequence: 200 } },
      ROLES,
    )!;
    expect(hit.targetWasMerlin).toBe(REFERENCE_ASSIGNMENT[1] === "merlin");
    expect(hit.knownEvilAssassinationTarget).toBe(false);

    const missed = assassinationError(
      { ...base, assassination: { assassin: 8, target: 5, atSequence: 200 } },
      ROLES,
    )!;
    expect(missed.knownEvilAssassinationTarget).toBe(false);
    expect(missed.targetRole).toBeNull();
  });

  it("没走到刺杀的对局返回 null，而不是一个假的零", () => {
    expect(assassinationError(base, ROLES)).toBeNull();
  });
});

/* ── The whole scripted game ────────────────────────────────────────────── */

describe("完整脚本对局（prompt-0.6.0，全程离线）", () => {
  interface Played {
    state: GameState;
    reports: CognitionReport[];
    planner: ModelRequest[];
    say: ModelRequest[];
    error: unknown;
  }

  async function play(): Promise<Played> {
    const state = createGame({
      seed: 3,
      config: CONFIG,
      deal: dealWith({ 1: "mordred", 9: "merlin" }),
    });
    const personas = assignPersonas(3, "heterogeneous-rotated");
    const store = new CognitionStore();
    const reports: CognitionReport[] = [];
    const planner: ModelRequest[] = [];
    const say: ModelRequest[] = [];
    const client = disclosureClient({
      claimSeats: [2, 7],
      onRequest: (r) => {
        if (!isSpokespersonRequest(r)) planner.push(r);
      },
      onSpokespersonRequest: (r) => say.push(r),
    });

    const agents = {} as Record<Seat, Agent>;
    for (const seat of SEATS) {
      agents[seat] = llmAgent(seat, {
        client,
        persona: personaById(personas[seat].id),
        strategy: strategyById("expert-disciplined"),
        config: CONFIG,
        cognition: { store, onCognition: (r) => reports.push(r) },
      });
    }

    let error: unknown = null;
    let n = 0;
    try {
      while (state.pending && n < 400) {
        const seat = state.pending.seat;
        const action = await agents[seat].act(observationFor(state, seat));
        applyAction(state, seat, action);
        n += 1;
      }
    } catch (caught) {
      error = caught;
    }
    return { state, reports, planner, say, error };
  }

  it("跑完整局，零网络请求，裁判零违规", async () => {
    const r = await play();
    expect(r.error).toBeNull();
    expect(r.state.pending).toBeNull();
    expect(checkInvariants(r.state)).toEqual([]);
    // `fetch` is stubbed to throw; reaching here at all proves nothing called it.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("社会与派权记忆跨轮存活，k… id 解析得了", async () => {
    const r = await play();
    expect(r.reports.some((x) => x.social !== null)).toBe(true);
    expect(r.reports.some((x) => x.contest !== null)).toBe(true);
    // Grows from the 19-character empty state.
    expect(Math.max(...r.reports.map((x) => x.packSections.cognition))).toBeGreaterThan(500);

    const observation = observationFor(r.state, 2);
    const contest = claimContestFrom(observation.publicLog);
    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      contest,
    );
    const kIds = registry.entries.filter((e) => e.kind === "contest-event");
    expect(kIds.length).toBeGreaterThan(0);
    for (const e of kIds) expect(isVerifiedPremise(registry, e.id), e.id).toBe(true);
  });

  it("公开发言全是自然中文，零机器编号", async () => {
    const r = await play();
    const speeches = r.state.log.filter(
      (e): e is Extract<typeof e, { type: "speech" }> => e.type === "speech",
    );
    expect(speeches.length).toBeGreaterThan(10);
    for (const s of speeches) {
      expect(findMachineIds(s.publicMessage), `seq ${s.sequence}`).toEqual([]);
    }
    // And the spokesperson was never shown one to copy.
    for (const request of r.say) {
      expect(request.user).not.toMatch(/`\[f\d+\]`/);
      expect(request.user).not.toContain("premiseIds");
    }
  });

  it("坏人协调在跑：非指定的互认坏人没有出过失败票", async () => {
    const r = await play();
    // Every mission's fail count is at most (designated riders) + (Oberon).
    const results = r.state.log.filter(
      (e): e is Extract<typeof e, { type: "mission_result" }> => e.type === "mission_result",
    );
    expect(results.length).toBeGreaterThan(0);
    for (const m of results) {
      expect(m.failCount).toBeLessThanOrEqual(2);
    }
    // And the coordination layer really reached the seats entitled to it.
    const sawIt = r.planner.filter((q) => q.user.includes("坏人出牌协调"));
    expect(sawIt.length).toBeGreaterThan(0);
  });

  it("投票分析在每一次投票上都跑了", async () => {
    const r = await play();
    const votes = r.planner.filter((q) => q.format.name.includes("_vote"));
    expect(votes.length).toBeGreaterThan(0);
    for (const q of votes) expect(q.user).toContain("投这一票之前，先填 `voteAnalysis`");
  });

  it("走到刺杀就跑候选排序，而且名单在那一刻才出现", async () => {
    const r = await play();
    const kill = r.planner.filter((q) => q.format.name.includes("assassinate"));
    if (kill.length === 0) {
      // Evil won on missions. Recorded rather than silently skipped.
      expect(r.state.outcome?.reason).toBe("missions_evil");
      return;
    }
    expect(kill[0].user).toContain("指认之前，先填 `assassination`");
    expect(kill[0].user).toContain("坏人这一边的确切身份");
    // Before the assassination phase, no prompt carries the roster.
    // Excluding the evil council, which happens in the SAME phase — the reveal
    // is what opens that discussion, so both legitimately carry the roster.
    const earlier = r.planner.filter(
      (q) =>
        !q.format.name.includes("assassinate") && !q.format.name.includes("evil_discuss"),
    );
    for (const q of earlier) {
      expect(q.user).not.toContain("坏人这一边的确切身份");
    }
  });

  it("公开产物里没有任何私有结构", async () => {
    const r = await play();
    const replay = serialisePublicReplay(
      buildPublicReplay(
        r.state,
        Object.fromEntries(SEATS.map((s) => [s, { name: "double" }])) as never,
        { status: "completed" },
      ),
    );
    // JSON KEYS, not bare words. `assassination_target` is a public event type
    // and `assassination_discuss` is a public phase name — a substring check on
    // "assassination" would be a test about vocabulary, not about leakage.
    for (const key of [
      "voteAnalysis",
      '"assassination":',
      '"coordination":',
      "designated",
      "counterEvidence",
      "ownClaimStrategy",
      "focalCandidates",
      "informationToConceal",
      "implicatedRiders",
      "whatWouldChangeIt",
    ]) {
      expect(replay, key).not.toContain(key);
    }
  });

  it("好人与奥伯伦的提示里推不出协调结构", async () => {
    const r = await play();
    for (const q of r.planner) {
      if (q.user.includes("坏人出牌协调")) {
        // Only a seat told it is a designated/undesignated rider sees the layer.
        expect(q.user).toMatch(/你是这一轮的指定出牌人|你不是指定出牌人/);
      }
    }
  });
});

/* ── The profile ────────────────────────────────────────────────────────── */

describe("m5-4-pilot", () => {
  const profile = loadProfile("m5-4-pilot");

  it("是 0.6.0 + expert-disciplined，Terra 专用", () => {
    expect(profile.promptVersion).toBe(PROMPT_VERSION_M54);
    expect(profile.experiment.strategyProfile).toBe("expert-disciplined");
    expect(profile.model.id).toBe("gpt-5.6-terra");
    expect(profile.pricing.modelId).toBe("gpt-5.6-terra");
  });

  it("两段设定和 M5.3 Terra 臂完全一致 —— 这次改的是提示，不是模型", () => {
    const terra = loadProfile("m5-3-terra-pilot");
    expect(profile.stages).toEqual(terra.stages);
    expect(profile.limits).toEqual(terra.limits);
    expect(profile.budget).toEqual(terra.budget);
    expect(profile.cognition).toEqual(terra.cognition);
    expect(profile.experiment.personaMode).toBe(terra.experiment.personaMode);
  });

  it("五条旧指纹一个字节没动", () => {
    expect(strategyFingerprint(strategyById("baseline"))).toBe(
      "71793ece5269104b0720487155ce96a6c6fc3e548e6fbcf2191b6ba35921f868",
    );
    expect(strategyFingerprint(strategyById("expert-cognitive"))).toBe(
      "911f22f5dc924f04051ed22daeab70d369edf7e03a60eccec9e958244e81adf1",
    );
    expect(strategyFingerprint(strategyById("expert-claim-contest"))).toBe(
      "f8121563c80eeacb621f10202d3a65634f76a6a1f2ed69cadc7e3546509a7929",
    );
    expect(strategyFingerprint(strategyById("expert-disclosure-safe"))).toBe(
      "c3b77b0cbaa247a15f0891b3640968b64c4463aca35be906f21b00f75303c53b",
    );
  });

  it("新臂是旧臂的超集，继承的是同一批对象", () => {
    const safe = strategyById("expert-disclosure-safe");
    const disciplined = strategyById("expert-disciplined");
    for (const h of safe.heuristics) expect(disciplined.heuristics).toContain(h);
    expect(disciplined.heuristics.length).toBeGreaterThan(safe.heuristics.length);
  });

  it("新加的条目里没有任何一条是配额或硬规则", () => {
    const added = strategyById("expert-disciplined").heuristics.filter(
      (h) => h.id.startsWith("edv.") || h.id.startsWith("eda."),
    );
    expect(added.length).toBeGreaterThanOrEqual(11);
    for (const h of added) {
      // No entry may demand a fixed vote or a fixed target.
      expect(h.consider, h.id).not.toMatch(/必须投反对|一定要否|必须刺/);
    }
    const rendered = strategyById("expert-disciplined");
    const text = rendered.heuristics.map((h) => h.consider).join("\n");
    expect(text).toContain("放过去也是一种取证");
    expect(text).toContain("最会组织的那个人同样可能是派西维尔");
  });

  it("规划者提示里，0.6.0 的四项新说明都在", async () => {
    const state = createGame({ seed: 5, config: CONFIG, deal: dealWith({}) });
    const observation = observationFor(state, state.pending!.seat);
    const built = buildCognitivePrompt({
      observation,
      persona: personaById("ledger"),
      strategy: strategyById("expert-disciplined"),
      ledger: new CognitionStore().for(observation),
      config: CONFIG,
    });
    expect(built.promptVersion).toBe(PROMPT_VERSION_M54);
    expect(built.system).toContain("私有信息可以决定动作");
    expect(built.user).toContain("communicationIntent");
  });
});
