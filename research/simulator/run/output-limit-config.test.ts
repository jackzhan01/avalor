import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { fixedGameId } from "../core/game-id";
import { answeringClient } from "../model/scripted-client";
import { ModelCallError, type ModelClient, type ModelRequest } from "../model/client";
import {
  parseCheckpoint,
  resumeFromCheckpoint,
  CHECKPOINT_SCHEMA,
} from "./checkpoint";
import {
  parseJsonl,
  type PrivateTraceLine,
  type PublicReplayLine,
} from "./artifacts";
import { preflight, runLiveGame, effectiveMaxOutputTokens } from "./live-game";

/**
 * The output cap is an experiment parameter, so it has to be readable off the
 * experiment's own record.
 *
 * The first paid game ran under a hard-coded 2000 that lived in two source
 * files, matched nothing in `config/default.json`, and therefore appeared in
 * neither artifact. The only `maxOutputTokens` a reader could find in the
 * public replay was `smoke.maxOutputTokens: 1000` — a different number, for a
 * different thing, actively misleading. These tests keep that from recurring.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("this suite must not make network calls");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const GAME_ID = fixedGameId("outcap");

function tempOut(): string {
  return mkdtempSync(join(tmpdir(), "avalon-outcap-"));
}

function options(out: string, client: ModelClient, extra: Record<string, unknown> = {}) {
  return { seed: 3, gameId: GAME_ID, outDir: out, client, ...extra };
}

/** Answers normally for `budget` requests, then throws a recoverable error. */
function limitedClient(budget: number): ModelClient {
  const inner = answeringClient();
  let sent = 0;
  return {
    name: "limited",
    async complete(request: ModelRequest) {
      if (sent >= budget) {
        throw new ModelCallError(503, "server_error", "overloaded", "stand-in");
      }
      sent += 1;
      return inner.complete(request);
    },
  };
}

const pub = <T,>(text: string, t: string): T[] =>
  (parseJsonl<PublicReplayLine>(text) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data as T);

const priv = <T,>(text: string, t: string): T[] =>
  (parseJsonl<PrivateTraceLine>(text) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data as T);

describe("limits.maxOutputTokens", () => {
  it("is 12000 in the shipped configuration", () => {
    expect(loadConfig().limits.maxOutputTokens).toBe(12000);
  });

  it("is validated like every other limit", () => {
    expect(() => loadConfig({ limits: { maxOutputTokens: 0 } })).toThrow();
    expect(() => loadConfig({ limits: { maxOutputTokens: -1 } })).toThrow();
    expect(() => loadConfig({ limits: { maxOutputTokens: 1.5 } })).toThrow();
  });

  it("is not the smoke-test limit, and the two never collapse into one", () => {
    const config = loadConfig();
    // Different numbers for different jobs: the smoke test is one tiny request
    // with a hard $0.10 ceiling; a full game is hundreds of reasoning-heavy
    // ones. Reading the smoke value as the game value is what made the first
    // game's artifact misleading.
    expect(config.smoke.maxOutputTokens).toBe(1000);
    expect(config.limits.maxOutputTokens).toBe(12000);
    expect(config.limits.maxOutputTokens).not.toBe(config.smoke.maxOutputTokens);
  });

  it("resolves from config with no hard-coded fallback", () => {
    const config = loadConfig();
    expect(effectiveMaxOutputTokens(config)).toBe(12000);
    expect(effectiveMaxOutputTokens(config, 9_000)).toBe(9_000);
    // A config that says 777 wins over any constant that used to live in code.
    expect(effectiveMaxOutputTokens(loadConfig({ limits: { maxOutputTokens: 777 } }))).toBe(777);
  });
});

describe("the effective cap reaches every record", () => {
  it("appears in the cost projection a human approves", () => {
    const opts = options(tempOut(), answeringClient());
    expect(preflight(opts).projection.maxOutputTokens).toBe(12000);
  });

  it("appears in the public experiment metadata", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient());
    const result = await runLiveGame(opts, preflight(opts));
    const meta = pub<Record<string, unknown>>(readFileSync(result.publicPath!, "utf8"), "public-metadata")[0];

    expect(meta.maxOutputTokens).toBe(12000);
    // And it is not confusable with the smoke number sitting in the same file.
    expect((meta.config as { smoke: { maxOutputTokens: number } }).smoke.maxOutputTokens).toBe(1000);
    expect((meta.config as { limits: { maxOutputTokens: number } }).limits.maxOutputTokens).toBe(12000);
  });

  it("appears in the private research trace", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient());
    const result = await runLiveGame(opts, preflight(opts));
    const manifest = priv<Record<string, unknown>>(readFileSync(result.privatePath!, "utf8"), "private-manifest")[0];

    expect(manifest.maxOutputTokens).toBe(12000);
  });

  it("appears in the final report", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient());
    const result = await runLiveGame(opts, preflight(opts));

    expect(result.maxOutputTokens).toBe(12000);
    expect(result.capacityRetries).toBe(0);
  });

  it("appears in the checkpoint, under a bumped schema", async () => {
    const out = tempOut();
    const opts = options(out, limitedClient(20));
    const paused = await runLiveGame(opts, preflight(opts));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    expect(checkpoint.schema).toBe(CHECKPOINT_SCHEMA);
    expect(checkpoint.maxOutputTokens).toBe(12000);
  });

  it("follows an override rather than the config, when one is given", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient(), { maxOutputTokens: 4_242 });
    const result = await runLiveGame(opts, preflight(opts));
    const meta = pub<Record<string, unknown>>(readFileSync(result.publicPath!, "utf8"), "public-metadata")[0];

    // The artifact describes what was SENT, not what was configured. An
    // artifact that disagreed with its own requests is worse than a silent one.
    expect(meta.maxOutputTokens).toBe(4_242);
    expect(result.maxOutputTokens).toBe(4_242);
  });
});

