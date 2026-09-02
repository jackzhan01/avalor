/**
 * The rejected-cognition telemetry path, end to end through `llm-agent`.
 *
 * WHAT WAS MISSING. `onCognition` fires only after every check passes, so for
 * four milestones a REFUSED attempt produced no report at all: `purposelessClaim`
 * could never be observed true, and `rejectedAmbiguity` could not count the
 * thing it was named after. The M5.5 pilot made that concrete and this file is
 * the proof it is closed.
 *
 * Every test drives the production path — strict-schema answer, canonical
 * parser, validation, fold, referee, telemetry — because the gap survived a
 * green suite built on direct calls to the checkers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { llmAgent, type CognitionReport } from "../agents/llm-agent";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import type { GameState } from "../core/state";
import { SEATS, type Seat } from "../core/types";
import { REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import { buildPublicReplay, serialisePublicReplay } from "../run/artifacts";
import {
  buildPrivateResearchTrace,
  privateTraceLines,
  type ModelCallRecord,
} from "../run/artifacts";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_M55 } from "../prompts/version";
import type { ModelRequest } from "../model/client";
import { CognitionStore } from "./store";
import { disclosureClient, isSpokespersonRequest } from "./scripted-cognitive-client";
import { claimStateFor } from "./claim-persistence";
import {
  COGNITION_REFUSAL_PREFIXES,
  refusedByCognition,
  REJECTION_CATEGORIES,
  summariseRejections,
  type CognitionRejection,
} from "./rejection";

const CONFIG = testConfig({
  promptVersion: PROMPT_VERSION_M55,
  cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  experiment: {
    personaMode: "heterogeneous-rotated",
    strategyProfile: "expert-disciplined",
  },
});

function dealWith(overrides: Partial<Record<Seat, RoleType>> = {}): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("这一套里任何请求都是 bug");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/* ── The driver ─────────────────────────────────────────────────────────── */

interface Spoken {
  readonly reports: CognitionReport[];
  readonly rejections: CognitionRejection[];
  readonly attempts: {
    readonly taskId: string;
    readonly outcome: string;
    readonly validationError?: string;
  }[];
  readonly prompts: string[];
  readonly error: unknown;
  /** Every error thrown, in order. The terminal one is the last. */
  readonly errors: string[];
  readonly applied: boolean;
  readonly store: CognitionStore;
}

/**
 * One decision, with a hand-written answer, driven through the real agent.
 *
 * `store` is threaded in so a test can ask the question that matters most for
 * a refusal: did the ledger change? A fresh store per call would make that
 * unanswerable.
 */
