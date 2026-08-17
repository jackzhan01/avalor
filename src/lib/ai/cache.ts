/**
 * The last AI result per game and task, kept so reopening the sheet does not
 * buy the same answer twice.
 *
 * Every call costs real money, and the sheet used to throw its result away on
 * close — so glancing back at an analysis you had just read billed for it
 * again. Persisted rather than held in memory for the same reason: a reload,
 * or a walk through the timeline tab and back, must not be a purchase.
 *
 * Stored alongside it is a signature of the log it was computed from, which is
 * what lets the UI answer the question that actually matters: has anything
 * happened since? If nothing has, a re-run would spend money to produce the
 * same paragraphs, and the button says so instead of letting you find out.
 */

import * as repo from "@/lib/db/repository";
import type { GameEvent } from "@/lib/types/events";
import type { AiTask, AnalysisResult, SpeechResult } from "./types";

export interface CachedRun {
  signature: string;
  createdAt: string;
  /** The steer the speech was generated with, so 「换一版」 starts where you left off. */
  steer?: string;
  result: AnalysisResult | SpeechResult;
}

/**
 * Cheap fingerprint of the log.
 *
 * Count and highest sequence together, because neither alone is enough:
 * sequences are never reused, so deleting one event and recording another
 * leaves the count identical while the maximum moves — and deleting the most
 * recent event lowers the maximum while the count also drops. Both change
 * unless the log is genuinely untouched.
 */
export function boardSignature(events: GameEvent[]): string {
  const highest = events.reduce((max, e) => Math.max(max, e.sequence), 0);
  return `${events.length}:${highest}`;
}

/*
 * `game:<id>:` prefixes anything scoped to one game, which is the convention
 * repository.deleteGame sweeps — so these do not outlive the game they
 * describe.
 */
const key = (gameId: string, task: AiTask) => `game:${gameId}:ai:${task}`;

export async function readCachedRun(
  gameId: string,
  task: AiTask,
): Promise<CachedRun | null> {
  return repo.readSetting<CachedRun>(key(gameId, task));
}

export async function writeCachedRun(
  gameId: string,
  task: AiTask,
  run: CachedRun,
): Promise<void> {
  await repo.writeSetting(key(gameId, task), run);
}
