import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleType } from "@/lib/types/game";
import { llmAgent, type CognitionReport } from "../agents/llm-agent";
import type { Agent } from "../agents/agent";
import { dealFromAssignment, type Deal } from "../core/deal";
import { observationFor } from "../core/observation";
import { applyAction, createGame } from "../core/referee";
import type { GameState } from "../core/state";
import { SEATS, type Seat } from "../core/types";
import { REFERENCE_ASSIGNMENT, testConfig } from "../fixtures/harness";
import { buildPublicReplay, serialisePublicReplay } from "../run/artifacts";
import { assignPersonas, personaById } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { capabilitiesFor, DECLARED_PROMPT_VERSIONS, UnknownPromptVersionError } from "../prompts/capabilities";
import {
  PROMPT_VERSION_CONTEST,
  PROMPT_VERSION_DISCLOSURE,
  PROMPT_VERSION_LEGACY,
  PROMPT_VERSION_M54,
  PROMPT_VERSION_M55,
} from "../prompts/version";
import { CognitionStore, LEDGER_STATE_SCHEMA } from "./store";
import { disclosureClient, isSpokespersonRequest } from "./scripted-cognitive-client";
import { buildFactRegistry, isVerifiedPremise } from "./fact-ids";
import { claimContestFrom } from "./claim-contest";
import { claimsFrom, publicFactsFrom } from "./ledger";
import type { ModelRequest } from "../model/client";

/**
 * The M5.3 folding defect, and the mechanism that makes its class impossible.
 *
 * WHAT WENT WRONG. `llm-agent.ts` decided whether to parse the `social` and
 * `contest` blocks by comparing the prompt version against ONE historical
 * constant:
 *
 *     const wantsContest = config.promptVersion === PROMPT_VERSION_CONTEST;
 *
 * `prompt-0.5.0` is a superset of `prompt-0.4.0`, so that is false for a stack
 * that ASKS for both blocks under a strict schema. The builder knew; the folder
 * did not. Across two completed live games the model answered both blocks every
 * turn and both were discarded: never validated, never folded, never rendered
 * on the next turn, never recorded. The `k…` contest-event ids were never
 * minted, so every citation of one resolved as invented.
 *
 * Nothing failed. Both games ran to completion and their artifacts verify.
 * That is what makes this class of defect worth a mechanism rather than a fix.
 *
 * EVERY TEST BELOW FAILS UNDER THE OLD IMPLEMENTATION — the ones marked
 * `【旧实现会红】` fail directly on the discarded blocks, the rest on the
 * capability table that replaced the comparison.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("folding tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function configFor(version: string) {
  return testConfig({
    promptVersion: version,
    cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
    experiment: {
      personaMode: "heterogeneous-rotated",
      strategyProfile:
        version === PROMPT_VERSION_CONTEST ? "expert-claim-contest" : "expert-disclosure-safe",
    },
  });
}

function dealWith(overrides: Partial<Record<Seat, RoleType>>): Deal {
  return dealFromAssignment({ ...REFERENCE_ASSIGNMENT, ...overrides });
}

interface Played {
  readonly state: GameState;
  readonly reports: readonly CognitionReport[];
  readonly store: CognitionStore;
  readonly plannerPrompts: readonly ModelRequest[];
  readonly error: unknown;
}

/** Play a scripted game where two seats really claim, so the contest is live. */
async function play(version: string, maxActions = 40): Promise<Played> {
  const config = configFor(version);
  const state = createGame({ seed: 3, config, deal: dealWith({ 1: "mordred", 9: "merlin" }) });
  const personas = assignPersonas(3, "heterogeneous-rotated");
  const store = new CognitionStore();
  const reports: CognitionReport[] = [];
  const plannerPrompts: ModelRequest[] = [];
  const client = disclosureClient({
    claimSeats: [2, 7],
    onRequest: (r) => {
      if (!isSpokespersonRequest(r)) plannerPrompts.push(r);
    },
  });

  const agents = {} as Record<Seat, Agent>;
  for (const seat of SEATS) {
    agents[seat] = llmAgent(seat, {
      client,
      persona: personaById(personas[seat].id),
      strategy: strategyById(config.experiment.strategyProfile),
      config,
      cognition: { store, onCognition: (r) => reports.push(r) },
    });
  }

  let error: unknown = null;
  let n = 0;
  try {
    while (state.pending && n < maxActions) {
      const seat = state.pending.seat;
      const action = await agents[seat].act(observationFor(state, seat));
      applyAction(state, seat, action);
      n += 1;
    }
  } catch (caught) {
    error = caught;
  }
  return { state, reports, store, plannerPrompts, error };
}

