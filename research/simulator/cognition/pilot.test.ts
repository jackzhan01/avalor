import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../config/load";
import { observationFor } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS } from "../core/types";
import { ModelCallError, type ModelClient, type ModelRequest } from "../model/client";
import { strategyFingerprint, strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_COGNITIVE } from "../prompts/version";
import { parseJsonl, type PrivateTraceLine, type PublicReplayLine } from "../run/artifacts";
import { parseCheckpoint } from "../run/checkpoint";
import { preflight, runLiveGame } from "../run/live-game";
import { CONTEXT_BUDGET } from "./limits";
import { CognitionStore } from "./store";
import { cognitiveClient } from "./scripted-cognitive-client";

/**
 * The M5 pilot, played end to end offline under the EXACT pilot profile.
 *
 * Not a variation on it and not a hand-assembled equivalent — `loadProfile
 * ("m5-pilot")`, the same call the CLI makes. A rehearsal under a config that
 * merely resembles the real one rehearses the wrong thing.
 *
 * `fetch` throws for the whole file.
 */

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    fetchCalls += 1;
    throw new Error("the offline pilot must not make network calls");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The real thing. */
const PILOT = loadProfile("m5-pilot");
const SEED = 1;
const tempOut = () => mkdtempSync(join(tmpdir(), "avalon-pilot-"));

function options(out: string, client: ModelClient, extra: Record<string, unknown> = {}) {
  return { seed: SEED, outDir: out, client, ...extra };
}

const priv = <T,>(text: string, t: string): T[] =>
  (parseJsonl<PrivateTraceLine>(text) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data as T);

const pub = <T,>(text: string, t: string): T[] =>
  (parseJsonl<PublicReplayLine>(text) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data as T);

type Report = {
  seat: number;
  taskId: string;
  attempt: number;
  premisesOverridden: number;
  boundsViolations: number;
  utilisation: { seat: number; constraints: number; hypotheses: number };
  packSections: Record<string, number>;
  estimatedTokens: number;
  overSoftTarget: boolean;
};

/** One complete scripted pilot, reused by most assertions below. */
async function playPilot() {
  const out = tempOut();
  const seen: ModelRequest[] = [];
  const opts = options(out, cognitiveClient({ onRequest: (r) => seen.push(r) }), {
    config: PILOT,
  });
  const result = await runLiveGame(opts, preflight(opts));
  const privateText = readFileSync(result.privatePath!, "utf8");
  const publicText = readFileSync(result.publicPath!, "utf8");
  const reports = (priv<unknown>(privateText, "cognition-telemetry")[0] ??
    []) as unknown as Report[];
  return { result, seen, privateText, publicText, reports };
}

describe("the scripted pilot completes", () => {
  it("plays a whole game under the pilot profile", async () => {
    const { result } = await playPilot();
    expect(result.status).toBe("completed");
    expect(result.outcome).toMatch(/good|evil/);
    expect(fetchCalls).toBe(0);
  });

  it("keeps cognition repairs, capacity retries and action repairs apart", async () => {
    const { result } = await playPilot();
    // Three different diagnoses, three different counters. A clean run has
    // zero of each, but conflating them would hide which one moved.
    expect(result.cognitionRepairs).toBe(0);
    expect(result.capacityRetries).toBe(0);
    expect(result.retries).toBe(0);
  });

  it("makes a cognition update on every decision", async () => {
    const { result, reports } = await playPilot();
    const actions = priv<unknown>(
      readFileSync(result.privatePath!, "utf8"),
      "action",
    ).length;
    expect(reports).toHaveLength(actions);
  });
});

describe("ten ledgers stay isolated", () => {
  it("files every report under the seat whose memory changed", async () => {
    const { reports } = await playPilot();
    for (const r of reports) expect(r.utilisation.seat).toBe(r.seat);
    expect(new Set(reports.map((r) => r.seat)).size).toBeGreaterThan(5);
  });

  it("gives every seat its own slot, and refuses to mix them", () => {
    const store = new CognitionStore();
    const state = createGame({ seed: SEED, config: PILOT });
    for (const seat of SEATS) {
      expect(store.for(observationFor(state, seat)).seat).toBe(seat);
    }
  });
});

describe("cognition survives a checkpoint and resume", () => {
  function limited(budget: number): ModelClient {
    const inner = cognitiveClient();
    let sent = 0;
    return {
      name: "limited",
      async complete(request) {
        if (sent >= budget) throw new ModelCallError(503, "server_error", "overloaded", "x");
        sent += 1;
        return inner.complete(request);
      },
    };
  }

  it("pauses, restores ten ledgers, and finishes", async () => {
    const out = tempOut();
    const first = options(out, limited(20), { config: PILOT });
    const paused = await runLiveGame(first, preflight(first));
    expect(paused.status).toBe("paused_provider_interruption");

    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    expect(checkpoint.cognition!.seats).toHaveLength(10);
    expect(checkpoint.cognitionConfig?.maxCognitionRepairs).toBe(2);
    expect(checkpoint.maxOutputTokens).toBe(20_000);

    const written = checkpoint.cognition!.seats.filter(
      (s) => s.self.lastProcessedSequence > 0,
    );
    expect(written.length).toBeGreaterThan(0);

    const again = options(out, cognitiveClient(), {
      config: PILOT,
      resumeFrom: checkpoint,
      gameId: checkpoint.gameId,
    });
    const resumed = await runLiveGame(again, preflight(again));
    expect(resumed.status).toBe("completed");
    expect(fetchCalls).toBe(0);
  });
});

