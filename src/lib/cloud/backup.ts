/**
 * Backup and restore, for signed-in users who ask for it.
 *
 * Backup, not sync. Two devices editing the same game would need a merge, and
 * merging an append-only log across devices means reconciling sequence numbers
 * that were both handed out as "next" — a real project. What people actually
 * fear is losing everything when a phone dies or iOS clears the site data, and
 * a one-way push and pull answers that completely.
 *
 * Runs entirely through the browser client on the anon key. Row-level security
 * is the boundary: every policy on game_backups is `auth.uid() = user_id`, so
 * a user physically cannot read or write another user's rows. The service role
 * key stays confined to the AI gate, where it belongs.
 *
 * The payload is the same versioned object the JSON export produces, private
 * layer included — a backup that dropped your own role and your reads would
 * restore a game you no longer recognise. Which means this is the one feature
 * that sends game data off the device, so it is opt-in, per-tap, and says so.
 */

import { browserClient } from "@/lib/auth/supabase-browser";
import * as repo from "@/lib/db/repository";
import { buildExport, parseImport, type GameExport } from "@/lib/db/transfer";
import type { GameRecord } from "@/lib/types/game";

const TABLE = "game_backups";

export interface BackupSummary {
  gameId: string;
  playerCount: number | null;
  eventCount: number | null;
  gameCreatedAt: string | null;
  updatedAt: string;
}

/** Metadata only — the payloads are far too heavy to list. */
export async function listBackups(): Promise<BackupSummary[]> {
  const { data, error } = await browserClient()
    .from(TABLE)
    .select("game_id, player_count, event_count, game_created_at, updated_at")
    .order("game_created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    gameId: row.game_id as string,
    playerCount: row.player_count as number | null,
    eventCount: row.event_count as number | null,
    gameCreatedAt: row.game_created_at as string | null,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Pushes every game on this device.
 *
 * Upserted on (user_id, game_id), so backing up twice overwrites rather than
 * accumulating, and a game that has grown since the last backup simply carries
 * the newer log.
 */
export async function backupAll(): Promise<{ uploaded: number }> {
  const supabase = browserClient();
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error("请先登录。");

  const { games } = await repo.listAllGames();
  if (games.length === 0) return { uploaded: 0 };

  const rows = [];
  for (const summary of games) {
    const loaded = await repo.loadGame(summary.id);
    if (!loaded) continue;
    rows.push({
      user_id: userId,
      game_id: loaded.game.id,
      payload: buildExport(loaded.game, loaded.events, { includePrivate: true }),
      player_count: loaded.game.playerCount,
      event_count: loaded.events.length,
      game_created_at: loaded.game.createdAt,
      updated_at: new Date().toISOString(),
    });
  }

  /*
   * Chunked because a whole history in one request can outgrow the request
   * body limit, and a rejected batch would look like "backup failed" with no
   * indication that it was only the size.
   */
  const CHUNK = 20;
  let uploaded = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "user_id,game_id" });
    if (error) throw new Error(error.message);
    uploaded += Math.min(CHUNK, rows.length - i);
  }
  return { uploaded };
}

/**
 * Pulls back anything this device does not have.
 *
 * Games already present are skipped rather than overwritten. A restore runs on
 * a device someone is already using, and silently replacing a game they have
 * been recording with an older cloud copy would destroy live work — the exact
 * failure a backup exists to prevent.
 */
export async function restoreMissing(): Promise<{
  restored: number;
  skipped: number;
}> {
  const { data, error } = await browserClient()
    .from(TABLE)
    .select("game_id, payload");
  if (error) throw new Error(error.message);

  const { games: local } = await repo.listAllGames();
  const present = new Set(local.map((g) => g.id));

  let restored = 0;
  let skipped = 0;

  for (const row of data ?? []) {
    if (present.has(row.game_id as string)) {
      skipped++;
      continue;
    }
    let parsed: GameExport;
    try {
      // Through the same validator a file import uses: a row that predates a
      // schema change must fail loudly here, not corrupt the local database.
      parsed = parseImport(JSON.stringify(row.payload));
    } catch {
      skipped++;
      continue;
    }
    await writeRestored(parsed);
    restored++;
  }

  return { restored, skipped };
}

async function writeRestored(exported: GameExport): Promise<void> {
  const game: GameRecord = {
    ...exported.game,
    // Trust the log, not the field: a backup taken mid-write could carry a
    // counter that trails its own events, and re-issuing a used sequence
    // number is how an append-only log stops being one.
    lastSequence: exported.events.reduce(
      (max, event) => Math.max(max, event.sequence),
      exported.game.lastSequence ?? 0,
    ),
  };
  await repo.restoreGame(game, exported.events);
}
