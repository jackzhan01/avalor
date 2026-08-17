import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL,
  clearByok,
  loadByok,
  maskKey,
  saveByok,
  validateKey,
} from "./byok";

/**
 * The storage round trip matters more than it looks: `loadByok` returning a
 * malformed config would send a broken request with the user's credential
 * attached, and returning null when a key IS stored would silently spend our
 * quota instead of theirs. Both directions are covered.
 */

function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

describe("validateKey", () => {
  it("rejects blank, short, and whitespace-bearing input", () => {
    expect(validateKey("")).toBeTruthy();
    expect(validateKey("   ")).toBeTruthy();
    expect(validateKey("sk-short")).toBeTruthy();
    expect(validateKey("sk-abc def ghijklmnopqrstuv")).toBeTruthy();
  });

  it("accepts a plausible key", () => {
    expect(validateKey("sk-proj-abcdefghijklmnopqrstuvwxyz")).toBeNull();
  });

  it("accepts keys that are not OpenAI-shaped", () => {
    // A regex demanding `sk-` would lock out every compatible provider.
    expect(validateKey("qwen-1234567890abcdefghijklmn")).toBeNull();
  });
});

describe("maskKey", () => {
  it("shows enough to recognise and not enough to use", () => {
    const masked = maskKey("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX9A");
    expect(masked).toBe("sk-proj-…WX9A");
    expect(masked).not.toContain("IJKLMNOP");
  });

  it("reveals nothing at all for a short string", () => {
    expect(maskKey("short")).toBe("•••••");
  });
});

describe("storage round trip", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and loads a full config", () => {
    installStorage();
    saveByok({ key: "sk-test-abcdefghijklmnop", model: "gpt-x", baseUrl: "https://x.dev/v1" });
    expect(loadByok()).toEqual({
      key: "sk-test-abcdefghijklmnop",
      model: "gpt-x",
      baseUrl: "https://x.dev/v1",
    });
  });

  it("fills in the default model and omits an empty base url", () => {
    installStorage();
    saveByok({ key: "sk-test-abcdefghijklmnop", model: "  ", baseUrl: "  " });
    const loaded = loadByok();
    expect(loaded?.model).toBe(DEFAULT_MODEL);
    expect(loaded?.baseUrl).toBeUndefined();
  });

  it("returns null after clearing", () => {
    installStorage();
    saveByok({ key: "sk-test-abcdefghijklmnop", model: "gpt-x" });
    clearByok();
    expect(loadByok()).toBeNull();
  });

  it("returns null for a stored blob that is junk or keyless", () => {
    const data = installStorage();
    data.set("avalor.ai.byok.v1", "not json at all");
    expect(loadByok()).toBeNull();
    data.set("avalor.ai.byok.v1", JSON.stringify({ model: "gpt-x" }));
    expect(loadByok()).toBeNull();
  });

  it("returns null on the server, where there is no localStorage", () => {
    vi.unstubAllGlobals();
    expect(loadByok()).toBeNull();
  });

  it("survives storage throwing (private mode) rather than crashing", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadByok()).toBeNull();
    expect(() => saveByok({ key: "sk-test-abcdefghijklmnop", model: "m" })).not.toThrow();
    expect(() => clearByok()).not.toThrow();
  });
});