describe("what the artifacts record", () => {
  it("stamps the effective version, arm, fingerprint, limits and output cap", async () => {
    const { result, privateText, publicText } = await playPilot();

    const manifest = priv<Record<string, unknown>>(privateText, "private-manifest")[0];
    expect(manifest.promptVersion).toBe(PROMPT_VERSION_COGNITIVE);
    expect(manifest.strategyId).toBe("expert-cognitive");
    expect(manifest.strategyFingerprint).toBe(
      strategyFingerprint(strategyById("expert-cognitive")),
    );
    expect(manifest.maxOutputTokens).toBe(20_000);
    expect((manifest.cognition as { mode: string }).mode).toBe("fused");
    expect((manifest.cognition as { maxCognitionRepairs: number }).maxCognitionRepairs).toBe(2);
    expect(manifest.cognitionLimits).toBeTruthy();

    const meta = pub<Record<string, unknown>>(publicText, "public-metadata")[0];
    expect(meta.promptVersion).toBe(PROMPT_VERSION_COGNITIVE);
    expect(meta.strategyId).toBe("expert-cognitive");
    expect(meta.maxOutputTokens).toBe(20_000);

    expect(result.maxOutputTokens).toBe(20_000);
  });

  it("sends 20,000 on every request", async () => {
    const { seen } = await playPilot();
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(request.maxOutputTokens).toBe(20_000);
  });

  it("leaks no ledger content into the public replay", async () => {
    const { publicText } = await playPilot();
    for (const field of [
      "hypotheses",
      "seatReads",
      "coverStory",
      "claimPlan",
      "nextTurnPlan",
      "rolePlan",
      "restsOnUnverified",
      "intendedPublicSignal",
      "factsUsed",
      "premiseIds",
      "evidenceFor",
      "evidenceAgainst",
    ]) {
      expect(publicText, field).not.toContain(field);
    }
  });

  it("keeps the strategy fingerprint out of the public artifact", async () => {
    // A digest of the whole catalog would let a reader diff two arms without
    // being given either one.
    const { publicText } = await playPilot();
    expect(publicText).not.toContain("strategyFingerprint");
  });
});

describe("size gates", () => {
  it("never approaches the 60K soft target in the scripted run", async () => {
    const { reports } = await playPilot();
    for (const r of reports) {
      expect(r.overSoftTarget).toBe(false);
      expect(r.estimatedTokens).toBeLessThan(CONTEXT_BUDGET.softTargetTokens);
    }
  });

  it("reports pack size by section, so the pilot can be calibrated", async () => {
    const { reports } = await playPilot();
    for (const key of ["factTables", "ownPrivateFacts", "cognition", "total"]) {
      expect(reports[0].packSections, key).toHaveProperty(key);
    }
    const last = reports[reports.length - 1];
    // Facts accumulate; the tables are the section that should grow.
    expect(last.packSections.factTables).toBeGreaterThan(reports[0].packSections.factTables);
  });

  it("fails BEFORE sending when a request would exceed the 250K hard cap", async () => {
    const out = tempOut();
    let sent = 0;
    const client: ModelClient = {
      name: "counting",
      async complete(request) {
        sent += 1;
        return cognitiveClient().complete(request);
      },
    };
    // A ceiling nothing can fit under: the gate must stop in front of the send.
    const tiny = loadProfile("m5-pilot", { limits: { maxStandardInputTokens: 1 } });
    const opts = options(out, client, { config: tiny });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("paused_input_limit");
    expect(sent).toBe(0);
  });

  it("keeps the hard cap at 250,000 in the pilot itself", () => {
    expect(PILOT.limits.maxStandardInputTokens).toBe(250_000);
    expect(CONTEXT_BUDGET.hardCeilingTokens).toBe(250_000);
  });
});

describe("bounds telemetry", () => {
  it("records violations instead of truncating the field", async () => {
    const out = tempOut();
    const tooLong = "很".repeat(400);
    const client = cognitiveClient({
      mutate: (c) => ({
        ...c,
        // Well over `evidenceChars`. The run must continue AND say so.
        seatReads: [
          {
            seat: 2,
            standing: "unresolved",
            evidenceFor: [tooLong],
            evidenceAgainst: [],
            lastChangeReason: "",
          },
        ],
      }),
    });
    const opts = options(out, client, { config: PILOT });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("completed");

    const reports = priv<unknown>(
      readFileSync(result.privatePath!, "utf8"),
      "cognition-telemetry",
    )[0] as unknown as Report[];
    expect(reports.some((r) => r.boundsViolations > 0)).toBe(true);

    // And the text is still whole — no silent semantic truncation.
    const stored = readFileSync(result.privatePath!, "utf8");
    expect(stored).toContain(tooLong.slice(0, 200));
  });

  it("reports zero violations on a well-behaved run", async () => {
    const { reports } = await playPilot();
    for (const r of reports) expect(r.boundsViolations).toBe(0);
  });
});
