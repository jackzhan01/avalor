import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfile } from "../config/load";
import { observationFor } from "../core/observation";
import type { Observation } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS } from "../core/types";
import { COMMON_RULES } from "../prompts/common";
import { assignPersonas, PERSONAS, renderPersona } from "../prompts/personas";
import { renderStrategy, strategyById } from "../prompts/strategies";
import { buildCognitivePrompt, COGNITION_INSTRUCTION } from "./build-cognitive";
import { renderFactTables } from "./context-pack";
import { DECISION_PROTOCOL_LAYER } from "./protocol";
import { COGNITION_FRAGMENT } from "./response";
import { CognitionStore } from "./store";

/**
 * The prompt-quality audit, executable.
 *
 * Every item the review gate asks about is a property something can check, so
 * it is checked here rather than asserted in prose. A review claim nobody can
 * re-run is a claim that rots the first time somebody edits a layer.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("the audit must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const PILOT = loadProfile("m5-pilot");
const EXPERT = strategyById("expert-cognitive");

function seatWith(role: string): Observation {
  for (let seed = 1; seed < 200; seed += 1) {
    const state = createGame({ seed, config: PILOT });
    const observation = observationFor(state, state.pending!.seat);
    if (observation.role === role) return observation;
  }
  throw new Error(`no pending seat with role ${role}`);
}

const profileFor = (role: string) => renderStrategy(EXPERT, seatWith(role));

function fullPrompt(role: string): string {
  const observation = seatWith(role);
  const built = buildCognitivePrompt({
    observation,
    persona: assignPersonas(1, "heterogeneous-rotated")[observation.seat],
    strategy: EXPERT,
    ledger: new CognitionStore().for(observation),
    config: PILOT,
  });
  return `${built.system}\n${built.user}`;
}

const ROLES = ["percival", "merlin", "loyal", "assassin", "morgana", "mordred", "oberon"];

/* ── 1. No duplicated general reasoning instruction ─────────────────────── */

