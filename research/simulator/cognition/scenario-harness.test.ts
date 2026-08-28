import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/load";
import { observationFor } from "../core/observation";
import type { Observation } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { assignPersonas } from "../prompts/personas";
import { renderStrategy, strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_COGNITIVE } from "../prompts/version";
import { buildCognitivePrompt } from "./build-cognitive";
import { CognitionStore } from "./store";
import { SCENARIOS, type Scenario } from "./scenarios";

/**
 * Every M5A scenario, pushed through the REAL prompt path.
 *
 * The M5A tests asserted the fixtures were well-formed. These assert something
 * different and harder: that a seat standing in each position actually gets a
 * prompt containing what the position demands. A rubric that names an analysis
 * obligation the prompt never supplies the material for is a rubric that grades
 * the prompt builder's omissions as the model's mistakes.
 *
 * Scripted only. `fetch` throws for the whole file.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("scenario harness must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const COG = loadConfig({
  promptVersion: PROMPT_VERSION_COGNITIVE,
  cognition: { enabled: true },
  experiment: { strategyProfile: "expert-cognitive" },
});

const EXPERT = strategyById("expert-cognitive");

/**
 * A real observation for a seat holding the scenario's role.
 *
 * Deliberately found by search rather than fabricated: a hand-built
 * observation could contain a shape the referee never produces, and then the
 * harness would be testing a prompt for a position that cannot occur.
 */
function seatHolding(role: string): { observation: Observation; seat: Seat } {
  for (let seed = 1; seed < 80; seed += 1) {
    const state = createGame({ seed, config: COG });
    const pending = state.pending!.seat;
    const observation = observationFor(state, pending);
    if (observation.role === role) return { observation, seat: pending };
  }
  // Fall back to any seat with the role, using its own (request-less) view for
  // strategy rendering only.
  for (let seed = 1; seed < 80; seed += 1) {
    const state = createGame({ seed, config: COG });
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      if (observation.role === role) return { observation, seat };
    }
  }
  throw new Error(`no seat with role ${role}`);
}

/** What this role actually reads in the expert profile. */
function profileFor(role: string): string {
  const { observation } = seatHolding(role);
  return renderStrategy(EXPERT, observation);
}

describe("every scenario's role gets the material its obligations need", () => {
  const byRole = new Map<string, Scenario[]>();
  for (const s of SCENARIOS) {
    byRole.set(s.tested.role, [...(byRole.get(s.tested.role) ?? []), s]);
  }

  it("covers every tested role with a rendered profile", () => {
    for (const role of byRole.keys()) {
      expect(profileFor(role).length, role).toBeGreaterThan(0);
    }
  });

  it("gives Percival the candidate-pair obligations", () => {
    const text = profileFor("percival");
    expect(text).toContain("【必须看到】");
    expect(text).toContain("这辆车里必然有莫甘娜");
    // And the non-claim plan requirement, which is the M5B policy decision.
    expect(text).toContain("什么条件出现你就会跳");
  });

  it("gives Percival the strong early-claim default without making it mandatory", () => {
    const text = profileFor("percival");
    expect(text).toContain("优先考虑直接跳派西维尔");
    expect(text).toContain("强默认");
    // Strong is not scripted: the word that would make it an order is absent.
    expect(text).not.toContain("必须跳");
  });

  it("gives Merlin the two-sets obligation and the Lady rule", () => {
    const text = profileFor("merlin");
    expect(text).toContain("看不见的莫德雷德");
    expect(text).toContain("通常应该验一个还没定性的莫德雷德候选");
    // Checking a known seat stays legal, but has to buy something.
    expect(text).toContain("要能说出它换到了什么");
  });

  it("gives the Assassin a ranked list with provenance", () => {
    const text = profileFor("assassin");
    expect(text).toContain("有排序");
    expect(text).toContain("哪一条新的公开证据");
  });

  it("gives evil seats the fail-versus-success comparison and the leak warning", () => {
    for (const role of ["assassin", "mordred", "morgana", "oberon"]) {
      const text = profileFor(role);
      expect(text, role).toContain("每一次都把踩和不踩摆出来比一遍");
      expect(text, role).toContain("至少有两个坏人");
    }
  });

  it("does not hard-code a single-fail convention", () => {
    const text = profileFor("assassin");
    expect(text).toContain("这不是说只能踩一张");
  });

  it("gives Oberon the no-coordination obligation", () => {
    const text = profileFor("oberon");
    expect(text).toContain("他们也不知道你是谁");
  });

  it("tells good seats that claims stay claims", () => {
    for (const role of ["merlin", "percival", "loyal"]) {
      expect(profileFor(role), role).toContain("永远不会变成硬信息");
    }
  });

  it("marks a loyal-servant claim as low-information for everyone", () => {
    for (const role of ["loyal", "merlin", "assassin"]) {
      expect(profileFor(role), role).toContain("本身几乎不携带信息");
    }
  });
});

