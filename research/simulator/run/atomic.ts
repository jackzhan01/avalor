/**
 * Writing a file that is never half-written.
 *
 * A checkpoint is the one artifact whose partial state is worse than its
 * absence: a truncated JSON file is not a checkpoint that failed to save, it
 * is a checkpoint that will fail to PARSE, and a run that crashed mid-write
 * would leave behind something that looks like a resume point and is not.
 * Same for a JSONL trace that a batch might later read.
 *
 * So every write goes to a temporary file IN THE SAME DIRECTORY and is then
 * renamed over the destination. The same-directory part is load-bearing:
 * `rename` is only atomic within a filesystem, and a temp file in the OS temp
 * dir may well be on another one, in which case Node falls back to a copy and
 * the guarantee is gone.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write `text` to `path`, atomically.
 *
 * Creates the parent directory if needed — callers only ever reach this after
 * their own preflight has passed, so a directory appearing here is intended.
 */
export function writeFileAtomic(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Random suffix rather than a pid: two runs writing the same path in one
  // process would otherwise collide on their temp names.
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    // Leave nothing behind on a failed write. The destination keeps whatever
    // it had, which is the previous good version or nothing at all.
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the cleanup failing must not mask the real error */
    }
    throw error;
  }
}
