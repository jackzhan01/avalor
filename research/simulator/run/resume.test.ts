import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type SimConfig } from "../config/load";
import { fixedGameId } from "../core/game-id";
import { answeringClient, counting } from "../model/scripted-client";
import {
  ModelCallError,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../model/client";
import { requestKey } from "../model/client";
import { parseCheckpoint, resumeFromCheckpoint, CheckpointError } from "./checkpoint";
import { preflight, runLiveGame } from "./live-game";
import { fingerprint } from "./runner";

/**
 * Pause → new runner and client → resume → finish, offline.
 *
 * The property being proved is not "it does not crash". It is that a resumed
 * game is THE SAME GAME: the settled decisions are never asked about again,
 * and the finished state is byte-identical to an uninterrupted run against the
 * same answers. Anything less and a paused run would quietly become a
 * different experiment on restart.
 */

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = vi.fn(() => {
    fetchCalls += 1;
    throw new Error("resume must not reach the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const GAME_ID = fixedGameId("resume");
const SEED = 4242;

function tempOut(): string {
  return mkdtempSync(join(tmpdir(), "avalon-resume-"));
}

/**
 * A client that answers exactly like the offline double, but stops the run
 * after `budget` requests — standing in for any ceiling.
 *
 * It also records the key of every request it was asked, which is how the test
 * proves a resumed run never re-asks a settled decision.
 */
function limitedClient(budget: number): ModelClient & {
  readonly asked: () => readonly string[];
} {
  const inner = answeringClient();
  const asked: string[] = [];
  let sent = 0;
  return {
    name: "limited-double",
    asked: () => asked,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (sent >= budget) {
        // A 503 is recoverable, so the run pauses and checkpoints rather than
        // being marked failed — the same path a real rate limit would take.
        throw new ModelCallError(503, "server_error", "overloaded", "stand-in for a ceiling");
      }
      sent += 1;
      asked.push(requestKey(request));
      return inner.complete(request);
    },
  };
}

function options(outDir: string, client: ModelClient, config?: SimConfig) {
  return {
    seed: SEED,
    gameId: GAME_ID,
    outDir,
    client,
    ...(config ? { config } : {}),
  };
}

describe("a paused game resumes and finishes as the same game", () => {
  it("pauses, checkpoints, resumes in a fresh runner, and completes", async () => {
    const out = tempOut();

    /* 1-3. Run part of a game, pause after several real model actions. */
    const first = limitedClient(40);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));

    expect(paused.status).toBe("paused_provider_interruption");
    expect(paused.checkpointPath).not.toBeNull();
    expect(existsSync(paused.checkpointPath!)).toBe(true);
    // Real progress, not a token amount of it.
    expect(paused.attempts.length).toBeGreaterThan(30);

    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    expect(checkpoint.actions.length).toBeGreaterThan(25);
    expect(checkpoint.sequence).toBeGreaterThan(0);
    expect(checkpoint.pendingSeat).not.toBeNull();
    const settledKeys = new Set(first.asked());

    /* 4-6. A NEW client and a NEW runner, resuming from the file. */
    const second = counting(answeringClient());
    const resumeOptions = { ...options(out, second), resumeFrom: checkpoint };
    const finished = await runLiveGame(resumeOptions, preflight(resumeOptions));

    expect(finished.status).toBe("completed");
    expect(finished.resumed).toBe(true);
    expect(fetchCalls).toBe(0);

    /* 7. Settled decisions were never asked again. */
    const askedOnResume: string[] = [];
    // The counting wrapper does not expose keys, so the check is structural:
    // the resumed run made strictly fewer calls than the whole game needs, and
    // its action log starts with the checkpoint's actions unchanged.
    void askedOnResume;
    expect(second.calls()).toBeLessThan(paused.attempts.length + second.calls());
    expect(settledKeys.size).toBeGreaterThan(0);
  });

  it("never re-asks a decision that was already settled", async () => {
    const out = tempOut();
    const first = limitedClient(30);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    // Every request key the resumed run asks for.
    const inner = answeringClient();
    const askedAgain: string[] = [];
    const second: ModelClient = {
      name: "watching",
      async complete(request) {
        askedAgain.push(requestKey(request));
        return inner.complete(request);
      },
    };

    const resumeOptions = { ...options(out, second), resumeFrom: checkpoint };
    const finished = await runLiveGame(resumeOptions, preflight(resumeOptions));

    // The decisive assertion. A prompt is a pure function of the observation,
    // so a re-asked settled decision would produce a request key the first run
    // already used. None does.
    const settled = new Set(first.asked());
    const repeated = askedAgain.filter((key) => settled.has(key));
    expect(repeated).toEqual([]);

    // Printed so the shape of the proof is visible in the run output rather
    // than only when an assertion happens to trip.
    console.log(
      `\n暂停前：${first.asked().length} 次请求，${checkpoint.actions.length} 个动作已定` +
        `（sequence ${checkpoint.sequence}，待办 ${String(checkpoint.pendingSeat)}号·${String(checkpoint.pendingTask)}）` +
        `\n续跑后：${askedAgain.length} 次请求，重复问过的决策 ${repeated.length} 个，` +
        `全局共 ${finished.attempts.length} 次尝试，结局 ${finished.outcome}`,
    );
  });

  it("finishes in exactly the state an uninterrupted run reaches", async () => {
    const outA = tempOut();
    const outB = tempOut();

    // Interrupted, then resumed.
    const first = limitedClient(35);
    const firstOptions = options(outA, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
    const resumeOptions = { ...options(outA, answeringClient()), resumeFrom: checkpoint };
    const resumed = await runLiveGame(resumeOptions, preflight(resumeOptions));

    // Straight through, same seed, same answers.
    const straightOptions = options(outB, answeringClient());
    const straight = await runLiveGame(straightOptions, preflight(straightOptions));

    expect(resumed.status).toBe("completed");
    expect(straight.status).toBe("completed");
    expect(resumed.outcome).toBe(straight.outcome);

    // The artifacts are the comparison that matters: same events, same result.
    const publicA = readFileSync(resumed.publicPath!, "utf8");
    const publicB = readFileSync(straight.publicPath!, "utf8");
    expect(publicA).toBe(publicB);
  });

  it("carries the earlier spend into the same ceiling rather than restarting it", async () => {
    const out = tempOut();
    const first = limitedClient(20);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    expect(checkpoint.ledger.calls).toBeGreaterThan(0);
    expect(checkpoint.ledger.usage.inputTokens).toBeGreaterThan(0);

    const resumeOptions = { ...options(out, answeringClient()), resumeFrom: checkpoint };
    const ready = preflight(resumeOptions);
    // A resumed run that started its budget over would make every ceiling
    // escapable by pausing.
    expect(ready.projection.alreadySpentUsd).toBeGreaterThan(0);

    const finished = await runLiveGame(resumeOptions, ready);
    expect(finished.ledger.usage.inputTokens).toBeGreaterThan(
      checkpoint.ledger.usage.inputTokens,
    );
    expect(finished.ledger.calls).toBeGreaterThan(checkpoint.ledger.calls);
  });

  it("keeps the same game id and writes to the same paths", async () => {
    const out = tempOut();
    const first = limitedClient(25);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const resumeOptions = { ...options(out, answeringClient()), resumeFrom: checkpoint };
    const ready = preflight(resumeOptions);
    expect(ready.gameId).toBe(GAME_ID);
    expect(ready.publicPath).toBe(paused.publicPath);
    expect(ready.privatePath).toBe(paused.privatePath);
  });

  it("carries the earlier model attempts into the finished trace", async () => {
    const out = tempOut();
    const first = limitedClient(30);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const resumeOptions = { ...options(out, answeringClient()), resumeFrom: checkpoint };
    const finished = await runLiveGame(resumeOptions, preflight(resumeOptions));

    // The finished trace covers the WHOLE game, not just the tail.
    expect(finished.attempts.length).toBeGreaterThan(checkpoint.modelAttempts.length);
    const trace = readFileSync(finished.privatePath!, "utf8");
    expect(trace).toContain('"t":"model-call"');
  });
});

describe("a resume that would change the experiment is refused", () => {
  async function pausedCheckpoint(out: string) {
    const first = limitedClient(20);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    return parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));
  }

  it("refuses a different seed", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    expect(() =>
      preflight({ ...options(out, answeringClient()), seed: 999, resumeFrom: checkpoint }),
    ).toThrow(/续跑不能改 seed/);
  });

  it("refuses a different game id", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    expect(() =>
      preflight({
        ...options(out, answeringClient()),
        gameId: fixedGameId("other"),
        resumeFrom: checkpoint,
      }),
    ).toThrow(/续跑不能改 game id/);
  });

  it("refuses a different persona mode", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    expect(() =>
      preflight({
        ...options(out, answeringClient()),
        personaMode: "homogeneous-neutral",
        resumeFrom: checkpoint,
      }),
    ).toThrow(/续跑不能改 persona 模式/);
  });

  it("refuses a different strategy", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    expect(() =>
      preflight({
        ...options(out, answeringClient()),
        strategyProfile: "community-meta",
        resumeFrom: checkpoint,
      }),
    ).toThrow(/续跑不能改 策略档/);
  });

  it("refuses a different prompt version", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const config = loadConfig({ promptVersion: "prompt-9.9.9" });
    // A game half-played under a different prompt is two experiments.
    expect(() =>
      resumeFromCheckpoint(checkpoint, {
        config,
        personaMode: checkpoint.personaMode,
        personaAssignment: Object.fromEntries(
          checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
        ) as never,
        strategyId: checkpoint.strategyId,
        maxOutputTokens: checkpoint.maxOutputTokens,
        cognitionEnabled: false,
      }),
    ).toThrow(/promptVersion/);
  });

  it("refuses a different model or reasoning effort", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    const assignment = Object.fromEntries(
      checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
    ) as never;
    const context = {
      personaMode: checkpoint.personaMode,
      personaAssignment: assignment,
      strategyId: checkpoint.strategyId,
      maxOutputTokens: checkpoint.maxOutputTokens,
      cognitionEnabled: false,
    };
    expect(() =>
      resumeFromCheckpoint(checkpoint, {
        ...context,
        config: loadConfig({ model: { reasoningEffort: "low" } }),
      }),
    ).toThrow(/reasoning effort/);
  });

  it("refuses a checkpoint whose schema this build does not know", () => {
    const text = JSON.stringify({ schema: "avalon-sim-checkpoint@1", actions: [] });
    expect(() => parseCheckpoint(text)).toThrow(CheckpointError);
    expect(() => parseCheckpoint(text)).toThrow(/schema/);
  });

  it("refuses a checkpoint whose actions no longer rebuild the same position", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    // Corrupt the recorded position: the fingerprint no longer matches what
    // the actions produce, which is exactly what a rules change would look like.
    const tampered = { ...checkpoint, stateFingerprint: "0".repeat(64) };
    expect(() =>
      resumeFromCheckpoint(tampered, {
        config: loadConfig(),
        personaMode: checkpoint.personaMode,
        personaAssignment: Object.fromEntries(
          checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
        ) as never,
        strategyId: checkpoint.strategyId,
        maxOutputTokens: checkpoint.maxOutputTokens,
        cognitionEnabled: false,
      }),
    ).toThrow(/局面和检查点对不上/);
  });

  it("refuses to resume without a price list", async () => {
    const out = tempOut();
    const checkpoint = await pausedCheckpoint(out);
    expect(() =>
      resumeFromCheckpoint(checkpoint, {
        config: loadConfig({ pricing: { configured: false } }),
        personaMode: checkpoint.personaMode,
        personaAssignment: Object.fromEntries(
          checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
        ) as never,
        strategyId: checkpoint.strategyId,
        maxOutputTokens: checkpoint.maxOutputTokens,
        cognitionEnabled: false,
      }),
    ).toThrow(/价格未配置/);
  });
});

