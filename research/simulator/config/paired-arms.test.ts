import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfile, resolveStage, type ProfileName, type SimConfig } from "./load";
import {
  PAIRED_ARM_ALLOWED_DIFFS,
  flattenConfig,
  pairedArmDiff,
  pairedArmVariables,
} from "./paired-arms";
import terraProfile from "./m5-3-terra-pilot.json";
import lunaProfile from "./m5-3-luna-pilot.json";
import { LUNA_PRICING, TERRA_PRICING, priceListFor } from "../model/price-lists";
import { observationFor } from "../core/observation";
import { drive } from "../fixtures/harness";
import { buildCognitivePrompt, fusedSchemaFor } from "../cognition/build-cognitive";
import { CognitionStore } from "../cognition/store";
import { buildFactRegistry } from "../cognition/fact-ids";
import { claimContestFrom } from "../cognition/claim-contest";
import { claimsFrom, publicFactsFrom } from "../cognition/ledger";
import { channelForTask, sanitiseIntent } from "../cognition/firewall";
import {
  buildSpokespersonPrompt,
  publicTableViewFor,
} from "../cognition/spokesperson";
import type { CommunicationIntent } from "../cognition/intent";
import { personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";

/**
 * The paired experiment's central claim, as a test.
 *
 * A paired arm is a statement about ONE difference. If anything else moves —
 * a limit, an effort, a repair budget, a strategy id, a persona mode — the
 * comparison stops meaning what it says, and it stops meaning it silently.
 *
 * So this file asserts three things:
 *
 *   THE RESOLVED CONFIGS differ only in the model id, its per-stage copies,
 *   and its price list. Everything else is byte-identical after flattening.
 *
 *   THE RENDERED PROMPTS are byte-identical between arms at the same scripted
 *   position — both stages, system and user. No behavioural prompt names a
 *   model, so the only place a model id may appear is the provider request
 *   envelope, which is not prompt text.
 *
 *   THE PRICE LISTS match the catalog exactly, so a rate cannot be edited in a
 *   profile alone.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("config tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const TERRA = loadProfile("m5-3-terra-pilot");
const LUNA = loadProfile("m5-3-luna-pilot");

/* ── The resolved diff ──────────────────────────────────────────────────── */

describe("两条配对臂只差一个变量", () => {
  it("归一化之后没有任何计划外的差异", () => {
    const diff = pairedArmDiff(TERRA, LUNA);
    // Named, so a failure says which field moved rather than "they differ".
    expect(diff.map((d) => `${d.path}: ${d.left} vs ${d.right}`)).toEqual([]);
  });

  it("而它们确实是两条臂 —— 允许的差异里真的有差异", () => {
    const vars = pairedArmVariables(TERRA, LUNA);
    const paths = vars.map((v) => v.path).sort();
    expect(paths).toEqual([
      "model.id",
      "pricing.cachedInputUsdPerMTok",
      "pricing.modelId",
      "pricing.outputUsdPerMTok",
      "pricing.pricingVersion",
      "pricing.sourceUrl",
      "pricing.uncachedInputUsdPerMTok",
      "pricing.verifiedOn",
      "stages.planner.model",
      "stages.spokesperson.model",
    ]);
  });

  it("允许清单只放四类东西，没有一条是行为", () => {
    // A wildcard here would be the quiet way to let a behavioural field slip
    // through later, so the list is enumerated and its shape is asserted.
    for (const path of PAIRED_ARM_ALLOWED_DIFFS) {
      expect(
        path === "model.id" ||
          path.startsWith("stages.") ||
          path.startsWith("pricing."),
        path,
      ).toBe(true);
    }
    expect(PAIRED_ARM_ALLOWED_DIFFS).toHaveLength(10);
  });

  it("两边打平的字段不是零 —— 否则上面的断言是空的", () => {
    const total = Object.keys(flattenConfig(TERRA)).length;
    expect(total).toBeGreaterThan(30);
    expect(total - pairedArmVariables(TERRA, LUNA).length).toBeGreaterThan(25);
  });

  it("每一条行为设定两边完全一样", () => {
    const behavioural = (c: SimConfig) => ({
      promptVersion: c.promptVersion,
      strategy: c.experiment.strategyProfile,
      personaMode: c.experiment.personaMode,
      cognition: c.cognition,
      limits: c.limits,
      budget: c.budget,
      run: c.run,
      plannerEffort: resolveStage(c, "planner").reasoningEffort,
      plannerCap: resolveStage(c, "planner").maxOutputTokens,
      sayEffort: resolveStage(c, "spokesperson").reasoningEffort,
      sayCap: resolveStage(c, "spokesperson").maxOutputTokens,
      repairs: c.stages.maxPublicMessageRepairs,
    });
    expect(behavioural(TERRA)).toEqual(behavioural(LUNA));
  });

  it("人定下来的那三个发言者设定就是这些", () => {
    for (const config of [TERRA, LUNA]) {
      const say = resolveStage(config, "spokesperson");
      expect(say.reasoningEffort).toBe("medium");
      expect(say.maxOutputTokens).toBe(3000);
      expect(config.stages.maxPublicMessageRepairs).toBe(1);
      const planner = resolveStage(config, "planner");
      expect(planner.reasoningEffort).toBe("high");
      expect(planner.maxOutputTokens).toBe(12000);
    }
    expect(resolveStage(TERRA, "planner").model).toBe("gpt-5.6-terra");
    expect(resolveStage(TERRA, "spokesperson").model).toBe("gpt-5.6-terra");
    expect(resolveStage(LUNA, "planner").model).toBe("gpt-5.6-luna");
    expect(resolveStage(LUNA, "spokesperson").model).toBe("gpt-5.6-luna");
  });

  it("m5-3-pilot 解析出来的行为和 Terra 臂完全一致", () => {
    // The generic profile and the named Terra arm must not drift apart; if they
    // do, "the Terra arm is the M5.3 pilot" stops being true.
    //
    // Compared RESOLVED, not raw: `m5-3-pilot` writes `null` for the planner
    // (inherit) and the Terra arm writes the values out. Those are the same
    // run, and a raw diff would call them different — which is exactly the
    // failure mode `resolveStage` exists to remove.
    const generic = loadProfile("m5-3-pilot");
    expect(resolveStage(generic, "planner")).toEqual(resolveStage(TERRA, "planner"));
    expect(resolveStage(generic, "spokesperson")).toEqual(
      resolveStage(TERRA, "spokesperson"),
    );
    expect(generic.stages.maxPublicMessageRepairs).toBe(
      TERRA.stages.maxPublicMessageRepairs,
    );
    // And everything outside `stages` is identical field for field.
    expect(
      pairedArmDiff(generic, TERRA).filter((d) => !d.path.startsWith("stages.")),
    ).toEqual([]);
  });
});

/* ── Pricing ────────────────────────────────────────────────────────────── */

describe("价目", () => {
  it("两个 profile 的价目和目录逐字段相同", () => {
    const check = (raw: Record<string, unknown>, expected: typeof TERRA_PRICING) => {
      const p = raw.pricing as Record<string, unknown>;
      expect(p.modelId).toBe(expected.modelId);
      expect(p.sourceUrl).toBe(expected.sourceUrl);
      expect(p.verifiedOn).toBe(expected.verifiedOn);
      expect(p.pricingVersion).toBe(expected.pricingVersion);
      expect(p.uncachedInputUsdPerMTok).toBe(expected.uncachedInputUsdPerMTok);
      expect(p.cachedInputUsdPerMTok).toBe(expected.cachedInputUsdPerMTok);
      expect(p.outputUsdPerMTok).toBe(expected.outputUsdPerMTok);
    };
    check(terraProfile as unknown as Record<string, unknown>, TERRA_PRICING);
    check(lunaProfile as unknown as Record<string, unknown>, LUNA_PRICING);
  });

  it("Terra 的价目和两局已完成对局用的是同一张表", () => {
    // Recorded in two shipped manifests and in every dollar figure reported
    // from them. Editing one of these numbers rewrites finished history.
    expect(TERRA_PRICING).toEqual({
      modelId: "gpt-5.6-terra",
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
      verifiedOn: "2026-08-23",
      pricingVersion: "gpt-5.6-terra@2026-08-23",
      uncachedInputUsdPerMTok: 2.0,
      cachedInputUsdPerMTok: 0.2,
      outputUsdPerMTok: 12.0,
    });
  });

  it("Luna 的价目带出处和读取日期，而且每一项都是 Terra 的十分之一", () => {
    expect(LUNA_PRICING.sourceUrl).toBe(
      "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    );
    expect(LUNA_PRICING.verifiedOn).toBe("2026-08-27");
    expect(LUNA_PRICING.pricingVersion).toBe("gpt-5.6-luna@2026-08-27");
    expect(LUNA_PRICING.uncachedInputUsdPerMTok).toBeCloseTo(
      TERRA_PRICING.uncachedInputUsdPerMTok / 10,
      10,
    );
    expect(LUNA_PRICING.cachedInputUsdPerMTok).toBeCloseTo(
      TERRA_PRICING.cachedInputUsdPerMTok / 10,
      10,
    );
    expect(LUNA_PRICING.outputUsdPerMTok).toBeCloseTo(
      TERRA_PRICING.outputUsdPerMTok / 10,
      10,
    );
  });

  it("没有配置价目的模型返回 null，不返回一个编出来的默认值", () => {
    expect(priceListFor("gpt-5.6-terra")).toBe(TERRA_PRICING);
    expect(priceListFor("gpt-5.6-luna")).toBe(LUNA_PRICING);
    expect(priceListFor("some-unpriced-model")).toBeNull();
  });

  it("两个 profile 都通过了 pricing.modelId 必须等于 model.id 的校验", () => {
    expect(TERRA.pricing.modelId).toBe(TERRA.model.id);
    expect(LUNA.pricing.modelId).toBe(LUNA.model.id);
    expect(TERRA.pricing.configured).toBe(true);
    expect(LUNA.pricing.configured).toBe(true);
  });
});

/* ── Byte-identical prompts ─────────────────────────────────────────────── */

const SAMPLE_INTENT: CommunicationIntent = {
  channel: "table-public",
  publicGoal: "把这一轮的比较标准定下来",
  targetSeats: [7],
  selectedClaimAction: "compare-claimants",
  requestedTeam: null,
  requestedVote: "reject",
  publicBasisIds: [],
  publicProposition: "现在唯一能公开核对的约束是挂掉的那辆车",
  desiredTableEffect: "这一票投反对",
};

/** Both stages' prompts for one seat under one profile, at a fixed position. */
function promptsUnder(profile: ProfileName): {
  plannerSystem: string;
  plannerUser: string;
  saySystem: string;
  sayUser: string;
  plannerSchema: string;
  saySchema: string;
} {
  const config = loadProfile(profile);
  const { state } = drive({
    seed: 5,
    config,
    stopWhen: (s, o) => s.log.length >= 6 && o.request?.kind === "speech",
  });
  const observation = observationFor(state, state.pending!.seat);
  const persona = personaById("ledger");
  const strategy = strategyById("expert-disclosure-safe");

  const planner = buildCognitivePrompt({
    observation,
    persona,
    strategy,
    ledger: new CognitionStore().for(observation),
    config,
  });

  const registry = buildFactRegistry(
    publicFactsFrom(observation.publicLog),
    claimsFrom(observation.publicLog),
    observation,
    claimContestFrom(observation.publicLog),
  );
  const { intent } = sanitiseIntent({
    intent: SAMPLE_INTENT,
    observation,
    registry,
    persona,
    taskId: planner.taskId,
    taskChannel: channelForTask(planner.taskId),
  });
  const say = buildSpokespersonPrompt({
    view: publicTableViewFor(observation),
    intent,
    persona,
    taskId: planner.taskId,
    speechCharLimit: config.limits.speechCharLimit,
    selectedAction: "",
  });

  return {
    plannerSystem: planner.system,
    plannerUser: planner.user,
    saySystem: say.system,
    sayUser: say.user,
    plannerSchema: JSON.stringify(planner.jsonSchema),
    saySchema: JSON.stringify(say.jsonSchema),
  };
}

describe("同一个局面下两条臂渲染出来的东西逐字节相同", () => {
  const terra = promptsUnder("m5-3-terra-pilot");
  const luna = promptsUnder("m5-3-luna-pilot");

  it("规划者的 system 与 user", () => {
    expect(terra.plannerSystem).toBe(luna.plannerSystem);
    expect(terra.plannerUser).toBe(luna.plannerUser);
  });

  it("发言者的 system 与 user", () => {
    expect(terra.saySystem).toBe(luna.saySystem);
    expect(terra.sayUser).toBe(luna.sayUser);
  });

  it("两段的 schema", () => {
    expect(terra.plannerSchema).toBe(luna.plannerSchema);
    expect(terra.saySchema).toBe(luna.saySchema);
    // And the 0.5.0 shape really is in there, so this is not comparing two
    // copies of the wrong thing.
    expect(terra.plannerSchema).toContain("communicationIntent");
  });

  it("没有任何一层提示文本提到 Terra 或 Luna", () => {
    for (const text of [
      terra.plannerSystem,
      terra.plannerUser,
      terra.saySystem,
      terra.sayUser,
    ]) {
      expect(text.toLowerCase()).not.toContain("terra");
      expect(text.toLowerCase()).not.toContain("luna");
      expect(text).not.toContain("gpt-5.6");
    }
  });

  it("模型 id 只出现在 provider 请求信封里，不在提示里", () => {
    // The one place it necessarily appears: the request object the client
    // sends. That is not prompt text and cannot reach the model as content.
    expect(resolveStage(TERRA, "planner").model).not.toBe(
      resolveStage(LUNA, "planner").model,
    );
    expect(terra.plannerUser).toBe(luna.plannerUser);
  });

  it("任务 schema 的构造也不看模型", () => {
    const speech = fusedSchemaFor(
      {
        id: "speech-regular",
        requestKind: "speech",
        title: "",
        instruction: "",
        publicMessageLimit: 220,
        fields: [],
        example: {},
      },
      "prompt-0.5.0",
    );
    expect(JSON.stringify(speech)).not.toContain("gpt-");
  });
});
