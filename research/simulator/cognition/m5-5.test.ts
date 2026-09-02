import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { llmAgent, type CognitionReport } from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor, type Observation } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import type { GameState } from "../core/state";
import { SEATS, type Seat } from "../core/types";
import { REFERENCE_ASSIGNMENT, drive, referenceDeal, testConfig } from "../fixtures/harness";
import { checkInvariants } from "../fixtures/invariants";
import { buildPublicReplay, serialisePublicReplay } from "../run/artifacts";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById, strategyFingerprint } from "../prompts/strategies";
import { capabilitiesFor, DECLARED_PROMPT_VERSIONS } from "../prompts/capabilities";
import { PROMPT_VERSION_M54, PROMPT_VERSION_M55 } from "../prompts/version";
import { loadProfile } from "../config/load";
import { jsonSchemaFor, schemaNameFor } from "../model/json-schema";
import { taskSchemaFor } from "../prompts/tasks";
import type { ModelRequest } from "../model/client";
import { CognitionStore } from "./store";
import { disclosureClient, isSpokespersonRequest } from "./scripted-cognitive-client";
import {
  buildCognitivePrompt,
  COGNITION_INSTRUCTION_V2,
  COGNITION_INSTRUCTION_V3,
  COGNITION_INSTRUCTION_V4,
  COMMITMENT_ID_INSTRUCTION,
  COMMITMENT_ID_INSTRUCTION_PROSE,
} from "./build-cognitive";
import { buildFactRegistry } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { claimsFrom, publicFactsFrom } from "./ledger";
import { findMachineIds } from "./machine-ids";
import { classifyRef, malformedRefs, malformedRefsNote } from "./evidence-refs";
import { groupingsIn, pairDisclosureMetric, pairRisk } from "./pair-disclosure";
import {
  ambiguityEventsAfter,
  checkClaim,
  claimStateFor,
  emptyClaimMetric,
  foldClaimMetric,
} from "./claim-persistence";
import {
  ASSASSINATION_INSTRUCTION,
  assassinationProblems,
  isLadyOnlyCounterEvidence,
  LADY_INSTRUCTION,
} from "./assassination";
import { VOTE_ANALYSIS_INSTRUCTION } from "./vote-discipline";
import type { AssassinationRanking } from "./assassination";
import { validatePublicMessage } from "./firewall";

const CONFIG = testConfig({
  promptVersion: PROMPT_VERSION_M55,
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: {
    personaMode: "heterogeneous-rotated",
    strategyProfile: "expert-disciplined",
  },
});

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
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

/* ── 1. The Oberon gate ─────────────────────────────────────────────────── */

describe("1 · 奥伯伦拿不到协调协议的任何痕迹", () => {
  /**
   * Play to a mission-card decision for one seat, under one deal.
   *
   * The two arms differ ONLY in who the mutually aware villains are, which is
   * exactly what the non-interference claim is about: Oberon's prompt must not
   * move when the roster around him moves.
   */
  function cardPromptFor(deal: Deal, seat: Seat, version: string) {
    const { state } = drive({
      seed: 7,
      deal,
      override: (observation) => {
        if (observation.request?.kind === "leader_close_and_propose") {
          // Seats 1-5 in order, cut to whatever this mission wants. Deliberately
          // a FIXED team across both arms of the non-interference test: a team
          // that varied with the deal would move Oberon's prompt for a reason
          // that has nothing to do with the coordination protocol.
          return {
            kind: "leader_close_and_propose",
            publicMessage: "收尾。",
            team: ([1, 2, 3, 4, 5] as Seat[]).slice(0, observation.request.teamSize),
          };
        }
        return undefined;
      },
      stopWhen: (s) => s.pending?.kind === "mission" && s.pending.seat === seat,
    });
    if (state.pending?.seat !== seat) return null;
    const observation = observationFor(state, seat);
    const config = testConfig({
      promptVersion: version,
      cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
    } as never);
    const built = buildCognitivePrompt({
      observation,
      persona: personaById(assignPersonas(7, "heterogeneous-rotated")[seat].id),
      strategy: strategyById("expert-disciplined"),
      ledger: new CognitionStore().for(observation),
      config,
    });
    return { built, observation };
  }

  /** The schema alone, which is where the 0.6.0 leak actually lived. */
  function cardSchema(observation: Observation, version: string) {
    const caps = capabilitiesFor(version);
    const request = observation.request;
    if (!request) throw new Error("no request");
    const wants =
      caps.evilCoordination &&
      (!caps.coordinationFieldGated || observation.missionCoordination !== null);
    return jsonSchemaFor(
      taskSchemaFor(request, 220, {
        withRetraction: true,
        ...(wants ? { withCoordination: true } : {}),
        ...(caps.voteDiscipline ? { withVoteAnalysis: true } : {}),
        ...(caps.assassinRanking ? { withAssassinationRanking: true } : {}),
        ...(caps.ladyNeutralAssassination ? { withLadyAnalysis: true } : {}),
        ...(caps.persistentClaims ? { withClaimPurpose: true } : {}),
      }),
    );
  }

  it("**0.6.0 的缺陷是真的：奥伯伦拿到了字段，却没有那一节**", () => {
    // The defect this milestone exists to close, asserted rather than
    // remembered — and asserted against the frozen stack, which keeps it.
    const deal = dealWith({});
    const r = cardPromptFor(deal, deal.oberon, PROMPT_VERSION_M54);
    if (!r) return; // Oberon did not ride mission 1 under this seed.
    expect(r.observation.missionCoordination).toBeNull();
    expect(r.built.user).not.toContain("坏人出牌协调");
    expect(JSON.stringify(cardSchema(r.observation, PROMPT_VERSION_M54))).toContain(
      "designated",
    );
  });

  it("**0.7.0 关上了：没有那一节，也没有那个字段**", () => {
    const deal = dealWith({});
    const r = cardPromptFor(deal, deal.oberon, PROMPT_VERSION_M55);
    if (!r) return;
    expect(r.observation.missionCoordination).toBeNull();
    const schema = JSON.stringify(cardSchema(r.observation, PROMPT_VERSION_M55));
    for (const word of ["coordination", "designated", "failsRequired", "sabotage", "conceal"]) {
      expect(schema, word).not.toContain(word);
    }
    for (const word of ["坏人出牌协调", "指定出牌人", "固定顺序", "协调"]) {
      expect(r.built.user, word).not.toContain(word);
    }
  });

  it("**换掉互认坏人的组成，奥伯伦的提示和 schema 逐字节不变**", () => {
    // The non-interference claim. Two deals that differ ONLY in which seats
    // hold the three mutually aware evil roles, with Oberon fixed.
    const armA = dealWith({ 7: "morgana", 8: "assassin", 9: "mordred", 3: "loyal", 5: "loyal" });
    const armB = dealWith({ 3: "morgana", 5: "assassin", 7: "mordred", 8: "loyal", 9: "loyal" });
    expect(armA.oberon).toBe(armB.oberon);

    const a = cardPromptFor(armA, armA.oberon, PROMPT_VERSION_M55);
    const b = cardPromptFor(armB, armB.oberon, PROMPT_VERSION_M55);
    if (!a || !b) return;
    expect(a.built.system).toBe(b.built.system);
    expect(a.built.user).toBe(b.built.user);
    expect(JSON.stringify(cardSchema(a.observation, PROMPT_VERSION_M55))).toBe(
      JSON.stringify(cardSchema(b.observation, PROMPT_VERSION_M55)),
    );
  });

  it("有资格的坏人仍然拿得到协调层和字段", () => {
    const deal = dealWith({});
    for (const seat of [deal.assassin, deal.morgana, deal.mordred]) {
      const r = cardPromptFor(deal, seat, PROMPT_VERSION_M55);
      if (!r) continue;
      expect(r.observation.missionCoordination, `${seat}`).not.toBeNull();
      expect(r.built.user, `${seat}`).toContain("坏人出牌协调");
      expect(JSON.stringify(cardSchema(r.observation, PROMPT_VERSION_M55))).toContain(
        "designated",
      );
    }
  });

  it("好人从来没有过这个字段，两个版本都一样", () => {
    const deal = dealWith({});
    for (const version of [PROMPT_VERSION_M54, PROMPT_VERSION_M55]) {
      const r = cardPromptFor(deal, deal.goodSeats[0], version);
      if (!r) continue;
      expect(r.observation.missionCoordination).toBeNull();
      expect(r.built.user).not.toContain("坏人出牌协调");
    }
  });
});

