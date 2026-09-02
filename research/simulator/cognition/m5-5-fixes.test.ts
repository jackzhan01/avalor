/**
 * The two runtime bugs the terminated M5.5 Terra pilot found.
 *
 * `g-35f98393-cbae-429c-8b3e-96fa9b1b4f46`, seed 1, request 10, $0.4448,
 * `cognition_invalid`. Both are reproduced here from the pilot's own recorded
 * state before either fix is exercised, so the tests describe what happened
 * rather than what I remember happening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { llmAgent, type CognitionReport } from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import type { GameState } from "../core/state";
import { CLAIM_PURPOSES, SEATS, type Seat, type SpeechAction } from "../core/types";
import { REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import { checkInvariants } from "../fixtures/invariants";
import { buildPublicReplay, serialisePublicReplay } from "../run/artifacts";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_M55 } from "../prompts/version";
import { taskSchemaFor } from "../prompts/tasks";
import { jsonSchemaFor } from "../model/json-schema";
import { parseAction } from "../model/structured";
import type { ModelRequest } from "../model/client";
import { CognitionStore } from "./store";
import { disclosureClient, isSpokespersonRequest } from "./scripted-cognitive-client";
import { claimContestFrom } from "./claim-contest";
import { contestProblems } from "./contest";
import { claimStateFor } from "./claim-persistence";
import { replayPrefix } from "../run/runner";
import type { RecordedAction } from "../run/artifacts";

const CONFIG = testConfig({
  promptVersion: PROMPT_VERSION_M55,
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: {
    personaMode: "heterogeneous-rotated",
    strategyProfile: "expert-disciplined",
  },
});

function dealWith(overrides: Partial<Record<Seat, RoleType>> = {}): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("这一套里任何请求都是 bug");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/* ── 1. The pilot state, exactly ────────────────────────────────────────── */

