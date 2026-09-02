import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { llmAgent, DisclosureInvalidError, type CognitionReport } from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import { dealFromAssignment, type Deal } from "../core/deal";
import { isPrivateType, type PublicEvent } from "../core/events";
import { observationFor } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import type { GameState } from "../core/state";
import { SEATS, type Action, type Seat } from "../core/types";
import { REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import type { ModelAttempt } from "../model/attempt";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { checkInvariants } from "../fixtures/invariants";
import { CognitionStore } from "./store";
import { disclosureClient, isSpokespersonRequest } from "./scripted-cognitive-client";
import { findDisclosures, protectedSecretsFor } from "./secrets";
import { taskHasPublicMessage } from "./firewall";
import type { ModelRequest } from "../model/client";

/**
 * The two-stage turn, end to end, through the real agent.
 *
 * Everything else in this milestone tests a piece. This runs whole games on the
 * `prompt-0.5.0` path with a scripted model on both legs, and asks the
 * questions that only the assembled thing can answer:
 *
 *   does the ACTION still come from stage 1, byte for byte, when stage 2 says
 *   something completely different?
 *   does a leaking planner produce a clean public log?
 *   does a leaking spokesperson get refused, retried on the identical prompt,
 *   and then stop the game rather than publish?
 *   do the phase and channel rules hold for every task, not just for speech?
 *
 * OFFLINE. The client is a double; `fetch` throws.
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

/** Merlin and Mordred trade places, so seat 2's Percival pair is exactly {7, 9}. */
function pairSevenNine(): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, 1: "mordred", 9: "merlin" });
}

interface RunResult {
  readonly state: GameState;
  readonly attempts: readonly ModelAttempt[];
  readonly reports: readonly CognitionReport[];
  readonly spokespersonPrompts: readonly ModelRequest[];
  readonly actions: readonly { readonly seat: Seat; readonly action: Action }[];
  readonly error: unknown;
}

/**
 * Play a `prompt-0.5.0` game with the two-stage agent.
 *
 * Built here rather than through `runGame` so the test can stop early and keep
 * everything the run produced. A helper that threw away the attempts on failure
 * would make the terminal-state test unable to say what happened.
 */
async function play(options: {
  readonly deal: Deal;
  readonly client: ReturnType<typeof disclosureClient>;
  readonly spokespersonPrompts?: ModelRequest[];
  readonly maxActions?: number;
}): Promise<RunResult> {
  const state = createGame({ seed: 3, config: CONFIG, deal: options.deal });
  const personas = assignPersonas(3, "heterogeneous-rotated");
  const store = new CognitionStore();
  const attempts: ModelAttempt[] = [];
  const reports: CognitionReport[] = [];
  const actions: { seat: Seat; action: Action }[] = [];

  const agents = {} as Record<Seat, Agent>;
  for (const seat of SEATS) {
    agents[seat] = llmAgent(seat, {
      client: options.client,
      persona: personaById(personas[seat].id),
      strategy: strategyById("expert-disclosure-safe"),
      config: CONFIG,
      onAttempt: (a) => attempts.push(a),
      cognition: { store, onCognition: (r) => reports.push(r) },
    });
  }

  let error: unknown = null;
  const limit = options.maxActions ?? 40;
  try {
    while (state.pending && actions.length < limit) {
      const seat = state.pending.seat;
      const observation = observationFor(state, seat);
      const action = await agents[seat].act(observation);
      actions.push({ seat, action });
      applyAction(state, seat, action);
    }
  } catch (caught) {
    error = caught;
  }

  return {
    state,
    attempts,
    reports,
    spokespersonPrompts: options.spokespersonPrompts ?? [],
    actions,
    error,
  };
}

/* ── The split holds ────────────────────────────────────────────────────── */