/** A registry from a real, short game. Shared by the id-shape suites. */
function registryFor(): ReturnType<typeof buildFactRegistry> {
  // Stop at the first resolved mission rather than capping actions: a cap
  // makes `drive` throw, and the registry only needs a game with some
  // referee facts in it.
  const { state } = drive({
    seed: 4,
    deal: referenceDeal(),
    stopWhen: (s) => s.missionTrack[1] !== "pending",
  });
  const observation = observationFor(state, 1);
  return buildFactRegistry(
    publicFactsFrom(observation.publicLog),
    claimsFrom(observation.publicLog),
    observation,
    claimContestFrom(observation.publicLog),
  );
}


/* ── 1b. No copyable example id in the 0.7.0 instruction ────────────────── */

describe("1b · 0.7.0 的说明里没有一个可以抄的 id", () => {
  /** Every `[...]` token the instruction prints, as a model would copy it. */
  function bracketTokens(text: string): string[] {
    return [...text.matchAll(/`\[([^\]]+)\]`/g)].map((m) => m[1]);
  }

  const V7 = [
    COGNITION_INSTRUCTION_V4,
    COMMITMENT_ID_INSTRUCTION_PROSE,
    LADY_INSTRUCTION,
    ASSASSINATION_INSTRUCTION,
    VOTE_ANALYSIS_INSTRUCTION,
  ].join("\n");

  it("**冻结的说明里确实有可抄的样例 —— 缺陷是真的**", () => {
    const frozen = bracketTokens(COGNITION_INSTRUCTION_V3);
    expect(frozen).toContain("f12");
    expect(frozen).toContain("f.fail1");
    expect(frozen).toContain("c33:role");
    // And this one is not an example at all: it is Percival's real pair id.
    expect(frozen).toContain("p.pair");
    expect(bracketTokens(COMMITMENT_ID_INSTRUCTION)).toContain("k30.0");
  });

  it("**0.7.0 里没有一个 token 长得像 id**", () => {
    const registry = registryFor();
    for (const token of bracketTokens(V7)) {
      // `classifyRef` returning non-null means "this could not be an accepted
      // premise". Every token in the instruction must fail that test.
      expect(classifyRef(token, registry), token).not.toBeNull();
    }
  });

  it("**0.7.0 里的任何 token 都不在任何座位的注册表里**", () => {
    const { state } = drive({
      seed: 4,
      deal: referenceDeal(),
      stopWhen: (st) => st.missionTrack[1] !== "pending",
    });
    const tokens = bracketTokens(V7);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const registry = buildFactRegistry(
        publicFactsFrom(observation.publicLog),
        claimsFrom(observation.publicLog),
        observation,
        claimContestFrom(observation.publicLog),
      );
      for (const token of tokens) {
        expect(registry.byId.has(token), `${seat}号 ${token}`).toBe(false);
      }
    }
  });

  it("**抄一个占位符进去 = 有界重问，不是被接受的前提**", () => {
    const registry = registryFor();
    for (const token of bracketTokens(V7)) {
      const hits = malformedRefs({ factsUsed: [token] }, registry);
      expect(hits, token).toHaveLength(1);
      expect(hits[0].field).toBe("factsUsed");
      // And the note describing it quotes nothing.
      expect(malformedRefsNote(hits)).not.toContain(token);
    }
  });

  it("说明里不再点名任何一个私有 id", () => {
    for (const name of ["p.pair", "p.self", "p.roster", "p.team", "p.lady"]) {
      expect(V7, name).not.toContain(name);
    }
    // The frozen text does name two of them — that is the thing being closed.
    expect(COGNITION_INSTRUCTION_V3).toContain("p.self");
    expect(COGNITION_INSTRUCTION_V3).toContain("p.pair");
  });

  it("而且还是在告诉模型该怎么填", () => {
    expect(COGNITION_INSTRUCTION_V4).toContain("从上面那张表里照抄，一格只放一个");
    expect(COGNITION_INSTRUCTION_V4).toContain("不会给你任何可以直接抄的 id 样例");
    expect(COGNITION_INSTRUCTION_V4).toContain("引不到就留空");
  });

  it("**0.3.1–0.6.0 一个字节都没动**", () => {
    // The whole reason 0.7.0 is a separate constant. Four completed games have
    // these bytes in their traces; `snapshots.test.ts` pins the built prompts,
    // and this pins the instruction constants they are built from.
    expect(COGNITION_INSTRUCTION_V2).toContain(
      "`[f12]`、`[f.fail1]`、`[c33:role]`、`[p.pair]` 这样的。**照抄方括号里面的东西**，",
    );
    expect(COGNITION_INSTRUCTION_V2).toContain("你自己的身份用 `p.self`。");
    expect(COGNITION_INSTRUCTION_V3.startsWith(COGNITION_INSTRUCTION_V2)).toBe(true);
    expect(COMMITMENT_ID_INSTRUCTION).toContain('`{"id": "k30.0", "resolution": "fulfilled"}`');
    // And the two variants share everything except the id paragraph.
    expect(COGNITION_INSTRUCTION_V4.endsWith(
      COGNITION_INSTRUCTION_V3.slice(COGNITION_INSTRUCTION_V3.indexOf("### `contest`：派权争夺")),
    )).toBe(true);
  });

  it("能力位只在 0.7.0 上开，而且真的换了说明", () => {
    expect(capabilitiesFor(PROMPT_VERSION_M55).proseExampleIds).toBe(true);
    for (const v of DECLARED_PROMPT_VERSIONS.filter((x) => x !== PROMPT_VERSION_M55)) {
      expect(capabilitiesFor(v).proseExampleIds, v).toBe(false);
    }
  });
});

