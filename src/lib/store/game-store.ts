"use client";

/**
 * The read model. Dexie is the durable log.
 *
 *   load     Dexie → store
 *   mutate   store (optimistic, synchronous) → Dexie (queued)
 *
 * Optimistic-first is required by the core UX rule: tapping a rating chip saves
 * with no Save button. An IndexedDB write on a mid-range phone can take 20-60 ms
 * under load, and a chip that lags that long feels broken.
 */

import { create } from "zustand";
import type { GameEvent, EventDraft, EventPatch } from "@/lib/types/events";
import type {
  GameRecord,
  Player,
  RoleSetConfig,
  RoleType,
  WinningSide,
} from "@/lib/types/game";
import * as repo from "@/lib/db/repository";
import { createEvent } from "@/lib/events/factory";
import { assignContext } from "@/lib/events/context";
import {
  collectCascade,
  insertEvents,
  nextSequence,
  removeEvents,
  replaceEvent,
} from "@/lib/events/mutate";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import { describeEvent } from "@/lib/format/labels";
import { pushUndo, undoLabel, type UndoEntry } from "./undo";
import { newId } from "@/lib/utils/id";

export interface SnackbarState {
  id: string;
  message: string;
  /** Whether to offer the Undo action. */
  undoable: boolean;
}

export type LoadStatus = "idle" | "loading" | "ready" | "error";

interface GameStore {
  status: LoadStatus;
  gameId: string | null;
  game: GameRecord | null;
  /** INVARIANT: ascending by sequence. */
  events: GameEvent[];
  undoStack: UndoEntry[];
  snackbar: SnackbarState | null;
  error: string | null;

  loadGame: (gameId: string) => Promise<void>;
  unload: () => void;
  addEvent: (draft: EventDraft) => Promise<GameEvent | null>;
  editEvent: (id: string, patch: EventPatch) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  undo: () => Promise<void>;
  endGame: (winningSide?: WinningSide | null) => Promise<void>;
  reopenGame: () => Promise<void>;
  updatePlayer: (playerId: string, patch: Partial<Player>) => Promise<void>;
  /** The user's own role. Private — never used as information about others. */
  setViewerRole: (role: RoleType | undefined) => Promise<void>;
  updateRoleSet: (roleSet: RoleSetConfig | undefined) => Promise<void>;
  setScratchpad: (text: string) => Promise<void>;
  updateSettings: (patch: Partial<GameRecord>) => Promise<void>;
  /**
   * Changing your own role invalidates the vision you recorded under the old
   * one, so those marks are dropped in the same step. Guessed marks survive —
   * they were your reads, not a consequence of the role.
   */
  changeViewerRole: (role: RoleType | undefined) => Promise<void>;
  /**
   * Endgame reveal. This is what turns a recorded game into a labelled one:
   * observations plus actions plus ground truth.
   */
  revealEndgame: (input: {
    assassinTargetId?: string;
    roles: Record<string, RoleType | undefined>;
    winningSide: WinningSide | null;
  }) => Promise<void>;
  showSnackbar: (message: string, undoable?: boolean) => void;
  dismissSnackbar: () => void;
}

/*
 * Serialized write queue: a single promise chain, so writes land in sequence
 * order and never interleave. Failures are handled per-call, not by breaking
 * the chain for everyone behind them.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * StrictMode runs effects twice in development, and the user can navigate away
 * mid-load. Track the in-flight id so a stale result can be discarded.
 */
