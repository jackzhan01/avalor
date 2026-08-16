import type { GameEvent } from "@/lib/types/events";

/**
 * Inverse operations for the last few actions.
 *
 * Held in memory only — it does not survive a refresh. That is the deliberate
 * cost of hard-deleting rows instead of tombstoning them: tombstones would make
 * undo durable, but would tax every selector, export and index scan forever, in
 * exchange for deleted-history archaeology nobody asked for.
 */
export type UndoEntry =
  | { kind: "add"; label: string; eventIds: string[] }
  | { kind: "delete"; label: string; events: GameEvent[] }
  | { kind: "edit"; label: string; before: GameEvent };

export const UNDO_DEPTH = 10;

export function pushUndo(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > UNDO_DEPTH ? next.slice(next.length - UNDO_DEPTH) : next;
}

export function undoLabel(entry: UndoEntry): string {
  switch (entry.kind) {
    case "add":
      return `已记录：${entry.label}`;
    case "delete":
      return `已删除：${entry.label}`;
    case "edit":
      return `已修改：${entry.label}`;
  }
}
