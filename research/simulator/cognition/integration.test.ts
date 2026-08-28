import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { fixedGameId } from "../core/game-id";
import { observationFor } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { ModelCallError, type ModelClient, type ModelRequest } from "../model/client";
import { answeringClient } from "../model/scripted-client";
import { assignPersonas } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_COGNITIVE, PROMPT_VERSION_LEGACY } from "../prompts/version";
import { llmAgent, CognitionInvalidError } from "../agents/llm-agent";
import { parseJsonl, type PrivateTraceLine, type PublicReplayLine } from "../run/artifacts";
import { parseCheckpoint, resumeFromCheckpoint } from "../run/checkpoint";
import { preflight, runLiveGame } from "../run/live-game";
import { buildCognitivePrompt } from "./build-cognitive";
import { CONTEXT_BUDGET } from "./limits";
import { CognitionStore } from "./store";
import { brokenCognitionClient, cognitiveClient } from "./scripted-cognitive-client";

/**
 * The cognition layer, end to end, through the real prompt/schema/reducer path.
 *
 * Everything below runs against a scripted double. `globalThis.fetch` throws
 * for the whole file, so "offline" is an assertion rather than an intention.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("M5 integration tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The opt-in config. Legacy stays the default everywhere else. */
const COG = loadConfig({
  promptVersion: PROMPT_VERSION_COGNITIVE,
  cognition: { enabled: true },
  experiment: { strategyProfile: "expert-cognitive" },
});
const LEGACY = loadConfig();

const GAME_ID = fixedGameId("m5b");
const tempOut = () => mkdtempSync(join(tmpdir(), "avalon-m5b-"));

function options(out: string, client: ModelClient, extra: Record<string, unknown> = {}) {
  return { seed: 5, gameId: GAME_ID, outDir: out, client, ...extra };
}

const priv = <T,>(text: string, t: string): T[] =>
  (parseJsonl<PrivateTraceLine>(text) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data as T);

const pub = <T,>(text: string, t: string): T[] =>
  (parseJsonl<PublicReplayLine>(text) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data as T);

/* ── Configuration gate ─────────────────────────────────────────────────── */

describe("cognition is opt-in and version-locked", () => {
  it("is off in the shipped configuration", () => {
    expect(LEGACY.cognition.enabled).toBe(false);
    expect(LEGACY.promptVersion).toBe(PROMPT_VERSION_LEGACY);
  });

  it("refuses cognition on the legacy prompt version", () => {
    // The two stacks must never share a version number: an artifact's recorded
    // version has to describe the prompts that actually produced it.
    expect(() => loadConfig({ cognition: { enabled: true } })).toThrow(/prompt-0\.3\.0/);
  });

  it("refuses the cognitive version without cognition", () => {
    expect(() => loadConfig({ promptVersion: PROMPT_VERSION_COGNITIVE })).toThrow(
      /prompt-0\.2\.0/,
    );
  });

  it("accepts only the implemented mode", () => {
    expect(() =>
      loadConfig({ cognition: { mode: "two-pass-critical" as never } }),
    ).toThrow(/fused/);
  });
});

/* ── Prompt construction ────────────────────────────────────────────────── */

/** The prompt the referee is actually waiting for. */
function pendingPrompt(store: CognitionStore, config = COG) {
  const state = createGame({ seed: 5, config });
  const observation = observationFor(state, state.pending!.seat);
  return buildCognitivePrompt({
    observation,
    persona: assignPersonas(5)[observation.seat],
    strategy: strategyById("expert-cognitive"),
    ledger: store.for(observation),
    config,
  });
}

function firstObservation(config = COG) {
  const state = createGame({ seed: 5, config });
  return observationFor(state, state.pending!.seat);
}

function promptFor(seat: Seat, store: CognitionStore, config = COG) {
  const state = createGame({ seed: 5, config });
  // Only the pending seat has a request, so a prompt for anyone else has
  // nothing to ask. Advance the referee's own pointer instead of guessing.
  const observation = observationFor(state, seat);
  if (!observation.request) {
    throw new Error(`${seat}号 has no request; use pendingObservation()`);
  }
  return buildCognitivePrompt({
    observation,
    persona: assignPersonas(5)[seat],
    strategy: strategyById("expert-cognitive"),
    ledger: store.for(observation),
    config,
  });
}