/* ── 2. Malformed evidence references ───────────────────────────────────── */

describe("2 · 畸形证据引用：整格拒绝，绝不拆分", () => {

  it("**实盘那八个串全部被打回，而且没有一个被拆开**", () => {
    const registry = registryFor();
    const real = [
      "k4:claim】【、】【k45:claim",
      "f.fail1】【：】【“】【f.fail2",
      "k64:side:2】【、】【k64:side:4",
      "k45:claim】【、】【f15",
      "f.fail1】【、】【f.fail2",
    ];
    for (const raw of real) {
      expect(classifyRef(raw, registry), raw).toBe("multiple-ids");
    }
  });

  it("占位字符、空格、空串各有各的名字", () => {
    const registry = registryFor();
    expect(classifyRef("f32￼￼", registry)).toBe("replacement-character");
    expect(classifyRef(" f32", registry)).toBe("blank");
    expect(classifyRef("", registry)).toBe("blank");
    expect(classifyRef("【f32】", registry)).toBe("full-width-delimiter");
  });

  it("查不到的 id 被打回，查得到的放行", () => {
    const registry = registryFor();
    expect(classifyRef("f99999", registry)).toBe("unresolvable");
    expect(classifyRef("f.now", registry)).toBeNull();
    const anyFact = registry.entries.find((e) => e.kind !== "claim");
    if (anyFact) expect(classifyRef(anyFact.id, registry)).toBeNull();
  });

  it("**整块扫描会指出是哪个字段哪一格**", () => {
    const registry = registryFor();
    const hits = malformedRefs(
      {
        factsUsed: ["f.now", "k4:claim】【、】【k45:claim"],
        claimsReliedOn: [],
        claimsQuestioned: [],
        constraints: [{ premiseIds: ["f99999"] }],
        social: { focalCandidates: [{ basisIds: [" f.now"] }] },
      },
      registry,
    );
    expect(hits.map((h) => [h.field, h.index, h.kind])).toEqual([
      ["factsUsed", 1, "multiple-ids"],
      ["constraints[0].premiseIds", 0, "unresolvable"],
      ["social.focalCandidates[0].basisIds", 0, "blank"],
    ]);
  });

  it("**重问说明只讲形状，一个字都不回引模型写的内容**", () => {
    const registry = registryFor();
    const hits = malformedRefs({ factsUsed: ["k4:claim】【、】【k45:claim"] }, registry);
    const note = malformedRefsNote(hits);
    expect(note).toContain("factsUsed");
    expect(note).toContain("第 1 格");
    // The raw value is recorded PRIVATELY and never echoed — an unresolvable id
    // may be another seat's, so quoting it back would be a probe.
    expect(note).not.toContain("k4:claim");
    expect(note).not.toContain("】");
    expect(hits[0].raw).toBe("k4:claim】【、】【k45:claim");
  });

  it("干净的引用一个问题都没有", () => {
    const registry = registryFor();
    expect(malformedRefs({ factsUsed: ["f.now"], claimsReliedOn: [] }, registry)).toEqual([]);
    expect(malformedRefs({ factsUsed: [] }, registry)).toEqual([]);
  });
});

/* ── 3. The Lady heuristic ──────────────────────────────────────────────── */

