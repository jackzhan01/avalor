import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProfile } from "../config/load";
import { observationFor, type Observation } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { assignPersonas } from "../prompts/personas";
import { renderStrategy, strategyById } from "../prompts/strategies";
import { buildCognitivePrompt } from "./build-cognitive";
import { CognitionStore } from "./store";
import { CONTEST_SCENARIOS, contestScenarioById } from "./scenarios-contest";
import { SCENARIOS } from "./scenarios";
import { SOCIAL_SCENARIOS } from "./scenarios-social";
import { CLAIM_ACT_VALUES, CONTEST_STANCE_VALUES, OWN_STATUS_VALUES } from "./contest";

/**
 * The twenty-five claim-contest fixtures, and the prompt a seat in each
 * position would actually receive.
 *
 * Same discipline as the two earlier harnesses: a fixture that names an
 * obligation the prompt never supplies material for grades the prompt builder's
 * omissions as the model's mistakes. So half of this checks the fixtures are
 * well-formed and half checks the rendered `expert-claim-contest` profile and
 * the 0.4.0 layer stack really carry what they demand.
 *
 * Scripted only. `fetch` throws for the whole file.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("the contest scenario harness must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = loadProfile("m5-2-pilot");
const CONTEST_ARM = strategyById("expert-claim-contest");

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

const profileFor = (role: string) => renderStrategy(CONTEST_ARM, seatHolding(role).observation);

const EVERY_ROLE = [
  "percival",
  "merlin",
  "loyal",
  "morgana",
  "assassin",
  "mordred",
  "oberon",
] as const;

describe("the fixtures are well-formed", () => {
  it("has twenty-five of them, with unique ids", () => {
    expect(CONTEST_SCENARIOS).toHaveLength(25);
    const ids = CONTEST_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("collides with neither earlier fixture set", () => {
    const older = new Set([...SCENARIOS, ...SOCIAL_SCENARIOS].map((s) => s.id));
    for (const s of CONTEST_SCENARIOS) expect(older.has(s.id), s.id).toBe(false);
  });

  it("never names one action as the only expert action", () => {
    for (const s of CONTEST_SCENARIOS) {
      expect(s.acceptableActionFamilies.length, s.id).toBeGreaterThanOrEqual(2);
      for (const family of s.acceptableActionFamilies) {
        expect(family.mustJustify.length, `${s.id}/${family.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every fixture obligations and failure modes", () => {
    for (const s of CONTEST_SCENARIOS) {
      expect(s.analysisObligations.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.expertFailureModes.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.contestObligations.mustRecord.length, s.id).toBeGreaterThan(0);
      expect(s.contestObligations.acts.length, s.id).toBeGreaterThan(0);
    }
  });

  it("names only real acts, statuses and stances", () => {
    for (const s of CONTEST_SCENARIOS) {
      for (const act of s.contestObligations.acts) {
        expect(CLAIM_ACT_VALUES, `${s.id}/${act}`).toContain(act);
      }
      for (const status of s.contestObligations.ownStatuses) {
        expect(OWN_STATUS_VALUES, `${s.id}/${status}`).toContain(status);
      }
      for (const stance of s.contestObligations.stances) {
        expect(CONTEST_STANCE_VALUES, `${s.id}/${stance}`).toContain(stance);
      }
    }
  });

  it("only requires assessing seats that actually claimed in the fixture", () => {
    for (const s of CONTEST_SCENARIOS) {
      const claimants = new Set(s.claims.filter((c) => c.kind === "role").map((c) => c.seat));
      for (const seat of s.contestObligations.mustAssess) {
        expect(claimants.has(seat), `${s.id} wants ${seat} assessed`).toBe(true);
      }
    }
  });

  it("forbids leaks wherever the tested seat holds something private", () => {
    for (const s of CONTEST_SCENARIOS) {
      const holdsSecret = s.tested.knowledge.kind !== "none" || s.tested.side === "evil";
      if (holdsSecret) expect(s.forbiddenLeaks.length, s.id).toBeGreaterThan(0);
    }
  });

  it("covers the twenty-five situations the milestone asked for", () => {
    const wanted = [
      "p01.true-percival-claims-early",
      "p02.true-percival-enters-late",
      "p03.morgana-preempts",
      "p04.morgana-counterclaims",
      "p05.merlin-claims-as-cover",
      "p06.loyal-claims-to-protect",
      "p07.assassin-claims-to-provoke",
      "p08.mordred-claims-off-a-clean-record",
      "p09.oberon-claims-without-teammates",
      "p10.three-claimants",
      "p11.true-percival-attacks-without-accusing",
      "p12.true-percival-delays-with-a-plan",
      "p13.claimant-refuses-to-answer",
      "p14.mission-evidence-splits-the-claimants",
      "p15.retract-before-a-vote",
      "p16.retract-after-a-failed-mission",
      "p17.same-retraction-read-two-ways",
      "p18.followers-switch",
      "p19.false-consensus-around-morgana",
      "p20.minority-breaks-the-coalition",
      "p21.both-candidates-on-a-decisive-team",
      "p22.fifth-proposal-tests-the-plans",
      "p23.merlin-supports-true-percival",
      "p24.assassin-reads-the-fight",
      "p25.nobody-claims",
    ];
    for (const id of wanted) expect(contestScenarioById(id).id).toBe(id);
  });

  it("walks every role through claiming Percival", () => {
    // The design says every role may claim. A fixture set that only exercised
    // Percival and Morgana would quietly encode the opposite.
    const claimants = new Set(
      CONTEST_SCENARIOS.filter((s) =>
        s.contestObligations.acts.some(
          (a) => a === "claim-percival" || a === "counterclaim-percival",
        ),
      ).map((s) => s.tested.role),
    );
    for (const role of EVERY_ROLE) expect(claimants.has(role), role).toBe(true);
  });
});

describe("every role is told what claiming buys and costs", () => {
  it("gives each role a benefit-and-risk entry of its own", () => {
    const byRole: Record<string, string> = {
      percival: "ecc.percival-claim-tradeoff",
      morgana: "ecc.morgana-claim-tradeoff",
      merlin: "ecc.merlin-claim-tradeoff",
      loyal: "ecc.loyal-claim-tradeoff",
      assassin: "ecc.assassin-claim-tradeoff",
      mordred: "ecc.mordred-claim-tradeoff",
      oberon: "ecc.oberon-claim-tradeoff",
    };
    for (const [role, id] of Object.entries(byRole)) {
      const h = CONTEST_ARM.heuristics.find((x) => x.id === id);
      expect(h, id).toBeTruthy();
      expect(profileFor(role), `${role}/${id}`).toContain(h!.consider);
      // Both halves, always: a benefit with no cost is an instruction.
      expect(h!.consider, id).toContain("换到的");
      expect(h!.consider, id).toContain("付出的");
    }
  });

  /**
   * The six disputed claim considerations, pinned by count and by id.
   *
   * A report of this work said "five" and then listed six. Counting them in
   * prose is how that happens; counting them in a test is how it stops. All
   * six are OPTIONAL — every one carries `disputed: true` and none may become
   * an obligation, because an obligation to claim would delete the choice the
   * whole milestone exists to study.
   */
  const DISPUTED_CLAIM_CONSIDERATIONS = [
    "ecc.morgana-many-lines",
    "ecc.merlin-claim-tradeoff",
    "ecc.loyal-claim-tradeoff",
    "ecc.assassin-claim-tradeoff",
    "ecc.mordred-claim-tradeoff",
    "ecc.oberon-claim-tradeoff",
  ] as const;

  it("has exactly SIX disputed considerations about claiming Percival", () => {
    expect(DISPUTED_CLAIM_CONSIDERATIONS).toHaveLength(6);
    for (const id of DISPUTED_CLAIM_CONSIDERATIONS) {
      const h = CONTEST_ARM.heuristics.find((x) => x.id === id);
      expect(h, id).toBeTruthy();
      expect(h!.disputed, id).toBe(true);
    }
  });

  it("makes none of the six a mandatory action", () => {
    for (const id of DISPUTED_CLAIM_CONSIDERATIONS) {
      const h = CONTEST_ARM.heuristics.find((x) => x.id === id)!;
      // `obligation` in this catalog constrains what a seat must NOTICE, never
      // what it must do — `renderStrategy` phrases it as 「必须看到」 and the
      // action stays free. So the thing worth pinning is not the flag but the
      // language: nothing here may read as an order.
      for (const imperative of ["必须跳", "一定要跳", "务必", "只能", "禁止"]) {
        expect(h.consider, `${id}/${imperative}`).not.toContain(imperative);
      }
    }
  });

  it("renders all six as 「有争议」, so the model sees they are contested", () => {
    for (const [id, role] of [
      ["ecc.morgana-many-lines", "morgana"],
      ["ecc.merlin-claim-tradeoff", "merlin"],
      ["ecc.loyal-claim-tradeoff", "loyal"],
      ["ecc.assassin-claim-tradeoff", "assassin"],
      ["ecc.mordred-claim-tradeoff", "mordred"],
      ["ecc.oberon-claim-tradeoff", "oberon"],
    ] as const) {
      const h = CONTEST_ARM.heuristics.find((x) => x.id === id)!;
      const line = profileFor(role)
        .split("\n")
        .find((l) => l.includes(h.consider));
      expect(line, id).toBeTruthy();
      expect(line, id).toContain("（有争议）");
    }
  });

  it("marks exactly two of the six as also obligations-to-NOTICE", () => {
    // Loyal and Oberon, and deliberately. Both are the roles whose claim rests
    // on information they DO NOT HAVE: a Loyal seat has no candidate pair, and
    // Oberon has no teammates. The cost of that gap is the one thing neither
    // can be allowed to miss — so both render as 「必须看到」…（有争议）:
    // see the trade-off, then decide freely. Pinned so the asymmetry stays
    // visible rather than looking like a slip.
    const withObligation = DISPUTED_CLAIM_CONSIDERATIONS.filter(
      (id) => CONTEST_ARM.heuristics.find((x) => x.id === id)!.obligation === true,
    );
    expect([...withObligation].sort()).toEqual([
      "ecc.loyal-claim-tradeoff",
      "ecc.oberon-claim-tradeoff",
    ]);
    expect(profileFor("loyal")).toContain("说不出目的的跳不是免费的噪音");
    expect(profileFor("oberon")).toContain("你不知道队友是谁");
  });

  it("tells every role that anyone can claim anything", () => {
    for (const role of EVERY_ROLE) {
      expect(profileFor(role), role).toContain("任何身份都可以说这句话");
    }
  });

  it("tells every role to compare claimants rather than poll them", () => {
    for (const role of EVERY_ROLE) {
      expect(profileFor(role), role).toContain("放在一起比");
    }
  });

  it("tells every role that attacking a claim is not an accusation", () => {
    for (const role of EVERY_ROLE) {
      expect(profileFor(role), role).toContain("打声称和指认坏人是两个动作");
    }
  });

  it("tells every role that retraction deletes nothing and proves nothing", () => {
    for (const role of EVERY_ROLE) {
      const text = profileFor(role);
      expect(text, role).toContain("退水**不删除任何东西**");
      expect(text, role).toContain("既不自动加分也不自动减分");
    }
  });

  it("makes position part of the decision rather than a style note", () => {
    for (const role of EVERY_ROLE) {
      const text = profileFor(role);
      expect(text, role).toContain("靠前跳是在**定调**");
      expect(text, role).toContain("第五案之前跳");
    }
  });
});