describe("role-specific expert material stays with its role", () => {
  it("does not show Percival's pair reasoning to anybody else", () => {
    for (const role of ["merlin", "loyal", "assassin", "mordred", "morgana", "oberon"]) {
      expect(profileFor(role), role).not.toContain("这辆车里必然有莫甘娜");
    }
  });

  it("does not show Merlin's Lady plan to anybody else", () => {
    for (const role of ["percival", "loyal", "mordred"]) {
      expect(profileFor(role), role).not.toContain("还没定性的莫德雷德候选");
    }
  });

  it("does not show evil card reasoning to good seats", () => {
    for (const role of ["merlin", "percival", "loyal"]) {
      expect(profileFor(role), role).not.toContain("每一次都把踩和不踩摆出来比一遍");
    }
  });
});

describe("the protocol and the profile do not say the same things", () => {
  /**
   * The division of labour, checked rather than described.
   *
   * General reasoning discipline belongs in the cached protocol layer;
   * situated expert judgement belongs in the profile. A phrase in both is two
   * copies that will drift, and the cached one wins by repetition.
   */
  it("keeps general discipline out of the profile", () => {
    const profile = SCENARIOS.map((s) => profileFor(s.tested.role)).join("\n");
    for (const generalPhrase of [
      "把新说法归类为「说法」，不是「事实」",
      "同时留住至少两种说得通的世界",
      "正面处理最强的那个异议",
      "写下有界的认知更新",
    ]) {
      expect(profile, generalPhrase).not.toContain(generalPhrase);
    }
  });

  it("keeps situated judgement out of the protocol", async () => {
    const { DECISION_PROTOCOL_LAYER } = await import("./protocol");
    for (const situated of [
      "莫甘娜",
      "莫德雷德",
      "派西维尔",
      "湖中女神",
      "刺客",
      "奥伯伦",
    ]) {
      expect(DECISION_PROTOCOL_LAYER, situated).not.toContain(situated);
    }
  });
});

describe("a built prompt carries the fixture's material", () => {
  function built(role: string) {
    const { observation } = seatHolding(role);
    if (!observation.request) return null;
    const store = new CognitionStore();
    return buildCognitivePrompt({
      observation,
      persona: assignPersonas(1)[observation.seat],
      strategy: EXPERT,
      ledger: store.for(observation),
      config: COG,
    });
  }

  it("includes the fact tables, the private block and the cognition instruction", () => {
    const prompt = built("loyal");
    expect(prompt).not.toBeNull();
    const text = `${prompt!.system}\n${prompt!.user}`;
    expect(text).toContain("硬事实（裁判记录，不可改写）");
    expect(text).toContain("只有你知道的硬信息");
    expect(text).toContain("除了动作，还要填一个 `cognition` 对象");
    // The protocol is in the cacheable half, the rest in the per-turn half.
    expect(prompt!.system).toContain("私下的思考流程");
    expect(prompt!.user).not.toContain("私下的思考流程");
  });

  it("tells the model the system decides premise hardness, not it", () => {
    const prompt = built("loyal");
    expect(prompt!.user).toContain("系统会自己判断这些前提硬不硬");
  });

  it("never puts cognition content into the public-message instruction", () => {
    const prompt = built("loyal");
    expect(prompt!.user).toContain("认知内容一个字都不要写进去");
  });
});
