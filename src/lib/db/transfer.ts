/**
 * JSON export / import.
 *
 * Worth having even with no AI in V1: it is the only backup a local-only app
 * has, it makes bugs reproducible, and it is the seed of a future dataset
 * (event history + true roles, once reveal-roles ships).
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord } from "@/lib/types/game";
import { bySequence } from "@/lib/types/events";

export const SCHEMA_VERSION = 1 as const;

export interface GameExport {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  game: GameRecord;
  events: GameEvent[];
}

export function buildExport(
  game: GameRecord,
  events: GameEvent[],
): GameExport {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    game,
    events: [...events].sort(bySequence),
  };
}

export function serializeExport(game: GameRecord, events: GameEvent[]): string {
  return JSON.stringify(buildExport(game, events), null, 2);
}

export class ImportError extends Error {}

/** Strict enough to catch a wrong file, lenient about optional fields. */
export function parseImport(json: string): GameExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportError("这不是有效的 JSON 文件。");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ImportError("文件内容不是一局对局记录。");
  }
  const candidate = parsed as Partial<GameExport>;

  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    throw new ImportError(
      `不支持的文件版本：${String(candidate.schemaVersion)}（当前支持 ${SCHEMA_VERSION}）。`,
    );
  }
  if (!candidate.game || !Array.isArray(candidate.events)) {
    throw new ImportError("文件里缺少对局或事件数据。");
  }
  if (!Array.isArray(candidate.game.players) || candidate.game.players.length === 0) {
    throw new ImportError("文件里没有玩家信息。");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: candidate.exportedAt ?? new Date().toISOString(),
    game: candidate.game as GameRecord,
    events: [...(candidate.events as GameEvent[])].sort(bySequence),
  };
}

export function exportFileName(game: GameRecord): string {
  const d = new Date(game.createdAt);
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0"),
  ].join("");
  return `avalor-${game.playerCount}p-${stamp}.json`;
}

/** Browser-only. Triggers a file download of the serialized game. */
export function downloadExport(game: GameRecord, events: GameEvent[]): void {
  const blob = new Blob([serializeExport(game, events)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFileName(game);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so Safari has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