describe("the true Percival must fight, or say why not", () => {
  const text = () => profileFor("percival");

  it("says a rival is taking authority, not offering an opinion", () => {
    expect(text()).toContain("他抢的是你的权威，不是在发表平行意见");
  });

  it("lists the ways of reducing a rival's credibility", () => {
    expect(text()).toContain("打他的时机");
    expect(text()).toContain("打他的候选对故事");
  });

  it("keeps 'attack' distinct from 'they are evil'", () => {
    expect(text()).toContain("不等于断定他是坏人");
    expect(text()).toContain("也确实可能是一个好人在给别人做掩护");
  });

  it("makes delay require four specific things", () => {
    const delay = CONTEST_ARM.heuristics.find(
      (h) => h.id === "ecc.percival-delay-needs-a-recovery-plan",
    )!;
    for (const piece of ["为什么**现在**拖更好", "你在拉谁", "具体什么事件", "拿回来"]) {
      expect(delay.consider, piece).toContain(piece);
    }
    expect(delay.consider).toContain("一句和上一轮一样的拖延理由");
  });

  it("requires a claim to be actionable", () => {
    expect(text()).toContain("只报身份不给方案");
  });

  it("keeps Percival's own material away from other roles", () => {
    for (const role of ["merlin", "loyal", "assassin", "mordred", "oberon", "morgana"]) {
      expect(profileFor(role), role).not.toContain("他抢的是你的权威");
    }
  });
});