describe("a resume under a different cap is refused", () => {
  it("refuses, naming the field", async () => {
    const out = tempOut();
    const opts = options(out, limitedClient(20));
    const paused = await runLiveGame(opts, preflight(opts));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    const context = {
      config: loadConfig(),
      personaMode: checkpoint.personaMode,
      personaAssignment: Object.fromEntries(
        checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
      ) as never,
      strategyId: checkpoint.strategyId,
      cognitionEnabled: false,
    };

    expect(() =>
      resumeFromCheckpoint(checkpoint, { ...context, maxOutputTokens: 2_000 }),
    ).toThrow(/maxOutputTokens/);
    // Raising the cap is the right fix for exhaustion — but it starts a NEW
    // experiment, not the second half of this one.
    expect(() =>
      resumeFromCheckpoint(checkpoint, { ...context, maxOutputTokens: 24_000 }),
    ).toThrow(/换了实验/);
  });

  it("accepts the same cap", async () => {
    const out = tempOut();
    const opts = options(out, limitedClient(20));
    const paused = await runLiveGame(opts, preflight(opts));
    const checkpoint = parseCheckpoint(readFileSync(paused.checkpointPath!, "utf8"));

    expect(() =>
      resumeFromCheckpoint(checkpoint, {
        config: loadConfig(),
        personaMode: checkpoint.personaMode,
        personaAssignment: Object.fromEntries(
          checkpoint.personaAssignment.map((e) => [e.seat, { id: e.persona }]),
        ) as never,
        strategyId: checkpoint.strategyId,
        maxOutputTokens: checkpoint.maxOutputTokens,
        cognitionEnabled: false,
      }),
    ).not.toThrow();
  });
});

describe("the Lady results round-trip", () => {
  it("are written to the private trace, not merely built in memory", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient());
    const result = await runLiveGame(opts, preflight(opts));
    const text = readFileSync(result.privatePath!, "utf8");
    const lines = priv<Record<number, unknown[]>>(text, "lady-results");

    // The regression: `PrivateResearchTrace.ladyResults` existed on the object
    // and was silently dropped by the serialiser, so the type promised a
    // round-trip the file could not deliver.
    expect(lines).toHaveLength(1);
    const results = lines[0];
    expect(results).toBeTruthy();
    for (const seat of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(Array.isArray(results[seat])).toBe(true);
    }
  });

  it("carry the true side, and agree with the private lady_result events", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient());
    const result = await runLiveGame(opts, preflight(opts));
    const text = readFileSync(result.privatePath!, "utf8");

    const serialised = priv<Record<number, { target: number; trueSide: string }[]>>(
      text,
      "lady-results",
    )[0];
    const events = priv<{ type: string; holder: number; target: number; trueSide: string }>(
      text,
      "private-event",
    ).filter((e) => e.type === "lady_result");

    const flat = Object.entries(serialised).flatMap(([holder, list]) =>
      list.map((r) => `${holder}:${r.target}:${r.trueSide}`),
    );
    expect(flat.length).toBe(events.length);
    for (const event of events) {
      expect(flat).toContain(`${event.holder}:${event.target}:${event.trueSide}`);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it("never reach the public replay, in any form", async () => {
    const out = tempOut();
    const opts = options(out, answeringClient());
    const result = await runLiveGame(opts, preflight(opts));
    const publicText = readFileSync(result.publicPath!, "utf8");

    // Byte-level, because this is the assertion that matters: a public replay
    // carrying the Lady's truth hands every downstream evaluation the answer.
    expect(publicText).not.toContain("trueSide");
    expect(publicText).not.toContain("lady-results");
    expect(publicText).not.toContain("ladyResults");
    expect(publicText).not.toContain("lady_result");
    // What a holder ANNOUNCED is public and must still be there.
    expect(publicText).toContain("lady_announced");
  });
});