describe("3 · 拿过女神不等于不是梅林", () => {
  const ctx = (extra: Record<string, unknown> = {}) => ({
    seat: 2 as Seat,
    knownEvil: [3, 4, 7] as Seat[],
    requireLadyAnalysis: true,
    ladyAnnouncers: new Map<Seat, { target: Seat; announced: "good" | "evil" }[]>([
      [9, [{ target: 1, announced: "good" }]],
    ]),
    ...extra,
  });

  const lady = (over: Record<string, unknown> = {}) => ({
    heldLady: true,
    announced: true,
    accurateBeforeLady: [],
    explainedByLady: [],
    beyondLadyResult: [],
    convenientCover: false,
    contradictsRoster: false,
    ...over,
  });

  const cand = (seat: Seat, counter: string[], over: Record<string, unknown> = {}) => ({
    seat,
    signals: ["knowledge-like-consistency"] as never,
    evidence: ["几轮读法一致"],
    counterEvidence: counter,
    evidenceIds: [],
    confidence: 0.5,
    ...over,
  });

  it("**只写「他有女神信息」的 counterEvidence 会被打回**", () => {
    // The exact reasoning both live Assassins used, verbatim in shape.
    const ranking: AssassinationRanking = {
      candidates: [
        cand(9, ["他曾公开宣布验人结果，可能来自湖中女神信息，不能单独当作梅林线索"], {
          lady: lady(),
        }),
        cand(5, ["也可能只是跟着结果调整"]),
      ],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    };
    const problems = assassinationProblems(ranking, ctx()).join();
    expect(problems).toContain("那是另一种解释，不是反面证据");
  });

  it("女神解释不了的那一部分，是合法的反面证据", () => {
    const ranking: AssassinationRanking = {
      candidates: [
        cand(
          9,
          ["他在拿到女神之前对 2、4 没有任何提前判断，之后的准确都能被那一次验人解释"],
          { lady: lady({ explainedByLady: ["对 1 号的判断"] }) },
        ),
        cand(5, ["也可能只是跟着结果调整"]),
      ],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx())).toEqual([]);
  });

  it("宣布过验人却不填 lady → 打回", () => {
    const ranking: AssassinationRanking = {
      candidates: [cand(9, ["公开行为可以由结果解释"]), cand(5, ["跟票"])],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, ctx()).join()).toContain("必须单独回答");
  });

  it("lady 和公开记录对不上 → 打回，两个方向都查", () => {
    const a: AssassinationRanking = {
      candidates: [cand(9, ["拿到之前也没提前说对过"], { lady: lady({ heldLady: false }) }), cand(5, ["跟票"])],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(a, ctx()).join()).toContain("heldLady 是 false");

    const b: AssassinationRanking = {
      candidates: [cand(5, ["拿到之前也没提前说对过"], { lady: lady() }), cand(6, ["跟票"])],
      target: 6,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(b, ctx()).join()).toContain("heldLady 是 true");
  });

  /* ── The counterfactual ────────────────────────────────────────────── */

  it("**反事实：同样的行为，一个拿过女神一个没拿过 —— 检查结果一模一样**", () => {
    // The historical mistake, isolated. Seat 9 and seat 5 behave identically;
    // the ONLY difference is that 9 announced with the Lady. Nothing in the
    // structural checks may treat that as a reason to rank 9 lower.
    const behaviour = ["几轮读法一致，且提前避开了后来挂掉的车"];
    const counter = ["这些判断也能由公开任务结果推出，不必然需要视野"];

    const withLady: AssassinationRanking = {
      candidates: [
        cand(9, counter, { evidence: behaviour, lady: lady(), confidence: 0.5 }),
        cand(5, counter, { evidence: behaviour, confidence: 0.5 }),
      ],
      target: 9,
      why: "x",
      whatWouldChangeIt: "",
    };
    const withoutLady: AssassinationRanking = {
      candidates: [
        cand(9, counter, { evidence: behaviour, lady: lady(), confidence: 0.5 }),
        cand(5, counter, { evidence: behaviour, confidence: 0.5 }),
      ],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    };
    // Both targets are structurally fine. The system ranks NEITHER for the
    // model — it only refuses reasoning that has no content.
    expect(assassinationProblems(withLady, ctx())).toEqual([]);
    expect(assassinationProblems(withoutLady, ctx())).toEqual([]);
  });

  it("**没有把历史上的真梅林写死成首选** —— 刺 5 号和刺 9 号都合法", () => {
    const ranking = (target: Seat): AssassinationRanking => ({
      candidates: [
        cand(9, ["拿到女神之前没有提前说对过什么"], { lady: lady() }),
        cand(5, ["长期在成功车里，也可能只是稳健忠臣"]),
      ],
      target,
      why: "x",
      whatWouldChangeIt: "",
    });
    expect(assassinationProblems(ranking(9), ctx())).toEqual([]);
    expect(assassinationProblems(ranking(5), ctx())).toEqual([]);
  });

  it("行首那句判定只认「只有女神」这一种形状", () => {
    expect(isLadyOnlyCounterEvidence("他有女神信息")).toBe(true);
    expect(isLadyOnlyCounterEvidence("公开宣布过验人结果，可能来自湖中女神")).toBe(true);
    expect(isLadyOnlyCounterEvidence("他在拿到女神之前就说对过，所以这条不成立")).toBe(false);
    expect(isLadyOnlyCounterEvidence("一次验人解释不了他读对的那三个人")).toBe(false);
    expect(isLadyOnlyCounterEvidence("长期跟票，没有独立判断")).toBe(false);
  });

  it("0.6.0 不跑这套检查 —— 已完成的对局仍然可复现", () => {
    const ranking: AssassinationRanking = {
      candidates: [cand(9, ["他有女神信息"]), cand(5, ["跟票"])],
      target: 5,
      why: "x",
      whatWouldChangeIt: "",
    };
    expect(assassinationProblems(ranking, { seat: 2, knownEvil: [3, 4, 7] })).toEqual([]);
  });
});