describe("Oberon is given nothing he does not have", () => {
  const text = () => profileFor("oberon");

  it("says plainly that he does not know his teammates", () => {
    expect(text()).toContain("你不知道队友是谁");
  });

  it("says a claim buys him no teammate information", () => {
    expect(text()).toContain("**不会让你知道任何队友**");
    expect(text()).toContain("在公开层面上是一样的");
  });

  it("never names a seat or a teammate anywhere in his profile", () => {
    expect(text()).not.toMatch(/\d+号(是|的)?(坏人|队友)/);
  });

  it("reads no field that could carry teammate knowledge", () => {
    for (const h of CONTEST_ARM.heuristics) {
      if (h.id.startsWith("ecc.oberon")) {
        expect(h.reads, h.id).not.toContain("knowledge");
      }
    }
  });

  it("does not show him the teammate-aware evil lines", () => {
    // `ecc.assassin-keep-two-books` and the Mordred entries are role-scoped.
    expect(text()).not.toContain("赢任务和找梅林是两本账");
    expect(text()).not.toContain("唯一有视野的好人看不见你，所以你的公开记录");
  });
});

describe("the built 0.4.0 prompt carries what the fixtures demand", () => {
  function built(role: string) {
    const { observation } = seatHolding(role);
    if (!observation.request) return null;
    const store = new CognitionStore();
    return buildCognitivePrompt({
      observation,
      persona: assignPersonas(1)[observation.seat],
      strategy: CONTEST_ARM,
      ledger: store.for(observation),
      config: CONFIG,
    });
  }

  const anyPrompt = () => built("loyal") ?? built("merlin") ?? built("percival");

  it("carries the contest protocol in the cached system layer", () => {
    const prompt = anyPrompt()!;
    expect(prompt.system).toContain("派权争夺");
    expect(prompt.system).toContain("任何身份都可以声称任何身份");
    expect(prompt.system).toContain("竞争者在抢的是你的权威");
    expect(prompt.system).toContain("打他的声称，不等于断定他是坏人");
  });

  it("keeps the protocol free of seat, role and state, so it caches", () => {
    const prompt = anyPrompt()!;
    const contestLayer = prompt.layers.find((l) => l.index === 2)!.text;
    expect(contestLayer).not.toMatch(/\d+号/);
    for (const role of EVERY_ROLE) expect(contestLayer, role).not.toContain(role);
  });

  it("renders the public claim table as its own layer", () => {
    const prompt = anyPrompt()!;
    const layer = prompt.layers.find((l) => l.index === 5.5);
    expect(layer).toBeTruthy();
    expect(layer!.text).toContain("身份声称与派权争夺");
    expect(layer!.text).toContain("没记录「谁是什么」");
  });

  it("offers 退水 in the speech schema, and explains the difference", () => {
    const prompt = anyPrompt()!;
    if (prompt.taskId.startsWith("speech")) {
      expect(prompt.user).toContain("retractClaim");
      expect(prompt.user).toContain("和 claim: null 不是一回事");
    }
    // And the cognition instruction says it for every task.
    expect(prompt.user).toContain("退水");
  });

  it("asks for the contest block and explains every required field", () => {
    const prompt = anyPrompt()!;
    for (const field of [
      "ownClaimStrategy",
      "situationSpecificBenefit",
      "triggerToRetract",
      "claimantAssessments",
      "rivalPlans",
      "distinctionTest",
      "publicClaimMove",
      "informationToConceal",
    ]) {
      expect(prompt.user, field).toContain(field);
    }
  });

  it("tells the model the action and the block must agree", () => {
    const prompt = anyPrompt()!;
    expect(prompt.user).toContain("动作字段和 `contest` 要对得上");
    expect(prompt.user).toContain("牌桌什么都看不到");
  });

  it("prints the `k…` id legend beside the others", () => {
    const prompt = anyPrompt()!;
    expect(prompt.user).toContain("`[k…]`");
    expect(prompt.user).toContain("同样只是「发生过」");
  });

  it("stamps prompt-0.4.0 and puts contest in the strict schema", () => {
    const prompt = anyPrompt()!;
    expect(prompt.promptVersion).toBe("prompt-0.4.0");
    const schema = prompt.jsonSchema as {
      properties: { cognition: { properties: Record<string, unknown> } };
    };
    expect(schema.properties.cognition.properties.contest).toBeTruthy();
    expect(schema.properties.cognition.properties.social).toBeTruthy();
  });
});
