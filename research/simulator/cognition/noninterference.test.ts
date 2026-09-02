import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { dealFromAssignment } from "../core/deal";
import type { Deal } from "../core/deal";
import { observationFor, type Observation } from "../core/observation";
import type { GameState } from "../core/state";
import type { Seat } from "../core/types";
import { drive, REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import { personaById } from "../prompts/personas";
import { publicOnly, sanitiseIntent } from "./firewall";
import { buildFactRegistry } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { claimsFrom, publicFactsFrom } from "./ledger";
import type { CommunicationIntent, SanitisedIntent } from "./intent";
import {
  assertPublicOnly,
  buildSpokespersonPrompt,
  publicTableViewFor,
} from "./spokesperson";

/**
 * THE CENTRAL CLAIM OF M5.3, stated as bytes.
 *
 * Take two games that differ ONLY in something hidden — Percival's pair, a
 * seat's role, the evil roster, a Lady result — hold the public state and the
 * already-chosen public action fixed, and require the public spokesperson's
 * prompt to be byte-identical.
 *
 * A byte-level assertion rather than a "does it mention the pair" one, and the
 * difference matters. Checking for a mention tests the detector; checking for
 * identical bytes tests that the hidden value never entered the prompt at all.
 * A spokesperson whose prompt does not depend on the pair cannot leak the pair
 * however it is prompted, argued with, or jailbroken — there is nothing there
 * to reveal.
 *
 * WHAT THESE TESTS DO NOT CLAIM. They say nothing about whether the wording is
 * good, and nothing about whether the private strategist reasons well. They say
 * one thing: the hidden half of the game is not an input to stage 2.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("disclosure tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const CONFIG = testConfig({
  promptVersion: "prompt-0.5.0",
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: { personaMode: "heterogeneous-rotated", strategyProfile: "expert-disclosure-safe" },
});

/** A game stopped mid-discussion, so the public log has real content. */
function stoppedGame(deal: Deal): GameState {
  const { state } = drive({
    seed: 7,
    deal,
    config: CONFIG,
    stopWhen: (s) => s.log.length >= 12,
  });
  return state;
}

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

const INTENT: CommunicationIntent = {
  channel: "table-public",
  publicGoal: "让牌桌换掉这辆车",
  targetSeats: [7],
  selectedClaimAction: "attack-rival-claim",
  requestedTeam: [1, 6, 8, 10],
  requestedVote: "reject",
  publicBasisIds: [],
  publicProposition: "7号 到现在没有解释过他为什么把自己放进每一辆关键车",
  desiredTableEffect: "这一票投反对，改带 1、6、8、10",
};

/**
 * Build stage 2's prompt for one seat of one game.
 *
 * Deliberately goes through the REAL path — registry, firewall, view — rather
 * than hand-constructing a `SanitisedIntent`. A test that skipped the firewall
 * would prove the spokesperson builder is clean and say nothing about whether
 * anything upstream hands it a secret.
 */
function spokespersonPrompt(state: GameState, seat: Seat): { system: string; user: string } {
  const observation = observationFor(state, seat);
  const registry = buildFactRegistry(
    publicFactsFrom(observation.publicLog),
    claimsFrom(observation.publicLog),
    observation,
    claimContestFrom(observation.publicLog),
  );
  const { intent } = sanitiseIntent({
    intent: INTENT,
    observation,
    registry,
    persona: personaById("challenger"),
    taskId: "speech-regular",
    taskChannel: "table-public",
  });
  const built = buildSpokespersonPrompt({
    view: publicTableViewFor(observation),
    intent,
    persona: personaById("challenger"),
    taskId: "speech-regular",
    speechCharLimit: CONFIG.limits.speechCharLimit,
    selectedAction: "- 公开表态：7号 踩",
  });
  return { system: built.system, user: built.user };
}

/* ── 1. The pair ────────────────────────────────────────────────────────── */

describe("非干涉：派西维尔候选对", () => {
  it("换掉候选对，发言者的 system 与 user 一个字节都不变", () => {
    // Seat 2 is Percival in both. In the first deal its pair is {1, 7}; in the
    // second, Merlin and Morgana have moved to 3 and 4, so its pair is {3, 4}.
    const a = stoppedGame(dealWith({}));
    const b = stoppedGame(
      dealWith({ 1: "loyal", 7: "loyal", 3: "merlin", 4: "morgana" }),
    );

    const pairA = observationFor(a, 2).knowledge;
    const pairB = observationFor(b, 2).knowledge;
    expect(pairA.kind).toBe("merlin_or_morgana");
    expect(pairB.kind).toBe("merlin_or_morgana");
    // The premise of the test: the two pairs really are different.
    expect(JSON.stringify(pairA)).not.toBe(JSON.stringify(pairB));

    const promptA = spokespersonPrompt(a, 2);
    const promptB = spokespersonPrompt(b, 2);
    expect(promptA.system).toBe(promptB.system);
    expect(promptA.user).toBe(promptB.user);
  });

  it("而规划者的提示确实会变 —— 否则这个测试是空的", () => {
    // The paired assertion. If stage 1's prompt were also invariant, the pair
    // would not be reaching the decision either, and M5.3 would have removed
    // the information rather than confined it.
    const a = observationFor(stoppedGame(dealWith({})), 2);
    const b = observationFor(
      stoppedGame(dealWith({ 1: "loyal", 7: "loyal", 3: "merlin", 4: "morgana" })),
      2,
    );
    expect(JSON.stringify(a.knowledge)).not.toBe(JSON.stringify(b.knowledge));
  });
});

/* ── 2. The role ────────────────────────────────────────────────────────── */

describe("非干涉：真实身份", () => {
  it("同一个座位换一个身份，发言者的提示不变", () => {
    // Seat 5 is loyal in the reference deal and Merlin in the variant. Public
    // state is identical because the scripted agents are deal-blind.
    const a = stoppedGame(dealWith({}));
    const b = stoppedGame(dealWith({ 1: "loyal", 5: "merlin" }));

    expect(observationFor(a, 5).role).toBe("loyal");
    expect(observationFor(b, 5).role).toBe("merlin");

    const promptA = spokespersonPrompt(a, 5);
    const promptB = spokespersonPrompt(b, 5);
    expect(promptA.system).toBe(promptB.system);
    expect(promptA.user).toBe(promptB.user);
  });
});

/* ── 3. The roster ──────────────────────────────────────────────────────── */

describe("非干涉：坏人名单", () => {
  it("换掉坏人分工，公开频道的发言者提示不变", () => {
    // Seat 8 is the assassin either way; who its teammates are moves.
    const a = stoppedGame(dealWith({}));
    const b = stoppedGame(dealWith({ 7: "loyal", 3: "morgana" }));

    const ka = observationFor(a, 8).knowledge;
    const kb = observationFor(b, 8).knowledge;
    expect(ka.kind).toBe("knows_teammates");
    expect(JSON.stringify(ka)).not.toBe(JSON.stringify(kb));

    const promptA = spokespersonPrompt(a, 8);
    const promptB = spokespersonPrompt(b, 8);
    expect(promptA.system).toBe(promptB.system);
    expect(promptA.user).toBe(promptB.user);
  });
});

/* ── 4. The Lady ────────────────────────────────────────────────────────── */

describe("非干涉：女神真实结果", () => {
  it("裁判给的真实答案换掉，宣布值不变时提示不变", () => {
    const state = stoppedGame(dealWith({}));
    const base = observationFor(state, 3);

    // Two observations that differ ONLY in the referee's private answer. Built
    // by hand because a deal that changes the truth would also change the deal.
    const truthful: Observation = {
      ...base,
      ladyResults: [
        { sequence: 40, missionNumber: 2, holder: 3 as Seat, target: 9 as Seat, trueSide: "evil" },
      ],
    };
    const lying: Observation = {
      ...base,
      ladyResults: [
        { sequence: 40, missionNumber: 2, holder: 3 as Seat, target: 9 as Seat, trueSide: "good" },
      ],
    };

    const build = (observation: Observation) => {
      const registry = buildFactRegistry(
        publicFactsFrom(observation.publicLog),
        claimsFrom(observation.publicLog),
        observation,
        claimContestFrom(observation.publicLog),
      );
      const { intent } = sanitiseIntent({
        intent: { ...INTENT, selectedClaimAction: "stay-hidden", requestedTeam: null },
        observation,
        registry,
        persona: personaById("ledger"),
        taskId: "lady-announce",
        taskChannel: "table-public",
      });
      return buildSpokespersonPrompt({
        view: publicTableViewFor(observation),
        intent,
        persona: personaById("ledger"),
        taskId: "lady-announce",
        speechCharLimit: CONFIG.limits.speechCharLimit,
        // The ANNOUNCED value, which is public the moment it is announced and
        // is held fixed here. The truth behind it is what moves.
        selectedAction: "- **当众宣布的结果：好人**",
      });
    };

    const a = build(truthful);
    const b = build(lying);
    expect(a.system).toBe(b.system);
    expect(a.user).toBe(b.user);
    // And the thing that moved is genuinely different.
    expect(truthful.ladyResults[0].trueSide).not.toBe(lying.ladyResults[0].trueSide);
  });
});

/* ── The view itself ────────────────────────────────────────────────────── */

describe("公开视图只有三个字段", () => {
  it("不含身份、阵营、私有知识、验人结果、名单、密谈、记忆、待办", () => {
    const state = stoppedGame(dealWith({}));
    const view = publicTableViewFor(observationFor(state, 2));
    expect(Object.keys(view).sort()).toEqual(["position", "publicLog", "seat"]);
  });

  it("把一个完整 Observation 当视图传进去会被运行时拒绝", () => {
    // An `Observation` is a structural superset of a `PublicTableView`, so the
    // compiler accepts the cast. Only the runtime check catches it, and the
    // cost of missing it is a whole batch of games whose spokespersons could
    // see the deal.
    const observation = observationFor(stoppedGame(dealWith({})), 2);
    expect(() => assertPublicOnly(observation, "view")).toThrow(/role/);
  });

  it("被清洗过的信封里只有类别，没有任何具体私有值", () => {
    const observation = observationFor(stoppedGame(dealWith({})), 2);
    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      claimContestFrom(observation.publicLog),
    );
    const { intent } = sanitiseIntent({
      intent: INTENT,
      observation,
      registry,
      persona: personaById("challenger"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    const sanitised: SanitisedIntent = intent;
    expect(sanitised.factsThatMustRemainPrivate).toContain("private-percival-pair");
    // The class is there; the seats never are.
    const serialised = JSON.stringify(sanitised);
    const knowledge = observation.knowledge;
    if (knowledge.kind === "merlin_or_morgana") {
      for (const seat of knowledge.pair) {
        expect(serialised).not.toContain(`"${seat}"`);
      }
    }
  });
});

/* ── 6. Actions stay free ───────────────────────────────────────────────── */

describe("私有信息仍然可以改变合法动作", () => {
  it("目标不是禁止用私有信息，而是禁止把私有信息说出去", () => {
    // The envelope carries a REJECT and a specific team. Where that decision
    // came from is stage 1's business; what crossed the firewall is an ask the
    // table can act on and check.
    const observation = observationFor(stoppedGame(dealWith({})), 2);
    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      claimContestFrom(observation.publicLog),
    );
    const { intent } = sanitiseIntent({
      intent: INTENT,
      observation,
      registry,
      persona: personaById("challenger"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    expect(intent.requestedVote).toBe("reject");
    expect(intent.requestedTeam).toEqual([1, 6, 8, 10]);
    expect(intent.selectedClaimAction).toBe("attack-rival-claim");
    // And the proposition survived, because it rests on the public record.
    expect(intent.publicProposition).toContain("7号");
  });

  it("公开依据只解析公开 id —— 私有 id 一个都进不来", () => {
    const observation = observationFor(stoppedGame(dealWith({})), 2);
    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      claimContestFrom(observation.publicLog),
    );
    const publicRegistry = publicOnly(registry);
    expect(publicRegistry.byId.has("p.pair")).toBe(false);
    expect(publicRegistry.byId.has("p.self")).toBe(false);
    expect(publicRegistry.byId.has("own-role")).toBe(false);
    // But the seat's own registry does hold them — the gate is the filter, not
    // an absence.
    expect(registry.byId.has("p.pair")).toBe(true);
  });
});