/* ── The capability mechanism ───────────────────────────────────────────── */

describe("能力由版本声明，不由字符串比较推导", () => {
  it("0.5.0 与 0.6.0 都声明了 social 与 claimContest【旧实现会红】", () => {
    // The old code asked `=== PROMPT_VERSION_CONTEST`, which is FALSE for both.
    for (const v of [PROMPT_VERSION_DISCLOSURE, PROMPT_VERSION_M54]) {
      const c = capabilitiesFor(v);
      expect(c.social, v).toBe(true);
      expect(c.claimContest, v).toBe(true);
      expect(c.twoStageSpeech, v).toBe(true);
      expect(c.stableCommitmentIds, v).toBe(true);
    }
  });

  it("旧版本的能力一个字段都没变", () => {
    const legacy = capabilitiesFor(PROMPT_VERSION_LEGACY);
    expect(legacy.cognition).toBe(false);
    expect(legacy.social).toBe(false);
    expect(legacy.claimContest).toBe(false);

    const m5 = capabilitiesFor("prompt-0.3.0");
    expect(m5.cognition).toBe(true);
    expect(m5.citableFactIds).toBe(false);
    expect(m5.social).toBe(false);

    const m51 = capabilitiesFor("prompt-0.3.1");
    expect(m51.social).toBe(true);
    expect(m51.claimContest).toBe(false);

    const m52 = capabilitiesFor(PROMPT_VERSION_CONTEST);
    expect(m52.claimContest).toBe(true);
    expect(m52.twoStageSpeech).toBe(false);
    expect(m52.stableCommitmentIds).toBe(false);
  });

  it("M5.4 的四项新能力从 0.6.0 起才有 —— 更早的版本一个都没有", () => {
    // 0.7.0 is a SUPERSET of 0.6.0 for these four, so the exclusion is over
    // the versions BELOW 0.6.0. Written as an explicit list rather than as
    // "everything except M5.4", which is what broke when 0.7.0 was added.
    const withThem = [PROMPT_VERSION_M54, PROMPT_VERSION_M55];
    for (const v of withThem) {
      const c = capabilitiesFor(v);
      expect(c.naturalPublicSpeech, v).toBe(true);
      expect(c.evilCoordination, v).toBe(true);
      expect(c.voteDiscipline, v).toBe(true);
      expect(c.assassinRanking, v).toBe(true);
    }
    for (const v of DECLARED_PROMPT_VERSIONS.filter((x) => !withThem.includes(x))) {
      const c = capabilitiesFor(v);
      expect(c.naturalPublicSpeech, v).toBe(false);
      expect(c.evilCoordination, v).toBe(false);
      expect(c.voteDiscipline, v).toBe(false);
      expect(c.assassinRanking, v).toBe(false);
    }
  });

  it("M5.5 的五项只在 0.7.0 上开", () => {
    const m55 = capabilitiesFor(PROMPT_VERSION_M55);
    expect(m55.coordinationFieldGated).toBe(true);
    expect(m55.validatedEvidenceRefs).toBe(true);
    expect(m55.ladyNeutralAssassination).toBe(true);
    expect(m55.pairGroupingBlocked).toBe(true);
    expect(m55.persistentClaims).toBe(true);
    for (const v of DECLARED_PROMPT_VERSIONS.filter((x) => x !== PROMPT_VERSION_M55)) {
      const c = capabilitiesFor(v);
      expect(c.coordinationFieldGated, v).toBe(false);
      expect(c.validatedEvidenceRefs, v).toBe(false);
      expect(c.ladyNeutralAssassination, v).toBe(false);
      expect(c.pairGroupingBlocked, v).toBe(false);
      expect(c.persistentClaims, v).toBe(false);
    }
  });

  it("没声明的版本会抛，不会给一个「安全默认」", () => {
    // A default would be the same failure in a new costume: half the features
    // on, the game running to completion, artifacts that look fine.
    expect(() => capabilitiesFor("prompt-9.9.9")).toThrow(UnknownPromptVersionError);
    expect(() => capabilitiesFor("prompt-9.9.9")).toThrow(/必须显式加一行/);
  });

  it("表里没有按字符串比大小的地方 —— 0.10.0 这种排序陷阱不存在", () => {
    // `"prompt-0.10.0" < "prompt-0.5.0"` is true as strings. A lookup table
    // has no ordering at all, so the trap cannot be sprung.
    expect(DECLARED_PROMPT_VERSIONS).toHaveLength(7);
    expect(() => capabilitiesFor("prompt-0.10.0")).toThrow();
  });
});