describe("the prompt-0.3.0 stack", () => {
  it("stamps the cognitive version", () => {
    const observation = firstObservation();
    const store = new CognitionStore();
    const built = buildCognitivePrompt({
      observation,
      persona: assignPersonas(5)[observation.seat],
      strategy: strategyById("expert-cognitive"),
      ledger: store.for(observation),
      config: COG,
    });
    expect(built.promptVersion).toBe(PROMPT_VERSION_COGNITIVE);
  });

  it("puts the protocol in the cacheable system half, with no seat in it", () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 5, config: COG });
    const pending = state.pending!.seat;
    const build = (persona: Seat) =>
      buildCognitivePrompt({
        observation: observationFor(state, pending),
        persona: assignPersonas(5)[persona],
        strategy: strategyById("expert-cognitive"),
        ledger: store.for(observationFor(state, pending)),
        config: COG,
      });
    const a = build(1);
    const b = build(2);
    // Layers 1-4 are rules, protocol, persona, role. Only persona and role can
    // differ between seats; the protocol must be byte-identical, which is what
    // makes ~150 requests share one cached prefix.
    const protocolA = a.layers.find((l) => l.title === "思考流程")!.text;
    const protocolB = b.layers.find((l) => l.title === "思考流程")!.text;
    expect(protocolB).toBe(protocolA);
    expect(protocolA).not.toMatch(/\d+号/);
  });

  it("requires a cognition block in the strict schema", () => {
    const store = new CognitionStore();
    const built = pendingPrompt(new CognitionStore());
    void store;
    const schema = built.jsonSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("cognition");
    expect(schema.properties.cognition).toBeDefined();
    // And the action fields are still there, from the SAME task schema the
    // referee validates against.
    for (const field of built.schema.fields) expect(schema.required).toContain(field.name);
  });

  it("refuses to build a prompt from another seat's ledger", () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 5, config: COG });
    const pending = state.pending!.seat;
    const other = SEATS.find((s) => s !== pending)!;
    expect(() =>
      buildCognitivePrompt({
        observation: observationFor(state, pending),
        persona: assignPersonas(5)[pending],
        strategy: strategyById("expert-cognitive"),
        ledger: store.for(observationFor(state, other)),
        config: COG,
      }),
    ).toThrow(new RegExp(`${other}号.*${pending}号`));
  });

  it("never offers the model a way to write a referee fact", () => {
    const schema = pendingPrompt(new CognitionStore()).jsonSchema as {
      properties: { cognition: { properties: Record<string, unknown> } };
    };
    const fields = Object.keys(schema.properties.cognition.properties);
    for (const forbidden of ["publicFacts", "privateFacts", "premiseVerified", "verified"]) {
      expect(fields, forbidden).not.toContain(forbidden);
    }
  });
});

/* ── Ten isolated minds ─────────────────────────────────────────────────── */

describe("ten seats, ten ledgers", () => {
  it("keeps each seat's memory to itself through a whole game", async () => {
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("completed");

    const text = readFileSync(result.privatePath!, "utf8");
    const reports = priv<{ seat: number; utilisation: { seat: number } }>(
      text,
      "cognition-telemetry",
    )[0] as unknown as { seat: number; utilisation: { seat: number } }[];
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      // A report is filed under the seat whose ledger it changed, always.
      expect(r.utilisation.seat).toBe(r.seat);
    }
    expect(new Set(reports.map((r) => r.seat)).size).toBeGreaterThan(1);
  });

  it("gives each seat a store slot that another seat cannot read", () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 5, config: COG });
    for (const seat of SEATS) {
      expect(store.for(observationFor(state, seat)).seat).toBe(seat);
    }
  });

  it("starts empty and stops being empty once a seat writes", async () => {
    const store = new CognitionStore();
    expect(store.isEmpty()).toBe(true);
    const state = createGame({ seed: 5, config: COG });
    const observation = observationFor(state, 3);
    const agent = llmAgent(3, {
      client: cognitiveClient(),
      persona: assignPersonas(5)[3],
      strategy: strategyById("expert-cognitive"),
      config: COG,
      cognition: { store },
    });
    void observation;
    const first = observationFor(state, state.pending!.seat);
    if (first.seat === 3) await agent.act(first);
    else {
      const other = llmAgent(first.seat, {
        client: cognitiveClient(),
        persona: assignPersonas(5)[first.seat],
        strategy: strategyById("expert-cognitive"),
        config: COG,
        cognition: { store },
      });
      await other.act(first);
    }
    expect(store.isEmpty()).toBe(false);
  });
});

