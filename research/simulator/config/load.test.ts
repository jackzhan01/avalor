import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "./load";

describe("configuration", () => {
  it("loads the shipped defaults", () => {
    const config = loadConfig();
    expect(config.playerCount).toBe(10);
    expect(config.simulatorVersion).toMatch(/^sim-/);
    expect(config.promptVersion).toMatch(/^prompt-/);
    expect(config.model.id).toBe("gpt-5.6-terra");
    expect(config.model.reasoningEffort).toBe("high");
    expect(config.limits.speechCharLimit).toBe(220);
    expect(config.limits.maxStandardInputTokens).toBe(250_000);
    expect(config.limits.maxLiveCallsPerGame).toBe(600);
    expect(config.budget).toEqual({
      costWarningPerGameUsd: 12,
      hardCostLimitPerGameUsd: 25,
      hardBatchCostLimitUsd: 100,
    });
  });

  /**
   * The reason this file exists at all. A literal model id at a call site is
   * how a run stops being reproducible — six weeks later nobody can say which
   * model produced a table.
   */
  it("carries the model id and its parameters, and lets a run override them", () => {
    expect(loadConfig().model.id).toBeTruthy();
    const custom = loadConfig({
      model: { id: "some-other-model", reasoningEffort: "low", params: { temperature: 0 } },
      // The shipped price table is for gpt-5.6-terra. A run on another model
      // has to supply its own table or turn costing off — both are legal,
      // silently costing one model at another's rates is not.
      pricing: { configured: false },
    });
    expect(custom.model.id).toBe("some-other-model");
    expect(custom.model.reasoningEffort).toBe("low");
    expect(custom.model.params).toEqual({ temperature: 0 });
  });

  it("rejects a setting nobody declared, instead of ignoring it", () => {
    expect(() =>
      loadConfig({ limits: { notAThing: 1 } as unknown as { speechCharLimit: number } }),
    ).toThrow(ConfigError);
  });

  it("rejects values of the wrong shape", () => {
    expect(() => loadConfig({ model: { id: "" } })).toThrow(ConfigError);
    expect(() => loadConfig({ limits: { speechCharLimit: 0 } })).toThrow(ConfigError);
    expect(() => loadConfig({ run: { concurrency: -1 } })).toThrow(ConfigError);
    expect(() => loadConfig({ limits: { maxLiveCallsPerGame: 0 } })).toThrow(ConfigError);
    expect(() => loadConfig({ limits: { speechCharLimit: 1.5 } })).toThrow(ConfigError);
  });

  it("is fixed at ten players", () => {
    expect(loadConfig().playerCount).toBe(10);
  });

  it("redacts anything that looks like a credential before it reaches a manifest", () => {
    const config = loadConfig({
      model: { id: "m", params: { apiKey: "sk-should-never-appear", temperature: 0.4 } },
      pricing: { configured: false },
    });
    const safe = redactConfig(config);
    expect(safe.model.params.apiKey).toBe("[redacted]");
    expect(safe.model.params.temperature).toBe(0.4);
    expect(JSON.stringify(safe)).not.toContain("sk-should-never-appear");
  });
});
