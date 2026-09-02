import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfile } from "../config/load";
import { observationFor } from "../core/observation";
import { drive, testConfig } from "../fixtures/harness";
import { DISCLOSURE_SEPARATION_LAYER, renderDisclosureRules } from "../cognition/disclosure";
import {
  DECISION_PROTOCOL_LAYER_V3,
  DECISION_PROTOCOL_LAYER_V4,
} from "../cognition/protocol";
import { buildCognitivePrompt, fusedSchemaFor } from "../cognition/build-cognitive";
import { CognitionStore } from "../cognition/store";
import { taskSchemaFor } from "./tasks";
import {
  CATALOG_IDS,
  applicableHeuristics,
  renderStrategy,
  strategyById,
  strategyFingerprint,
} from "./strategies";
import {
  COGNITIVE_VERSIONS,
  PROMPT_VERSION_CONTEST,
  PROMPT_VERSION_DISCLOSURE,
} from "./version";
import { capabilitiesFor } from "./capabilities";

/**
 * The M5.3 arm: what it removed, what it kept, and what stayed frozen.
 *
 * The freeze half matters as much as the change half. Four fingerprints are
 * recorded in shipped artifacts and one completed live game; if one of them
 * moves, a recorded arm now describes a profile that does not exist, and no
 * comparison against that game means anything afterwards.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("prompt tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ── The freeze ─────────────────────────────────────────────────────────── */

describe("之前四条臂一个字节都没动", () => {
  it("四个指纹和已发布产物里记录的完全一致", () => {
    // Recorded in shipped manifests. Any diff means a completed game's arm no
    // longer exists in the repository that claims to contain it.
    expect(strategyFingerprint(strategyById("baseline"))).toBe(
      "71793ece5269104b0720487155ce96a6c6fc3e548e6fbcf2191b6ba35921f868",
    );
    expect(strategyFingerprint(strategyById("community-meta"))).toBe(
      "386267250486a7e628694af4ee7991063e5bbd075f188ddcb6190840f41683ba",
    );
    expect(strategyFingerprint(strategyById("expert-cognitive"))).toBe(
      "911f22f5dc924f04051ed22daeab70d369edf7e03a60eccec9e958244e81adf1",
    );
    expect(strategyFingerprint(strategyById("expert-social"))).toBe(
      "2858a6e8cc530e5c92d829c13ce96c7a97b6fced73893f60b6af1a7a84e78f8d",
    );
    expect(strategyFingerprint(strategyById("expert-claim-contest"))).toBe(
      "f8121563c80eeacb621f10202d3a65634f76a6a1f2ed69cadc7e3546509a7929",
    );
  });

  it("0.4.0 的系统层没有被追加的规则改到", () => {
    // 0.5.0 appends; it does not edit. The completed pilot's cached prefix has
    // to stay rebuildable from a checkout.
    expect(DECISION_PROTOCOL_LAYER_V4.startsWith(DECISION_PROTOCOL_LAYER_V3)).toBe(true);
    expect(DECISION_PROTOCOL_LAYER_V4.endsWith(DISCLOSURE_SEPARATION_LAYER)).toBe(true);
    expect(DECISION_PROTOCOL_LAYER_V3).not.toContain("私有信息可以决定动作");
  });

  it("0.4.0 的响应 schema 里仍然有 publicMessage，没有信封", () => {
    const speech = taskSchemaFor(
      { kind: "speech", seat: 1, slot: "regular" },
      220,
      { withRetraction: true },
    );
    const contest = fusedSchemaFor(speech, PROMPT_VERSION_CONTEST) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(contest.required).toContain("publicMessage");
    expect(contest.required).not.toContain("communicationIntent");
    expect(contest.properties.communicationIntent).toBeUndefined();
  });
});

/* ── The new arm ────────────────────────────────────────────────────────── */