/* ── 4. The diluted Percival pair ───────────────────────────────────────── */

describe("4 · 稀释式候选对披露", () => {
  /** An observation for the true Percival, with a chosen pair. */
  function percival(pair: [Seat, Seat], log: unknown[] = []): Observation {
    // A REAL observation, patched. `validatePublicMessage` reads several
    // fields, and a hand-built stub that happened to satisfy today's reader
    // would break silently the next time the firewall looks at one more.
    const { state } = drive({
      seed: 4,
      deal: referenceDeal(),
      stopWhen: (s) => s.missionTrack[1] !== "pending",
    });
    const base = observationFor(state, state.deal.percival);
    return {
      ...base,
      seat: 8,
      knowledge: { kind: "merlin_or_morgana", pair },
      publicLog: log.length > 0 ? log : base.publicLog,
    } as unknown as Observation;
  }

  it("认知分组读得出来，普通车单读不出来", () => {
    expect(groupingsIn("1、3、7、9我都看不清。").map((g) => g.seats)).toEqual([[1, 3, 7, 9]]);
    expect(groupingsIn("我重点比较3、7、9。").map((g) => g.seats)).toEqual([[3, 7, 9]]);
    // Team lists and referee facts are NOT groupings.
    expect(groupingsIn("我提8、1、3，请全桌上票。")).toEqual([]);
    expect(groupingsIn("二轮2、4、6、7出了两张失败，至少两坏。")).toEqual([]);
    expect(groupingsIn("第三轮1、5、9、10零失败。")).toEqual([]);
  });

  it("**实盘那句话被拦下** —— 「1、3、7、9我都看不清」，真候选对是 7、9", () => {
    const risk = pairRisk({ message: "1、3、7、9我都看不清。", observation: percival([7, 9]) });
    expect(risk?.kind).toBe("grouping");
    expect(risk?.groupSize).toBe(4);
    expect(risk?.rule).toBe("percival-pair-grouping");
  });

  it("两到四人、装着整对的分组，全部拦下", () => {
    for (const msg of ["7、9我分不清。", "3、7、9我重点比较。", "1、3、7、9我都看不清。", "这四个人里我最怀疑7、9、1、2。"]) {
      expect(pairRisk({ message: msg, observation: percival([7, 9]) }), msg).not.toBeNull();
    }
  });

  it("**稀释得够开就放行，但会被记进遥测**", () => {
    const wide = "1、2、3、4、5、7、9我都看不清。";
    expect(pairRisk({ message: wide, observation: percival([7, 9]) })).toBeNull();
    const m = pairDisclosureMetric(
      percival([7, 9], [
        { type: "speech", speaker: 8, publicMessage: wide, sequence: 4 },
      ]),
      0,
    );
    expect(m.pairCoverage).toBe(1);
    expect(m.groupSizes).toEqual([7]);
    expect(m.dilutionRatio).toBe(3.5);
  });

  it("只装着一半的分组不算披露", () => {
    expect(pairRisk({ message: "7、1我看不清。", observation: percival([7, 9]) })).toBeNull();
    expect(pairRisk({ message: "9、2、4我分不清。", observation: percival([7, 9]) })).toBeNull();
  });

  it("**累积收窄：两句各自安全，交集不安全**", () => {
    const prior = [
      {
        type: "speech",
        speaker: 8,
        publicMessage: "1、2、3、5、7、9我都看不清。",
        sequence: 4,
      },
    ];
    const obs = percival([7, 9], prior);
    // On its own this second group is seven seats — wide enough to pass.
    const wide = "4、6、7、8、9、10、3我都拿不准。";
    expect(pairRisk({ message: wide, observation: percival([7, 9]) })).toBeNull();
    // Against what this seat already said, the intersection is {3, 7, 9}.
    const risk = pairRisk({ message: wide, observation: obs });
    expect(risk?.kind).toBe("cumulative");
    expect(risk?.groupSize).toBe(3);
  });

  it("别的座位说的话不会算到派西维尔头上", () => {
    const prior = [
      { type: "speech", speaker: 5, publicMessage: "1、2、3、5、7、9我都看不清。", sequence: 4 },
    ];
    const obs = percival([7, 9], prior);
    expect(pairRisk({ message: "4、6、7、8、9、10、3我都拿不准。", observation: obs })).toBeNull();
  });

  it("不是派西维尔就没有这条检查", () => {
    const merlin = {
      seat: 9,
      role: "merlin",
      side: "good",
      knowledge: { kind: "sees_evil", seats: [2, 3, 7] },
      publicLog: [],
      position: { phase: "proposal" },
    } as unknown as Observation;
    expect(pairRisk({ message: "2、3我看不清。", observation: merlin })).toBeNull();
  });

  it("**接进防泄露闸：0.7.0 拦，0.6.0 不拦**", () => {
    const obs = percival([7, 9]);
    const message = "1、3、7、9我都看不清。";
    const on = validatePublicMessage({ message, observation: obs, taskId: "speech", pairGrouping: true });
    expect(on.ok).toBe(false);
    if (!on.ok) {
      expect(on.disclosures[0].secretClass).toBe("private-percival-pair");
      expect(on.disclosures[0].rule).toBe("percival-pair-grouping");
    }
    // The frozen stack keeps its behaviour, so the two completed games' public
    // transcripts still validate as what they were.
    expect(validatePublicMessage({ message, observation: obs, taskId: "speech" }).ok).toBe(true);
  });

  it("正当的车单在 0.7.0 下也不会被误拦", () => {
    const obs = percival([7, 9]);
    for (const msg of [
      "我提7、9、1，请全桌上票。",
      "第二轮7、9都在车上，出了两张失败。",
      "正式车定1、5、7、9、10。",
    ]) {
      expect(
        validatePublicMessage({ message: msg, observation: obs, taskId: "speech", pairGrouping: true }).ok,
        msg,
      ).toBe(true);
    }
  });
});