/* ── Claims never become facts ──────────────────────────────────────────── */

describe("the one-way valve", () => {
  it("marks a model's claim-backed constraint as unverified, whatever it says", async () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 5, config: COG });
    const observation = observationFor(state, state.pending!.seat);

    const agent = llmAgent(observation.seat, {
      client: cognitiveClient({
        mutate: (c) => ({
          ...c,
          constraints: [
            {
              id: "sneaky",
              statement: "6号是好人",
              // An id that names nothing the referee recorded.
              premiseIds: ["c999:role"],
              premiseLabels: ["他自己说的"],
            },
          ],
        }),
      }),
      persona: assignPersonas(5)[observation.seat],
      strategy: strategyById("expert-cognitive"),
      config: COG,
      cognition: { store },
    });
    await agent.act(observation);

    const ledger = store.for(observation);
    const sneaky = ledger.constraints.find((c) => c.id === "sneaky");
    expect(sneaky).toBeDefined();
    // The model never gets to declare its own premise verified — the reducer
    // asks the referee's fact table and answers for it.
    expect(sneaky!.restsOnUnverified).toBe(true);
    expect(sneaky!.premises[0].verified).toBe(false);
  });

  it("accepts a genuinely referee-backed premise as verified", async () => {
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    const text = readFileSync(result.privatePath!, "utf8");
    const reports = priv<unknown>(text, "cognition-telemetry")[0] as unknown as {
      premisesOverridden: number;
    }[];
    // Late in a game there are real facts to cite, so at least one attempt must
    // have produced a constraint with nothing overridden.
    expect(reports.some((r) => r.premisesOverridden === 0)).toBe(true);
  });
});

/* ── Failure behaviour ──────────────────────────────────────────────────── */