describe("1 · 第一次对跳 —— 实盘卡死的那一步", () => {
  /**
   * The public log as it stood at the moment the pilot died.
   *
   * Seat 8 claimed Percival at seq 4 and nothing else had happened; seat 7 was
   * the next speaker. Written out rather than driven, so the state under test
   * is the recorded one and cannot drift with the scripted double.
   */
  const PILOT_LOG = [
    { type: "game_start", sequence: 1 },
    { type: "opening_direction", sequence: 2, seat: 8, ladySide: "left", rotation: "right" },
    { type: "lady_assigned", sequence: 3, holder: 9 },
    {
      type: "speech",
      sequence: 4,
      speaker: 8,
      slot: "opening",
      publicMessage: "我跳派西维尔。",
      claim: "percival",
      stances: [],
      tentativeTeam: [8, 1, 2],
      noTeamYet: false,
    },
  ] as never;

  /** Seat 7's block, field for field as the pilot recorded it. */
  const PILOT_CONTEST = {
    ownClaimStrategy: {
      currentStatus: "active",
      intendedClaimRole: "percival",
      situationSpecificBenefit: "首轮抢下派权，8 号的车单要过我这一关",
      situationSpecificRisk: "对跳会把我摆到台面上，之后每一步都要对得上",
      triggerToClaim: "现在",
      triggerToRetract: "如果我的车连挂两轮",
      candidatePairStory: "",
      leadershipObjective: "把发车权拿过来",
      concealmentCost: "不跳就只能跟着 8 号的节奏走",
      consistencyObligations: ["我说过 8、1、2 不够安全"],
    },
    claimantAssessments: [
      {
        claimantSeat: 8,
        claimedRole: "percival",
        claimedOrImpliedPair: null,
        positiveCase: ["他确实第一个跳了"],
        negativeCase: ["首轮首点零信息就跳，成本很低"],
        contradictions: [],
        fulfilledPredictions: [],
        failedPredictions: [],
        currentAssessment: "contested",
        conditionToUpgrade: "他的车真的开出成功",
        conditionToDowngrade: "他的车挂了",
        premiseIds: [],
      },
    ],
    rivalPlans: [
      {
        rivalSeat: 8,
        whyTheirClaimCompetesWithMine: "同一个身份只能有一个是真的",
        attackCase: "他零信息就跳，时机太便宜",
        expectedDefense: "他会说先跳是为了组织好人",
        myResponse: "那就请他先拿出可核对的车单标准",
        riskOfOverattacking: "打太狠会让好人两边都不信",
        distinctionTest: "看谁的车先开出成功",
      },
    ],
    alignment: {
      selectedClaimant: 8,
      stance: "oppose",
      proposition: "8 号的派西维尔声称没有任何可核对的东西支撑",
      voteOrTeamConsequence: "他的原车我下票",
      conditionToSwitch: "他给出结果之前就说对的判断",
    },
    publicClaimMove: {
      act: "counterclaim-percival",
      targetSeats: [8],
      publicProposition: "我也跳派西维尔",
      requestedTeam: null,
      requestedVote: "reject",
      evidenceIds: [],
      informationToConceal: "我的真实身份",
    },
  } as never;

  const check = (speech: unknown) =>
    contestProblems(PILOT_CONTEST, {
      seat: 7,
      contest: claimContestFrom(PILOT_LOG),
      teamSize: null,
      speech: speech as never,
    });

  it("**实盘那一刻的状态确实是「8 号站着、7 号没站过」**", () => {
    const contest = claimContestFrom(PILOT_LOG);
    expect(contest.activePercivalClaimants).toEqual([8]);
    expect(contest.bySeat[7]).toBeUndefined();
  });

  it("**第一次对跳 + 对现任做计划，现在一次就过**", () => {
    // The exact submission that was refused three times and killed the game.
    expect(
      check({ claim: "percival", retractClaim: false, stances: [] }),
    ).toEqual([]);
  });

  it("**旧实现在同一份输入上必然失败** —— 把那一行的条件重算一遍", () => {
    // The pre-fix predicate, recomputed from the same inputs rather than by
    // temporarily reverting the file: `iAmStanding` read ONLY the referee
    // record from before the action, so a first counter-claim could never
    // satisfy it. The live artifact agrees — all three attempts were refused.
    const contest = claimContestFrom(PILOT_LOG);
    const oldIAmStanding = ["active", "contested"].includes(
      contest.bySeat[7]?.status ?? "none",
    );
    const rivalPlans = (PILOT_CONTEST as never as { rivalPlans: unknown[] }).rivalPlans;
    expect(oldIAmStanding).toBe(false);
    expect(rivalPlans.length).toBeGreaterThan(0);
    // Which is exactly the refusal condition that killed the pilot.
    expect(!oldIAmStanding && rivalPlans.length > 0).toBe(true);
    // And the new one, on the same inputs, does not fire.
    expect(check({ claim: "percival", retractClaim: false, stances: [] })).toEqual([]);
  });

  it("**同一个块、不提交声称 → 仍然拒绝**（旧行为在这里保留）", () => {
    // The rejection that was always correct: planning against a rival while
    // standing on nothing and claiming nothing.
    expect(check({ claim: null, retractClaim: false, stances: [] }).join()).toContain(
      "rivalPlans 只在你自己也站在声称上时才有意义",
    );
    expect(check(null).join()).toContain("rivalPlans 只在你自己也站在声称上时才有意义");
  });

  it("同一步里又跳又退水 → 不算站上去", () => {
    // Claiming and retracting at once is a contradiction the referee itself
    // rejects; treating it as standing here would launder it.
    expect(
      check({ claim: "percival", retractClaim: true, stances: [] }).join(),
    ).toContain("rivalPlans 只在你自己也站在声称上时才有意义");
  });

  it("跳的是别的身份 → 不算站上派权", () => {
    expect(
      check({ claim: "merlin", retractClaim: false, stances: [] }).join(),
    ).toContain("rivalPlans 只在你自己也站在声称上时才有意义");
  });

  it("**没有削弱其他检查**：声称者覆盖、退水、动作冲突照旧", () => {
    const speech = { claim: "percival", retractClaim: false, stances: [] };
    // Coverage: dropping the standing claimant from the assessments is refused.
    const noCoverage = {
      ...(PILOT_CONTEST as unknown as Record<string, unknown>),
      claimantAssessments: [],
    };
    expect(contestProblems(noCoverage as never, {
      seat: 7,
      contest: claimContestFrom(PILOT_LOG),
      teamSize: null,
      speech: speech as never,
    }).join()).toContain("8号");

    // `defend-own-claim` still needs a claim that ALREADY stands — you cannot
    // defend one you are making in the same breath.
    const defending = {
      ...(PILOT_CONTEST as unknown as Record<string, unknown>),
      publicClaimMove: {
        ...(PILOT_CONTEST as never as { publicClaimMove: Record<string, unknown> })
          .publicClaimMove,
        act: "defend-own-claim",
        targetSeats: [],
      },
    };
    expect(contestProblems(defending as never, {
      seat: 7,
      contest: claimContestFrom(PILOT_LOG),
      teamSize: null,
      speech: speech as never,
    }).join()).toContain("但你现在没有成立的身份声称");

    // Atomicity: the block says counterclaim, the speech claims nothing.
    expect(
      check({ claim: null, retractClaim: false, stances: [] }).join(),
    ).toContain("这次发言的 claim 是 null");
  });
});