describe("expert-disclosure-safe", () => {
  const safe = strategyById("expert-disclosure-safe");
  const contest = strategyById("expert-claim-contest");

  it("指纹钉住", () => {
    expect(strategyFingerprint(safe)).toBe(
      "c3b77b0cbaa247a15f0891b3640968b64c4463aca35be906f21b00f75303c53b",
    );
  });

  it("在目录里", () => {
    expect(CATALOG_IDS).toContain("expert-disclosure-safe");
    expect(CATALOG_IDS).toHaveLength(7);
  });

  const SUPERSEDED = [
    "ec.percival-pair-same-team",
    "ec.percival-early-claim-default",
    "ec.percival-do-not-rank-the-pair-publicly",
    "es.percival-pair-same-team-crosses-a-line",
    "ecc.percival-claim-tradeoff",
    "ecc.percival-fight-the-rival",
    "ecc.percival-claim-must-be-actionable",
  ];

  it("七条会把候选对推向公开的条目全部被替换掉了", () => {
    const ids = safe.heuristics.map((h) => h.id);
    for (const id of SUPERSEDED) {
      // Present in the arm that leaked, absent from the arm that replaces it.
      expect(contest.heuristics.map((h) => h.id), id).toContain(id);
      expect(ids, id).not.toContain(id);
    }
  });

  it("那七条被替换，不是被删除 —— 每一个决策都还有去处", () => {
    const ids = safe.heuristics.map((h) => h.id);
    for (const id of [
      "eds.percival-pair-is-for-deciding-not-for-saying",
      "eds.percival-pair-same-team",
      "eds.percival-claim-tradeoff",
      "eds.percival-fight-the-rival-on-public-record",
      "eds.percival-claim-must-be-actionable",
      "eds.percival-distinction-test-over-assertion",
      "eds.percival-no-public-reason-is-still-an-action",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("其余条目是从 expert-claim-contest 原样继承的同一批对象", () => {
    // Identity, not equality: a copy would drift the moment either side was
    // edited, and the drift would be invisible.
    const kept = contest.heuristics.filter((h) => !SUPERSEDED.includes(h.id));
    for (const h of kept) expect(safe.heuristics).toContain(h);
    expect(safe.heuristics.length).toBe(kept.length + 12);
  });

  it("渲染出来的文本里没有一句在教人公开那一对", () => {
    const rendered = renderStrategy(safe);
    for (const phrase of [
      "把候选对变成公开的组织依据",
      "带上可执行的东西：候选对怎么处理",
      "打他的候选对故事",
      "越等于自报身份并点出候选对",
      "沉默地投反对既救不了这一轮",
    ]) {
      expect(rendered, phrase).not.toContain(phrase);
    }
    // And the arm it replaces really did carry them, so this is not vacuous.
    const old = renderStrategy(contest);
    expect(old).toContain("把候选对变成公开的组织依据");
  });

  it("每一个动作都还在 —— 换的是理由的来源，不是选择空间", () => {
    const rendered = renderStrategy(safe);
    for (const action of ["跳", "对跳", "退水", "反对", "检验"]) {
      expect(rendered, action).toContain(action);
    }
    expect(rendered).toContain("动作一个都没少");
  });
});

/* ── The role rules ─────────────────────────────────────────────────────── */

describe("按身份的披露规则", () => {
  it("每个身份都有一条，而且只依赖身份", () => {
    for (const role of [
      "merlin",
      "percival",
      "loyal",
      "morgana",
      "assassin",
      "mordred",
      "oberon",
    ] as const) {
      const text = renderDisclosureRules(role);
      expect(text.length).toBeGreaterThan(100);
      // A pure function of the role: calling it twice gives the same bytes.
      expect(renderDisclosureRules(role)).toBe(text);
    }
  });

  it("派西维尔那一条点名了三个被禁的句子，并且说它们只是例子", () => {
    const text = renderDisclosureRules("percival");
    expect(text).toContain("7、9一梅林一莫甘娜");
    expect(text).toContain("我的两个候选是7号和9号");
    expect(text).toContain("7、9中必有莫甘娜，所以这车必坏");
    expect(text).toContain("这四条是例子，不是名单");
    // And it keeps the action free.
    expect(text).toContain("你可以公开跳派西维尔，而且不需要交出这一对");
  });

  it("每一条都同时说了「可以用它做什么」，不只是「不许说」", () => {
    for (const role of ["percival", "merlin", "morgana"] as const) {
      expect(renderDisclosureRules(role)).toContain("可以");
    }
  });

  it("女神与刺杀频道的规则发给每一个身份", () => {
    for (const role of ["loyal", "oberon", "assassin"] as const) {
      const text = renderDisclosureRules(role);
      expect(text).toContain("只能通过「宣布」这个合法动作变成公开的");
      expect(text).toContain("任何信息都不会因为你想说就变成公开的");
    }
  });
});

/* ── The version wiring ─────────────────────────────────────────────────── */

describe("0.5.0 的接线", () => {
  it("是认知版本之一，0.5.0 与 0.6.0 分离两段，更早的都不分", () => {
    expect(COGNITIVE_VERSIONS).toContain(PROMPT_VERSION_DISCLOSURE);
    expect(capabilitiesFor(PROMPT_VERSION_DISCLOSURE).twoStageSpeech).toBe(true);
    for (const version of ["prompt-0.2.0", "prompt-0.3.0", "prompt-0.3.1", "prompt-0.4.0"]) {
      expect(capabilitiesFor(version).twoStageSpeech, version).toBe(false);
    }
  });

  it("profile 配的是 0.5.0 + expert-disclosure-safe，两段默认继承同一个模型", () => {
    const config = loadProfile("m5-3-pilot");
    expect(config.promptVersion).toBe(PROMPT_VERSION_DISCLOSURE);
    expect(config.experiment.strategyProfile).toBe("expert-disclosure-safe");
    expect(config.cognition.enabled).toBe(true);
    // The first scientific pilot runs one model family on both legs.
    expect(config.stages.planner.model).toBeNull();
    expect(config.stages.spokesperson.model).toBeNull();
    // The one number that is deliberately NOT inherited, and is a hypothesis.
    expect(config.stages.spokesperson.maxOutputTokens).toBe(3000);
    expect(config.stages.spokesperson.reasoningEffort).toBe("medium");
  });

  it("说话任务的规划者 schema 里没有 publicMessage，有信封", () => {
    const speech = taskSchemaFor(
      { kind: "speech", seat: 1, slot: "regular" },
      220,
      { withRetraction: true },
    );
    const planner = fusedSchemaFor(speech, PROMPT_VERSION_DISCLOSURE) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(planner.required).not.toContain("publicMessage");
    expect(planner.properties.publicMessage).toBeUndefined();
    expect(planner.required).toContain("communicationIntent");
    expect(planner.required).toContain("cognition");
    // The action half is untouched: the planner still chooses the claim.
    expect(planner.properties.claim).toBeDefined();
    expect(planner.properties.retractClaim).toBeDefined();
  });

  it("不说话的任务不加信封", () => {
    const vote = taskSchemaFor({ kind: "vote", seat: 1 }, 220);
    const planner = fusedSchemaFor(vote, PROMPT_VERSION_DISCLOSURE) as {
      required: string[];
    };
    expect(planner.required).not.toContain("communicationIntent");
    expect(planner.required).toContain("choice");
  });

  it("规划者提示带上了披露规则和分离规则", () => {
    const config = testConfig({
      promptVersion: PROMPT_VERSION_DISCLOSURE,
      cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
      experiment: {
        personaMode: "heterogeneous-rotated",
        strategyProfile: "expert-disclosure-safe",
      },
    });
    // Stopped at a SPEAKING decision specifically: a vote has no public
    // message, so it gets no envelope and the assertion below would be about
    // the wrong task.
    const { state } = drive({
      seed: 5,
      config,
      stopWhen: (s, o) => s.log.length >= 6 && o.request?.kind === "speech",
    });
    const observation = observationFor(state, state.pending!.seat);
    const built = buildCognitivePrompt({
      observation,
      persona: { id: "x", name: "x", status: "draft", dials: {} as never, text: "" },
      strategy: strategyById("expert-disclosure-safe"),
      ledger: new CognitionStore().for(observation),
      config,
    });
    expect(built.promptVersion).toBe(PROMPT_VERSION_DISCLOSURE);
    expect(built.system).toContain("私有信息可以决定动作，但不能被抄进公开发言");
    expect(built.system).toContain("你手上哪些东西不能进公开发言");
    expect(built.user).toContain("你不写公开发言 —— 你写一个 `communicationIntent`");
    // The envelope instruction comes BEFORE the cognition one: it changes the
    // shape of the answer's action half, and a model that reads "fill in
    // `cognition`" first has already decided that shape.
    expect(built.user.indexOf("communicationIntent")).toBeLessThan(
      built.user.indexOf("### `contest`：派权争夺"),
    );
  });

  it("按身份过滤仍然生效：忠臣读不到派西维尔那几条", () => {
    const config = testConfig({
      promptVersion: PROMPT_VERSION_DISCLOSURE,
      cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
      experiment: {
        personaMode: "heterogeneous-rotated",
        strategyProfile: "expert-disclosure-safe",
      },
    });
    const { state } = drive({ seed: 5, config, stopWhen: (s) => s.log.length >= 6 });
    const safe = strategyById("expert-disclosure-safe");
    for (const seat of [1, 2, 3] as const) {
      const observation = observationFor(state, seat);
      const ids = applicableHeuristics(safe, observation).map((h) => h.id);
      if (observation.role !== "percival") {
        expect(ids, `${seat}`).not.toContain("eds.percival-pair-is-for-deciding-not-for-saying");
      }
      // The table-side rule reaches everybody.
      expect(ids, `${seat}`).toContain("eds.do-not-ask-for-the-pair");
    }
  });
});