describe("两阶段：动作归规划者，措辞归发言者", () => {
  it("一个说话回合发两次请求，一次规划一次措辞", async () => {
    const result = await play({
      deal: pairSevenNine(),
      client: disclosureClient(),
      maxActions: 400,
    });
    expect(result.error).toBeNull();

    const planner = result.attempts.filter((a) => !a.taskId.endsWith("#say"));
    const say = result.attempts.filter((a) => a.taskId.endsWith("#say"));
    expect(say.length).toBeGreaterThan(0);
    // Exactly one wording request per speaking decision, and none for the rest.
    const speaking = planner.filter((a) => taskHasPublicMessage(a.taskId));
    expect(say).toHaveLength(speaking.length);
    // A vote never spends a second request.
    expect(planner.some((a) => a.taskId === "vote")).toBe(true);
    expect(say.some((a) => a.taskId.startsWith("vote"))).toBe(false);
  });

  it("发言者说什么都改不了已经定下来的动作", async () => {
    // The double's spokesperson always writes the same sentence, and it names
    // no team and no vote. The proposals and votes still come out legal and
    // varied, because they were chosen upstream.
    const result = await play({
      deal: pairSevenNine(),
      client: disclosureClient(),
      maxActions: 400,
    });
    expect(result.error).toBeNull();
    // Ran to the end, so the invariants are checked on a finished game rather
    // than on a position the referee is still in the middle of.
    expect(result.state.pending).toBeNull();
    const proposals = result.actions.filter((a) => a.action.kind === "leader_close_and_propose");
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      if (p.action.kind !== "leader_close_and_propose") continue;
      expect(new Set(p.action.team).size).toBe(p.action.team.length);
    }
    // And the referee accepted the whole run.
    expect(checkInvariants(result.state).length).toBe(0);
  });

  it("发言者的提示里没有身份层、没有私有信息层、没有推理记录", async () => {
    const prompts: ModelRequest[] = [];
    await play({
      deal: pairSevenNine(),
      client: disclosureClient({ onSpokespersonRequest: (r) => prompts.push(r) }),
      spokespersonPrompts: prompts,
      maxActions: 12,
    });
    expect(prompts.length).toBeGreaterThan(0);
    for (const request of prompts) {
      const whole = `${request.system}\n${request.user}`;
      expect(whole).not.toContain("## 三、你的身份");
      expect(whole).not.toContain("只有你知道的硬信息");
      expect(whole).not.toContain("你自己的推理记录");
      expect(whole).not.toContain("你手上哪些东西不能进公开发言");
      expect(whole).not.toContain("p.pair");
      expect(whole).not.toContain("p.self");
      // The wording schema has exactly one field.
      expect(Object.keys((request.format.schema as { properties: object }).properties)).toEqual([
        "publicMessage",
      ]);
    }
  });

  it("规划者的提示里这些层全都在 —— 否则上一个测试是空的", async () => {
    const planner: ModelRequest[] = [];
    await play({
      deal: pairSevenNine(),
      client: disclosureClient({
        onRequest: (r) => {
          if (!isSpokespersonRequest(r)) planner.push(r);
        },
      }),
      maxActions: 6,
    });
    const whole = `${planner[0].system}\n${planner[0].user}`;
    expect(whole).toContain("## 三、你的身份");
    expect(whole).toContain("只有你知道的硬信息");
    expect(whole).toContain("你手上哪些东西不能进公开发言");
    expect(whole).toContain("私有信息可以决定动作，但不能被抄进公开发言");
  });
});

/* ── J. The completed failure, as a regression ──────────────────────────── */

describe("M5.2 seq 45 的回归", () => {
  it("规划者可以私下得出「7、9」并据此反对，公开发言里一个字都没有", async () => {
    // The seat that leaked in the pilot was the true Percival with pair {7, 9}.
    // Here its planner actively tries to publish exactly that, in every text
    // field of the envelope and through `p.pair` as a public basis.
    const prompts: ModelRequest[] = [];
    const result = await play({
      deal: pairSevenNine(),
      client: disclosureClient({
        leakingPlannerSeats: [2],
        claimSeats: [2],
        onSpokespersonRequest: (r) => prompts.push(r),
      }),
      maxActions: 30,
    });
    expect(result.error).toBeNull();

    // Nothing in the public log carries the pair.
    const speeches = result.state.log.filter(
      (e): e is Extract<PublicEvent, { type: "speech" }> => e.type === "speech",
    );
    expect(speeches.length).toBeGreaterThan(0);
    const secrets = protectedSecretsFor(observationFor(result.state, 2));
    expect(secrets.percivalPair).toEqual([7, 9]);
    for (const speech of speeches) {
      expect(
        findDisclosures(speech.publicMessage, secrets, {
          isLadyAnnouncement: false,
          isEvilCouncil: false,
          publicLog: result.state.log,
        }),
      ).toEqual([]);
      expect(speech.publicMessage).not.toContain("一梅林一莫甘娜");
      expect(speech.publicMessage).not.toContain("p.pair");
    }

    // The seat still claimed Percival — the action was never taken away.
    expect(speeches.some((s) => s.speaker === 2 && s.claim === "percival")).toBe(true);

    // And the firewall recorded every attempt rather than handling it silently.
    const mine = result.reports.filter((r) => r.seat === 2 && r.disclosure !== null);
    expect(mine.length).toBeGreaterThan(0);
    const anyRedaction = mine.some((r) => (r.disclosure?.redactedFields.length ?? 0) > 0);
    expect(anyRedaction).toBe(true);
    const leaked = mine.flatMap((r) => r.disclosure?.plannerLeakClasses ?? []);
    expect(leaked).toContain("private-percival-pair");
    // `p.pair` and `p.self` were both refused as public bases.
    expect(mine.some((r) => (r.disclosure?.rejectedBasisIds ?? 0) >= 2)).toBe(true);
  });

  it("被抹掉的那一段没有以任何形式到达发言者", async () => {
    const prompts: ModelRequest[] = [];
    await play({
      deal: pairSevenNine(),
      client: disclosureClient({
        leakingPlannerSeats: [2],
        onSpokespersonRequest: (r) => prompts.push(r),
      }),
      maxActions: 20,
    });
    for (const request of prompts) {
      const whole = `${request.system}\n${request.user}`;
      expect(whole).not.toContain("一梅林一莫甘娜");
      expect(whole).not.toContain("p.pair");
    }
    // At least one prompt shows the redaction marker, which is what the
    // spokesperson is told to ignore rather than reconstruct.
    expect(prompts.some((r) => r.user.includes("已被系统整段移除"))).toBe(true);
  });
});