describe("the protocol and the expert profile do not overlap", () => {
  it("keeps general discipline out of the profile", () => {
    // The protocol is cached once per game; the profile is re-rendered per
    // seat. A sentence in both is two copies that drift, and the cached one
    // wins by repetition.
    const everyProfile = ROLES.map(profileFor).join("\n");
    for (const general of [
      "把新说法归类为「说法」，不是「事实」",
      "同时留住至少两种说得通的世界",
      "正面处理最强的那个异议",
      "想出几个不同的候选动作",
      "写下有界的认知更新",
      "一条结论最多和它最弱的前提一样硬",
    ]) {
      expect(everyProfile, general).not.toContain(general);
    }
  });

  it("keeps situated judgement out of the protocol", () => {
    for (const situated of ["莫甘娜", "莫德雷德", "派西维尔", "湖中女神", "刺客", "奥伯伦"]) {
      expect(DECISION_PROTOCOL_LAYER, situated).not.toContain(situated);
    }
  });

  it("shares no long sentence between the two layers", () => {
    // Mechanical rather than by hand: any run of 12+ characters appearing in
    // both is a duplication somebody introduced without noticing.
    const everyProfile = ROLES.map(profileFor).join("\n");
    const protocolChunks = DECISION_PROTOCOL_LAYER.split(/[\n。：，、]/)
      .map((s) => s.replace(/[*`#\-\s]/g, ""))
      .filter((s) => s.length >= 12);
    const duplicated = protocolChunks.filter((chunk) => everyProfile.includes(chunk));
    expect(duplicated).toEqual([]);
  });
});

/* ── 2. Persona vs expert obligations ───────────────────────────────────── */

describe("persona wording does not fight the expert obligations", () => {
  it("never phrases a persona as a rule", () => {
    for (const persona of Object.values(PERSONAS)) {
      const text = renderPersona(persona);
      for (const imperative of ["必须", "一定要", "务必", "禁止", "只能这样"]) {
        expect(text, `${persona.id}/${imperative}`).not.toContain(imperative);
      }
    }
  });

  it("never has a persona tell a seat what to decide", () => {
    // Personas are style. A persona that said "always approve" would silently
    // outrank a role plan, and the pilot would measure the persona.
    for (const persona of Object.values(PERSONAS)) {
      const text = renderPersona(persona);
      for (const decision of ["投赞成", "投反对", "跳身份", "出成功", "踩", "上票"]) {
        expect(text, `${persona.id}/${decision}`).not.toContain(decision);
      }
    }
  });

  it("mentions no role and no seat number", () => {
    for (const persona of Object.values(PERSONAS)) {
      const text = renderPersona(persona);
      expect(text).not.toMatch(/\d+号/);
      for (const role of ["梅林", "派西维尔", "莫甘娜", "莫德雷德", "奥伯伦", "刺客"]) {
        expect(text, `${persona.id}/${role}`).not.toContain(role);
      }
    }
  });
});

/* ── 3-5. Percival ──────────────────────────────────────────────────────── */

describe("Percival: a strong prior, never a script", () => {
  it("has a strong early-position claim prior", () => {
    const text = profileFor("percival");
    expect(text).toContain("优先考虑直接跳派西维尔");
    expect(text).toContain("强默认");
  });

  it("does not force a claim in any position", () => {
    const text = profileFor("percival");
    // The exact convention this project has refused to encode since M3.
    expect(text).not.toContain("必须跳");
    expect(text).not.toContain("一定要跳");
    expect(text).toContain("不是照做不可的动作");
    // And staying hidden is still a named, legal line.
    expect(text).toContain("不跳是合法的");
  });

  it("requires a concrete plan if Percival stays hidden", () => {
    const text = profileFor("percival");
    // Three things, all named: leadership, the pair, and the trigger.
    expect(text).toContain("怎么在不公开身份的情况下组织好人");
    expect(text).toContain("怎么继续用候选对");
    expect(text).toContain("什么条件出现你就会跳");
    expect(text).toContain("等于这个身份没有被使用");
  });

  it("has somewhere in the schema to put that plan", () => {
    // An obligation with no field to record it is advice, not an obligation.
    const props = (COGNITION_FRAGMENT as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("claimPlan");
    expect(props).toHaveProperty("updatedRolePlan");
    expect(props).toHaveProperty("nextTurnPlan");
  });

  it("states the both-candidates-on-one-team obligation", () => {
    const text = profileFor("percival");
    expect(text).toContain("【必须看到】");
    expect(text).toContain("这辆车里必然有莫甘娜");
    // Recognising is required; the response is not.
    expect(text).toContain("怎么处理完全由你决定");
  });
});

/* ── 6. Claims are never referee truth ──────────────────────────────────── */

describe("nothing describes a claim or a Lady announcement as truth", () => {
  it("labels the Lady announcement as what the holder said", () => {
    // Rendered directly rather than fished out of a game position: the caveat
    // only appears once an announcement exists, and a test that depended on
    // finding such a position would pass vacuously whenever it did not.
    const observation = seatWith("loyal");
    const text = renderFactTables(
      [
        {
          kind: "lady_announcement",
          id: "f62",
          provenance: { kind: "referee", sequence: 62 },
          holder: 9,
          target: 6,
          announced: "good",
        },
      ],
      [],
      observation,
    );
    expect(text).toContain("9号 验了 6号");
    expect(text).toContain("这是他说的，不是裁判说的");
  });

  it("heads the claims section as claims", () => {
    const text = fullPrompt("loyal");
    expect(text).toContain("公开说法（有人这么说过，不等于真的）");
  });

  it("tells good seats a claim never becomes hard information", () => {
    for (const role of ["merlin", "percival", "loyal"]) {
      expect(profileFor(role), role).toContain("永远不会变成硬信息");
    }
  });

  it("marks a loyal-servant claim as intrinsically low-information", () => {
    const text = profileFor("loyal");
    expect(text).toContain("本身几乎不携带信息");
    expect(text).toContain("尤其不能用来自证");
  });

  it("puts the failed-team caveat inline with the constraint", () => {
    const text = fullPrompt("loyal");
    if (!text.includes("至少有")) return;
    expect(text).toContain("没洗清车上其他人");
  });
});

/* ── 7. Merlin ──────────────────────────────────────────────────────────── */

describe("Merlin separates visible evil from the blind spot", () => {
  it("names both sets explicitly", () => {
    const text = profileFor("merlin");
    expect(text).toContain("我看得见的坏人");
    expect(text).toContain("我看不见的莫德雷德");
    expect(text).toContain("两个不同的集合");
  });

  it("says the private block also states the blind spot", () => {
    const text = fullPrompt("merlin");
    expect(text).toContain("莫德雷德你看不见");
  });

  it("prefers searching, and prices the alternative", () => {
    const text = profileFor("merlin");
    expect(text).toContain("通常应该验一个还没定性的莫德雷德候选");
    expect(text).toContain("要能说出它换到了什么");
  });

  it("warns against a mechanically perfect voting record", () => {
    const text = profileFor("merlin");
    expect(text).toContain("每次都投对");
    expect(text).toContain("刺杀掩护");
  });
});

/* ── 8. Assassin ────────────────────────────────────────────────────────── */

describe("Assassin keeps a ranked list with provenance", () => {
  it("asks for an ordered candidate list", () => {
    expect(profileFor("assassin")).toContain("有排序");
  });

  it("requires a cited reason for every ranking change", () => {
    const text = profileFor("assassin");
    expect(text).toContain("哪一条新的公开证据");
    expect(text).toContain("说不出依据的排序变化");
  });

  it("separates winning missions from preparing the kill", () => {
    expect(profileFor("assassin")).toContain("赢任务和准备刺杀是两件事");
  });
});

/* ── 9. Evil mission cards ──────────────────────────────────────────────── */

describe("evil mission decisions compare all three considerations", () => {
  it("demands an explicit fail-versus-success comparison", () => {
    for (const role of ["assassin", "mordred", "morgana", "oberon"]) {
      expect(profileFor(role), role).toContain("每一次都把踩和不踩摆出来比一遍");
    }
  });

  it("names the double-fail leak", () => {
    const text = profileFor("assassin");
    expect(text).toContain("至少有两个坏人");
    expect(text).toContain("只卖掉了信息");
  });

  it("does not hard-code a single-fail convention", () => {
    const text = profileFor("assassin");
    expect(text).toContain("这不是说只能踩一张");
    expect(text).not.toContain("必须只踩");
  });

  it("says cover expires when one more failure wins", () => {
    expect(profileFor("mordred")).toContain("没有以后它就不值钱了");
  });
});

/* ── 10-11. No chain-of-thought; structured conclusions only ────────────── */

describe("nothing asks for free-form reasoning", () => {
  it("tells the model not to write the process down", () => {
    expect(DECISION_PROTOCOL_LAYER).toContain("这十四步的过程不要写出来");
    expect(COGNITION_INSTRUCTION).toContain("把上面思考流程的**结论**填进去，不要写过程");
  });

  it("never uses a phrase that invites a transcript", () => {
    const everything = [
      COMMON_RULES,
      DECISION_PROTOCOL_LAYER,
      COGNITION_INSTRUCTION,
      ...ROLES.map(profileFor),
    ].join("\n");
    for (const invite of [
      "一步一步地写",
      "把你的推理过程写下来",
      "展示你的思考",
      "详细说明你是怎么想的",
      "chain of thought",
      "step by step",
    ]) {
      expect(everything, invite).not.toContain(invite);
    }
  });

  it("offers no free-text field big enough to hide a transcript in", () => {
    const props = (COGNITION_FRAGMENT as {
      properties: Record<string, { type?: unknown }>;
    }).properties;
    // Every string field is a bounded conclusion; the arrays are id lists and
    // short labels. There is no `reasoning`, `analysis` or `notes`.
    for (const forbidden of ["reasoning", "analysis", "thoughts", "notes", "scratchpad"]) {
      expect(Object.keys(props), forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the public message free of cognition", () => {
    expect(COGNITION_INSTRUCTION).toContain("认知内容一个字都不要写进去");
    expect(DECISION_PROTOCOL_LAYER).toContain("不要写进公开发言");
  });

  it("tells the model it cannot certify its own premises", () => {
    expect(COGNITION_INSTRUCTION).toContain("系统会自己判断这些前提硬不硬");
    const props = (COGNITION_FRAGMENT as { properties: Record<string, unknown> }).properties;
    const constraint = props.constraints as { items: { properties: Record<string, unknown> } };
    expect(Object.keys(constraint.items.properties)).not.toContain("premiseVerified");
  });
});

/* ── The seat's own view stays its own ──────────────────────────────────── */

describe("role-specific material stays with its role", () => {
  it("keeps each role's obligations off every other role's prompt", () => {
    const markers: [string, string][] = [
      ["percival", "这辆车里必然有莫甘娜"],
      ["merlin", "还没定性的莫德雷德候选"],
      ["assassin", "哪一条新的公开证据"],
      ["oberon", "他们也不知道你是谁"],
    ];
    for (const [owner, marker] of markers) {
      for (const other of ROLES) {
        if (other === owner) continue;
        expect(profileFor(other), `${other} saw ${owner}'s`).not.toContain(marker);
      }
    }
  });

  it("gives every seat a usable profile all the same", () => {
    const state = createGame({ seed: 1, config: PILOT });
    for (const seat of SEATS) {
      const rendered = renderStrategy(EXPERT, observationFor(state, seat));
      const entries = (rendered.match(/^- /gm) ?? []).length;
      expect(entries, `${seat}号`).toBeGreaterThanOrEqual(10);
    }
  });
});
