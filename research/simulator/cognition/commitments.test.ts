import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observationFor } from "../core/observation";
import { drive, testConfig } from "../fixtures/harness";
import { buildCognitivePrompt, fusedSchemaFor } from "./build-cognitive";
import {
  activeCommitments,
  commitmentId,
  withCommitmentIds,
  type PublicCommitment,
} from "./ledger";
import { limitsFor } from "./limits";
import { applyFusedUpdate, parseCognition } from "./response";
import { CognitionStore, LEDGER_STATE_SCHEMA } from "./store";
import { buildFactRegistry } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { taskSchemaFor } from "../prompts/tasks";
import { strategyById } from "../prompts/strategies";
import { personaById } from "../prompts/personas";
import { PROMPT_VERSION_CONTEST, PROMPT_VERSION_DISCLOSURE } from "../prompts/version";
import type { ModelRequest } from "../model/client";
import { baseCognition } from "./scripted-cognitive-client";

/**
 * Commitments close by ID, not by echoing their own text back.
 *
 * WHY IT CHANGED. Text equality meant a seat retired a promise only if it
 * reproduced the promise 「一字不差」. The completed M5.2 game recorded three
 * unmatched closures: the model meant to close something, a character drifted,
 * and the ledger silently kept holding the seat to a promise it believed it had
 * discharged. Every later turn then reasoned against a commitment list that was
 * wrong, and nothing in the loop could notice.
 *
 * WHAT MUST NOT CHANGE. The two frozen stacks keep sending and accepting the
 * `text` shape, because their schemas are part of two recorded games. And a
 * checkpoint written before ids existed has to stay resumable.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("commitment tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG_050 = testConfig({
  promptVersion: PROMPT_VERSION_DISCLOSURE,
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: {
    personaMode: "heterogeneous-rotated",
    strategyProfile: "expert-disclosure-safe",
  },
});

const SPEECH = taskSchemaFor({ kind: "speech", seat: 1, slot: "regular" }, 220, {
  withRetraction: true,
});

/**
 * A structurally legal cognition block, borrowed from the scripted double.
 *
 * Borrowed rather than hand-written: the block has forty-odd required fields
 * across three versions, and a fixture that restates them drifts out of sync
 * with the parser and quietly starts testing itself. The double already has to
 * produce a legal one for every other test in the suite.
 */
function cognitionBlock(
  request: ModelRequest,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...baseCognition(request), ...overrides };
}

/**
 * The request shape `baseCognition` reads.
 *
 * The SCHEMA has to be the real one: the double decides which version's block
 * to build by looking at which properties the schema asks for. A placeholder
 * `{}` silently produces a `prompt-0.3.0` block, which then fails a 0.5.0 parse
 * for reasons that have nothing to do with what the test is about.
 */
function requestFor(built: {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}): ModelRequest {
  return {
    model: "test",
    reasoningEffort: "high",
    system: built.system,
    user: built.user,
    maxOutputTokens: 1,
    format: { name: built.schemaName, schema: built.jsonSchema, strict: true },
    params: {},
  };
}

/**
 * One real 0.5.0 planner prompt, so the fixture's cited ids are ids the prompt
 * actually printed. Built once: it is deterministic.
 */
const SAMPLE = (() => {
  const { state } = drive({
    seed: 4,
    config: CONFIG_050,
    stopWhen: (s, o) => s.log.length >= 6 && o.request?.kind === "speech",
  });
  const observation = observationFor(state, state.pending!.seat);
  const built = buildCognitivePrompt({
    observation,
    persona: personaById("ledger"),
    strategy: strategyById("expert-disclosure-safe"),
    ledger: new CognitionStore().for(observation),
    config: CONFIG_050,
  });
  return {
    observation,
    request: requestFor({
      system: built.system,
      user: built.user,
      jsonSchema: built.jsonSchema as Record<string, unknown>,
      schemaName: built.schemaName,
    }),
  };
})();

/* ── The id itself ──────────────────────────────────────────────────────── */