async function speak(input: {
  readonly state: GameState;
  readonly seat: Seat;
  readonly store: CognitionStore;
  readonly answer: (prompt: string) => Record<string, unknown>;
  readonly repairs?: number;
}): Promise<Spoken> {
  const reports: CognitionReport[] = [];
  const rejections: CognitionRejection[] = [];
  const attempts: { taskId: string; outcome: string; validationError?: string }[] = [];
  const prompts: string[] = [];
  const base = disclosureClient({});
  const client = {
    name: "hand-written",
    async complete(request: ModelRequest) {
      const response = await base.complete(request);
      if (isSpokespersonRequest(request)) return response;
      prompts.push(request.user);
      const cell = JSON.parse(response.text) as Record<string, unknown>;
      const patch = input.answer(request.user);
      // A nested `cognition` patch is MERGED rather than replacing the double's
      // block, so a test can corrupt one citation array and leave the rest of
      // a valid block intact — which is the only way to reach the evidence
      // check without tripping an earlier one.
      const cognition =
        patch.cognition && cell.cognition
          ? { ...(cell.cognition as object), ...(patch.cognition as object) }
          : (patch.cognition ?? cell.cognition);
      return {
        ...response,
        text: JSON.stringify({ ...cell, ...patch, ...(cognition ? { cognition } : {}) }),
      };
    },
  };
  const agent = llmAgent(input.seat, {
    client: client as never,
    persona: personaById(assignPersonas(3, "heterogeneous-rotated")[input.seat].id),
    strategy: strategyById("expert-disciplined"),
    config: CONFIG,
    cognition: {
      store: input.store,
      onCognition: (r) => reports.push(r),
      onRejection: (r) => rejections.push(r),
    },
    onAttempt: (a) =>
      attempts.push({
        taskId: a.taskId,
        outcome: a.outcome,
        ...(a.validationError ? { validationError: a.validationError } : {}),
      }),
  });

  let error: unknown = null;
  const errors: string[] = [];
  let applied = false;
  const repairs = input.repairs ?? 0;
  for (let attempt = 0; attempt <= repairs; attempt += 1) {
    try {
      const action = await agent.act(
        observationFor(input.state, input.seat),
        attempt === 0
          ? undefined
          : { attempt, error: error instanceof Error ? error.message : String(error) },
      );
      applyAction(input.state, input.seat, action);
      applied = true;
      error = null;
      break;
    } catch (caught) {
      error = caught;
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return { reports, rejections, attempts, prompts, error, errors, applied, store: input.store };
}

/** Play on until `seat` is asked to speak again. */
async function runUntilSpeechBy(
  state: GameState,
  seat: Seat,
  store: CognitionStore,
): Promise<void> {
  let guard = 0;
  while (state.pending && guard < 200) {
    if (state.pending.seat === seat && state.pending.kind === "speech") return;
    await speak({ state, seat: state.pending.seat, store, answer: () => ({}) });
    guard += 1;
  }
}

/** A game where `seat` stands on a Percival claim and can speak again. */
async function standingClaim(): Promise<{
  state: GameState;
  seat: Seat;
  store: CognitionStore;
}> {
  const store = new CognitionStore();
  const state = createGame({ seed: 3, config: CONFIG, deal: dealWith() });
  while (state.pending && state.pending.kind !== "speech") {
    await speak({ state, seat: state.pending.seat, store, answer: () => ({}) });
  }
  const seat = state.pending!.seat;
  await speak({
    state,
    seat,
    store,
    answer: () => ({ claim: "percival", claimPurpose: "first-claim" }),
  });
  await runUntilSpeechBy(state, seat, store);
  return { state, seat, store };
}

/* ── 1. One report per rejected attempt ─────────────────────────────────── */

describe("1 · 每一次被拒都发一条，类别正确", () => {
  it("**无谓的重复声称：三次尝试 → 三条拒绝记录**", async () => {
    const { state, seat, store } = await standingClaim();
    expect(state.pending).not.toBeNull();
    expect(claimStateFor(seat, "percival", state.log).standing).toBe("percival");

    const r = await speak({
      state,
      seat,
      store,
      answer: () => ({ claim: "percival", claimPurpose: null }),
      repairs: 2,
    });
    expect(r.applied).toBe(false);
    expect(r.rejections).toHaveLength(3);
    for (const [i, rejection] of r.rejections.entries()) {
      expect(rejection.seat).toBe(seat);
      expect(rejection.attempt).toBe(i + 1);
      expect(rejection.categories).toEqual(["purposeless-claim"]);
      expect(rejection.codes).toEqual(["claim.purpose-missing"]);
      // The first two expect another ask; the last one is the end of the line.
      expect(rejection.willRetry).toBe(i < 2);
    }
    // All three name the SAME decision, which is what makes a repair chain
    // groupable rather than three unrelated events.
    expect(new Set(r.rejections.map((x) => x.decision)).size).toBe(1);
  });

  it("**站不住的 resolving-ambiguity → unsupported-ambiguity**", async () => {
    const { state, seat, store } = await standingClaim();
    const r = await speak({
      state,
      seat,
      store,
      answer: () => ({
        claim: "percival",
        claimPurpose: "resolving-ambiguity",
        ambiguityEventIds: [99999],
      }),
      repairs: 2,
    });
    expect(r.rejections.length).toBeGreaterThan(0);
    for (const rejection of r.rejections) {
      expect(rejection.categories).toEqual(["unsupported-ambiguity"]);
      expect(rejection.codes[0].startsWith("ambiguity.")).toBe(true);
    }
  });

  it("**畸形证据引用 → malformed-evidence，代码带类型和字段**", async () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 3, config: CONFIG, deal: dealWith() });
    while (state.pending && state.pending.kind !== "speech") {
      await speak({ state, seat: state.pending.seat, store, answer: () => ({}) });
    }
    const seat = state.pending!.seat;
    const r = await speak({
      state,
      seat,
      store,
      // The exact shape the live 0.6.0 game wrote: two ids packed into one box
      // with full-width delimiters.
      answer: () => ({ cognition: { factsUsed: ["k4:claim】【、】【k45:claim"] } }),
      repairs: 2,
    });
    expect(r.applied).toBe(false);
    expect(r.rejections.length).toBeGreaterThan(0);
    for (const rejection of r.rejections) {
      expect(rejection.categories).toEqual(["malformed-evidence"]);
      expect(rejection.codes).toEqual(["evidence.multiple-ids:factsUsed"]);
    }
    // And the offending string itself is nowhere in the telemetry.
    expect(JSON.stringify(r.rejections)).not.toContain("k4:claim");
    expect(JSON.stringify(r.rejections)).not.toContain("】");
  });

  it("**接受的那一次不会被算成拒绝**", async () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 3, config: CONFIG, deal: dealWith() });
    while (state.pending && state.pending.kind !== "speech") {
      await speak({ state, seat: state.pending.seat, store, answer: () => ({}) });
    }
    const seat = state.pending!.seat;
    const r = await speak({
      state,
      seat,
      store,
      answer: () => ({ claim: "percival", claimPurpose: "first-claim" }),
    });
    expect(r.applied).toBe(true);
    expect(r.rejections).toEqual([]);
    expect(r.reports).toHaveLength(1);
  });
});

