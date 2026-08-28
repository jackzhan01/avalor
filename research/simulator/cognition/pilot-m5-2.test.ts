import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../config/load";
import { observationFor } from "../core/observation";
import { createGame } from "../core/referee";
import { SEATS, type Seat } from "../core/types";
import { ModelCallError, type ModelClient, type ModelRequest } from "../model/client";
import { strategyFingerprint, strategyById } from "../prompts/strategies";
import { PROMPT_VERSION_CONTEST } from "../prompts/version";
import { parseJsonl, type PrivateTraceLine, type PublicReplayLine } from "../run/artifacts";
import { parseCheckpoint } from "../run/checkpoint";
import { preflight, runLiveGame } from "../run/live-game";
import { CONTEXT_BUDGET } from "./limits";
import { CognitionStore } from "./store";
import { claimContestFrom } from "./claim-contest";
import { cognitiveClient, contestingClient } from "./scripted-cognitive-client";
import {
  claimTimeline,
  contestReport,
  type ContestObservation,
} from "./metrics-contest";
import type { PublicRecord } from "./metrics";

/**
 * The M5.2 pilot, played end to end offline under the EXACT pilot profile.
 *
 * `loadProfile("m5-2-pilot")` — the same call the CLI makes. Two doubles are
 * used: the quiet one, which claims nothing, and `contestingClient`, which puts
 * three seats on Percival and retracts one of them. Only the second exercises
 * the thing this milestone is about, and only the first proves the machinery
 * does not REQUIRE a contest to run.
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

const PILOT = loadProfile("m5-2-pilot");
const SEED = 1;
const tempOut = () => mkdtempSync(join(tmpdir(), "avalon-m52-"));

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
  premisesVerified: number;
  premisesOverridden: number;
  boundsViolations: number;
  estimatedTokens: number;
  overSoftTarget: boolean;
  packSections: Record<string, number>;
  utilisation: Record<string, unknown>;
  contest: {
    ownClaimStatus: string;
    act: string;
    targetSeats: number[];
    stance: string;
    selectedClaimant: number | null;
    assessments: { seat: number; level: string; publicStatus: string; restsOnUnverified: boolean }[];
    rivalSeats: number[];
  } | null;
};

/** The contesting double: three claimants, one retraction, one attacker. */
async function playContested() {
  const out = tempOut();
  const seen: ModelRequest[] = [];
  const opts = options(
    out,
    contestingClient({
      claimSeats: [2, 5, 8],
      retractSeats: [5],
      attackSeats: [2],
      onRequest: (r) => seen.push(r),
    }),
    { config: PILOT },
  );
  const result = await runLiveGame(opts, preflight(opts));
  const privateText = readFileSync(result.privatePath!, "utf8");
  const publicText = readFileSync(result.publicPath!, "utf8");
  const reports = (priv<unknown>(privateText, "cognition-telemetry")[0] ?? []) as Report[];
  return { result, seen, privateText, publicText, reports };
}

/** The quiet double: nobody claims anything, all game. */
async function playQuiet() {
  const out = tempOut();
  const opts = options(out, cognitiveClient(), { config: PILOT });
  const result = await runLiveGame(opts, preflight(opts));
  const privateText = readFileSync(result.privatePath!, "utf8");
  const reports = (priv<unknown>(privateText, "cognition-telemetry")[0] ?? []) as Report[];
  return { result, privateText, publicText: readFileSync(result.publicPath!, "utf8"), reports };
}

describe("the scripted M5.2 pilot completes", () => {
  it("plays a whole contested game under the real profile", async () => {
    const { result } = await playContested();
    expect(result.status).toBe("completed");
    expect(result.outcome).toMatch(/good|evil/);
    expect(fetchCalls).toBe(0);
  });

  it("plays a whole game where nobody claims, too", async () => {
    // The contest layer must not REQUIRE a contest. A table that never claims
    // is exactly what the M5 pilot produced, and it has to remain legal.
    const { result } = await playQuiet();
    expect(result.status).toBe("completed");
    expect(result.cognitionRepairs).toBe(0);
    expect(result.retries).toBe(0);
  });

  it("needs no repairs when the double plays inside the rules", async () => {
    const { result } = await playContested();
    expect(result.cognitionRepairs).toBe(0);
    expect(result.capacityRetries).toBe(0);
    expect(result.retries).toBe(0);
  });

  it("makes a cognition update on every decision", async () => {
    const { result, reports } = await playContested();
    const actions = priv<unknown>(readFileSync(result.privatePath!, "utf8"), "action").length;
    expect(reports).toHaveLength(actions);
  });
});