describe("承诺 id", () => {
  it("由位置决定，所以重放和续跑铸出同一个", () => {
    expect(commitmentId(30, 0)).toBe("k30.0");
    expect(commitmentId(30, 1)).toBe("k30.1");
    // Pure: no clock, no counter, no randomness.
    expect(commitmentId(30, 0)).toBe(commitmentId(30, 0));
  });

  it("同一手做的几条承诺不会撞 id", () => {
    const ids = [0, 1, 2].map((i) => commitmentId(12, i));
    expect(new Set(ids).size).toBe(3);
  });

  it("旧检查点里没有 id 的承诺会被按同样规则补上", () => {
    const legacy = [
      { text: "我保 3号", atSequence: 8, withdrawnAtSequence: null },
      { text: "我不带 6号", atSequence: 8, withdrawnAtSequence: null },
      { text: "R3 我会跳", atSequence: 20, withdrawnAtSequence: null },
    ] as unknown as readonly PublicCommitment[];
    const filled = withCommitmentIds(legacy);
    expect(filled.map((c) => c.id)).toEqual(["k8.0", "k8.1", "k20.0"]);
    // Text is preserved untouched — it is what a human reviewer reads.
    expect(filled.map((c) => c.text)).toEqual(legacy.map((c) => c.text));
  });

  it("已经有 id 的承诺不会被重新编号", () => {
    const existing = [
      { id: "k5.0", text: "旧的", atSequence: 8, withdrawnAtSequence: null },
    ] as unknown as readonly PublicCommitment[];
    expect(withCommitmentIds(existing)[0].id).toBe("k5.0");
  });
});

/* ── The schema ─────────────────────────────────────────────────────────── */