/* ── 2. State semantics ─────────────────────────────────────────────────── */

describe("2 · 被拒的尝试不改变任何状态", () => {
  it("**账本、公开日志、公开产物全都没有动**", async () => {
    const { state, seat, store } = await standingClaim();
    const before = {
      log: state.log.length,
      claims: JSON.stringify(state.standingClaims),
      ledger: JSON.stringify(store.export()),
    };
    const r = await speak({
      state,
      seat,
      store,
      answer: () => ({ claim: "percival", claimPurpose: null }),
      repairs: 2,
    });
    expect(r.applied).toBe(false);
    expect(state.log.length).toBe(before.log);
    expect(JSON.stringify(state.standingClaims)).toBe(before.claims);
    // THE ONE THAT MATTERS. A refused block must not become memory.
    expect(JSON.stringify(store.export())).toBe(before.ledger);
    expect(r.reports).toEqual([]);
  });

  it("**修好之后：拒绝记录留着，外加一份被接受的报告**", async () => {
    const { state, seat, store } = await standingClaim();
    let asked = 0;
    const r = await speak({
      state,
      seat,
      store,
      answer: () => {
        asked += 1;
        // Wrong once, then right — the ordinary repair.
        return asked === 1
          ? { claim: "percival", claimPurpose: null }
          : { claim: "percival", claimPurpose: "resolving-ambiguity", ambiguityEventIds: [] };
      },
      repairs: 2,
    });
    void r;
    // The second answer is also unsupported, so drive a genuinely repairable
    // one: wrong first, then no claim at all (always legal).
    const { state: s2, seat: seat2, store: st2 } = await standingClaim();
    let n = 0;
    const good = await speak({
      state: s2,
      seat: seat2,
      store: st2,
      answer: () => {
        n += 1;
        return n === 1 ? { claim: "percival", claimPurpose: null } : { claim: null };
      },
      repairs: 2,
    });
    expect(good.applied).toBe(true);
    expect(good.rejections).toHaveLength(1);
    expect(good.rejections[0].attempt).toBe(1);
    expect(good.rejections[0].willRetry).toBe(true);
    expect(good.reports).toHaveLength(1);
    expect(good.reports[0].attempt).toBe(2);
  });

  it("被拒的尝试不会进公开回放，新字段一个都不出现", async () => {
    const { state, seat, store } = await standingClaim();
    await speak({
      state,
      seat,
      store,
      answer: () => ({ claim: "percival", claimPurpose: null }),
      repairs: 2,
    });
    const replay = serialisePublicReplay(
      buildPublicReplay(
        state,
        Object.fromEntries(SEATS.map((x) => [x, { name: "double" }])) as never,
        { status: "completed" },
      ),
    );
    for (const key of [
      "cognition-rejection",
      "willRetry",
      "purposeless-claim",
      "unsupported-ambiguity",
      "malformed-evidence",
      "claim.purpose-missing",
      "decision",
    ]) {
      expect(replay, key).not.toContain(key);
    }
  });
});

/* ── 3. The private artifact ────────────────────────────────────────────── */

