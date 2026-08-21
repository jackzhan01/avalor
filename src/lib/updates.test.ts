import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LATEST_VERSION,
  UPDATES,
  hasUnseenUpdates,
  lastSeenVersion,
  markUpdatesSeen,
} from "./updates";

/**
 * The update log is content, so most of it cannot be tested. What can be, and
 * is worth it: that the badge logic works, that it survives a browser which
 * refuses to store anything, and that the entries stay in an order a reader
 * can follow.
 */

function stubStorage(store: Map<string, string> | null) {
  vi.stubGlobal("window", {
    localStorage: store
      ? {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
        }
      : {
          // Private browsing, or storage full. Both throw here.
          getItem: () => {
            throw new Error("denied");
          },
          setItem: () => {
            throw new Error("denied");
          },
        },
  });
}

describe("the unread badge", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts someone who has never looked as having something to read", () => {
    stubStorage(new Map());
    expect(lastSeenVersion()).toBeNull();
    expect(hasUnseenUpdates()).toBe(true);
  });

  it("goes quiet once the current version has been seen", () => {
    const store = new Map<string, string>();
    stubStorage(store);
    markUpdatesSeen();
    expect(lastSeenVersion()).toBe(LATEST_VERSION);
    expect(hasUnseenUpdates()).toBe(false);
  });

  it("comes back when a newer version ships", () => {
    const store = new Map<string, string>();
    stubStorage(store);
    markUpdatesSeen("0.1");
    expect(hasUnseenUpdates()).toBe(true);
  });

  it("does not blow up when storage refuses", () => {
    stubStorage(null);
    // Private browsing throws on both reads and writes. The cost of that is
    // one extra red dot, never a crash.
    expect(() => lastSeenVersion()).not.toThrow();
    expect(() => markUpdatesSeen()).not.toThrow();
    expect(hasUnseenUpdates()).toBe(true);
  });

  it("survives being asked on the server, where there is no window", () => {
    vi.stubGlobal("window", undefined);
    expect(lastSeenVersion()).toBeNull();
    expect(() => markUpdatesSeen()).not.toThrow();
  });
});

describe("the entries themselves", () => {
  it("puts the newest first", () => {
    const dates = UPDATES.map((u) => u.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(UPDATES[0].version).toBe(LATEST_VERSION);
  });

  it("has no duplicate versions", () => {
    const seen = new Set(UPDATES.map((u) => u.version));
    expect(seen.size).toBe(UPDATES.length);
  });

  it("says something in every entry", () => {
    for (const entry of UPDATES) {
      expect(entry.title.length).toBeGreaterThan(2);
      expect(entry.highlights.length).toBeGreaterThan(0);
      for (const line of entry.highlights) expect(line.length).toBeGreaterThan(4);
    }
  });

  it("admits what is wrong with the version being shipped", () => {
    // Not a style rule. Shipping a known problem in silence is how a release
    // note stops being worth reading, and this is the release that has some.
    expect(UPDATES[0].caveats?.length).toBeGreaterThan(0);
  });
});