describe("corrupt cognition is never accepted", () => {
  const cases = ["missing", "one-hypothesis", "no-premises", "contradictory"] as const;

  for (const defect of cases) {
    it(`fails terminally on "${defect}" rather than waving it through`, async () => {
      const out = tempOut();
      const opts = options(out, brokenCognitionClient(defect), { config: COG });
      const result = await runLiveGame(opts, preflight(opts));

      // The ACTION in every one of these is legal. What is broken is the
      // memory, and a legal move is not a reason to keep a corrupt ledger.
      expect(result.status).toBe("cognition_invalid");
      expect(result.outcome).toMatch(/cognition/);
      // Partial artifacts, and no checkpoint: resuming would fail identically.
      expect(result.publicPath).toBeTruthy();
      expect(result.privatePath).toBeTruthy();
      expect(result.checkpointPath).toBeNull();
    });
  }

  it("repairs a recoverable defect before giving up", async () => {
    const out = tempOut();
    let sent = 0;
    const client = cognitiveClient({
      mutate: (c) => {
        sent += 1;
        // Broken once, then fine: the repair channel should absorb it.
        return sent === 1 ? { ...c, hypotheses: [(c.hypotheses as unknown[])[0]] } : c;
      },
    });
    const opts = options(out, client, { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("completed");
    // Counted apart from action repairs: "the move was wrong" and "the memory
    // was wrong" are different diagnoses and should not share a number.
    expect(result.cognitionRepairs).toBeGreaterThan(0);
  });

  it("names the offending field in the repair note", async () => {
    const store = new CognitionStore();
    const state = createGame({ seed: 5, config: COG });
    const observation = observationFor(state, state.pending!.seat);
    const seen: ModelRequest[] = [];
    const agent = llmAgent(observation.seat, {
      client: cognitiveClient({
        onRequest: (r) => seen.push(r),
        mutate: (c) => ({ ...c, hypotheses: [(c.hypotheses as unknown[])[0]] }),
      }),
      persona: assignPersonas(5)[observation.seat],
      strategy: strategyById("expert-cognitive"),
      config: COG,
      cognition: { store },
    });

    await expect(agent.act(observation)).rejects.toThrow();
    // A repair note saying "invalid" costs a request and teaches nothing.
    await expect(
      agent.act(observation, { attempt: 1, error: "cognition 有问题：hypotheses 至少要 2 种" }),
    ).rejects.toThrow();
    expect(seen[1].user).toContain("hypotheses");
  });

  it("still stops on an exhausted output budget, ahead of any cognition check", async () => {
    // Capacity behaviour is unchanged by M5: the answer never arrived, so
    // there is no cognition to validate.
    const out = tempOut();
    const client: ModelClient = {
      name: "exhausted",
      async complete() {
        return {
          text: "",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: COG.limits.maxOutputTokens,
            reasoningTokens: COG.limits.maxOutputTokens,
          },
          latencyMs: 1,
          cached: false,
          modelReturned: "double",
          status: "incomplete" as const,
          incompleteReason: "max_output_tokens",
        };
      },
    };
    const opts = options(out, client, { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("output_limit_exhausted");
    expect(result.capacityRetries).toBe(1);
  });

  it("exposes the terminal error type for a caller to classify", () => {
    const error = new CognitionInvalidError(3, "speech", 3, "hypotheses 只有一个");
    expect(error.name).toBe("CognitionInvalidError");
    expect(error.message).toContain("认知记录不可用");
  });
});

/* ── Persistence ────────────────────────────────────────────────────────── */

describe("cognition survives checkpoint and resume", () => {
  /** Answers for `budget` requests, then throws something recoverable. */
  function limited(budget: number): ModelClient {
    const inner = cognitiveClient();
    let sent = 0;
    return {
      name: "limited-cognitive",
      async complete(request) {
        if (sent >= budget) throw new ModelCallError(503, "server_error", "overloaded", "x");
        sent += 1;
        return inner.complete(request);
      },
    };
  }

  it("writes ten ledgers into the checkpoint", async () => {
    const out = tempOut();
    const opts = options(out, limited(18), { config: COG });
    const paused = await runLiveGame(opts, preflight(opts));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    expect(checkpoint.schema).toBe("avalon-sim-checkpoint@4");
    expect(checkpoint.cognition).not.toBeNull();
    expect(checkpoint.cognition!.seats).toHaveLength(10);
    expect(checkpoint.cognitionConfig?.enabled).toBe(true);
    // Ascending seat order, always — a resumed game must rebuild the same minds.
    expect(checkpoint.cognition!.seats.map((s) => s.seat)).toEqual([...SEATS]);
  });

  it("restores what the seats had learned", async () => {
    const out = tempOut();
    const first = options(out, limited(18), { config: COG });
    const paused = await runLiveGame(first, preflight(first));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const written = checkpoint.cognition!.seats.filter(
      (s) => s.self.lastProcessedSequence > 0 || s.constraints.length > 0,
    );
    expect(written.length).toBeGreaterThan(0);

    const store = new CognitionStore(checkpoint.cognition!);
    const state = createGame({ seed: 5, config: COG });
    for (const saved of written) {
      const restored = store.for(observationFor(state, saved.seat));
      expect(restored.self.lastProcessedSequence).toBe(saved.self.lastProcessedSequence);
      expect(restored.constraints.map((c) => c.id)).toEqual(saved.constraints.map((c) => c.id));
    }
  });

  it("resumes and finishes with the minds intact", async () => {
    const out = tempOut();
    const first = options(out, limited(18), { config: COG });
    const paused = await runLiveGame(first, preflight(first));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const again = options(out, cognitiveClient(), { config: COG, resumeFrom: checkpoint });
    const resumed = await runLiveGame(again, preflight(again));
    expect(resumed.status).toBe("completed");
  });

  it("refuses to resume a legacy checkpoint into a cognition run", async () => {
    const out = tempOut();
    const legacyClient = (() => {
      const inner = answeringClient();
      let sent = 0;
      return {
        name: "limited-legacy",
        async complete(request: ModelRequest) {
          if (sent >= 18) throw new ModelCallError(503, "server_error", "overloaded", "x");
          sent += 1;
          return inner.complete(request);
        },
      } as ModelClient;
    })();
    const legacy = options(out, legacyClient, { config: LEGACY });
    const paused = await runLiveGame(legacy, preflight(legacy));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    expect(checkpoint.cognition).toBeNull();

    const opts = options(out, cognitiveClient(), { config: COG, resumeFrom: checkpoint });
    // Refused on promptVersion, which fires before the cognition-specific
    // check — the two stacks carry different version numbers precisely so this
    // is caught by the oldest and bluntest guard rather than a new one.
    await expect(async () => runLiveGame(opts, preflight(opts))).rejects.toThrow(
      /promptVersion/,
    );
  });

  it("also refuses on the cognition arm alone, if a version were forged", async () => {
    // Defence in depth. A hand-edited checkpoint could carry the cognitive
    // version string while holding no ledgers; the arm check catches that.
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const ready = preflight(opts);
    void (await runLiveGame(opts, ready));

    const state = createGame({ seed: 5, config: COG });
    expect(() =>
      resumeFromCheckpoint(
        {
          promptVersion: PROMPT_VERSION_COGNITIVE,
          simulatorVersion: COG.simulatorVersion,
          config: COG,
          personaMode: COG.experiment.personaMode,
          personaAssignment: [],
          strategyId: "expert-cognitive",
          customStrategyText: null,
          maxOutputTokens: COG.limits.maxOutputTokens,
          cognitionConfig: null,
          seed: 5,
        } as never,
        {
          config: COG,
          personaMode: COG.experiment.personaMode,
          personaAssignment: assignPersonas(5),
          strategyId: "expert-cognitive",
          maxOutputTokens: COG.limits.maxOutputTokens,
          cognitionEnabled: true,
        },
      ),
    ).toThrow(/认知层/);
    void state;
  });
});

/* ── Artifacts ──────────────────────────────────────────────────────────── */

describe("artifacts keep cognition private", () => {
  it("records the arm and the limits in the private manifest only", async () => {
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const result = await runLiveGame(opts, preflight(opts));

    const manifest = priv<Record<string, unknown>>(
      readFileSync(result.privatePath!, "utf8"),
      "private-manifest",
    )[0];
    expect((manifest.cognition as { enabled: boolean }).enabled).toBe(true);
    expect(manifest.cognitionLimits).toBeTruthy();

    const meta = pub<Record<string, unknown>>(
      readFileSync(result.publicPath!, "utf8"),
      "public-metadata",
    )[0];
    expect(meta.cognition).toBeUndefined();
    expect(meta.cognitionLimits).toBeUndefined();
    expect(meta.promptVersion).toBe(PROMPT_VERSION_COGNITIVE);
    expect(meta.strategyId).toBe("expert-cognitive");
  });

  it("leaks no cognition field into the public replay", async () => {
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    const text = readFileSync(result.publicPath!, "utf8");

    // NOT asserting the substring "cognition" is absent: `metadata.config`
    // legitimately carries the arm's configuration, exactly as it carries the
    // model and the limits. What must never appear is ledger CONTENT.
    for (const field of [
      "hypotheses",
      "seatReads",
      "coverStory",
      "claimPlan",
      "rolePlan",
      "constraints",
      "restsOnUnverified",
      "intendedPublicSignal",
      "factsUsed",
      "premiseIds",
    ]) {
      expect(text, field).not.toContain(field);
    }
  });

  it("keeps the telemetry in the private trace", async () => {
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    const reports = priv<unknown>(
      readFileSync(result.privatePath!, "utf8"),
      "cognition-telemetry",
    )[0] as unknown as Record<string, unknown>[];

    expect(reports.length).toBeGreaterThan(0);
    const first = reports[0];
    for (const key of [
      "seat",
      "taskId",
      "premisesOverridden",
      "boundsViolations",
      "utilisation",
      "packSections",
      "estimatedTokens",
      "overSoftTarget",
    ]) {
      expect(first, key).toHaveProperty(key);
    }
  });
});

/* ── Budgets ────────────────────────────────────────────────────────────── */

describe("size budgets", () => {
  it("stays under the soft target for a whole cognitive game", async () => {
    const out = tempOut();
    const opts = options(out, cognitiveClient(), { config: COG });
    const result = await runLiveGame(opts, preflight(opts));
    const reports = priv<unknown>(
      readFileSync(result.privatePath!, "utf8"),
      "cognition-telemetry",
    )[0] as unknown as { estimatedTokens: number; overSoftTarget: boolean }[];

    for (const r of reports) {
      expect(r.overSoftTarget).toBe(false);
      expect(r.estimatedTokens).toBeLessThan(CONTEXT_BUDGET.softTargetTokens);
    }
  });

  it("keeps the 12,000 output cap recorded and effective", async () => {
    const out = tempOut();
    const seen: ModelRequest[] = [];
    const opts = options(out, cognitiveClient({ onRequest: (r) => seen.push(r) }), {
      config: COG,
    });
    const result = await runLiveGame(opts, preflight(opts));

    expect(result.maxOutputTokens).toBe(12_000);
    for (const request of seen) expect(request.maxOutputTokens).toBe(12_000);
    const meta = pub<Record<string, unknown>>(
      readFileSync(result.publicPath!, "utf8"),
      "public-metadata",
    )[0];
    expect(meta.maxOutputTokens).toBe(12_000);
  });

  it("still enforces the 250,000 hard input ceiling", () => {
    expect(COG.limits.maxStandardInputTokens).toBe(250_000);
    expect(CONTEXT_BUDGET.hardCeilingTokens).toBe(250_000);
  });
});

/* ── The legacy path is untouched ───────────────────────────────────────── */

describe("prompt-0.2.0 games are unchanged", () => {
  it("produces the same public replay with and without M5 present", async () => {
    const a = tempOut();
    const b = tempOut();
    const first = options(a, answeringClient(), { config: LEGACY });
    const second = options(b, answeringClient(), { config: LEGACY });
    const one = await runLiveGame(first, preflight(first));
    const two = await runLiveGame(second, preflight(second));

    expect(one.status).toBe("completed");
    expect(readFileSync(two.publicPath!, "utf8")).toBe(readFileSync(one.publicPath!, "utf8"));
  });

  it("sends no cognition block and asks for none", async () => {
    const out = tempOut();
    const seen: ModelRequest[] = [];
    const client: ModelClient = {
      name: "watching",
      async complete(request) {
        seen.push(request);
        return answeringClient().complete(request);
      },
    };
    const opts = options(out, client, { config: LEGACY });
    await runLiveGame(opts, preflight(opts));

    for (const request of seen) {
      expect(request.format.name).not.toContain("cog");
      expect(request.system).not.toContain("私下的思考流程");
      expect(request.user).not.toContain("cognition");
    }
  });

  it("writes null cognition into a legacy private manifest", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient(), { config: LEGACY });
    const result = await runLiveGame(opts, preflight(opts));
    const manifest = priv<Record<string, unknown>>(
      readFileSync(result.privatePath!, "utf8"),
      "private-manifest",
    )[0];
    expect(manifest.cognition).toBeNull();
    expect(manifest.cognitionLimits).toBeNull();
    expect(manifest.promptVersion).toBe(PROMPT_VERSION_LEGACY);
  });
});