describe("3 · 私有轨迹里的 cognition-rejection", () => {
  const rejection = (over: Partial<CognitionRejection> = {}): CognitionRejection => ({
    decision: "speech-regular@12",
    seat: 7,
    taskId: "speech-regular",
    attempt: 1,
    categories: ["purposeless-claim"],
    codes: ["claim.purpose-missing"],
    willRetry: true,
    ...over,
  });

  it("**一行一条，类型是 `cognition-rejection`**", () => {
    const state = createGame({ seed: 3, config: CONFIG, deal: dealWith() });
    const trace = buildPrivateResearchTrace(
      state,
      Object.fromEntries(SEATS.map((x) => [x, { name: "double" }])) as never,
      [],
      {
        runId: "t",
        gameId: "g-test",
        status: "completed",
        maxOutputTokens: 12000,
        strategyId: "expert-disciplined",
        strategyFingerprint: "x",
        cognition: CONFIG.cognition,
        cognitionReports: [],
        cognitionRejections: [rejection(), rejection({ attempt: 2, willRetry: false })],
        modelCalls: [] as readonly ModelCallRecord[],
      } as never,
    );
    const lines = privateTraceLines(trace);
    const rows = lines.filter((l) => l.t === "cognition-rejection");
    expect(rows).toHaveLength(2);
    expect(rows[0].t).toBe("cognition-rejection");
  });

  it("**汇总分开数「修好了」和「用尽了」**", () => {
    const summary = summariseRejections([
      // One decision, repaired on the second ask.
      rejection({ decision: "a", attempt: 1, willRetry: true }),
      // Another, exhausted.
      rejection({ decision: "b", attempt: 1, willRetry: true }),
      rejection({ decision: "b", attempt: 2, willRetry: true }),
      rejection({ decision: "b", attempt: 3, willRetry: false }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.repaired).toBe(1);
    expect(summary.exhausted).toBe(1);
    expect(summary.byCategory["purposeless-claim"]).toBe(4);
    expect(summary.bySeat["7"]).toBe(4);
    expect(summary.byTask["speech-regular"]).toBe(4);
  });

  it("**对象里没有任何可以装私有值的位置**", () => {
    const keys = Object.keys(rejection()).sort();
    expect(keys).toEqual(
      ["attempt", "categories", "codes", "decision", "seat", "taskId", "willRetry"].sort(),
    );
    // And the two open-ended fields are closed vocabularies.
    for (const c of rejection().categories) expect(REJECTION_CATEGORIES).toContain(c);
    for (const code of rejection().codes) expect(code).toMatch(/^[a-z]+\.[a-z-]+(:[\w.[\]]+)?$/);
  });
});

/* ── 4. The consistency assertion ───────────────────────────────────────── */

describe("4 · 拒绝条数 == 归因于认知校验的 invalid 次数", () => {
  it("**两个计数在同一次决策上必须相等**", async () => {
    const { state, seat, store } = await standingClaim();
    const r = await speak({
      state,
      seat,
      store,
      answer: () => ({ claim: "percival", claimPurpose: null }),
      repairs: 2,
    });
    // `model-call outcome: invalid` is unchanged and still recorded — the
    // historical channel. The new list must line up with the subset of those
    // attributable to cognition validation, which for this decision is all of
    // them on the planner leg.
    // `refusedByCognition` is the SAME predicate `run/live-game.ts` uses to set
    // `rejectedBy: "cognition"`, imported rather than restated — a second copy
    // is how M5.5's two new prefixes came to be filed as `action-format`.
    const askedAndRefused = r.prompts.length - (r.applied ? 1 : 0);
    expect(r.rejections).toHaveLength(askedAndRefused);
    // Every REPAIRABLE refusal is attributable to cognition validation by the
    // runner's own predicate. The last error is the terminal `CognitionInvalid`
    // one, which is a different thing and deliberately not matched.
    const repairable = r.errors.slice(0, -1);
    expect(repairable.length).toBe(2);
    for (const message of repairable) expect(refusedByCognition(message)).toBe(true);
    expect(refusedByCognition(r.errors.at(-1)!)).toBe(false);
    expect(r.errors.at(-1)).toContain("cognition 结构始终不合法");
    // And the prefixes really are the ones the module publishes.
    for (const message of repairable) {
      expect(COGNITION_REFUSAL_PREFIXES.some((prefix) => message.startsWith(prefix))).toBe(true);
    }
  });

  it("零网络请求", () => {
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
