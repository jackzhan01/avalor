import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor, type Observation } from "../core/observation";
import type { GameState } from "../core/state";
import type { Seat } from "../core/types";
import { drive, REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import { personaById } from "../prompts/personas";
import {
  ALL_SECRET_CLASSES,
  classifyEntry,
  classifyFactId,
  reachesTablePublic,
  strongestOf,
  strongestSecret,
} from "./classification";
import {
  REDACTED,
  channelForTask,
  disclosureContextFor,
  messageFieldFor,
  publicOnly,
  sanitiseIntent,
  taskHasPublicMessage,
  validatePublicMessage,
} from "./firewall";
import { buildFactRegistry, PRIVATE_IDS } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { claimsFrom, publicFactsFrom } from "./ledger";
import type { CommunicationIntent } from "./intent";
import { findDisclosures, protectedSecretsFor, seatsNamedIn } from "./secrets";
import { buildSpokespersonPrompt, publicTableViewFor } from "./spokesperson";

/**
 * The firewall, from three directions.
 *
 *   THE CLASSIFICATION is right, including what it does with a derived
 *   conclusion whose premises disagree.
 *   THE ADVERSARIAL PLANNER cannot get a secret across, whichever field it
 *   puts it in.
 *   THE DETECTOR catches the three sentences the milestone names, and does NOT
 *   catch an ordinary public inference that happens to mention the same seats.
 *
 * That last one is half the work. A filter that refuses 「6、7、9 里可能有莫甘娜」
 * would be safe and useless: it would delete the reasoning the whole simulator
 * exists to study, and it would do it silently.
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
  experiment: { personaMode: "heterogeneous-rotated", strategyProfile: "expert-disclosure-safe" },
});

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

function stoppedGame(deal: Deal = dealWith({})): GameState {
  return drive({ seed: 7, deal, config: CONFIG, stopWhen: (s) => s.log.length >= 12 }).state;
}

function registryFor(observation: Observation) {
  return buildFactRegistry(
    publicFactsFrom(observation.publicLog),
    claimsFrom(observation.publicLog),
    observation,
    claimContestFrom(observation.publicLog),
  );
}

const BASE_INTENT: CommunicationIntent = {
  channel: "table-public",
  publicGoal: "换掉这辆车",
  targetSeats: [7],
  selectedClaimAction: "attack-rival-claim",
  requestedTeam: [1, 6, 8, 10],
  requestedVote: "reject",
  publicBasisIds: [],
  publicProposition: "7号 三次要车都把自己放进去，没解释过为什么",
  desiredTableEffect: "投反对，改带 1、6、8、10",
};

/* ── E. Classification ──────────────────────────────────────────────────── */

describe("信息分级由系统拥有", () => {
  it("公开事实、推导事实、说法、派权事件都是牌桌公开", () => {
    for (const kind of ["public-fact", "derived-fact", "claim", "contest-event"] as const) {
      expect(classifyEntry(3, "f12", kind).channel).toBe("table-public");
      expect(classifyEntry(3, "f12", kind).secretClass).toBeNull();
    }
  });

  it("候选对永远不能被任何动作解密，身份可以", () => {
    const pair = classifyEntry(3, PRIVATE_IDS.percivalPair, "private-fact");
    expect(pair.channel).toBe("seat-private");
    expect(pair.secretClass).toBe("private-percival-pair");
    expect(pair.declassification.permitted).toBe(false);

    const self = classifyEntry(3, PRIVATE_IDS.self, "private-fact");
    expect(self.secretClass).toBe("private-role");
    expect(self.declassification.permitted).toBe(true);
    expect(self.declassification.viaAction).toBe("speech.claim");
    // And what it publishes is a CLAIM, not the content of anything private.
    expect(self.declassification.publishes).toContain("声称");
  });

  it("女神结果是阶段解密：只有 lady_announce，而且只公开宣布的值", () => {
    const lady = classifyEntry(3, "p.lady2", "private-fact");
    expect(lady.channel).toBe("phase-authorised");
    expect(lady.declassification.viaAction).toBe("lady_announce");
    expect(lady.authorisedPhases).toEqual(["lady_announce"]);
    expect(reachesTablePublic(lady, "lady_announce")).toBe(true);
    expect(reachesTablePublic(lady, "discussion")).toBe(false);
    expect(lady.declassification.publishes).toContain("可以是假的");
  });

  it("队友名单是坏人密谈频道，而且只在刺杀阶段", () => {
    const roster = classifyEntry(3, PRIVATE_IDS.teammates, "private-fact");
    expect(roster.channel).toBe("evil-council");
    expect(roster.authorisedSide).toBe("evil");
    expect(roster.authorisedPhases).toContain("assassination_discuss");
    expect(reachesTablePublic(roster, "assassination_discuss")).toBe(false);
  });

  it("查不到的 id 一律按最私有处理，而不是按不存在处理", () => {
    const observation = observationFor(stoppedGame(), 2);
    const c = classifyFactId(registryFor(observation), "f_totally_made_up");
    expect(c.channel).toBe("seat-private");
    expect(c.authorisedSeats).toEqual([]);
    expect(c.declassification.permitted).toBe(false);
  });

  it("推导结论继承前提里最强的那一条隐私", () => {
    const publicFact = classifyEntry(3, "f12", "public-fact");
    const pair = classifyEntry(3, PRIVATE_IDS.percivalPair, "private-fact");
    const merged = strongestOf([publicFact, pair]);
    expect(merged.channel).toBe("seat-private");
    expect(merged.secretClass).toBe("private-percival-pair");
    // A declassifiable premise plus a permanent secret is a permanent secret.
    const self = classifyEntry(3, PRIVATE_IDS.self, "private-fact");
    expect(strongestOf([self, pair]).declassification.permitted).toBe(false);
  });

  it("没有前提的结论是公开的 —— 这是正确的默认，也是危险的那个", () => {
    expect(strongestOf([]).channel).toBe("table-public");
  });

  it("秘密类别有全序，候选对排在最强", () => {
    expect(strongestSecret(["private-cognition", "private-percival-pair"])).toBe(
      "private-percival-pair",
    );
    expect(strongestSecret([null, null])).toBeNull();
    expect(ALL_SECRET_CLASSES).toHaveLength(7);
  });
});

/* ── Seat extraction ────────────────────────────────────────────────────── */

describe("从中文里读出座位号", () => {
  it("认得 N号、顿号列表、以及压缩的连号", () => {
    expect(seatsNamedIn("7号和9号")).toEqual([7, 9]);
    expect(seatsNamedIn("7、9")).toEqual([7, 9]);
    expect(seatsNamedIn("57910")).toEqual([5, 7, 9, 10]);
    expect(seatsNamedIn("16810")).toEqual([1, 6, 8, 10]);
    expect(seatsNamedIn("10号")).toEqual([10]);
  });
});

/* ── G + J. The detector ────────────────────────────────────────────────── */

describe("防泄露检测器", () => {
  const secrets = {
    seat: 8 as Seat,
    role: "percival" as RoleType,
    percivalPair: [7, 9] as readonly Seat[],
    merlinVision: [] as readonly Seat[],
    knownTeammates: [] as readonly Seat[],
    evilRoster: [] as readonly Seat[],
    ladyTruths: [],
  };
  const context = { isLadyAnnouncement: false, isEvilCouncil: false, publicLog: [] };

  it("拦下里程碑点名的那三句", () => {
    for (const sentence of [
      "7、9一梅林一莫甘娜",
      "我的两个候选是7号和9号",
      "7、9中必有莫甘娜，所以这车必坏",
    ]) {
      const found = findDisclosures(sentence, secrets, context);
      expect(found.length, sentence).toBeGreaterThan(0);
      expect(found[0].secretClass).toBe("private-percival-pair");
    }
  });

  it("拦下实盘里真的说出去的那句", () => {
    // The M5.2 pilot, seat 8, sequences 45 and 58.
    const real = "7、9一梅林一莫甘娜，57910必有坏人；0:2不能赌，我反对，建议16810。";
    const found = findDisclosures(real, secrets, context);
    expect(found.some((d) => d.secretClass === "private-percival-pair")).toBe(true);
  });

  it("放行一句只靠公开记录的、要求同一个动作的话", () => {
    // Structurally what the milestone says an acceptable public result looks
    // like: same vote, same alternative team, no private value anywhere.
    const safe =
      "7号一直用派身份推动自己进入关键车，却没有给出可以由任务和票型验证的候选逻辑。" +
      "现在0:2，57910缺少足够公开安全依据，我反对，建议16810。";
    expect(findDisclosures(safe, secrets, context)).toEqual([]);
  });

  it("放行一个提到同样两个座位、但没有断言那一对结构的三人推论", () => {
    // Over-refusing this would delete ordinary public reasoning. It names 7 and
    // 9, mentions Morgana, and is not a disclosure — the clause names three.
    const ordinary = "第二轮挂的车里 6、7、9 都在，所以这三个人里至少有一个莫甘娜级别的坏人。";
    expect(findDisclosures(ordinary, secrets, context)).toEqual([]);
  });

  it("放行一个只点了其中一个候选的踩人发言", () => {
    expect(findDisclosures("我踩 7号，他的车和票对不上。", secrets, context)).toEqual([]);
  });

  it("拦下私有事实 id 和认知 schema 字段名", () => {
    expect(findDisclosures("按 [p.pair] 我反对", secrets, context)[0].rule).toBe(
      "private-fact-id",
    );
    expect(
      findDisclosures("我的 rivalPlans 里写了要打 7号", secrets, context)[0].secretClass,
    ).toBe("private-cognition");
  });

  it("梅林完整视野被当成已知说出来会被拦下，当成推理不会", () => {
    const merlin = { ...secrets, role: "merlin" as RoleType, percivalPair: [], merlinVision: [7, 8, 10] as readonly Seat[] };
    expect(
      findDisclosures("我知道 7、8、10 都是坏人。", merlin, context).length,
    ).toBeGreaterThan(0);
    // The same three seats, framed as an inference from the public record.
    expect(
      findDisclosures("两辆挂掉的车交集是 7、8、10，我倾向避开他们。", merlin, context),
    ).toEqual([]);
  });

  it("坏人点自己的队友会被拦下，刺杀密谈里不会", () => {
    const evil = {
      ...secrets,
      role: "assassin" as RoleType,
      percivalPair: [],
      knownTeammates: [7, 9] as readonly Seat[],
    };
    expect(findDisclosures("7、9 是我的队友", evil, context).length).toBeGreaterThan(0);
    expect(
      findDisclosures("7、9 是我的队友", evil, { ...context, isEvilCouncil: true }),
    ).toEqual([]);
  });
});

/* ── H.5. The adversarial planner ───────────────────────────────────────── */

describe("对抗性规划者：往每一个信封字段里塞私有信息", () => {
  /**
   * A planner that is actively trying to publish. Not a hypothetical: the
   * envelope is model-written, so "what if it puts the pair in `publicGoal`"
   * is a thing that will happen the first time a game runs long enough.
   */
  function attack(observation: Observation, payload: string): CommunicationIntent {
    return {
      ...BASE_INTENT,
      publicGoal: payload,
      publicProposition: payload,
      desiredTableEffect: payload,
      publicBasisIds: [PRIVATE_IDS.percivalPair, PRIVATE_IDS.self, "own-role", "f_invented"],
    };
  }

  const PAYLOADS = [
    "7、9一梅林一莫甘娜",
    "我的两个候选是7号和9号",
    "看 [p.pair]，7、9 二选一",
    "我的 hypotheses 里 7号 是莫甘娜",
  ];

  it("每一种载荷都在发言者提示建起来之前被整段抹掉", () => {
    // Seat 2 is Percival with pair {1, 7} in the reference deal; the payloads
    // name 7 and 9, so build a deal whose pair really is {7, 9}.
    // Merlin and Mordred trade places, so seat 2's pair really is {7, 9}. The
    // ten-player line-up stays legal — `dealFromAssignment` checks it.
    const deal = dealWith({ 1: "mordred", 9: "merlin" });
    const state = stoppedGame(deal);
    const observation = observationFor(state, 2);
    expect(protectedSecretsFor(observation).percivalPair).toEqual([7, 9]);

    for (const payload of PAYLOADS) {
      const { intent, audit } = sanitiseIntent({
        intent: attack(observation, payload),
        observation,
        registry: registryFor(observation),
        persona: personaById("challenger"),
        taskId: "speech-regular",
        taskChannel: "table-public",
      });

      expect(intent.publicGoal, payload).toBe(REDACTED);
      expect(intent.publicProposition, payload).toBe(REDACTED);
      expect(intent.desiredTableEffect, payload).toBe(REDACTED);
      expect(audit.redactedFields.map((r) => r.what).sort()).toEqual([
        "desiredTableEffect",
        "publicGoal",
        "publicProposition",
      ]);

      const built = buildSpokespersonPrompt({
        view: publicTableViewFor(observation),
        intent,
        persona: personaById("challenger"),
        taskId: "speech-regular",
        speechCharLimit: CONFIG.limits.speechCharLimit,
        selectedAction: "",
      });
      const whole = `${built.system}\n${built.user}`;
      expect(whole, payload).not.toContain(payload);
      expect(whole).not.toContain("一梅林一莫甘娜");
      expect(whole).not.toContain("p.pair");
    }
  });

  it("私有的、编造的、越权的 id 一个都过不去，而且都被记下来了", () => {
    const observation = observationFor(stoppedGame(), 2);
    const { intent, audit } = sanitiseIntent({
      intent: {
        ...BASE_INTENT,
        publicBasisIds: [PRIVATE_IDS.percivalPair, PRIVATE_IDS.self, "own-role", "f_invented"],
      },
      observation,
      registry: registryFor(observation),
      persona: personaById("challenger"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    expect(intent.publicBasisIds).toEqual([]);
    expect(audit.rejectedBasisIds).toHaveLength(4);
    // The two kinds of failure are described differently, because they are.
    expect(audit.rejectedBasisIds.find((r) => r.what === "p.pair")?.secretClass).toBe(
      "private-percival-pair",
    );
    expect(audit.rejectedBasisIds.find((r) => r.what === "f_invented")?.reason).toContain(
      "查不到",
    );
  });

  it("真实的公开 id 照常通过，并且带着它的公开标签", () => {
    const observation = observationFor(stoppedGame(), 2);
    const registry = registryFor(observation);
    const firstPublic = publicOnly(registry).entries[0];
    const { intent, audit } = sanitiseIntent({
      intent: { ...BASE_INTENT, publicBasisIds: [firstPublic.id] },
      observation,
      registry,
      persona: personaById("challenger"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    expect(intent.publicBasisIds).toEqual([firstPublic.id]);
    expect(intent.publicBasis[0].label).toBe(firstPublic.label);
    expect(audit.rejectedBasisIds).toEqual([]);
  });

  it("规划者声明的频道不作数 —— 频道由任务决定", () => {
    const observation = observationFor(stoppedGame(), 2);
    const { intent, audit } = sanitiseIntent({
      intent: { ...BASE_INTENT, channel: "evil-council" },
      observation,
      registry: registryFor(observation),
      persona: personaById("challenger"),
      taskId: "speech-regular",
      taskChannel: "table-public",
    });
    expect(intent.channel).toBe("table-public");
    expect(audit.channelCorrected).toBe(true);
  });
});

/* ── The task table ─────────────────────────────────────────────────────── */

describe("哪些任务有公开发言、走哪个频道", () => {
  it("有话说的六个任务走两阶段，没话说的四个不走", () => {
    for (const id of [
      "opening-direction",
      "speech-opening",
      "speech-regular",
      "leader-close-and-propose",
      "lady-announce",
      "evil-discuss",
    ]) {
      expect(taskHasPublicMessage(id), id).toBe(true);
    }
    for (const id of ["vote", "mission-card", "lady-select", "assassinate"]) {
      expect(taskHasPublicMessage(id), id).toBe(false);
    }
  });

  it("只有坏人密谈走 evil-council，字段名也跟着变", () => {
    expect(channelForTask("evil-discuss")).toBe("evil-council");
    expect(channelForTask("speech-regular")).toBe("table-public");
    expect(messageFieldFor("evil-discuss")).toBe("message");
    expect(messageFieldFor("speech-regular")).toBe("publicMessage");
  });

  it("只有 lady-announce 这一个任务把阶段闸打开", () => {
    const observation = observationFor(stoppedGame(), 2);
    expect(disclosureContextFor(observation, "lady-announce").isLadyAnnouncement).toBe(true);
    expect(disclosureContextFor(observation, "speech-regular").isLadyAnnouncement).toBe(false);
  });
});

/* ── The final gate ─────────────────────────────────────────────────────── */

describe("成句之后的最后一道闸", () => {
  it("对任何路径产出的句子都生效，不只是发言者产出的", () => {
    const deal = dealWith({ 1: "mordred", 9: "merlin" });
    const observation = observationFor(stoppedGame(deal), 2);
    const bad = validatePublicMessage({
      message: "7、9一梅林一莫甘娜，别让他们同车。",
      observation,
      taskId: "speech-regular",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.disclosures[0].secretClass).toBe("private-percival-pair");

    const good = validatePublicMessage({
      message: "7号 到现在没解释过 R2 那辆车，我反对，建议 1、6、8、10。",
      observation,
      taskId: "speech-regular",
    });
    expect(good.ok).toBe(true);
  });
});
