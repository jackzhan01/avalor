import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor } from "../core/observation";
import type { Seat } from "../core/types";
import { drive, REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import { personaById } from "../prompts/personas";
import { applicableHeuristics, renderStrategy, strategyById } from "../prompts/strategies";
import { renderDisclosureRules } from "./disclosure";
import { buildFactRegistry } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { claimsFrom, publicFactsFrom } from "./ledger";
import { REDACTED, sanitiseIntent, validatePublicMessage } from "./firewall";
import { findDisclosures, protectedSecretsFor } from "./secrets";
import type { CommunicationIntent } from "./intent";

/**
 * A human decision, encoded: false claimants may invent and publicly state a
 * candidate-pair story.
 *
 * WHY THIS IS THE RIGHT LINE. The firewall protects a SECRET, and a seat that
 * was never handed a pair has no secret to protect. A Morgana saying 「我的候选
 * 是 3、5」 is lying in public, which is the game. Banning all two-seat stories
 * would delete a legitimate move from four roles in order to protect one, and
 * it would do it by making the ban itself the tell.
 *
 * THE ASYMMETRY IS REAL AND IS ACCEPTED. Only a seat WITHOUT a real pair can
 * publish one, so "gave a pair" is weak evidence of "not the true Percival".
 * That is handled where it belongs — in the table's own reading, via
 * `eds.pair-story-is-not-evidence` — rather than by a mechanism that would have
 * to read every seat's private state to enforce.
 *
 * COINCIDENCE IS NOT DISCLOSURE. A Morgana who guesses two seats that happen to
 * be the true Percival's pair has leaked nothing: it did not know, and nothing
 * private moved. The detector is keyed to the SPEAKER's own secrets, which is
 * what makes that fall out rather than needing a special case.
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

const CONFIG = testConfig({
  promptVersion: "prompt-0.5.0",
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: {
    personaMode: "heterogeneous-rotated",
    strategyProfile: "expert-disclosure-safe",
  },
});

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

/** Merlin and Mordred trade places, so seat 2's Percival pair is exactly {7, 9}. */
const PAIR_SEVEN_NINE = dealWith({ 1: "mordred", 9: "merlin" });

function stopped(deal: Deal) {
  return drive({ seed: 7, deal, config: CONFIG, stopWhen: (s) => s.log.length >= 12 }).state;
}

const PAIR_STORY = "我的两个候选是3号和5号，其中一个是莫甘娜。";

/* ── The invented story is legal ────────────────────────────────────────── */

describe("假声称者可以编一个候选对故事并公开讲", () => {
  it("莫甘娜讲一个自己编的候选对，闸不拦", () => {
    // Seat 7 is Morgana. It holds teammates, not a pair — so it has nothing
    // of this class to leak, and the story is a lie rather than a disclosure.
    const observation = observationFor(stopped(PAIR_SEVEN_NINE), 7);
    expect(observation.role).toBe("morgana");
    expect(protectedSecretsFor(observation).percivalPair).toEqual([]);

    const verdict = validatePublicMessage({
      message: PAIR_STORY,
      observation,
      taskId: "speech-regular",
    });
    expect(verdict.ok).toBe(true);
  });

  it("忠臣、刺客、莫德雷德、奥伯伦讲同一句，同样不拦", () => {
    const state = stopped(PAIR_SEVEN_NINE);
    // Loyal, assassin, mordred, oberon in this deal. Seat 2 is the Percival
    // and is deliberately NOT here — it is the next describe block.
    for (const seat of [3, 8, 1, 10] as Seat[]) {
      const observation = observationFor(state, seat);
      expect(protectedSecretsFor(observation).percivalPair, `${seat}`).toEqual([]);
      expect(
        validatePublicMessage({
          message: PAIR_STORY,
          observation,
          taskId: "speech-regular",
        }).ok,
        `${seat}号 ${observation.role}`,
      ).toBe(true);
    }
  });

  it("**巧合不算泄露**：没有那一对的人猜中了真实那一对，照样放行", () => {
    // The human decision, stated exactly. Seat 7 is Morgana; the true pair is
    // {7, 9}. It names 7 and 9 and asserts the pair structure — and it knows
    // nothing, so nothing private moved.
    const observation = observationFor(stopped(PAIR_SEVEN_NINE), 7);
    const coincidence = "我的两个候选是7号和9号，一梅林一莫甘娜。";
    expect(
      validatePublicMessage({ message: coincidence, observation, taskId: "speech-regular" }).ok,
    ).toBe(true);
  });

  it("信封里的候选对故事不会被抹掉 —— 它对这个座位不是秘密", () => {
    const observation = observationFor(stopped(PAIR_SEVEN_NINE), 7);
    const intent: CommunicationIntent = {
      channel: "table-public",
      publicGoal: "占住派西维尔这个位置",
      targetSeats: [],
      selectedClaimAction: "claim-percival",
      requestedTeam: null,
      requestedVote: "approve",
      publicBasisIds: [],
      publicProposition: PAIR_STORY,
      desiredTableEffect: "按我说的车投",
    };
    const { intent: sanitised, audit } = sanitiseIntent({
      intent,
      observation,
      registry: buildFactRegistry(
        publicFactsFrom(observation.publicLog),
        claimsFrom(observation.publicLog),
        observation,
        claimContestFrom(observation.publicLog),
      ),
      persona: personaById("direct"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    expect(sanitised.publicProposition).toBe(PAIR_STORY);
    expect(sanitised.publicProposition).not.toBe(REDACTED);
    expect(audit.redactedFields).toEqual([]);
  });
});

/* ── The true Percival is still blocked ─────────────────────────────────── */

describe("而真派西维尔说同一句仍然被拦", () => {
  it("真派讲自己真实的那一对 → 拦下", () => {
    const observation = observationFor(stopped(PAIR_SEVEN_NINE), 2);
    expect(observation.role).toBe("percival");
    expect(protectedSecretsFor(observation).percivalPair).toEqual([7, 9]);

    const verdict = validatePublicMessage({
      message: "我的两个候选是7号和9号，一梅林一莫甘娜。",
      observation,
      taskId: "speech-regular",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.disclosures[0].secretClass).toBe("private-percival-pair");
  });

  it("真派讲一个**编的**、不是自己那一对的故事 → 放行", () => {
    // The rule protects the VALUE, not the shape. A true Percival that lies
    // about its pair has published nothing true, and lying is legal.
    const observation = observationFor(stopped(PAIR_SEVEN_NINE), 2);
    expect(
      validatePublicMessage({ message: PAIR_STORY, observation, taskId: "speech-regular" }).ok,
    ).toBe(true);
  });

  it("同一句话，两个座位两种结果 —— 这就是「针对说话人自己的秘密」", () => {
    const state = stopped(PAIR_SEVEN_NINE);
    const sentence = "7、9一梅林一莫甘娜。";
    const truePercival = observationFor(state, 2);
    const morgana = observationFor(state, 7);
    expect(
      validatePublicMessage({ message: sentence, observation: truePercival, taskId: "speech-regular" }).ok,
    ).toBe(false);
    expect(
      validatePublicMessage({ message: sentence, observation: morgana, taskId: "speech-regular" }).ok,
    ).toBe(true);
  });

  it("检测器只看说话人自己的秘密，不看别人的", () => {
    const state = stopped(PAIR_SEVEN_NINE);
    const morgana = observationFor(state, 7);
    const secrets = protectedSecretsFor(morgana);
    // Morgana's own protected set has a roster and no pair.
    expect(secrets.percivalPair).toEqual([]);
    expect(secrets.knownTeammates.length).toBeGreaterThan(0);
    // So its own roster IS protected, in the same sentence shape.
    const roster = secrets.knownTeammates.join("、");
    expect(
      findDisclosures(`${roster} 是我的队友`, secrets, {
        isLadyAnnouncement: false,
        isEvilCouncil: false,
        publicLog: morgana.publicLog,
      }).length,
    ).toBeGreaterThan(0);
  });
});

/* ── The table-side rules survive ───────────────────────────────────────── */

describe("桌面这一侧的两条规则还在", () => {
  it("`eds.pair-story-is-not-evidence` 仍然在策略档里，而且发给每个人", () => {
    const safe = strategyById("expert-disclosure-safe");
    const entry = safe.heuristics.find((h) => h.id === "eds.pair-story-is-not-evidence");
    expect(entry).toBeDefined();
    expect(entry?.scope ?? { kind: "all" }).toEqual({ kind: "all" });
    // It says the story is not verification, and says the inference is soft.
    expect(entry?.consider).toContain("不是核实");
    expect(entry?.disputed).toBe(true);
  });

  it("「追问候选对等于替刺客提问」这条公开警告还在", () => {
    const rendered = renderStrategy(strategyById("expert-disclosure-safe"));
    expect(rendered).toContain("等于替刺客提问");
    // And in the role layer every seat reads, not only in the strategy.
    expect(renderDisclosureRules("loyal")).toContain("等于在替刺客提问");
  });

  it("两条规则每个座位都读得到，不分身份", () => {
    const state = stopped(PAIR_SEVEN_NINE);
    const safe = strategyById("expert-disclosure-safe");
    for (const seat of [1, 2, 7, 9] as Seat[]) {
      const ids = applicableHeuristics(safe, observationFor(state, seat)).map((h) => h.id);
      expect(ids, `${seat}`).toContain("eds.do-not-ask-for-the-pair");
      expect(ids, `${seat}`).toContain("eds.pair-story-is-not-evidence");
    }
  });

  it("没有一条规则全局禁止「两个座位的说法」", () => {
    // The human decision, as an assertion about the text: the profile must not
    // contain a blanket ban, only the value-specific one.
    const rendered = renderStrategy(strategyById("expert-disclosure-safe"));
    expect(rendered).not.toContain("不要讲候选对故事");
    expect(rendered).not.toContain("禁止讲候选对");
    // Morgana's own entry still names inventing one as a real line.
    expect(rendered).toContain("编错的候选对故事以后会塌");
  });
});

/* ── Invented stories are claims, never evidence ────────────────────────── */

describe("编出来的候选对故事在账本里是「说法」，不是事实", () => {
  it("公开身份声称永远解析成 claim，不会变成硬事实", () => {
    // Two seats claim Percival; the registry records the SAYING as a fact and
    // the content as a claim. An invented pair story rides on the claim.
    const state = stopped(PAIR_SEVEN_NINE);
    const observation = observationFor(state, 2);
    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      claimContestFrom(observation.publicLog),
    );
    for (const entry of registry.entries) {
      if (entry.kind !== "claim") continue;
      // A claim id never resolves as a hard premise. That is the ledger's
      // oldest invariant and it is what keeps an invented story unverified.
      expect(entry.id.startsWith("c")).toBe(true);
    }
  });

  it("身份声称本身在分级里是牌桌公开的说法，不是任何人的私有值", () => {
    const observation = observationFor(stopped(PAIR_SEVEN_NINE), 7);
    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      claimContestFrom(observation.publicLog),
    );
    // Whatever a seat says about a pair travels as a claim on the public
    // channel; nothing in the classification promotes it.
    const claimIds = registry.entries.filter((e) => e.kind === "claim");
    for (const c of claimIds) expect(c.seat).toBeNull();
  });
});