let inflightGameId: string | null = null;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useGameStore = create<GameStore>((set, get) => {
  /** Pull the durable log back over the optimistic state after a failed write. */
  async function resync(gameId: string, reason: string) {
    try {
      const loaded = await repo.loadGame(gameId);
      if (!loaded || get().gameId !== gameId) return;
      set({
        game: loaded.game,
        events: loaded.events,
        undoStack: [],
        snackbar: {
          id: newId(),
          message: `${reason}，已恢复到已保存的状态。`,
          undoable: false,
        },
      });
    } catch {
      set({ error: reason });
    }
  }

  function write(gameId: string, fn: () => Promise<void>, reason: string) {
    enqueue(fn).catch(() => void resync(gameId, reason));
  }

  return {
    status: "idle",
    gameId: null,
    game: null,
    events: [],
    undoStack: [],
    snackbar: null,
    error: null,

    async loadGame(gameId) {
      const state = get();
      if (state.gameId === gameId && state.status === "ready") return;
      if (inflightGameId === gameId) return;

      inflightGameId = gameId;
      set({ status: "loading", gameId, error: null });
      try {
        const loaded = await repo.loadGame(gameId);
        if (inflightGameId !== gameId) return; // superseded by a newer load
        if (!loaded) {
          set({ status: "error", error: "找不到这局游戏。", game: null, events: [] });
          return;
        }
        set({
          status: "ready",
          game: loaded.game,
          events: loaded.events,
          undoStack: [],
          error: null,
        });
      } catch (err) {
        if (inflightGameId !== gameId) return;
        set({ status: "error", error: errorMessage(err) });
      } finally {
        if (inflightGameId === gameId) inflightGameId = null;
      }
    },

    unload() {
      inflightGameId = null;
      set({
        status: "idle",
        gameId: null,
        game: null,
        events: [],
        undoStack: [],
        snackbar: null,
        error: null,
      });
    },

    async addEvent(draft) {
      const { game, events } = get();
      if (!game) return null;

      // Context comes from the fold, so an appended event is correct by
      // construction and needs no reconciliation pass.
      const timeline = deriveTimeline(events, game);
      const event = createEvent(draft, {
        gameId: game.id,
        sequence: nextSequence(events),
        missionNumber: timeline.missionNumber,
        proposalNumber: timeline.proposalNumber,
      });

      const label = describeEvent(event, game);
      const entry: UndoEntry = { kind: "add", label, eventIds: [event.id] };
      set({
        events: [...events, event],
        undoStack: pushUndo(get().undoStack, entry),
        snackbar: { id: newId(), message: undoLabel(entry), undoable: true },
      });

      write(game.id, () => repo.appendEvent(event), "保存失败");
      return event;
    },

    async editEvent(id, patch) {
      const { game, events } = get();
      if (!game) return;
      const before = events.find((e) => e.id === id);
      if (!before) return;

      const updated = { ...before, ...patch } as GameEvent;
      const { events: reconciled, changed } = assignContext(
        replaceEvent(events, updated),
        game,
      );

      const entry: UndoEntry = {
        kind: "edit",
        label: describeEvent(updated, game),
        before,
      };
      set({
        events: reconciled,
        undoStack: pushUndo(get().undoStack, entry),
        snackbar: { id: newId(), message: undoLabel(entry), undoable: true },
      });

      const rows = dedupeById([updated, ...changed]);
      write(game.id, () => repo.putEvents(game.id, rows), "修改保存失败");
    },

    async deleteEvent(id) {
      const { game, events } = get();
      if (!game) return;
      const plan = collectCascade(events, id);
      if (!plan) return;

      const removed = [plan.target, ...plan.dependents];
      const { events: reconciled, changed } = assignContext(
        removeEvents(events, plan.ids),
        game,
      );

      const entry: UndoEntry = {
        kind: "delete",
        label: describeEvent(plan.target, game),
        events: removed,
      };
      set({
        events: reconciled,
        undoStack: pushUndo(get().undoStack, entry),
        snackbar: { id: newId(), message: undoLabel(entry), undoable: true },
      });

      write(
        game.id,
        () => repo.deleteEvents(game.id, plan.ids, changed),
        "删除保存失败",
      );
    },

    async undo() {
      const { game, events, undoStack } = get();
      const entry = undoStack[undoStack.length - 1];
      if (!game || !entry) return;
      const rest = undoStack.slice(0, -1);

      if (entry.kind === "add") {
        const { events: reconciled, changed } = assignContext(
          removeEvents(events, entry.eventIds),
          game,
        );
        set({ events: reconciled, undoStack: rest, snackbar: null });
        write(
          game.id,
          () => repo.deleteEvents(game.id, entry.eventIds, changed),
          "撤销失败",
        );
        return;
      }

      if (entry.kind === "delete") {
        // Correct only because deletes never renumber: the restored rows slot
        // back into their original places in the ordering.
        const { events: reconciled, changed } = assignContext(
          insertEvents(events, entry.events),
          game,
        );
        set({ events: reconciled, undoStack: rest, snackbar: null });
        write(
          game.id,
          () => repo.restoreEvents(game.id, entry.events, changed),
          "撤销失败",
        );
        return;
      }

      const { events: reconciled, changed } = assignContext(
        replaceEvent(events, entry.before),
        game,
      );
      set({ events: reconciled, undoStack: rest, snackbar: null });
      const rows = dedupeById([entry.before, ...changed]);
      write(game.id, () => repo.putEvents(game.id, rows), "撤销失败");
    },

    async endGame(winningSide = null) {
      const { game } = get();
      if (!game) return;
      const patch: Partial<GameRecord> = {
        status: "completed",
        winningSide,
        completedAt: new Date().toISOString(),
      };
      set({ game: { ...game, ...patch } });
      write(game.id, () => repo.updateGame(game.id, patch), "结束对局保存失败");
    },

    async reopenGame() {
      const { game } = get();
      if (!game) return;
      const patch: Partial<GameRecord> = {
        status: "active",
        winningSide: null,
      };
      set({ game: { ...game, ...patch } });
      write(game.id, () => repo.updateGame(game.id, patch), "保存失败");
    },

    async updatePlayer(playerId, patch) {
      const { game } = get();
      if (!game) return;
      const players = game.players.map((p) =>
        p.id === playerId ? { ...p, ...patch } : p,
      );
      set({ game: { ...game, players } });
      write(game.id, () => repo.updateGame(game.id, { players }), "保存失败");
    },

    async setViewerRole(role) {
      const { game } = get();
      if (!game) return;
      set({ game: { ...game, viewerRole: role } });
      write(
        game.id,
        () => repo.updateGame(game.id, { viewerRole: role }),
        "保存失败",
      );
    },

    async updateRoleSet(roleSet) {
      const { game } = get();
      if (!game) return;
      set({ game: { ...game, roleSet } });
      write(game.id, () => repo.updateGame(game.id, { roleSet }), "保存失败");
    },

    async setScratchpad(text) {
      const { game } = get();
      if (!game) return;
      set({ game: { ...game, scratchpad: text } });
      write(
        game.id,
        () => repo.updateGame(game.id, { scratchpad: text }),
        "草稿保存失败",
      );
    },

    async updateSettings(patch) {
      const { game } = get();
      if (!game) return;
      set({ game: { ...game, ...patch } });
      write(game.id, () => repo.updateGame(game.id, patch), "保存失败");
    },

    async changeViewerRole(role) {
      const { game, events } = get();
      if (!game) return;

      // Vision recorded as `known` was a consequence of the previous role. It
      // is no longer true, so it goes; guesses were the user's own reads and
      // survive untouched.
      const stale = events.filter(
        (e) => e.type === "role_mark" && e.certainty === "known",
      );
      const remaining =
        stale.length > 0 ? removeEvents(events, stale.map((e) => e.id)) : events;
      const { events: reconciled, changed } = assignContext(remaining, game);

      set({
        game: { ...game, viewerRole: role },
        events: reconciled,
        undoStack: [],
      });

      write(
        game.id,
        async () => {
          if (stale.length > 0) {
            await repo.deleteEvents(
              game.id,
              stale.map((e) => e.id),
              changed,
            );
          }
          await repo.updateGame(game.id, { viewerRole: role });
        },
        "保存失败",
      );
    },

    async revealEndgame({ assassinTargetId, roles, winningSide }) {
      const { game } = get();
      if (!game) return;
      const players = game.players.map((p) => ({
        ...p,
        actualRole: roles[p.id],
      }));
      const patch: Partial<GameRecord> = {
        players,
        ...(assassinTargetId ? { assassinTargetId } : {}),
        winningSide,
        status: "completed",
        completedAt: new Date().toISOString(),
      };
      set({ game: { ...game, ...patch } });
      write(game.id, () => repo.updateGame(game.id, patch), "保存失败");
    },

    showSnackbar(message, undoable = false) {
      set({ snackbar: { id: newId(), message, undoable } });
    },

    dismissSnackbar() {
      set({ snackbar: null });
    },
  };
});

function dedupeById(events: GameEvent[]): GameEvent[] {
  const byId = new Map<string, GameEvent>();
  for (const e of events) byId.set(e.id, e);
  return Array.from(byId.values());
}
