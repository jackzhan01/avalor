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
import { PROMPT_VERSION_COGNITIVE_V2 } from "../prompts/version";
import { parseJsonl, type PrivateTraceLine, type PublicReplayLine } from "../run/artifacts";
import { parseCheckpoint } from "../run/checkpoint";
import { preflight, runLiveGame } from "../run/live-game";
import { CONTEXT_BUDGET } from "./limits";
import { CognitionStore } from "./store";
import { cognitiveClient } from "./scripted-cognitive-client";
import { coordinationReport, type PublicRecord, type SocialObservation } from "./metrics";

/**
 * The M5.1 pilot, played end to end offline under the EXACT pilot profile.
 *
 * `loadProfile("m5-1-pilot")` — the same call the CLI makes, not a config that
 * merely resembles it. The M5 pilot's own rehearsal established that habit and
 * this one keeps it.
 *
 * What this file is FOR, beyond "it runs": the completed pilot shipped with a
 * defect nothing offline could see, because nothing offline was checking that
 * the model could resolve what the prompt showed it. The headline assertion
 * here is `premisesVerified > 0` — a number that was structurally zero for an
 * entire paid game.
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

const PILOT = loadProfile("m5-1-pilot");
const SEED = 1;
const tempOut = () => mkdtempSync(join(tmpdir(), "avalon-m51-"));

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
  premisesVerified: number;
  premisesFromClaims: number;
  unmatchedClosures: number;
  registrySize: number;
  boundsViolations: number;
  utilisation: Record<string, unknown>;
  packSections: Record<string, number>;
  estimatedTokens: number;
  overSoftTarget: boolean;
  social: {
    focalCandidates: { seat: number; restsOnUnverified: boolean }[];
    stance: string | null;
    focalSeat: number | null;
    proposition: string;
    publicAction: string;
    coordinateWith: number[];
    proposedTeam: number[] | null;
    votingBloc: string;
  } | null;
};

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

describe("the scripted M5.1 pilot completes", () => {
  it("plays a whole game under the real profile", async () => {
    const { result } = await playPilot();
    expect(result.status).toBe("completed");
    expect(result.outcome).toMatch(/good|evil/);
    expect(fetchCalls).toBe(0);
  });

  it("needs no repairs of any kind", async () => {
    const { result } = await playPilot();
    expect(result.cognitionRepairs).toBe(0);
    expect(result.capacityRetries).toBe(0);
    expect(result.retries).toBe(0);
  });

  it("makes a cognition update on every decision", async () => {
    const { result, reports } = await playPilot();
    const actions = priv<unknown>(readFileSync(result.privatePath!, "utf8"), "action").length;
    expect(reports).toHaveLength(actions);
  });
});

describe("the fact-id repair, measured", () => {
  it("resolves the premises the model cites — the number that was zero", async () => {
    const { reports } = await playPilot();
    const verified = reports.reduce((a, r) => a + r.premisesVerified, 0);
    const unknown = reports.reduce((a, r) => a + r.premisesOverridden, 0);
    expect(verified).toBeGreaterThan(0);
    // The completed pilot's 871 citations all landed here. This double cites
    // only ids it read out of the rendered prompt, so nothing should.
    expect(unknown).toBe(0);
  });

  it("leaves no constraint resting on an unverified premise, in this run", async () => {
    const { reports } = await playPilot();
    const unverified = reports.reduce(
      (a, r) => a + Number(r.utilisation.unverifiedConstraints ?? 0),
      0,
    );
    // 144 of 154 responses carried one in the completed pilot, structurally.
    expect(unverified).toBe(0);
  });

  it("offers a registry that grows as the game produces facts", async () => {
    const { reports } = await playPilot();
    expect(reports[0].registrySize).toBeGreaterThan(0);
    expect(Math.max(...reports.map((r) => r.registrySize))).toBeGreaterThan(
      reports[0].registrySize,
    );
  });

  it("prints the legend in every request", async () => {
    const { seen } = await playPilot();
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(request.user).toContain("怎么引用");
  });
});

describe("the social block reaches the ledger and comes back", () => {
  it("records an alignment on every decision", async () => {
    const { reports } = await playPilot();
    for (const r of reports) {
      expect(r.social, `${r.seat}/${r.taskId}`).toBeTruthy();
      expect(r.social!.stance).toBeTruthy();
    }
  });

  it("computes restsOnUnverified for a focal read, never accepts it", async () => {
    const { reports } = await playPilot();
    const reads = reports.flatMap((r) => r.social?.focalCandidates ?? []);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(typeof read.restsOnUnverified).toBe("boolean");
  });

  it("renders the previous turn's social model back into the next prompt", async () => {
    const { seen } = await playPilot();
    const withSocial = seen.filter((r) => r.user.includes("你对牌桌的读"));
    expect(withSocial.length).toBeGreaterThan(0);
  });

  it("produces enough structure for the coordination metrics to run", async () => {
    const { reports, publicText } = await playPilot();
    const observations: SocialObservation[] = reports
      .filter((r) => r.social)
      .map((r) => ({
        seat: r.seat as SocialObservation["seat"],
        taskId: r.taskId,
        atSequence: Number(r.utilisation.seat ?? 0) * 0 + reports.indexOf(r),
        focalCandidates: r.social!.focalCandidates.map((f) => ({
          seat: f.seat as SocialObservation["seat"],
          influence: "medium" as const,
          credibility: "contested" as const,
          restsOnUnverified: f.restsOnUnverified,
        })),
        stance: r.social!.stance as SocialObservation["stance"],
        focalSeat: r.social!.focalSeat as SocialObservation["focalSeat"],
        proposition: r.social!.proposition,
        publicAction: r.social!.publicAction,
        coordinateWith: r.social!.coordinateWith as SocialObservation["coordinateWith"],
        proposedTeam: r.social!.proposedTeam as SocialObservation["proposedTeam"],
        votingBloc: r.social!.votingBloc as SocialObservation["votingBloc"],
      }));
    const record: PublicRecord = {
      votes: [],
      proposals: [],
      missions: [],
      speeches: pub<{ speaker: number; publicMessage: string; sequence: number }>(
        publicText,
        "event",
      )
        .filter((e) => typeof e.publicMessage === "string" && e.speaker !== undefined)
        .map((e) => ({
          speaker: e.speaker as SocialObservation["seat"],
          publicMessage: e.publicMessage,
          atSequence: e.sequence,
        })),
    };
    const report = coordinationReport(observations, record);
    expect(report.stances.total).toBe(observations.length);
    expect(report.graph.length).toBeGreaterThan(0);
  });
});

describe("ten ledgers stay isolated", () => {
  it("files every report under the seat whose memory changed", async () => {
    const { reports } = await playPilot();
    for (const r of reports) expect(r.utilisation.seat).toBe(r.seat);
    expect(new Set(reports.map((r) => r.seat)).size).toBeGreaterThan(5);
  });

  it("gives every seat its own slot", () => {
    const store = new CognitionStore();
    const state = createGame({ seed: SEED, config: PILOT });
    for (const seat of SEATS) {
      expect(store.for(observationFor(state, seat)).seat).toBe(seat);
    }
  });
});

describe("cognition and the social model survive a checkpoint", () => {
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

  it("pauses, restores ten ledgers WITH their social models, and finishes", async () => {
    const out = tempOut();
    const first = options(out, limited(24), { config: PILOT });
    const paused = await runLiveGame(first, preflight(first));
    expect(paused.status).toBe("paused_provider_interruption");

    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    expect(checkpoint.cognition!.seats).toHaveLength(10);
    expect(checkpoint.maxOutputTokens).toBe(12_000);

    const withSocial = checkpoint.cognition!.seats.filter(
      (s) => (s as { social?: unknown }).social,
    );
    expect(withSocial.length).toBeGreaterThan(0);

    const again = options(out, cognitiveClient(), {
      config: PILOT,
      resumeFrom: checkpoint,
      gameId: checkpoint.gameId,
    });
    const resumed = await runLiveGame(again, preflight(again));
    expect(resumed.status).toBe("completed");
    expect(fetchCalls).toBe(0);
  });

  it("keeps premise ids resolving after a resume", async () => {
    const out = tempOut();
    const first = options(out, limited(24), { config: PILOT });
    const paused = await runLiveGame(first, preflight(first));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const again = options(out, cognitiveClient(), {
      config: PILOT,
      resumeFrom: checkpoint,
      gameId: checkpoint.gameId,
    });
    const resumed = await runLiveGame(again, preflight(again));
    const reports = priv<unknown>(
      readFileSync(resumed.privatePath!, "utf8"),
      "cognition-telemetry",
    )[0] as unknown as Report[];
    // Ids come from sequence numbers, so a rebuilt position mints the same set.
    // If it did not, every constraint written before the pause would decay to
    // unverified the moment the game resumed.
    expect(reports.reduce((a, r) => a + r.premisesVerified, 0)).toBeGreaterThan(0);
    expect(reports.reduce((a, r) => a + r.premisesOverridden, 0)).toBe(0);
  });
});

describe("what the artifacts record", () => {
  it("stamps 0.3.1, expert-social, the fingerprint and the 12,000 cap", async () => {
    const { result, privateText, publicText } = await playPilot();

    const manifest = priv<Record<string, unknown>>(privateText, "private-manifest")[0];
    expect(manifest.promptVersion).toBe(PROMPT_VERSION_COGNITIVE_V2);
    expect(manifest.strategyId).toBe("expert-social");
    expect(manifest.strategyFingerprint).toBe(
      strategyFingerprint(strategyById("expert-social")),
    );
    expect(manifest.maxOutputTokens).toBe(12_000);

    const meta = pub<Record<string, unknown>>(publicText, "public-metadata")[0];
    expect(meta.promptVersion).toBe(PROMPT_VERSION_COGNITIVE_V2);
    expect(meta.strategyId).toBe("expert-social");
    expect(result.maxOutputTokens).toBe(12_000);
  });

  it("sends 12,000 on every request", async () => {
    const { seen } = await playPilot();
    for (const request of seen) expect(request.maxOutputTokens).toBe(12_000);
  });

  it("leaks no ledger or social content into the public replay", async () => {
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
      // The social block, which is the new private surface.
      "focalCandidates",
      "conditionToReconsider",
      "coalitionPlan",
      "strongestDissent",
      "reasonsToFollow",
      "reasonsToChallenge",
      "closedCommitments",
    ]) {
      expect(publicText, field).not.toContain(field);
    }
  });

  it("keeps the strategy fingerprint out of the public artifact", async () => {
    const { publicText } = await playPilot();
    expect(publicText).not.toContain("strategyFingerprint");
  });
});

describe("size gates", () => {
  it("stays far below the 60K soft target", async () => {
    const { reports } = await playPilot();
    for (const r of reports) {
      expect(r.overSoftTarget).toBe(false);
      expect(r.estimatedTokens).toBeLessThan(CONTEXT_BUDGET.softTargetTokens);
    }
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
    const tiny = loadProfile("m5-1-pilot", { limits: { maxStandardInputTokens: 1 } });
    const opts = options(out, client, { config: tiny });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("paused_input_limit");
    expect(sent).toBe(0);
  });

  it("keeps the hard cap at 250,000", () => {
    expect(PILOT.limits.maxStandardInputTokens).toBe(250_000);
  });

  it("reports bounds violations instead of truncating", async () => {
    const out = tempOut();
    const tooLong = "很".repeat(400);
    const client = cognitiveClient({
      mutate: (c) => ({
        ...c,
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
    expect(readFileSync(result.privatePath!, "utf8")).toContain(tooLong.slice(0, 200));
  });
});

describe("a broken social block is repaired, then refused", () => {
  it("re-asks when the social block is unusable, and records WHY", async () => {
    const out = tempOut();
    let firstOnly = true;
    const client = cognitiveClient({
      mutate: (c) => {
        if (!firstOnly) return c;
        firstOnly = false;
        // The M5.1 analogue of the pilot's empty `premiseIds`: a focal read
        // with no public basis at all.
        const social = c.social as { focalCandidates: Record<string, unknown>[] };
        return {
          ...c,
          social: {
            ...social,
            focalCandidates: [{ ...social.focalCandidates[0], basisIds: [] }],
          },
        };
      },
    });
    const opts = options(out, client, { config: PILOT });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("completed");
    // `retries` counts malformed ACTIONS only — the action here was fine, and
    // conflating the two counters is what produced a wrong report last time.
    expect(result.retries).toBe(0);
    expect(result.cognitionRepairs).toBeGreaterThan(0);

    const attempts = priv<{ rejectedBy?: string; rejectionReason?: string }>(
      readFileSync(result.privatePath!, "utf8"),
      "model-call",
    );
    const rejected = attempts.filter((a) => a.rejectedBy);
    expect(rejected.length).toBeGreaterThan(0);
    // The whole point of the field: the trace says which half failed.
    expect(rejected[0].rejectedBy).toBe("cognition");
    expect(rejected[0].rejectionReason).toContain("basisIds");
  });
});