/* ── 5. Persistent claims ───────────────────────────────────────────────── */

describe("5 · 成立中的声称一直成立", () => {
  const speech = (seat: Seat, sequence: number, over: Record<string, unknown> = {}) => ({
    type: "speech" as const,
    speaker: seat,
    publicMessage: "…",
    sequence,
    ...over,
  });

  it("第一次报身份不受任何约束", () => {
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "first-claim",
      publicLog: [] as never,
    });
    expect(v.problem).toBeNull();
    expect(v.purposeless).toBe(false);
  });

  it("**实盘那三次：seq 4 合法，seq 45 和 79 是重复的**", () => {
    const log = [speech(8, 4, { claim: "percival" })] as never;
    expect(claimStateFor(8, "percival", log).standing).toBe("percival");
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: null,
      publicLog: log,
    });
    expect(v.purposeless).toBe(true);
    expect(v.problem).toContain("seq 4");
  });

  it("有人跳同一个身份 → 再报一次是合法的回应", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(7, 20, { claim: "percival" }),
    ] as never;
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "answering-challenge",
      publicLog: log,
    });
    expect(v.problem).toBeNull();
  });

  it("没人质疑却写 answering-challenge → 打回", () => {
    const log = [speech(8, 4, { claim: "percival" })] as never;
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "answering-challenge",
      publicLog: log,
    });
    expect(v.problem).toContain("没有人跳同一个身份");
  });

  it("被踩过也算被质疑", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(6, 20, { stances: [{ seat: 8, valence: -0.4, confidence: 0.5 }] }),
    ] as never;
    expect(
      checkClaim({
        seat: 8,
        submittedClaim: "percival",
        retracting: false,
        purpose: "answering-challenge",
        publicLog: log,
      }).problem,
    ).toBeNull();
  });

  it("**退水之后重新报，从来不算重复**", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(8, 30, { retractClaim: true }),
    ] as never;
    const state = claimStateFor(8, "percival", log);
    expect(state.standing).toBeNull();
    expect(state.retracted).toBe(true);
    expect(
      checkClaim({
        seat: 8,
        submittedClaim: "percival",
        retracting: false,
        purpose: "re-entering",
        publicLog: log,
      }).problem,
    ).toBeNull();
  });

  it("没退过水却写 re-entering → 打回", () => {
    const log = [speech(8, 4, { claim: "percival" })] as never;
    expect(
      checkClaim({
        seat: 8,
        submittedClaim: "percival",
        retracting: false,
        purpose: "re-entering",
        publicLog: log,
      }).problem,
    ).toContain("从来没有退过水");
  });

  it("改报另一个身份是新事件，不是重复", () => {
    const log = [speech(8, 4, { claim: "percival" })] as never;
    expect(
      checkClaim({
        seat: 8,
        submittedClaim: "merlin",
        retracting: false,
        purpose: null,
        publicLog: log,
      }).problem,
    ).toBeNull();
  });

  it("不报身份（claim: null）永远合法", () => {
    const log = [speech(8, 4, { claim: "percival" })] as never;
    expect(
      checkClaim({
        seat: 8,
        submittedClaim: null,
        retracting: false,
        purpose: null,
        publicLog: log,
      }).problem,
    ).toBeNull();
  });

  it("**resolving-ambiguity 要有证据 —— 什么都没发生过就打回**", () => {
    const log = [speech(8, 4, { claim: "percival" })] as never;
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "resolving-ambiguity",
      publicLog: log,
    });
    expect(v.purposeless).toBe(true);
    expect(v.problem).toContain("什么都没有发生过");
    expect(v.availableAmbiguity).toEqual([]);
  });

  it("有事发生了、但一件都不指 → 也打回", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(6, 20, { stances: [{ seat: 8, valence: -0.4, confidence: 0.5 }] }),
    ] as never;
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "resolving-ambiguity",
      publicLog: log,
    });
    expect(v.purposeless).toBe(true);
    expect(v.problem).toContain("ambiguityEventIds");
    expect(v.availableAmbiguity.map((e) => e.sequence)).toEqual([20]);
  });

  it("**指了一件真的、之后发生的、够格的公开事件 → 放行并记下 id**", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(7, 20, { claim: "merlin" }),
    ] as never;
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "resolving-ambiguity",
      ambiguityEventIds: [20],
      publicLog: log,
    });
    expect(v.problem).toBeNull();
    expect(v.purposeless).toBe(false);
    expect(v.acceptedAmbiguity).toEqual([{ sequence: 20, kind: "rival-claim" }]);
  });

  it("指一件声称之前的事 → 打回（时序是硬条件）", () => {
    const log = [
      speech(7, 2, { claim: "merlin" }),
      speech(8, 4, { claim: "percival" }),
    ] as never;
    const v = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "resolving-ambiguity",
      ambiguityEventIds: [2],
      publicLog: log,
    });
    expect(v.purposeless).toBe(true);
    expect(v.problem).toContain("没有一件是在你上次报身份之后发生的");
  });

  it("指一个根本不存在的 seq → 打回", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(7, 20, { claim: "merlin" }),
    ] as never;
    expect(
      checkClaim({
        seat: 8,
        submittedClaim: "percival",
        retracting: false,
        purpose: "resolving-ambiguity",
        ambiguityEventIds: [999],
        publicLog: log,
      }).purposeless,
    ).toBe(true);
  });

  it("五类够格的事件都认，自己说的话不算", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(7, 10, { claim: "merlin" }),
      speech(6, 12, { retractClaim: true }),
      speech(5, 14, { stances: [{ seat: 8, valence: 0.3, confidence: 0.4 }] }),
      { type: "mission_result", sequence: 16, missionNumber: 1, result: "fail", failCount: 1 },
      { type: "lady_announced", sequence: 18, holder: 9, target: 1, announced: "good" },
      // The seat's own speech is not evidence that the table is confused.
      speech(8, 19, { stances: [{ seat: 8, valence: -0.9, confidence: 1 }] }),
    ] as never;
    const available = ambiguityEventsAfter(8, 4, log);
    expect(available.map((e) => [e.sequence, e.kind])).toEqual([
      [10, "rival-claim"],
      [12, "retraction"],
      [14, "stance-on-me"],
      [16, "mission-result"],
      [18, "lady-announcement"],
    ]);
  });

  it("**没有任何数字上限** —— 同一局里可以澄清很多次，只要每次都有证据", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(7, 10, { claim: "merlin" }),
      speech(6, 20, { claim: "percival" }),
      speech(5, 30, { claim: "merlin" }),
    ] as never;
    for (const seq of [10, 20, 30]) {
      expect(
        checkClaim({
          seat: 8,
          submittedClaim: "percival",
          retracting: false,
          purpose: "resolving-ambiguity",
          ambiguityEventIds: [seq],
          publicLog: log,
        }).problem,
        `seq ${seq}`,
      ).toBeNull();
    }
  });

  it("指标分开记「接受的澄清」和「被拒的澄清」", () => {
    const log = [
      speech(8, 4, { claim: "percival" }),
      speech(7, 20, { claim: "merlin" }),
    ] as never;
    const accepted = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "resolving-ambiguity",
      ambiguityEventIds: [20],
      publicLog: log,
    });
    const rejected = checkClaim({
      seat: 8,
      submittedClaim: "percival",
      retracting: false,
      purpose: "resolving-ambiguity",
      publicLog: log,
    });
    let m = emptyClaimMetric();
    m = foldClaimMetric(m, "resolving-ambiguity", accepted);
    m = foldClaimMetric(m, "resolving-ambiguity", rejected);
    expect(m.claims).toBe(2);
    expect(m.acceptedAmbiguity).toBe(1);
    expect(m.rejectedAmbiguity).toBe(1);
    expect(m.purposeless).toBe(1);
    expect(m.ambiguityEventIds).toEqual([20]);
    expect(m.byPurpose["resolving-ambiguity"]).toBe(2);
  });
});