/* ── 2. The two fields, through the canonical parser ────────────────────── */

describe("2 · claimPurpose / ambiguityEventIds 走规范解析器", () => {
  const request = { kind: "speech" as const, seat: 7 as Seat, slot: "regular" as const };
  const answer = (extra: Record<string, unknown>) =>
    parseAction(
      JSON.stringify({
        publicMessage: "我还是那句话。",
        stances: [],
        claim: "percival",
        ...extra,
      }),
      request,
    );

  it("**两个字段都活着到 parsed.action**", () => {
    const r = answer({ claimPurpose: "answering-challenge", ambiguityEventIds: [20, 34] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.action as SpeechAction;
    expect(a.claimPurpose).toBe("answering-challenge");
    expect(a.ambiguityEventIds).toEqual([20, 34]);
  });

  it("四个合法 purpose 全部通过", () => {
    for (const p of CLAIM_PURPOSES) {
      const r = answer({ claimPurpose: p });
      expect(r.ok, p).toBe(true);
      if (r.ok) expect((r.action as SpeechAction).claimPurpose).toBe(p);
    }
  });

  it("不认识的 purpose 被打回，而不是悄悄丢掉", () => {
    const r = answer({ claimPurpose: "because-i-felt-like-it" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("claimPurpose");
  });

  it("坏的 ambiguityEventIds 被打回", () => {
    for (const bad of [["20"], [-1], [1.5], "20", 20]) {
      const r = answer({ ambiguityEventIds: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("**没给的时候连键都不写** —— 0.6.0 的回答解析出来一个字节不变", () => {
    const r = answer({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("claimPurpose" in r.action).toBe(false);
    expect("ambiguityEventIds" in r.action).toBe(false);
    // null is the same as absent, for the same reason.
    const withNulls = answer({ claimPurpose: null, ambiguityEventIds: null });
    expect(withNulls.ok).toBe(true);
    if (withNulls.ok) {
      expect("claimPurpose" in withNulls.action).toBe(false);
      expect("ambiguityEventIds" in withNulls.action).toBe(false);
    }
  });
});

/* ── 3. The schema-to-parser contract ───────────────────────────────────── */

describe("3 · schema ↔ 解析器契约", () => {
  /**
   * Fields the schema asks for that are deliberately NOT part of the action.
   *
   * AN EXPLICIT LIST, and that is the whole point. Each of these is read by
   * `llm-agent` from the raw answer for its own purpose — the ledger, the
   * firewall, the vote and coordination checks — and none belongs on the object
   * the referee applies. A field that is in NEITHER this list nor the parsed
   * action is the M5.5 bug shape: asked for, answered, discarded.
   */
  /** Written to the action only when true. See `structured.ts`. */
  const ABSENT_WHEN_FALSE: readonly string[] = ["retractClaim", "noTeamYet"];

  const READ_ELSEWHERE: readonly string[] = [
    "cognition",
    "communicationIntent",
    "voteAnalysis",
    "coordination",
    "assassination",
  ];

  /** One legal-looking answer per schema, built from the schema itself. */
  function sampleFor(fields: readonly string[]): Record<string, unknown> {
    const cell: Record<string, unknown> = {};
    const put = (k: string, v: unknown) => {
      if (fields.includes(k)) cell[k] = v;
    };
    put("publicMessage", "一句话。");
    put("message", "一句话。");
    put("stances", []);
    put("claim", "percival");
    put("claimPurpose", "first-claim");
    put("ambiguityEventIds", [4]);
    put("retractClaim", false);
    put("tentativeTeam", null);
    put("noTeamYet", true);
    put("team", [1, 2, 3]);
    put("choice", "approve");
    put("card", "success");
    put("ladySide", "left");
    put("target", 5);
    put("announced", "good");
    put("message", "一句话。");
    put("memoryPatch", null);
    put("rationale", null);
    return cell;
  }

  /**
   * Every `DecisionRequest` kind. All nine, deliberately.
   *
   * A contract that covered only the kinds somebody remembered would miss the
   * next field added to the one that was forgotten — which is exactly how the
   * M5.5 bug survived a green suite.
   */
  const REQUESTS = [
    { kind: "choose_opening_direction", seat: 8 },
    { kind: "speech", seat: 7, slot: "regular" },
    { kind: "speech", seat: 7, slot: "opening" },
    { kind: "leader_close_and_propose", seat: 8, teamSize: 3 },
    { kind: "vote", seat: 3 },
    { kind: "mission", seat: 2 },
    { kind: "lady_select", seat: 9, eligible: [1, 2, 3] },
    { kind: "lady_announce", seat: 9, target: 1, eligible: [1, 2, 3] },
    { kind: "evil_discuss", seat: 2, audience: [2, 3, 7] },
    { kind: "assassinate", seat: 2 },
  ] as never as readonly { kind: string; seat: Seat }[];

  it("**schema 要的每一个动作字段，解析器都必须留下** —— 否则这条会红", () => {
    const dropped: string[] = [];
    for (const request of REQUESTS) {
      const schema = taskSchemaFor(request as never, 220, {
        withRetraction: true,
        withCoordination: true,
        withVoteAnalysis: true,
        withAssassinationRanking: true,
        withLadyAnalysis: true,
        withClaimPurpose: true,
      });
      expect(schema, request.kind).toBeTruthy();
      const fields = schema.fields.map((f) => f.name);
      // The JSON Schema and the field list must agree, first of all.
      const properties = Object.keys(
        (jsonSchemaFor(schema) as { properties: Record<string, unknown> }).properties,
      );
      expect(properties.sort()).toEqual([...fields].sort());

      const parsed = parseAction(JSON.stringify(sampleFor(fields)), request as never);
      expect(parsed.ok, `${request.kind}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      if (!parsed.ok) continue;
      for (const name of fields) {
        if (READ_ELSEWHERE.includes(name)) continue;
        // `kind` is synthesised, and a null-valued optional legitimately
        // vanishes — what must not happen is a field with a REAL value
        // disappearing without anybody noticing.
        const value = sampleFor(fields)[name];
        if (value === null || value === undefined) continue;
        // `false` legitimately maps to absence for the two flags that are
        // written only when true — an always-present `false` would change the
        // bytes of every speech replayed from a game recorded before the flag
        // existed. Documented in `structured.ts`, and listed here rather than
        // silently skipped so the exception stays visible.
        if (value === false && ABSENT_WHEN_FALSE.includes(name)) continue;
        if (!(name in (parsed.action as unknown as Record<string, unknown>))) {
          dropped.push(`${request.kind}.${name}`);
        }
      }
    }
    expect(dropped).toEqual([]);
  });

  it("这条契约真的会红 —— 拿一个解析器不认识的字段验证它", () => {
    // A field the schema could expose and the parser does not know about must
    // be caught, not shrugged off. Simulated here rather than by breaking the
    // parser, so the test stays honest about what it is checking.
    const fields = ["publicMessage", "claim", "somethingNew"];
    const parsed = parseAction(
      JSON.stringify({ publicMessage: "x", claim: "percival", somethingNew: 42 }),
      { kind: "speech", seat: 7, slot: "regular" } as never,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const missing = fields.filter(
      (n) => !READ_ELSEWHERE.includes(n) && !(n in (parsed.action as unknown as Record<string, unknown>)),
    );
    expect(missing).toEqual(["somethingNew"]);
  });
});

/* ── 4. End to end, through llm-agent ───────────────────────────────────── */

describe("4 · 端到端：strict schema → 解析 → 校验 → 折叠 → 裁判 → 遥测", () => {
  /**
   * One decision, driven through the real agent with a crafted answer.
   *
   * DELIBERATELY NOT a whole scripted game for the claim cases. A game double
   * decides for itself when to claim, so a test built on one is really a test
   * of the double — and the bug this file exists for slipped past a green suite
   * for exactly that reason. Here the answer is written by hand, and everything
   * after it is the production path: `parseAction`, the contest and claim
   * checks, the ledger fold, `applyAction`, and the telemetry hook.
   */
  async function speak(input: {
    readonly state: GameState;
    readonly seat: Seat;
    readonly answer: (prompt: string) => Record<string, unknown>;
    /**
     * How many times to re-ask after a rejection, the way `runLiveGame` does.
     *
     * The agent does NOT retry inside `act` — it throws `UnparseableAnswer` and
     * the runner calls `act` again with `RejectionFeedback`. A test that only
     * called `act` once would see a single prompt and conclude no repair
     * happened, which is the opposite of the truth.
     */
    readonly repairs?: number;
  }): Promise<{
    readonly reports: CognitionReport[];
    readonly prompts: string[];
    readonly error: unknown;
    readonly applied: boolean;
  }> {
    const reports: CognitionReport[] = [];
    const prompts: string[] = [];
    const store = new CognitionStore();
    const base = disclosureClient({});
    const client = {
      name: "hand-written",
      async complete(request: ModelRequest) {
        const response = await base.complete(request);
        if (isSpokespersonRequest(request)) return response;
        prompts.push(request.user);
        const cell = JSON.parse(response.text) as Record<string, unknown>;
        return { ...response, text: JSON.stringify({ ...cell, ...input.answer(request.user) }) };
      },
    };
    const agent = llmAgent(input.seat, {
      client: client as never,
      persona: personaById(assignPersonas(3, "heterogeneous-rotated")[input.seat].id),
      strategy: strategyById("expert-disciplined"),
      config: CONFIG,
      cognition: { store, onCognition: (r) => reports.push(r) },
    });
    let error: unknown = null;
    let applied = false;
    const repairs = input.repairs ?? 0;
    for (let attempt = 0; attempt <= repairs; attempt += 1) {
      try {
        const action = await agent.act(
          observationFor(input.state, input.seat),
          attempt === 0
            ? undefined
            : { attempt, error: error instanceof Error ? error.message : String(error) },
        );
        applyAction(input.state, input.seat, action);
        applied = true;
        error = null;
        break;
      } catch (caught) {
        error = caught;
      }
    }
    return { reports, prompts, error, applied };
  }

  /**
   * Play on until `seat` is asked to SPEAK again.
   *
   * Landing on any pending decision is not enough: injecting `claim` into a
   * vote or a mission card produces an action the parser correctly ignores, and
   * the test would then be asserting about a claim that was never submitted.
   */
  async function runUntilSpeechBy(state: GameState, seat: Seat): Promise<void> {
    let guard = 0;
    while (state.pending && guard < 200) {
      if (state.pending.seat === seat && state.pending.kind === "speech") return;
      await speak({ state, seat: state.pending.seat, answer: () => ({}) });
      guard += 1;
    }
  }

  /**
   * Make somebody publicly take a stance on `seat`, whenever the next speaker
   * comes up.
   *
   * A `stance-on-me` is one of the five kinds that qualify as an ambiguity, and
   * it is the only one reachable inside a single proposal round. Planted rather
   * than hoped for: other seats simply TALKING is deliberately not an
   * ambiguity, which is the whole point of the gate.
   */
  async function plantChallengeAgainst(state: GameState, seat: Seat): Promise<boolean> {
    let guard = 0;
    while (state.pending && guard < 60) {
      if (state.pending.kind === "speech" && state.pending.seat !== seat) {
        await speak({
          state,
          seat: state.pending.seat,
          answer: () => ({ stances: [{ seat, valence: -0.5, confidence: 0.5 }] }),
        });
        return true;
      }
      await speak({ state, seat: state.pending.seat, answer: () => ({}) });
      guard += 1;
    }
    return false;
  }

  /** A game standing at seat 7's regular speech, with seat 8 claiming first. */
  async function pilotPrefix(): Promise<GameState> {
    const state = createGame({ seed: 3, config: CONFIG, deal: dealWith() });
    // Seat 8 opens and claims Percival — the pilot's seq 4.
    while (state.pending && state.pending.kind !== "speech") {
      const seat = state.pending.seat;
      await speak({ state, seat, answer: () => ({}) });
    }
    const opener = state.pending!.seat;
    await speak({ state, seat: opener, answer: () => ({ claim: "percival" }) });
    return state;
  }

  it("**离线复现实盘前缀：7 号的第一次对跳一次通过，零认知重问**", async () => {
    const state = await pilotPrefix();
    const contest = claimContestFrom(state.log);
    expect(contest.activePercivalClaimants.length).toBe(1);
    const claimant = contest.activePercivalClaimants[0];
    const seat = state.pending!.seat;
    expect(seat).not.toBe(claimant);

    const r = await speak({
      state,
      seat,
      answer: () => ({ claim: "percival", claimPurpose: "first-claim" }),
    });
    expect(r.error).toBeNull();
    expect(r.applied).toBe(true);
    // ONE prompt means one attempt: no cognition repair happened.
    expect(r.prompts).toHaveLength(1);
    expect(claimContestFrom(state.log).activePercivalClaimants).toContain(seat);
  });

  it("**遥测 byPurpose 被填上了** —— 这就是实盘漏掉的那一格", async () => {
    const state = await pilotPrefix();
    const seat = state.pending!.seat;
    const r = await speak({
      state,
      seat,
      answer: () => ({ claim: "percival", claimPurpose: "first-claim" }),
    });
    const m = r.reports.at(-1)?.claimRealism;
    expect(m).not.toBeNull();
    expect(m!.claims).toBe(1);
    expect(m!.byPurpose["first-claim"]).toBe(1);
    expect(m!.purposeless).toBe(0);
  });

  it("**有正当 purpose 的重复声称通过**", async () => {
    const state = await pilotPrefix();
    const seat = state.pending!.seat;
    await speak({ state, seat, answer: () => ({ claim: "percival", claimPurpose: "first-claim" }) });
    // Somebody has to actually challenge before `answering-challenge` is true.
    // The check reads the log, not the seat's feelings about the table.
    expect(await plantChallengeAgainst(state, seat)).toBe(true);
    await runUntilSpeechBy(state, seat);
    if (!state.pending) return;
    const r = await speak({
      state,
      seat,
      answer: () => ({ claim: "percival", claimPurpose: "answering-challenge" }),
    });
    expect(r.error).toBeNull();
    expect(r.prompts).toHaveLength(1);
    expect(r.reports.at(-1)?.claimRealism?.purposeless).toBe(0);
    expect(r.reports.at(-1)?.claimRealism?.byPurpose["answering-challenge"]).toBe(1);
  });

  it("**没有 purpose 的重复声称被有界重问**", async () => {
    const state = await pilotPrefix();
    const seat = state.pending!.seat;
    await speak({ state, seat, answer: () => ({ claim: "percival", claimPurpose: "first-claim" }) });
    await runUntilSpeechBy(state, seat);
    if (!state.pending) return;
    expect(claimStateFor(seat, "percival", state.log).standing).toBe("percival");
    const r = await speak({
      state,
      seat,
      answer: () => ({ claim: "percival", claimPurpose: null }),
      repairs: 2,
    });
    // Refused every time, never applied, and the reason is the named one.
    expect(r.applied).toBe(false);
    // Bounded: two repairs, then the run stops rather than accepting a claim
    // the record does not support. The LAST error is the terminal one, so the
    // evidence that the repair path ran is the prompts, not the message.
    expect(r.prompts).toHaveLength(3);
    expect(r.prompts.at(-1)).toContain("这个身份声称是重复的");
    expect(r.prompts.at(-1)).toContain("一直挂着");
    expect(String(r.error)).toContain("cognition 结构始终不合法");
    // NOT asserted on telemetry. `onCognition` fires only after every check
    // passes, so a REJECTED claim never produces a report — the rejection is
    // recorded as a model-call outcome in the private trace instead. Reported
    // as a known limitation rather than papered over with a weaker assertion.
  });

  it("**resolving-ambiguity：合格的事件通过**", async () => {
    const state = await pilotPrefix();
    const seat = state.pending!.seat;
    await speak({ state, seat, answer: () => ({ claim: "percival", claimPurpose: "first-claim" }) });
    // Something has to have HAPPENED. Other seats simply talking is not an
    // ambiguity — the gate exists precisely to refuse that.
    expect(await plantChallengeAgainst(state, seat)).toBe(true);
    await runUntilSpeechBy(state, seat);
    if (!state.pending) return;
    let cited: number[] = [];
    const r = await speak({
      state,
      seat,
      answer: (prompt) => {
        // The prompt lists what may legitimately be cited. Using it is the
        // point: the seat is answering from the record, not guessing.
        // The prompt layer says 「能引的有：」 and the repair note says
        // 「可以引的有：」. Matching both, because the test must read what the
        // seat was actually shown rather than one remembered phrasing.
        const offered = /(?:可以引的有|能引的有)：([^。]*)。/.exec(prompt);
        cited = [...(offered?.[1] ?? "").matchAll(/seq (\d+)/g)].map((m) => Number(m[1]));
        return {
          claim: "percival",
          claimPurpose: "resolving-ambiguity",
          ambiguityEventIds: cited.slice(0, 1),
        };
      },
    });
    expect(cited.length).toBeGreaterThan(0);
    expect(r.error).toBeNull();
    expect(r.prompts).toHaveLength(1);
    const m = r.reports.at(-1)?.claimRealism;
    expect(m?.acceptedAmbiguity).toBe(1);
    expect(m?.rejectedAmbiguity).toBe(0);
    expect(m?.ambiguityEventIds).toEqual(cited.slice(0, 1));
  });

  it("**resolving-ambiguity：不存在 / 声称之前的事件被重问**", async () => {
    for (const bogus of [[99999], [1]]) {
      const state = await pilotPrefix();
      const seat = state.pending!.seat;
      await speak({
        state,
        seat,
        answer: () => ({ claim: "percival", claimPurpose: "first-claim" }),
      });
      await runUntilSpeechBy(state, seat);
      if (!state.pending) continue;
      const r = await speak({
        state,
        seat,
        answer: () => ({
          claim: "percival",
          claimPurpose: "resolving-ambiguity",
          ambiguityEventIds: bogus,
        }),
        repairs: 2,
      });
      expect(r.applied, JSON.stringify(bogus)).toBe(false);
      expect(r.prompts.length, JSON.stringify(bogus)).toBe(3);
      expect(r.prompts.at(-1), JSON.stringify(bogus)).toContain("这个身份声称是重复的");
      // NOT asserted on telemetry. `onCognition` fires only after every check
    // passes, so a REJECTED claim never produces a report — the rejection is
    // recorded as a model-call outcome in the private trace instead. Reported
    // as a known limitation rather than papered over with a weaker assertion.
    }
  });

  it("**接受的 purpose 与事件 id 挺过 JSON 往返，并在重放里保持一致**", async () => {
    const state = await pilotPrefix();
    const seat = state.pending!.seat;
    const before = state.standingClaims.map((c) => c.seat);
    await speak({
      state,
      seat,
      answer: () => ({ claim: "percival", claimPurpose: "first-claim" }),
    });
    // What a checkpoint does to the action: JSON out, JSON in.
    const action = {
      kind: "speech",
      publicMessage: "x",
      claim: "percival",
      claimPurpose: "first-claim",
      ambiguityEventIds: [4],
    };
    const round = JSON.parse(JSON.stringify(action)) as SpeechAction;
    expect(round.claimPurpose).toBe("first-claim");
    expect(round.ambiguityEventIds).toEqual([4]);
    // And the referee state the resume would rebuild carries the claim.
    expect(state.standingClaims.map((c) => c.seat)).toEqual([...before, seat]);
  });

  it("**两个字段进不了公开事件、公开发言和公开产物**", async () => {
    const state = await pilotPrefix();
    const seat = state.pending!.seat;
    await speak({
      state,
      seat,
      answer: () => ({
        claim: "percival",
        claimPurpose: "resolving-ambiguity",
        ambiguityEventIds: [4],
      }),
      repairs: 0,
    });
    const replay = serialisePublicReplay(
      buildPublicReplay(
        state,
        Object.fromEntries(SEATS.map((x) => [x, { name: "double" }])) as never,
        { status: "completed" },
      ),
    );
    for (const key of [
      "claimPurpose",
      "ambiguityEventIds",
      "first-claim",
      "resolving-ambiguity",
      "answering-challenge",
    ]) {
      expect(replay, key).not.toContain(key);
    }
    for (const e of state.log) {
      if (e.type !== "speech") continue;
      expect(Object.keys(e)).not.toContain("claimPurpose");
      expect(Object.keys(e)).not.toContain("ambiguityEventIds");
    }
  });

  it("**整局仍然跑得完，零网络请求，裁判零违规**", async () => {
    const state = createGame({ seed: 3, config: CONFIG, deal: dealWith() });
    const store = new CognitionStore();
    const client = disclosureClient({ claimSeats: [2, 7] });
    const agents = {} as Record<Seat, Agent>;
    for (const s of SEATS) {
      agents[s] = llmAgent(s, {
        client,
        persona: personaById(assignPersonas(3, "heterogeneous-rotated")[s].id),
        strategy: strategyById("expert-disciplined"),
        config: CONFIG,
        cognition: { store },
      });
    }
    let n = 0;
    while (state.pending && n < 400) {
      const s = state.pending.seat;
      applyAction(state, s, await agents[s].act(observationFor(state, s)));
      n += 1;
    }
    expect(state.pending).toBeNull();
    expect(checkInvariants(state)).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
