/**
 * The ONLY module allowed to import `dexie`.
 *
 * Everything else goes through `repository.ts`. That single rule is what keeps
 * server rendering safe: IndexedDB does not exist on the server, so if a Dexie
 * import were reachable from a component's module graph, `next build` would
 * fail (or worse, fail only at request time).
 */

import Dexie, { type Table } from "dexie";
import type { GameRecord } from "@/lib/types/game";
import type { GameEvent } from "@/lib/types/events";

export interface MetaRecord {
  key: string;
  value: unknown;
}

export class AvalonDB extends Dexie {
  games!: Table<GameRecord, string>;
  events!: Table<GameEvent, string>;
  meta!: Table<MetaRecord, string>;

  constructor() {
    super("avalon-live-notebook");
    this.version(1).stores({
      games: "id, updatedAt, createdAt, status",
      // &[gameId+sequence] is unique: it makes the primary load an index scan
      // with no client-side sort, AND turns a two-tab sequence collision into a
      // catchable ConstraintError instead of silent corruption.
      events:
        "id, gameId, &[gameId+sequence], [gameId+type], [gameId+missionNumber]",
      meta: "key",
    });
    // Do not add indexes casually — writes sit on the tap path.
  }
}

let instance: AvalonDB | null = null;

/**
 * Lazy singleton. Throws loudly on the server rather than failing mysteriously
 * later — a development-time error beats a production surprise.
 */
export function getDb(): AvalonDB {
  if (typeof window === "undefined") {
    throw new Error(
      "getDb() was called during server rendering. IndexedDB is browser-only — " +
        "call it from an effect or an event handler, never during render.",
    );
  }
  if (!instance) instance = new AvalonDB();
  return instance;
}

/** Re-exported so repository.ts can build range queries without importing Dexie. */
export const MIN_KEY = Dexie.minKey;
export const MAX_KEY = Dexie.maxKey;