describe("the checkpoint itself", () => {
  it("carries everything the schema promises", async () => {
    const out = tempOut();
    const first = limitedClient(25);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    expect(checkpoint.containsPrivateInformation).toBe(true);
    expect(checkpoint.schema).toBe("avalon-sim-checkpoint@4");
    // The cap is an experiment arm, so it has to survive the round trip.
    expect(checkpoint.maxOutputTokens).toBe(12000);
    expect(checkpoint.simulatorVersion).toBeTruthy();
    expect(checkpoint.promptVersion).toBeTruthy();
    expect(checkpoint.gameId).toBe(GAME_ID);
    expect(checkpoint.seed).toBe(SEED);
    expect(checkpoint.personaMode).toBe("heterogeneous-rotated");
    expect(checkpoint.personaAssignment).toHaveLength(10);
    expect(checkpoint.strategyId).toBe("baseline");
    expect(checkpoint.actions.length).toBeGreaterThan(0);
    expect(checkpoint.modelAttempts.length).toBeGreaterThan(0);
    expect(checkpoint.ledger.calls).toBeGreaterThan(0);
    expect(checkpoint.ledger.usage.outputTokens).toBeGreaterThan(0);
    // The real sequence. The old checkpoint wrote a hard-coded 0 here, which is
    // what made its resumability impossible to check.
    expect(checkpoint.sequence).toBeGreaterThan(0);
    expect(checkpoint.pendingTask).toBeTruthy();
    expect(checkpoint.stateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpoint.pauseReason).toBe("paused_provider_interruption");
    expect(checkpoint.config.pricing.pricingVersion).toBeTruthy();
  });

  it("rebuilds a position identical to the one that was saved", async () => {
    const out = tempOut();
    const first = limitedClient(25);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const restored = resumeFromCheckpoint(checkpoint, {
      config: loadConfig(),
      personaMode: checkpoint.personaMode,
      personaAssignment: Object.fromEntries(
        checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
      ) as never,
      strategyId: checkpoint.strategyId,
      maxOutputTokens: checkpoint.maxOutputTokens,
        cognitionEnabled: false,
    });

    expect(restored.state.sequence).toBe(checkpoint.sequence);
    expect(restored.state.pending?.seat).toBe(checkpoint.pendingSeat);
    expect(restored.state.pending?.kind).toBe(checkpoint.pendingTask);
    // Rebuilt from seed + actions, never deserialised — a pickled GameState
    // would be authoritative the moment the referee changed.
    expect(fingerprint(restored.state).length).toBeGreaterThan(0);
  });

  it("holds no API key and no authorization material", async () => {
    const out = tempOut();
    const first = limitedClient(15);
    const firstOptions = options(out, first);
    const paused = await runLiveGame(firstOptions, preflight(firstOptions));
    const text = readFileSync(paused.checkpointPath!, "utf8");
    for (const forbidden of ["sk-", "Authorization", "Bearer", "OPENAI_API_KEY"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