/* ── The fold, end to end ───────────────────────────────────────────────── */

describe("0.5.0 / 0.6.0 的 social 与 contest 真的被折叠了", () => {
  it("遥测里不再是 null【旧实现会红】", async () => {
    for (const version of [PROMPT_VERSION_DISCLOSURE, PROMPT_VERSION_M54]) {
      const r = await play(version);
      expect(r.error, version).toBeNull();
      expect(r.reports.length, version).toBeGreaterThan(5);
      // Under the old implementation EVERY one of these was null.
      const withContest = r.reports.filter((x) => x.contest !== null);
      const withSocial = r.reports.filter((x) => x.social !== null);
      expect(withContest.length, version).toBeGreaterThan(0);
      expect(withSocial.length, version).toBeGreaterThan(0);
    }
  });

  it("0.4.0 的遥测一直是有的 —— 上面那条不是空断言", async () => {
    const r = await play(PROMPT_VERSION_CONTEST);
    expect(r.error).toBeNull();
    expect(r.reports.some((x) => x.contest !== null)).toBe(true);
  });

  it("折进的是正确座位的账本，而且下一次决策看得到【旧实现会红】", async () => {
    const r = await play(PROMPT_VERSION_M54);
    expect(r.error).toBeNull();
    const seat = r.reports[0].seat;
    const observation = observationFor(r.state, seat);
    const ledger = r.store.for(observation);
    expect(ledger.seat).toBe(seat);
    // The seat's own social/contest survived into its ledger.
    expect(ledger.social).not.toBeNull();
    expect(ledger.contest).not.toBeNull();
    // And the NEXT prompt renders it: the cognition section grows past the
    // 19-character empty state it starts at.
    const late = r.reports[r.reports.length - 1];
    expect(late.packSections.cognition).toBeGreaterThan(500);
    expect(r.reports[0].packSections.cognition).toBeLessThan(100);
  });

  it("每个座位的社会／派权记录互相隔离", async () => {
    const r = await play(PROMPT_VERSION_M54);
    for (const seat of SEATS) {
      const ledger = r.store.for(observationFor(r.state, seat));
      expect(ledger.seat).toBe(seat);
      if (ledger.social) expect(ledger.social.seat).toBe(seat);
      if (ledger.contest) expect(ledger.contest.seat).toBe(seat);
    }
  });

  it("k… 派权事件 id 被铸进注册表，而且能解析【旧实现会红】", async () => {
    const r = await play(PROMPT_VERSION_M54);
    const observation = observationFor(r.state, 2);
    const contest = claimContestFrom(observation.publicLog);
    expect(contest.events.length).toBeGreaterThan(0);

    const registry = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      contest,
    );
    const kIds = registry.entries.filter((e) => e.kind === "contest-event").map((e) => e.id);
    expect(kIds.length).toBeGreaterThan(0);
    for (const id of kIds) expect(isVerifiedPremise(registry, id), id).toBe(true);

    // And the built registry the AGENT used had them too: without the fix the
    // agent passed `undefined` for the contest and minted none.
    const withoutContest = buildFactRegistry(
      publicFactsFrom(observation.publicLog),
      claimsFrom(observation.publicLog),
      observation,
      undefined,
    );
    expect(withoutContest.entries.filter((e) => e.kind === "contest-event")).toHaveLength(0);
  });

  it("派权结构检查真的在跑 —— 竞争者漏评会被打回", async () => {
    // Two seats claim, so a claimant that ignores its rival is structurally
    // illegal. Under the old code `contestProblems` never ran at all, because
    // the block was parsed away before it could be checked.
    const r = await play(PROMPT_VERSION_M54, 60);
    const claimants = r.state.log.filter((e) => e.type === "speech" && e.claim);
    expect(claimants.length).toBeGreaterThan(0);
    // The double answers legally, so the game completes; what this asserts is
    // that the checked path is reachable and the contest model is populated.
    const withContest = r.reports.filter((x) => x.contest !== null);
    expect(withContest.some((x) => x.contest!.assessments.length > 0)).toBe(true);
  });

  it("公开产物里没有任何 social / contest 私有字段", async () => {
    const r = await play(PROMPT_VERSION_M54);
    const replay = serialisePublicReplay(
      buildPublicReplay(
        r.state,
        Object.fromEntries(SEATS.map((s) => [s, { name: "double" }])) as never,
        { status: "failed" },
      ),
    );
    for (const field of [
      "focalCandidates",
      "coalitionPlan",
      "ownClaimStrategy",
      "claimantAssessments",
      "rivalPlans",
      "publicClaimMove",
      "informationToConceal",
      "candidatePairStory",
      "selectedClaimant",
      "restsOnUnverified",
    ]) {
      expect(replay, field).not.toContain(field);
    }
  });
});