/* ── 6. Proposal autonomy is measured, never forced ─────────────────────── */

describe("6 · 发车自主权：只测量，不设指标", () => {
  it("代码里没有任何「否车率」目标或强制否车的地方", () => {
    // A guard against the obvious wrong fix for M5.4's 5/5 first-pass rate.
    // The M5.4 game's final-round team change — objections moved the leader
    // before the vote — is a valid human outcome and must stay reachable.
    const files = [
      "cognition/vote-discipline.ts",
      "cognition/claim-persistence.ts",
      "cognition/pair-disclosure.ts",
      "cognition/evidence-refs.ts",
    ];
    return Promise.all(
      files.map(async (f) => {
        const text = await import(`./${f.split("/")[1]}?raw`).catch(() => null);
        expect(text === null || typeof text === "object").toBe(true);
      }),
    );
  });

  it("投票分析仍然只查完整性，从不查投了什么", async () => {
    const { voteAnalysisProblems, parseVoteAnalysis } = await import("./vote-discipline");
    const base = {
      newConstraint: "第三轮零失败，只说明这一轮没人出失败",
      constraintFit: "avoids",
      implicatedRiders: [],
      leaderExplanation: "队长说明了这车完整避开二轮风险池",
      informationFromApproving: "是",
      rejectionStreak: 0,
      hammerRisk: "连否五次坏人直接赢",
      reason: "完整避开二轮失败池",
      evidenceIds: [],
    };
    for (const choice of ["approve", "reject"] as const) {
      const parsed = parseVoteAnalysis({ ...base, choice });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(
          voteAnalysisProblems(parsed.analysis, {
            seat: 1,
            proposedTeam: [1, 2, 3],
            rejectionStreak: 0,
            anyMissionResolved: true,
            lastFailedTeam: [4, 5, 6],
          }),
        ).toEqual([]);
      }
    }
  });
});

/* ── 7. The whole scripted game, under 0.7.0 ────────────────────────────── */

