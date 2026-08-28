import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertProfileCoherent,
  isProfileName,
  loadConfig,
  loadProfile,
  PROFILE_NAMES,
} from "./load";
import { PROMPT_VERSION_COGNITIVE, PROMPT_VERSION_LEGACY } from "../prompts/version";
import { assignPersonas } from "../prompts/personas";
import { SEATS } from "../core/types";

/**
 * A named profile, so running an experiment never means editing the baseline.
 *
 * `default.json` is what makes Experiments 2 and 3 rebuildable from a
 * checkout. Every one of these tests is ultimately about that: the pilot gets
 * its own file, the default keeps its own values, and no combination that
 * would produce a mislabelled artifact loads at all.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("config tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the M5 pilot profile", () => {
  it("is a real named profile, not an ad-hoc override bundle", () => {
    expect(PROFILE_NAMES).toContain("m5-pilot");
    expect(isProfileName("m5-pilot")).toBe(true);
    expect(isProfileName("nope")).toBe(false);
  });

  it("carries exactly the pilot's decided values", () => {
    const config = loadProfile("m5-pilot");
    expect(config.promptVersion).toBe(PROMPT_VERSION_COGNITIVE);
    expect(config.cognition.enabled).toBe(true);
    expect(config.cognition.mode).toBe("fused");
    expect(config.cognition.maxCognitionRepairs).toBe(2);
    expect(config.limits.maxOutputTokens).toBe(20_000);
    expect(config.experiment.strategyProfile).toBe("expert-cognitive");
    expect(config.experiment.personaMode).toBe("heterogeneous-rotated");
  });

  it("inherits everything it does not mention", () => {
    const pilot = loadProfile("m5-pilot");
    const base = loadConfig();
    expect(pilot.model.id).toBe(base.model.id);
    expect(pilot.model.reasoningEffort).toBe(base.model.reasoningEffort);
    expect(pilot.limits.maxStandardInputTokens).toBe(250_000);
    expect(pilot.budget).toEqual(base.budget);
    expect(pilot.pricing).toEqual(base.pricing);
    expect(pilot.simulatorVersion).toBe(base.simulatorVersion);
  });

  it("leaves the legacy default completely alone", () => {
    // The whole reason the profile is a separate file.
    const base = loadConfig();
    expect(base.promptVersion).toBe(PROMPT_VERSION_LEGACY);
    expect(base.cognition.enabled).toBe(false);
    expect(base.limits.maxOutputTokens).toBe(12_000);
    expect(base.experiment.strategyProfile).toBe("baseline");
  });

  it("keeps the seat→persona mapping Experiment 3 used", () => {
    // `heterogeneous-rotated` at the same seed must resolve identically, or the
    // pilot is not standing where Experiment 3 stood.
    const pilot = loadProfile("m5-pilot");
    const personas = assignPersonas(1, pilot.experiment.personaMode);
    expect(SEATS.map((s) => personas[s].id)).toEqual([
      "connector",
      "steady",
      "mediator",
      "terse",
      "gambler",
      "ledger",
      "direct",
      "challenger",
      "listener",
      "skeptic",
    ]);
  });

  it("strips $comment keys rather than validating them as fields", () => {
    // The profile documents itself in-file; a validator meeting `$comment`
    // would report a field nobody set.
    expect(() => loadProfile("m5-pilot")).not.toThrow();
    expect(loadProfile("m5-pilot")).not.toHaveProperty("$comment");
  });

  it("accepts caller overrides on top", () => {
    const config = loadProfile("m5-pilot", { limits: { maxOutputTokens: 9_000 } });
    expect(config.limits.maxOutputTokens).toBe(9_000);
    // And the rest of the profile survives the override.
    expect(config.cognition.enabled).toBe(true);
  });
});

describe("incompatible combinations do not load", () => {
  it("refuses cognition on the legacy prompt version", () => {
    expect(() => loadConfig({ cognition: { enabled: true } })).toThrow(/prompt-0\.3\.0/);
  });

  it("refuses the cognitive version without cognition", () => {
    expect(() => loadConfig({ promptVersion: PROMPT_VERSION_COGNITIVE })).toThrow(
      /prompt-0\.2\.0/,
    );
  });

  it("refuses expert-cognitive on the legacy path", () => {
    // Its obligations are recorded through the cognition block; on the old
    // stack they would be advice with nowhere to land.
    expect(() =>
      assertProfileCoherent("test", loadConfig({ experiment: { strategyProfile: "expert-cognitive" } })),
    ).toThrow(/需要 cognition\.enabled=true/);
  });

  it("refuses a frozen historical arm under cognition", () => {
    // Refused at LOAD, not on a later call somebody could forget to make.
    expect(() =>
      loadProfile("m5-pilot", { experiment: { strategyProfile: "community-meta" } }),
    ).toThrow(/历史臂/);

    // And the check itself is exported, so a caller assembling a config by
    // hand can run the same rule.
    const byHand = loadConfig({
      promptVersion: PROMPT_VERSION_COGNITIVE,
      cognition: { enabled: true },
      experiment: { strategyProfile: "community-meta" },
    });
    expect(() => assertProfileCoherent("byHand", byHand)).toThrow(/历史臂/);
  });

  it("refuses an unimplemented cognition mode", () => {
    expect(() => loadConfig({ cognition: { mode: "two-pass-critical" as never } })).toThrow(
      /fused/,
    );
  });

  it("runs the coherence check as part of loading a profile", () => {
    // Not a separate step a caller could forget.
    expect(() =>
      loadProfile("m5-pilot", { experiment: { strategyProfile: "baseline" } }),
    ).toThrow(/历史臂/);
  });
});

describe("legacy commands still resolve to the legacy path", () => {
  it("gives a no-profile load the seven-layer stack", () => {
    const config = loadConfig();
    expect(config.cognition.enabled).toBe(false);
    expect(config.promptVersion).toBe(PROMPT_VERSION_LEGACY);
  });

  it("lets the two frozen arms load exactly as before", () => {
    for (const arm of ["baseline", "community-meta"] as const) {
      const config = loadConfig({ experiment: { strategyProfile: arm } });
      expect(() => assertProfileCoherent("legacy", config)).not.toThrow();
      expect(config.limits.maxOutputTokens).toBe(12_000);
    }
  });
});
