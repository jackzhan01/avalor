import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfile } from "../config/load";
import { observationFor, type Observation } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { assignPersonas } from "../prompts/personas";
import { renderStrategy, strategyById } from "../prompts/strategies";
import { buildCognitivePrompt } from "./build-cognitive";
import { CognitionStore } from "./store";
import { SOCIAL_SCENARIOS, socialScenarioById } from "./scenarios-social";
import { SCENARIOS } from "./scenarios";
import { ALIGNMENT_VALUES } from "./social";

/**
 * The twelve coordination fixtures, and the prompt a seat standing in each
 * position would actually receive.
 *
 * Same discipline as the M5A harness: a fixture that names an obligation the
 * prompt never supplies the material for is grading the prompt builder's
 * omissions as the model's mistakes. So half of this file checks the fixtures
 * are well-formed and half checks the rendered `expert-social` profile and the
 * 0.3.1 layer stack really carry what they demand.
 *
 * Scripted only. `fetch` throws for the whole file.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("the social scenario harness must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = loadProfile("m5-1-pilot");
const SOCIAL = strategyById("expert-social");

function seatHolding(role: string): { observation: Observation; seat: Seat } {
  for (let seed = 1; seed < 120; seed += 1) {
    const state = createGame({ seed, config: CONFIG });
    const pending = state.pending!.seat;
    const observation = observationFor(state, pending);
    if (observation.role === role) return { observation, seat: pending };
  }
  for (let seed = 1; seed < 120; seed += 1) {
    const state = createGame({ seed, config: CONFIG });
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      if (observation.role === role) return { observation, seat };
    }
  }
  throw new Error(`no seat with role ${role}`);
}

function profileFor(role: string): string {
  return renderStrategy(SOCIAL, seatHolding(role).observation);
}

describe("the fixtures are well-formed", () => {
  it("has twelve of them, with unique ids", () => {
    expect(SOCIAL_SCENARIOS).toHaveLength(12);
    const ids = SOCIAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not collide with the M5A fixture ids", () => {
    const older = new Set(SCENARIOS.map((s) => s.id));
    for (const s of SOCIAL_SCENARIOS) expect(older.has(s.id), s.id).toBe(false);
  });

  it("never names one action as the only expert action", () => {
    for (const s of SOCIAL_SCENARIOS) {
      expect(s.acceptableActionFamilies.length, s.id).toBeGreaterThanOrEqual(2);
      for (const family of s.acceptableActionFamilies) {
        expect(family.mustJustify.length, `${s.id}/${family.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every fixture checkable analysis obligations and failure modes", () => {
    for (const s of SOCIAL_SCENARIOS) {
      expect(s.analysisObligations.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.expertFailureModes.length, s.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("names only real alignment stances", () => {
    for (const s of SOCIAL_SCENARIOS) {
      for (const stance of s.socialObligations.stances) {
        expect(ALIGNMENT_VALUES, `${s.id}/${stance}`).toContain(stance);
      }
      expect(s.socialObligations.stances.length, s.id).toBeGreaterThan(0);
      expect(s.socialObligations.mustRecord.length, s.id).toBeGreaterThan(0);
    }
  });

  it("keeps hidden information out of every fixture's permitted public message", () => {
    for (const s of SOCIAL_SCENARIOS) {
      // Every fixture whose seat holds private knowledge must forbid leaking it.
      const holdsSecret =
        s.tested.knowledge.kind !== "none" || s.tested.side === "evil";
      if (holdsSecret) expect(s.forbiddenLeaks.length, s.id).toBeGreaterThan(0);
    }
  });

  it("covers the twelve situations the milestone asked for", () => {
    const wanted = [
      "x01.percival-claims-with-a-plan",
      "x02.percival-hides-but-props-up-a-proxy",
      "x03.percival-pair-on-one-team",
      "x04.morgana-counterclaims",
      "x05.loyal-conditionally-follows",
      "x06.loyal-rejects-a-contradicted-claimant",
      "x07.minority-dissenter-becomes-focal",
      "x08.trusted-leader-loses-a-team",
      "x09.two-coalitions",
      "x10.hammer-changes-following",
      "x11.merlin-backs-a-leader",
      "x12.evil-manufactures-consensus",
    ];
    for (const id of wanted) expect(socialScenarioById(id).id).toBe(id);
  });

  it("spreads across roles rather than testing Percival twelve times", () => {
    const roles = new Set(SOCIAL_SCENARIOS.map((s) => s.tested.role));
    expect(roles.size).toBeGreaterThanOrEqual(4);
    expect(roles.has("percival")).toBe(true);
    expect(roles.has("merlin")).toBe(true);
    expect(roles.has("loyal")).toBe(true);
    // And at least one evil seat, or the counterplay half is untested.
    expect(SOCIAL_SCENARIOS.some((s) => s.tested.side === "evil")).toBe(true);
  });
});

describe("Percival gets leadership material without being scripted", () => {
  const text = () => profileFor("percival");

  it("makes an early claim a strong default that carries a plan", () => {
    expect(text()).toContain("强烈倾向直接跳");
    expect(text()).toContain("大家该怎么投");
    expect(text()).toContain("有人对跳你会怎么办");
  });

  it("still says not claiming is legal", () => {
    expect(text()).toContain("不跳也合法");
    expect(text()).not.toContain("必须跳");
  });

  it("requires a fresh reason each turn, not a copied trigger", () => {
    // The pilot's Percival wrote nearly the same trigger seventeen times.
    expect(text()).toContain("一字不差地照抄上一轮的触发条件");
  });

  it("requires the hidden Percival to do something by the end of cycle one", () => {
    expect(text()).toContain("第一轮的任务已经结算，而你还没跳");
    expect(text()).toContain("三样一样都没有");
  });

  it("reopens the claim question when both candidates ride one team", () => {
    expect(text()).toContain("重新问一次跳不跳");
    expect(text()).toContain("沉默地投反对既救不了这一轮");
  });

  it("never tells other roles who the real Percival is", () => {
    for (const role of ["loyal", "merlin", "assassin", "mordred", "oberon"]) {
      expect(profileFor(role), role).not.toContain("强烈倾向直接跳");
      expect(profileFor(role), role).not.toContain("第一轮的任务已经结算，而你还没跳");
    }
  });
});

describe("loyal seats get following without obedience", () => {
  const text = () => profileFor("loyal");

  it("says a Percival claim is not itself a reason to trust", () => {
    expect(text()).toContain("跳了派西维尔本身不是理由");
    expect(text()).toContain("莫甘娜也会跳");
  });

  it("asks a follower to say what it is following, out loud", () => {
    expect(text()).toContain("点名是谁");
    expect(text()).toContain("只说「我同意 X 号」不产生共同知识");
  });

  it("requires an exit condition", () => {
    expect(text()).toContain("说不出撤退条件的跟随不是判断");
  });

  it("says when to drop a leader", () => {
    expect(text()).toContain("公开降低或收回信任");
    expect(text()).toContain("一张换不掉的椅子比坐在上面的人危险");
  });

  it("refuses to let two leaders freeze the table", () => {
    expect(text()).toContain("不要各打五十大板");
  });

  it("gives good seats the anti-groupthink line, and nobody a duty to follow", () => {
    for (const role of ["loyal", "merlin", "percival"]) {
      const t = profileFor(role);
      expect(t, role).not.toContain("必须跟");
      expect(t, role).toContain("焦点");
    }
  });
});

describe("evil gets the counterplay", () => {
  it("lets Morgana claim or counterclaim Percival", () => {
    const text = profileFor("morgana");
    expect(text).toContain("跳派西维尔（或者对跳）");
    expect(text).toContain("没人跳的时候先跳往往更强");
  });

  it("lets evil endorse a false leader rather than lead", () => {
    for (const role of ["assassin", "mordred", "morgana", "oberon"]) {
      expect(profileFor(role), role).toContain("捧一个方向对你有利的好人");
    }
  });

  it("lets evil split a coalition and manufacture consensus", () => {
    const text = profileFor("assassin");
    expect(text).toContain("拆开它通常比正面反对有效");
    expect(text).toContain("让它看起来像是桌面共识");
  });

  it("names the cost of manufacturing consensus, so it is not free", () => {
    expect(profileFor("mordred")).toContain("回头去数谁推过它的人");
  });

  it("keeps Morgana's counterclaim line away from good seats", () => {
    for (const role of ["loyal", "merlin", "percival"]) {
      expect(profileFor(role), role).not.toContain("跳派西维尔（或者对跳）");
    }
  });
});

describe("Merlin can support a leader without becoming one", () => {
  it("offers backing a focal player as a concealment line", () => {
    const text = profileFor("merlin");
    expect(text).toContain("支持他往往比自己再抛一个正确的新观点安全");
    expect(text).toContain("每次都恰好站对边");
  });

  it("warns about ending up in the chair", () => {
    expect(profileFor("merlin")).toContain("这是刺客最想看到的位置");
  });
});

describe("the focal position belongs to everybody", () => {
  it("tells every role that the chair is a position, not a role", () => {
    for (const role of ["loyal", "merlin", "percival", "assassin", "morgana", "oberon"]) {
      expect(profileFor(role), role).toContain("那是一个**位置**，不是一种身份");
    }
  });

  it("tells every role that a vindicated dissenter is evidence, not proof", () => {
    for (const role of ["loyal", "assassin"]) {
      expect(profileFor(role), role).toContain("坏人也会反对一辆注定要挂的车来买信誉");
    }
  });

  it("tells every role the hammer changes the cost of following", () => {
    for (const role of ["loyal", "morgana"]) {
      expect(profileFor(role), role).toContain("之前跟着他反对是便宜的，现在不是");
    }
  });
});

describe("the built 0.3.1 prompt carries what the fixtures demand", () => {
  function built(role: string) {
    const { observation } = seatHolding(role);
    if (!observation.request) return null;
    const store = new CognitionStore();
    return buildCognitivePrompt({
      observation,
      persona: assignPersonas(1)[observation.seat],
      strategy: SOCIAL,
      ledger: store.for(observation),
      config: CONFIG,
    });
  }

  it("carries the public-action bridge in the cached system layer", () => {
    const prompt = built("loyal") ?? built("merlin");
    expect(prompt).toBeTruthy();
    expect(prompt!.system).toContain("从私下判断到牌桌上的动作");
    expect(prompt!.system).toContain("现在谁在带节奏？");
    expect(prompt!.system).toContain("别人才能和你配合");
    // And the concealment carve-out, so it is not a duty to confess.
    expect(prompt!.system).toContain("不是每一条怀疑都要说出口");
  });

  it("keeps the bridge's steps out of the per-turn user message, so it caches", () => {
    // The profile REFERS to the bridge by name ("那六步不在这里") — that is a
    // pointer, and pointers are how the division of labour is kept visible. What
    // must not be duplicated is the steps themselves: two copies drift, and the
    // cached one wins by repetition.
    const prompt = built("loyal") ?? built("merlin");
    for (const step of [
      "现在谁在带节奏？",
      "他到底要大家接受哪一句话？",
      "反对它的最强理由是什么？",
      "别人才能和你配合",
    ]) {
      expect(prompt!.user, step).not.toContain(step);
    }
  });

  it("asks for the social block and explains every required field", () => {
    const prompt = built("loyal") ?? built("merlin");
    for (const field of [
      "focalCandidates",
      "conditionToReconsider",
      "alignment",
      "publicAction",
      "coalitionPlan",
      "strongestDissent",
      "closedCommitments",
    ]) {
      expect(prompt!.user, field).toContain(field);
    }
  });

  it("prints the fact-id legend and a worked example of an id", () => {
    const prompt = built("loyal") ?? built("merlin");
    expect(prompt!.user).toContain("照抄方括号里面的东西");
    expect(prompt!.user).toContain("`[f12]`");
  });

  it("stamps prompt-0.3.1 and puts social in the strict schema", () => {
    const prompt = built("loyal") ?? built("merlin");
    expect(prompt!.promptVersion).toBe("prompt-0.3.1");
    const schema = prompt!.jsonSchema as {
      properties: { cognition: { properties: Record<string, unknown> } };
    };
    expect(schema.properties.cognition.properties.social).toBeTruthy();
    expect(schema.properties.cognition.properties.closedCommitments).toBeTruthy();
  });
});