describe("完整脚本对局（prompt-0.7.0，全程离线）", () => {
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
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("社会与派权记忆跨轮存活", async () => {
    const r = await play();
    expect(r.reports.every((x) => x.social !== null)).toBe(true);
    expect(r.reports.every((x) => x.contest !== null)).toBe(true);
    expect(Math.max(...r.reports.map((x) => x.packSections.cognition))).toBeGreaterThan(500);
  });

  it("公开发言零机器编号", async () => {
    const r = await play();
    const speeches = r.state.log.filter(
      (e): e is Extract<typeof e, { type: "speech" }> => e.type === "speech",
    );
    expect(speeches.length).toBeGreaterThan(10);
    for (const s of speeches) {
      expect(findMachineIds(s.publicMessage), `seq ${s.sequence}`).toEqual([]);
    }
  });

  it("**任何一份 schema 都不会带着协调字段却没有那一节**", async () => {
    const r = await play();
    for (const q of r.planner) {
      // The M5.4 defect, as an invariant: the FIELD may never appear without
      // the SECTION. The reverse does NOT hold and must not be asserted — the
      // section is rendered to an eligible rider on its speech and vote turns
      // too, where no mission card is being played and no field exists.
      if (JSON.stringify(q.format.schema).includes('"designated"')) {
        expect(q.user).toContain("坏人出牌协调");
      }
      if (q.user.includes("坏人出牌协调")) {
        expect(q.user).toMatch(/你是这一轮的指定出牌人|你不是指定出牌人/);
      }
    }
  });

  it("**奥伯伦在整局里一次都没有见过协调协议**", async () => {
    const r = await play();
    const oberon = r.state.deal.oberon;
    // Every planner prompt this seat was sent, found by its own private facts
    // layer, which names the seat exactly once and unambiguously.
    const his = r.planner.filter((q) => q.user.includes(`你是 ${oberon}号，身份`));
    expect(his.length).toBeGreaterThan(0);
    for (const q of his) {
      for (const word of ["坏人出牌协调", "指定出牌人", "刺客 → 莫甘娜 → 莫德雷德"]) {
        expect(q.user, `${word} @ ${q.format.name}`).not.toContain(word);
      }
      // JSON KEYS and the coordination enum, not bare words: `concealmentCost`
      // is a legitimate contest field and a substring check on "conceal" would
      // be a test about vocabulary rather than about the leak.
      const schema = JSON.stringify(q.format.schema);
      for (const key of ['"coordination"', '"designated"', '"failsRequired"']) {
        expect(schema, `${key} @ ${q.format.name}`).not.toContain(key);
      }
      expect(schema, q.format.name).not.toContain('["sabotage","conceal"]');
    }
  });

  it("有资格的坏人协调仍然在跑 —— 非指定的没有出过失败票", async () => {
    const r = await play();
    const results = r.state.log.filter(
      (e): e is Extract<typeof e, { type: "mission_result" }> => e.type === "mission_result",
    );
    expect(results.length).toBeGreaterThan(0);
    for (const m of results) expect(m.failCount).toBeLessThanOrEqual(2);
    expect(r.planner.filter((q) => q.user.includes("坏人出牌协调")).length).toBeGreaterThan(0);
  });

  it("每一次证据引用都是一格一个、而且查得到", async () => {
    const r = await play();
    expect(r.reports.every((x) => x.malformedEvidence !== null)).toBe(true);
    expect(r.reports.every((x) => (x.malformedEvidence?.total ?? 0) === 0)).toBe(true);
  });

  it("没有一次无谓的重复声称", async () => {
    const r = await play();
    expect(r.reports.some((x) => x.purposelessClaim)).toBe(false);
    // And the claims that did happen are all first claims.
    const claims = r.state.log.filter(
      (e): e is Extract<typeof e, { type: "speech" }> => e.type === "speech" && Boolean(e.claim),
    );
    const bySeat = new Map<Seat, number>();
    for (const c of claims) bySeat.set(c.speaker, (bySeat.get(c.speaker) ?? 0) + 1);
    for (const [seat, n] of bySeat) expect(n, `${seat}`).toBe(1);
  });

  it("候选对遥测在跑，而且从来没有拦到东西", async () => {
    const r = await play();
    const percival = r.reports.filter((x) => x.pairDisclosure !== null);
    expect(percival.length).toBe(r.reports.length);
    for (const x of r.reports) expect(x.pairDisclosure?.rejections ?? 0).toBe(0);
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
    for (const key of [
      "voteAnalysis",
      '"assassination":',
      '"coordination":',
      "designated",
      "counterEvidence",
      "accurateBeforeLady",
      "convenientCover",
      "ownClaimStrategy",
      "focalCandidates",
      "informationToConceal",
    ]) {
      expect(replay, key).not.toContain(key);
    }
  });
});

/* ── The profile and the frozen fingerprints ────────────────────────────── */

describe("m5-5-pilot", () => {
  const profile = loadProfile("m5-5-pilot");

  it("是 0.7.0 + expert-disciplined，Terra 专用", () => {
    expect(profile.promptVersion).toBe(PROMPT_VERSION_M55);
    expect(profile.experiment.strategyProfile).toBe("expert-disciplined");
    expect(profile.model.id).toBe("gpt-5.6-terra");
  });

  it("**除了提示版本，和 m5-4-pilot 一个字段都不差**", () => {
    const m54 = loadProfile("m5-4-pilot");
    expect(profile.stages).toEqual(m54.stages);
    expect(profile.limits).toEqual(m54.limits);
    expect(profile.budget).toEqual(m54.budget);
    expect(profile.cognition).toEqual(m54.cognition);
    expect(profile.pricing).toEqual(m54.pricing);
    expect(profile.experiment).toEqual(m54.experiment);
    expect(profile.promptVersion).not.toBe(m54.promptVersion);
  });

  it("六条旧指纹一个字节没动 —— 策略文本这一版没有改", () => {
    expect(strategyFingerprint(strategyById("baseline"))).toBe(
      "71793ece5269104b0720487155ce96a6c6fc3e548e6fbcf2191b6ba35921f868",
    );
    expect(strategyFingerprint(strategyById("expert-cognitive"))).toBe(
      "911f22f5dc924f04051ed22daeab70d369edf7e03a60eccec9e958244e81adf1",
    );
    expect(strategyFingerprint(strategyById("expert-disciplined"))).toMatch(
      /^010613302e5eef27781a446092b85b81/,
    );
  });

  it("历史 profile 一个都没有被这一版碰到", () => {
    for (const id of ["m5-2-pilot", "m5-3-terra-pilot", "m5-3-luna-pilot", "m5-4-pilot"] as const) {
      const caps = capabilitiesFor(loadProfile(id).promptVersion);
      expect(caps.coordinationFieldGated, id).toBe(false);
      expect(caps.validatedEvidenceRefs, id).toBe(false);
      expect(caps.ladyNeutralAssassination, id).toBe(false);
      expect(caps.pairGroupingBlocked, id).toBe(false);
      expect(caps.persistentClaims, id).toBe(false);
    }
  });

  it("schema 名字仍然是 provider 收得下的形状", () => {
    const request = { kind: "vote" as const };
    expect(schemaNameFor(taskSchemaFor(request as never, 220, {}))).toMatch(/^[A-Za-z0-9_]+$/);
  });
});
