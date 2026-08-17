/**
 * Every IndexedDB read and write, and all transaction boundaries.
 *
 * Browser-only: call from effects and event handlers, never during render.
 */

import { getDb, MIN_KEY, MAX_KEY } from "./db";
import type { GameRecord, Player, PlayerCount, RoleSetConfig } from "@/lib/types/game";
import type { GameEvent } from "@/lib/types/events";
import { newId } from "@/lib/utils/id";

export interface GameSummary {
  id: string;
  name?: string;
  playerCount: number;
  status: GameRecord["status"];
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

export interface LoadedGame {
  game: GameRecord;
  /** Ascending by sequence — guaranteed by the compound index, not by a sort. */
  events: GameEvent[];
}

export interface CreateGameInput {
  playerCount: PlayerCount;
  /** Names are optional; seats are not. */
  names?: Record<number, string | undefined>;
  roleSet?: RoleSetConfig;
  /** Seat number of the first leader. Defaults to seat 1. */
  firstLeaderSeat?: number;
  /**
   * Which seat the user is sitting in. Anchors them to six o'clock on the
   * round table. Defaults to seat 1, which is the right assumption when a
   * group doesn't call each other by number.
   */
  viewerSeat?: number;
  /** Whether 湖中女神 is in play. */
  ladyEnabled?: boolean;
  name?: string;
}

export function buildGame(input: CreateGameInput): GameRecord {
  const now = new Date().toISOString();
  const players: Player[] = Array.from(
    { length: input.playerCount },
    (_, i) => {
      const seat = i + 1;
      const name = input.names?.[seat]?.trim();
      return { id: newId(), seat, ...(name ? { name } : {}) };
    },
  );
  const firstSeat = input.firstLeaderSeat ?? 1;
  const firstLeader =
    players.find((p) => p.seat === firstSeat) ?? players[0];
  const viewer =
    players.find((p) => p.seat === (input.viewerSeat ?? 1)) ?? players[0];

  return {
    id: newId(),
    schemaVersion: 1,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    playerCount: input.playerCount,
    players,
    ...(input.roleSet ? { roleSet: input.roleSet } : {}),
    firstLeaderId: firstLeader.id,
    viewerPlayerId: viewer.id,
    ...(input.ladyEnabled ? { ladyEnabled: true } : {}),
    status: "active",
    winningSide: null,
    lastSequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createGame(input: CreateGameInput): Promise<GameRecord> {
  const game = buildGame(input);
  await getDb().games.add(game);
  return game;
}

export async function loadGame(gameId: string): Promise<LoadedGame | null> {
  const db = getDb();
  const game = await db.games.get(gameId);
  if (!game) return null;
  const events = await db.events
    .where("[gameId+sequence]")
    .between([gameId, MIN_KEY], [gameId, MAX_KEY])
    .toArray();
  return { game, events };
}

export async function listRecentGames(limit = 30): Promise<GameSummary[]> {
  const db = getDb();
  const games = await db.games
    .orderBy("updatedAt")
    .reverse()
    .limit(limit)
    .toArray();

  return Promise.all(
    games.map(async (g) => ({
      id: g.id,
      name: g.name,
      playerCount: g.playerCount,
      status: g.status,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      eventCount: await db.events.where("gameId").equals(g.id).count(),
    })),
  );
}

/** Every game plus its event count, for the personal stats page. */
export async function listAllGames(): Promise<{
  games: GameRecord[];
  eventCounts: Record<string, number>;
}> {
  const db = getDb();
  const games = await db.games.orderBy("createdAt").reverse().toArray();
  const eventCounts: Record<string, number> = {};
  for (const game of games) {
    eventCounts[game.id] = await db.events
      .where("gameId")
      .equals(game.id)
      .count();
  }
  return { games, eventCounts };
}

/** Append one event and bump the game's durable sequence counter atomically. */
export async function appendEvent(event: GameEvent): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.events, db.games, async () => {
    await db.events.add(event);
    await db.games.update(event.gameId, {
      lastSequence: event.sequence,
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * Apply an edit together with any events whose derived mission/proposal context
 * shifted as a result. Both land in one transaction so the denormalized context
 * can never be observed out of step with the log.
 */
export async function putEvents(
  gameId: string,
  events: GameEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const db = getDb();
  await db.transaction("rw", db.events, db.games, async () => {
    await db.events.bulkPut(events);
    await db.games.update(gameId, { updatedAt: new Date().toISOString() });
  });
}

/** Delete events (target + cascade) and re-write shifted context in one go. */
export async function deleteEvents(
  gameId: string,
  ids: string[],
  contextDiff: GameEvent[] = [],
): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.events, db.games, async () => {
    await db.events.bulkDelete(ids);
    if (contextDiff.length > 0) await db.events.bulkPut(contextDiff);
    await db.games.update(gameId, { updatedAt: new Date().toISOString() });
  });
}

/** Undo of a delete: put the exact rows back, original sequences intact. */
export async function restoreEvents(
  gameId: string,
  events: GameEvent[],
  contextDiff: GameEvent[] = [],
): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.events, db.games, async () => {
    await db.events.bulkPut(events);
    if (contextDiff.length > 0) await db.events.bulkPut(contextDiff);
    await db.games.update(gameId, { updatedAt: new Date().toISOString() });
  });
}

export async function updateGame(
  gameId: string,
  patch: Partial<GameRecord>,
): Promise<void> {
  await getDb().games.update(gameId, {
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Writes a whole game and its log back, for a cloud restore or a file import.
 *
 * One transaction: a game row without its events is a game that renders as
 * empty and looks, to its owner, exactly like data loss. `bulkPut` rather than
 * `bulkAdd` so re-running a restore is harmless.
 */
export async function restoreGame(
  game: GameRecord,
  events: GameEvent[],
): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.games, db.events, async () => {
    await db.games.put(game);
    await db.events.bulkPut(events);
  });
}

export async function deleteGame(gameId: string): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.events, db.games, db.meta, async () => {
    await db.events.where("gameId").equals(gameId).delete();
    await db.games.delete(gameId);
    // Anything keyed `game:<id>:` belongs to this game and goes with it —
    // the convention that keeps per-game settings from outliving the game.
    await db.meta.where("key").startsWith(`game:${gameId}:`).delete();
  });
}

/*
 * Device-level preferences.
 *
 * The `meta` table has existed since v1 for exactly this and had no occupant
 * until now. Preferences belong here rather than in localStorage because they
 * are read on the same tick as the games are, from the same place, and a
 * second storage mechanism would be a second thing to migrate later.
 */

export const SETTING_DISPLAY_NAME = "displayName";

export async function readSetting<T>(key: string): Promise<T | null> {
  const row = await getDb().meta.get(key);
  return row ? (row.value as T) : null;
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await getDb().meta.put({ key, value });
}

/** Highest sequence actually present, for resyncing after a write conflict. */
export async function maxSequence(gameId: string): Promise<number> {
  const db = getDb();
  const last = await db.events
    .where("[gameId+sequence]")
    .between([gameId, MIN_KEY], [gameId, MAX_KEY])
    .last();
  return last?.sequence ?? 0;
}
