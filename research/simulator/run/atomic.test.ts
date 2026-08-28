import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic";

/**
 * A checkpoint whose partial state is worse than its absence.
 *
 * A truncated JSON file is not a checkpoint that failed to save; it is a
 * checkpoint that will fail to PARSE, which looks like a resume point and is
 * not one. So every write lands via a temp file in the same directory followed
 * by a rename.
 */

function temp(): string {
  return mkdtempSync(join(tmpdir(), "avalon-atomic-"));
}

describe("atomic writes", () => {
  it("writes the file", () => {
    const dir = temp();
    const path = join(dir, "a.json");
    writeFileAtomic(path, '{"ok":true}\n');
    expect(readFileSync(path, "utf8")).toBe('{"ok":true}\n');
  });

  it("creates the parent directory when it does not exist yet", () => {
    const dir = temp();
    const path = join(dir, "private", "deep", "a.json");
    writeFileAtomic(path, "x");
    expect(existsSync(path)).toBe(true);
  });

  it("leaves no temporary file behind", () => {
    const dir = temp();
    writeFileAtomic(join(dir, "a.json"), "x");
    writeFileAtomic(join(dir, "b.json"), "y");
    // A stray `.tmp` beside a real artifact is the thing a batch would later
    // pick up and try to parse.
    expect(readdirSync(dir).sort()).toEqual(["a.json", "b.json"]);
  });

  it("replaces an existing file wholesale, never appending", () => {
    const dir = temp();
    const path = join(dir, "a.json");
    writeFileSync(path, "a very long previous version that must not survive", "utf8");
    writeFileAtomic(path, "short");
    expect(readFileSync(path, "utf8")).toBe("short");
  });

  it("keeps the previous version when the new write fails", () => {
    const dir = temp();
    const path = join(dir, "a.json");
    writeFileAtomic(path, "good");
    // A directory where the temp file wants to go is the simplest way to make
    // the write fail after the destination already holds something valid.
    expect(() => writeFileAtomic(join(dir, "sub"), "x")).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("good");
  });

  it("survives two writes to the same path in one process", () => {
    const dir = temp();
    const path = join(dir, "a.json");
    // Random temp suffixes rather than a pid: two writers in one process would
    // otherwise collide on the same temp name.
    writeFileAtomic(path, "one");
    writeFileAtomic(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });
});