/* ── G. The message gate is terminal, not lenient ───────────────────────── */

describe("发言者自己泄露时", () => {
  it("句子不进公开日志，重试用的是一模一样的提示，然后停下", async () => {
    const prompts: ModelRequest[] = [];
    const result = await play({
      deal: pairSevenNine(),
      client: disclosureClient({
        leakingSpokespersonSeats: [2],
        onSpokespersonRequest: (r) => prompts.push(r),
      }),
      maxActions: 30,
    });

    expect(result.error).toBeInstanceOf(DisclosureInvalidError);
    const error = result.error as DisclosureInvalidError;
    expect(error.seat).toBe(2);
    // One initial try plus `maxPublicMessageRepairs` retries.
    expect(error.attempts).toBe(CONFIG.stages.maxPublicMessageRepairs + 1);

    // The offending sentence never became an event.
    for (const event of result.state.log) {
      if (event.type !== "speech") continue;
      expect(event.publicMessage).not.toContain("一梅林一莫甘娜");
    }

    // The retry is byte-identical. Nothing about the request was wrong, and a
    // repair note quoting the rejected sentence would be handing the model the
    // secret it just tried to publish.
    const forSeatTwo = prompts.filter((r) => /## 你是 2号的发言/.test(r.user));
    expect(forSeatTwo.length).toBe(CONFIG.stages.maxPublicMessageRepairs + 1);
    expect(forSeatTwo[0].user).toBe(forSeatTwo[1].user);
    expect(forSeatTwo[0].system).toBe(forSeatTwo[1].system);
    for (const request of forSeatTwo) {
      expect(request.user).not.toContain("一梅林一莫甘娜");
      expect(request.user).not.toContain("被拦下");
    }
  });
});

/* ── I. Phase and channel ───────────────────────────────────────────────── */

describe("解密只能来自合法动作与允许的阶段", () => {
  it("整局跑完，公开日志里没有任何座位的私有信息", async () => {
    const deal = pairSevenNine();
    const result = await play({ deal, client: disclosureClient(), maxActions: 200 });
    expect(result.error).toBeNull();

    // Every seat, against its own secrets, over the whole public log.
    for (const seat of SEATS) {
      const secrets = protectedSecretsFor(observationFor(result.state, seat));
      for (const event of result.state.log) {
        if (event.type !== "speech") continue;
        if (event.speaker !== seat) continue;
        expect(
          findDisclosures(event.publicMessage, secrets, {
            isLadyAnnouncement: false,
            isEvilCouncil: false,
            publicLog: result.state.log,
          }),
          `${seat}号 seq ${event.sequence}`,
        ).toEqual([]);
      }
    }
  });

  it("私有事件一条都没进公开日志", async () => {
    const result = await play({ deal: pairSevenNine(), client: disclosureClient(), maxActions: 200 });
    for (const event of result.state.log) {
      expect(isPrivateType(event.type)).toBe(false);
    }
  });

  it("每一个会说话的任务都走了两阶段，不会说话的一个都没走", async () => {
    const result = await play({ deal: pairSevenNine(), client: disclosureClient(), maxActions: 200 });
    const byTask = new Map<string, { planner: number; say: number }>();
    for (const attempt of result.attempts) {
      const base = attempt.taskId.replace(/#say$/, "");
      const entry = byTask.get(base) ?? { planner: 0, say: 0 };
      if (attempt.taskId.endsWith("#say")) entry.say += 1;
      else entry.planner += 1;
      byTask.set(base, entry);
    }
    for (const [task, counts] of byTask) {
      if (taskHasPublicMessage(task)) {
        expect(counts.say, task).toBe(counts.planner);
      } else {
        expect(counts.say, task).toBe(0);
      }
    }
    // The run really did reach the tasks with no message.
    expect(byTask.has("vote")).toBe(true);
  });

  it("坏人密谈走的是 evil-council 频道，字段名也不一样", async () => {
    const prompts: ModelRequest[] = [];
    const result = await play({
      deal: pairSevenNine(),
      client: disclosureClient({ onSpokespersonRequest: (r) => prompts.push(r) }),
      maxActions: 400,
    });
    const council = prompts.filter((r) => r.format.name.includes("evil_discuss"));
    if (council.length > 0) {
      for (const request of council) {
        expect(request.system).toContain("坏人密谈");
        expect(
          Object.keys((request.format.schema as { properties: object }).properties),
        ).toEqual(["message"]);
      }
    } else {
      // Evil won on missions, so the assassination phase never opened. Recorded
      // rather than silently skipped: a test that quietly asserts nothing is
      // worse than one that says which branch it took.
      expect(result.state.outcome?.reason).toBe("missions_evil");
    }
  });
});