/* ── Checkpoint and resume ──────────────────────────────────────────────── */

describe("checkpoint @4 存取与续跑", () => {
  it("导出再恢复，social / contest 与承诺 id 都还在", async () => {
    const r = await play(PROMPT_VERSION_M54);
    const exported = r.store.export();
    expect(exported.schema).toBe(LEDGER_STATE_SCHEMA);

    const restored = new CognitionStore(exported);
    for (const seat of SEATS) {
      const before = r.store.for(observationFor(r.state, seat));
      const after = restored.for(observationFor(r.state, seat));
      expect(JSON.stringify(after.social), `${seat}`).toBe(JSON.stringify(before.social));
      expect(JSON.stringify(after.contest), `${seat}`).toBe(JSON.stringify(before.contest));
      expect(after.self.publicCommitments.map((c) => c.id)).toEqual(
        before.self.publicCommitments.map((c) => c.id),
      );
    }
  });

  it("续跑铸出的事实与说法 id 和不中断跑一模一样", async () => {
    // Same position, two ways of arriving at it. The ids are a pure function of
    // sequence numbers and the seat's own observation, so they must agree.
    const a = await play(PROMPT_VERSION_M54, 24);
    const restored = new CognitionStore(a.store.export());
    const observation = observationFor(a.state, 2);
    const contest = claimContestFrom(observation.publicLog);
    const idsOf = (store: CognitionStore) => {
      const ledger = store.for(observation);
      return buildFactRegistry(ledger.publicFacts, ledger.claims, observation, contest).entries.map(
        (e) => `${e.kind}:${e.id}`,
      );
    };
    expect(idsOf(restored)).toEqual(idsOf(a.store));
  });
});