describe("schema：0.5.0 要 id，冻结版本仍然要原文", () => {
  it("0.5.0 的 closedCommitments 只收 id", () => {
    const schema = fusedSchemaFor(SPEECH, PROMPT_VERSION_DISCLOSURE) as {
      properties: { cognition: { properties: Record<string, { items: { required: string[]; properties: Record<string, unknown> } }> } };
    };
    const closed = schema.properties.cognition.properties.closedCommitments;
    expect(closed.items.required).toEqual(["id", "resolution"]);
    expect(closed.items.properties.text).toBeUndefined();
  });

  it("0.4.0 的 closedCommitments 一个字节都没动，仍然是原文", () => {
    const schema = fusedSchemaFor(SPEECH, PROMPT_VERSION_CONTEST) as {
      properties: { cognition: { properties: Record<string, { items: { required: string[]; properties: Record<string, unknown> } }> } };
    };
    const closed = schema.properties.cognition.properties.closedCommitments;
    expect(closed.items.required).toEqual(["text", "resolution"]);
    expect(closed.items.properties.id).toBeUndefined();
  });

  it("0.5.0 下只给 text 会被打回，并说清为什么", () => {
    const parsed = parseCognition(
      cognitionBlock(SAMPLE.request, { closedCommitments: [{ text: "我保 3号", resolution: "fulfilled" }] }),
      { limits: limitsFor("prompt-0.5.0"), withSocial: true, withContest: true, withCommitmentIds: true },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("id 不能为空");
  });

  it("0.4.0 下只给 text 仍然合法", () => {
    const parsed = parseCognition(
      cognitionBlock(SAMPLE.request, { closedCommitments: [{ text: "我保 3号", resolution: "fulfilled" }] }),
      { limits: limitsFor("prompt-0.4.0"), withSocial: true, withContest: true },
    );
    expect(parsed.ok).toBe(true);
  });
});

/* ── The fold ───────────────────────────────────────────────────────────── */

describe("按 id 关闭", () => {
  const observation = SAMPLE.observation;
  const limits = limitsFor("prompt-0.5.0");

  function fold(
    ledger: ReturnType<CognitionStore["for"]>,
    block: Record<string, unknown>,
  ) {
    const parsed = parseCognition(block, {
      limits,
      withSocial: true,
      withContest: true,
      withCommitmentIds: true,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const claimContest = claimContestFrom(observation.publicLog);
    const registry = buildFactRegistry(
      ledger.publicFacts,
      ledger.claims,
      observation,
      claimContest,
    );
    return applyFusedUpdate(
      ledger,
      observation,
      parsed.cognition,
      observation.publicLog.length,
      { registry, limits, claimContest },
    );
  }

  it("新承诺拿到确定性 id，原文保留给人看", () => {
    const store = new CognitionStore();
    const first = fold(store.for(observation), cognitionBlock(SAMPLE.request, { newCommitments: ["我保 3号", "我不带 6号"] }));
    const made = first.ledger.self.publicCommitments;
    expect(made.map((c) => c.id)).toEqual([
      commitmentId(observation.publicLog.length, 0),
      commitmentId(observation.publicLog.length, 1),
    ]);
    expect(made.map((c) => c.text)).toEqual(["我保 3号", "我不带 6号"]);
  });

  it("用 id 关掉一条，另一条还活着，而且状态记在案", () => {
    const store = new CognitionStore();
    store.put(fold(store.for(observation), cognitionBlock(SAMPLE.request, { newCommitments: ["我保 3号", "我不带 6号"] })).ledger);

    const target = store.for(observation).self.publicCommitments[0];
    const second = fold(
      store.for(observation),
      cognitionBlock(SAMPLE.request, { closedCommitments: [{ id: target.id, resolution: "fulfilled" }] }),
    );

    expect(second.unmatchedClosures).toBe(0);
    const all = second.ledger.self.publicCommitments;
    expect(all[0].resolution).toBe("fulfilled");
    expect(all[0].resolvedAtSequence).not.toBeNull();
    // History is kept: the text is still there for a human reviewer.
    expect(all[0].text).toBe("我保 3号");
    expect(activeCommitments(all).map((c) => c.text)).toEqual(["我不带 6号"]);
  });

  it("三种状态都能关，withdrawn 同时记进 withdrawnAtSequence", () => {
    for (const resolution of ["fulfilled", "obsolete", "withdrawn"] as const) {
      const store = new CognitionStore();
      store.put(fold(store.for(observation), cognitionBlock(SAMPLE.request, { newCommitments: ["某个承诺"] })).ledger);
      const target = store.for(observation).self.publicCommitments[0];
      const closed = fold(
        store.for(observation),
        cognitionBlock(SAMPLE.request, { closedCommitments: [{ id: target.id, resolution }] }),
      ).ledger.self.publicCommitments[0];
      expect(closed.resolution, resolution).toBe(resolution);
      expect(
        closed.withdrawnAtSequence === null,
        resolution,
      ).toBe(resolution !== "withdrawn");
    }
  });

  it("**这就是那个 bug**：原文差一个字，按 id 关照样成功", () => {
    const store = new CognitionStore();
    store.put(fold(store.for(observation), cognitionBlock(SAMPLE.request, { newCommitments: ["我保 3号，除非他上了挂掉的车"] })).ledger);
    const target = store.for(observation).self.publicCommitments[0];

    // The id is what the model is shown and what it echoes back. The text it
    // remembers may be a paraphrase — under the old rule that silently failed.
    const result = fold(
      store.for(observation),
      cognitionBlock(SAMPLE.request, { closedCommitments: [{ id: target.id, resolution: "obsolete" }] }),
    );
    expect(result.unmatchedClosures).toBe(0);
    expect(activeCommitments(result.ledger.self.publicCommitments)).toHaveLength(0);
  });

  it("关一个不存在的 id 仍然被记成未匹配，不静默吞掉", () => {
    const store = new CognitionStore();
    store.put(fold(store.for(observation), cognitionBlock(SAMPLE.request, { newCommitments: ["我保 3号"] })).ledger);
    const result = fold(
      store.for(observation),
      cognitionBlock(SAMPLE.request, { closedCommitments: [{ id: "k999.9", resolution: "fulfilled" }] }),
    );
    expect(result.unmatchedClosures).toBe(1);
    expect(activeCommitments(result.ledger.self.publicCommitments)).toHaveLength(1);
  });

  it("提示里每条承诺前面都印着它的 id", () => {
    const store = new CognitionStore();
    store.put(fold(store.for(observation), cognitionBlock(SAMPLE.request, { newCommitments: ["我保 3号"] })).ledger);
    const built = buildCognitivePrompt({
      observation,
      persona: personaById("ledger"),
      strategy: strategyById("expert-disclosure-safe"),
      ledger: store.for(observation),
      config: CONFIG_050,
    });
    const id = store.for(observation).self.publicCommitments[0].id;
    expect(built.user).toContain(`\`[${id}]\` 我保 3号`);
    expect(built.user).toContain("0.5.0 起改用 id");
  });
});

/* ── Checkpoint and replay compatibility ────────────────────────────────── */

describe("检查点与重放兼容", () => {
  it("账本状态 schema 升到 @4，旧的三个仍然收", () => {
    expect(LEDGER_STATE_SCHEMA).toBe("avalon-ledger-state@4");
  });

  it("从 @3 的检查点恢复：承诺被补上 id，而且可以用 id 关掉", () => {
    const { state } = drive({
      seed: 4,
      config: CONFIG_050,
      stopWhen: (s, o) => s.log.length >= 6 && o.request?.kind === "speech",
    });
    const observation = observationFor(state, state.pending!.seat);

    // A checkpoint written before ids existed: schema @3, no `id` anywhere.
    const legacyState = {
      schema: "avalon-ledger-state@3",
      seats: [
        {
          seat: observation.seat,
          claimAssessments: [],
          constraints: [],
          hypotheses: [],
          dossiers: {},
          social: null,
          contest: null,
          self: {
            seat: observation.seat,
            publicCommitments: [
              { text: "我保 3号", atSequence: 4, withdrawnAtSequence: null },
              { text: "我不带 6号", atSequence: 4, withdrawnAtSequence: null },
            ],
            rolePlan: "",
            intendedSignal: "",
            coverStory: "",
            claimPlan: "",
            nextTurnPlan: "",
            lastProcessedSequence: 4,
          },
        },
      ],
    };

    const store = new CognitionStore(legacyState as never);
    const restored = store.for(observation).self.publicCommitments;
    expect(restored.map((c) => c.id)).toEqual(["k4.0", "k4.1"]);
    expect(restored.map((c) => c.text)).toEqual(["我保 3号", "我不带 6号"]);

    // And the backfilled id really closes it — which is what makes a paused
    // pre-id game resumable rather than merely loadable.
    const limits = limitsFor("prompt-0.5.0");
    const parsed = parseCognition(
      cognitionBlock(SAMPLE.request, { closedCommitments: [{ id: "k4.0", resolution: "fulfilled" }] }),
      { limits, withSocial: true, withContest: true, withCommitmentIds: true },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ledger = store.for(observation);
    const claimContest = claimContestFrom(observation.publicLog);
    const result = applyFusedUpdate(
      ledger,
      observation,
      parsed.cognition,
      observation.publicLog.length,
      {
        registry: buildFactRegistry(ledger.publicFacts, ledger.claims, observation, claimContest),
        limits,
        claimContest,
      },
    );
    expect(result.unmatchedClosures).toBe(0);
    expect(activeCommitments(result.ledger.self.publicCommitments).map((c) => c.text)).toEqual([
      "我不带 6号",
    ]);
  });

  it("补 id 是确定性的：同一份旧状态恢复两次，id 完全一样", () => {
    const legacy = [
      { text: "a", atSequence: 8, withdrawnAtSequence: null },
      { text: "b", atSequence: 8, withdrawnAtSequence: null },
    ] as unknown as readonly PublicCommitment[];
    expect(withCommitmentIds(legacy).map((c) => c.id)).toEqual(
      withCommitmentIds(legacy).map((c) => c.id),
    );
  });
});