describe("the public contest reaches the table", () => {
  it("records three claims and one retraction in the public replay", async () => {
    const { publicText } = await playContested();
    const events = pub<{ type: string; claim?: string; retractClaim?: boolean; speaker?: number }>(
      publicText,
      "event",
    );
    const claims = events.filter((e) => e.type === "speech" && e.claim === "percival");
    const retractions = events.filter((e) => e.type === "speech" && e.retractClaim === true);
    expect(new Set(claims.map((e) => e.speaker)).size).toBe(3);
    expect(retractions).toHaveLength(1);
  });

  it("derives the contest from the public replay alone", async () => {
    const { publicText } = await playContested();
    const events = pub<Record<string, unknown>>(publicText, "event");
    const contest = claimContestFrom(events as never);
    const timeline = claimTimeline(contest);
    expect(timeline.percivalClaims).toBe(3);
    expect(timeline.retractions).toBe(1);
    expect(timeline.counterclaims).toBeGreaterThan(0);
    // Two claimed and stayed; one withdrew.
    expect(contest.activePercivalClaimants).toHaveLength(2);
    expect(contest.retractedPercivalClaimants).toHaveLength(1);
  });

  it("renders the contest table into every prompt after the first claim", async () => {
    const { seen } = await playContested();
    const withTable = seen.filter((r) => r.user.includes("正在争派西维尔的"));
    expect(withTable.length).toBeGreaterThan(10);
  });

  it("keeps the withdrawn claim visible after the retraction", async () => {
    const { seen } = await playContested();
    const after = seen.filter((r) => r.user.includes("公开退水"));
    expect(after.length).toBeGreaterThan(0);
    // The whole point: what was retracted is still there to be judged.
    expect(after[after.length - 1].user).toContain("退的是 seq");
  });
});

describe("the private block folds in and comes back", () => {
  it("records a contest model on every decision", async () => {
    const { reports } = await playContested();
    for (const r of reports) expect(r.contest, `${r.seat}/${r.taskId}`).toBeTruthy();
  });

  it("takes public status from the referee, never from the model", async () => {
    const { reports, publicText } = await playContested();
    const contest = claimContestFrom(pub<Record<string, unknown>>(publicText, "event") as never);
    const assessed = reports.flatMap((r) => r.contest?.assessments ?? []);
    expect(assessed.length).toBeGreaterThan(0);
    for (const a of assessed) {
      expect(["active", "contested", "retracted", "implied", "none"]).toContain(a.publicStatus);
    }
    // And the final reads agree with the referee's final record.
    const last = reports[reports.length - 1];
    for (const a of last.contest?.assessments ?? []) {
      expect(a.publicStatus).toBe(contest.bySeat[a.seat as Seat]?.status);
    }
  });

  it("resolves the premises the model cites", async () => {
    const { reports } = await playContested();
    expect(reports.reduce((a, r) => a + r.premisesVerified, 0)).toBeGreaterThan(0);
    expect(reports.reduce((a, r) => a + r.premisesOverridden, 0)).toBe(0);
  });

  it("renders the contest model back into the next prompt", async () => {
    const { seen } = await playContested();
    expect(seen.some((r) => r.user.includes("你在派权争夺里的位置"))).toBe(true);
  });

  it("produces enough structure for the contest metrics to run", async () => {
    const { reports, publicText } = await playContested();
    const contest = claimContestFrom(pub<Record<string, unknown>>(publicText, "event") as never);
    const observations: ContestObservation[] = reports
      .filter((r) => r.contest)
      .map((r, i) => ({
        seat: r.seat as Seat,
        taskId: r.taskId,
        atSequence: i,
        ownClaimStatus: r.contest!.ownClaimStatus,
        act: r.contest!.act,
        targetSeats: r.contest!.targetSeats as Seat[],
        requestedTeam: null,
        requestedVote: "none",
        stance: r.contest!.stance,
        selectedClaimant: r.contest!.selectedClaimant as Seat | null,
        assessments: r.contest!.assessments.map((a) => ({ ...a, seat: a.seat as Seat })),
        rivalSeats: r.contest!.rivalSeats as Seat[],
      }));
    const record: PublicRecord = { votes: [], proposals: [], missions: [], speeches: [] };
    const report = contestReport(observations, contest, record);
    expect(report.timeline.percivalClaims).toBe(3);
    expect(report.attacks.length).toBeGreaterThan(0);
    expect(report.retractions).toHaveLength(1);
    // No reveal supplied: the hidden-truth sections stay null.
    expect(report.roles).toBeNull();
    expect(report.capture).toBeNull();
  });
});

describe("ten ledgers stay isolated", () => {
  it("files every report under the seat whose memory changed", async () => {
    const { reports } = await playContested();
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

describe("the contest survives a checkpoint", () => {
  function limited(budget: number): ModelClient {
    const inner = contestingClient({ claimSeats: [2, 5, 8], retractSeats: [5], attackSeats: [2] });
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

  it("pauses, restores ten ledgers WITH their contest models, and finishes", async () => {
    const out = tempOut();
    const first = options(out, limited(26), { config: PILOT });
    const paused = await runLiveGame(first, preflight(first));
    expect(paused.status).toBe("paused_provider_interruption");

    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    expect(checkpoint.cognition!.seats).toHaveLength(10);
    expect(checkpoint.maxOutputTokens).toBe(12_000);
    const withContest = checkpoint.cognition!.seats.filter(
      (s) => (s as { contest?: unknown }).contest,
    );
    expect(withContest.length).toBeGreaterThan(0);

    const again = options(
      out,
      contestingClient({ claimSeats: [2, 5, 8], retractSeats: [5], attackSeats: [2] }),
      { config: PILOT, resumeFrom: checkpoint, gameId: checkpoint.gameId },
    );
    const resumed = await runLiveGame(again, preflight(again));
    expect(resumed.status).toBe("completed");
    expect(fetchCalls).toBe(0);
  });
});

describe("what the artifacts record", () => {
  it("stamps 0.4.0, expert-claim-contest, the fingerprint and the 12,000 cap", async () => {
    const { result, privateText, publicText } = await playContested();
    const manifest = priv<Record<string, unknown>>(privateText, "private-manifest")[0];
    expect(manifest.promptVersion).toBe(PROMPT_VERSION_CONTEST);
    expect(manifest.strategyId).toBe("expert-claim-contest");
    expect(manifest.strategyFingerprint).toBe(
      strategyFingerprint(strategyById("expert-claim-contest")),
    );
    expect(manifest.maxOutputTokens).toBe(12_000);

    const meta = pub<Record<string, unknown>>(publicText, "public-metadata")[0];
    expect(meta.promptVersion).toBe(PROMPT_VERSION_CONTEST);
    expect(meta.strategyId).toBe("expert-claim-contest");
    expect(result.maxOutputTokens).toBe(12_000);
  });

  it("sends 12,000 on every request", async () => {
    const { seen } = await playContested();
    for (const request of seen) expect(request.maxOutputTokens).toBe(12_000);
  });

  it("leaks no private contest field into the public replay", async () => {
    const { publicText } = await playContested();
    for (const field of [
      // M5 / M5.1 surfaces.
      "hypotheses",
      "seatReads",
      "coverStory",
      "focalCandidates",
      "coalitionPlan",
      // The new one.
      "ownClaimStrategy",
      "situationSpecificBenefit",
      "triggerToClaim",
      "triggerToRetract",
      "candidatePairStory",
      "claimantAssessments",
      "currentAssessment",
      "conditionToUpgrade",
      "rivalPlans",
      "attackCase",
      "expectedDefense",
      "riskOfOverattacking",
      "distinctionTest",
      "publicClaimMove",
      "informationToConceal",
      "restsOnUnverified",
    ]) {
      expect(publicText, field).not.toContain(field);
    }
  });

  it("does put the public half in the replay, so the test above is not vacuous", async () => {
    const { publicText } = await playContested();
    // The claim itself IS public. If none of this were here, "nothing leaked"
    // would just mean "nothing was written".
    expect(publicText).toContain("percival");
    expect(publicText).toContain("retractClaim");
  });
});

describe("size gates", () => {
  it("stays far below the 60K soft target even with a live contest", async () => {
    const { reports } = await playContested();
    for (const r of reports) {
      expect(r.overSoftTarget).toBe(false);
      expect(r.estimatedTokens).toBeLessThan(CONTEXT_BUDGET.softTargetTokens);
    }
  });

  it("reports the contest table as its own pack section", async () => {
    const { reports } = await playContested();
    expect(reports[0].packSections).toHaveProperty("claimContest");
    const grew = reports[reports.length - 1].packSections.claimContest;
    expect(grew).toBeGreaterThan(reports[0].packSections.claimContest);
  });

  it("costs nothing extra on a table where nobody claims", async () => {
    const quiet = await playQuiet();
    const contested = await playContested();
    const peak = (rs: Report[]) => Math.max(...rs.map((r) => r.packSections.claimContest));
    // The section is size-driven by how much the table is FIGHTING, not by how
    // long the game is — which is why it is its own section.
    expect(peak(quiet.reports)).toBeLessThan(peak(contested.reports));
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
    const tiny = loadProfile("m5-2-pilot", { limits: { maxStandardInputTokens: 1 } });
    const opts = options(out, client, { config: tiny });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("paused_input_limit");
    expect(sent).toBe(0);
  });
});

describe("a structurally broken contest block is re-asked, and recorded", () => {
  it("re-asks when a claimant ignores a rival, and says why", async () => {
    const out = tempOut();
    let once = true;
    const client = contestingClient({
      claimSeats: [2, 5, 8],
      mutate: (c) => {
        const contest = c.contest as Record<string, unknown> | undefined;
        if (!once || !contest) return c;
        const assessments = contest.claimantAssessments as unknown[];
        if (assessments.length === 0) return c;
        once = false;
        // Drop one standing claimant from the comparison — the exact failure
        // `contestProblems` exists to refuse.
        return { ...c, contest: { ...contest, claimantAssessments: [] } };
      },
    });
    const opts = options(out, client, { config: PILOT });
    const result = await runLiveGame(opts, preflight(opts));
    expect(result.status).toBe("completed");
    expect(result.cognitionRepairs).toBeGreaterThan(0);

    const attempts = priv<{ rejectedBy?: string; rejectionReason?: string }>(
      readFileSync(result.privatePath!, "utf8"),
      "model-call",
    );
    const rejected = attempts.filter((a) => a.rejectedBy);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0].rejectedBy).toBe("cognition");
    expect(rejected[0].rejectionReason).toContain("派权争夺不能只看自己");
  });
});
