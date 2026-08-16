"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "./game-store";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import { deriveOpinions } from "@/lib/selectors/opinions";
import type { DerivedOpinions, DerivedTimeline } from "@/lib/types/derived";
import type { CtaMode } from "@/lib/selectors";
import { sortedBySeat } from "@/lib/types/game";

/**
 * Selector hooks.
 *
 * Every one of these must return a REFERENTIALLY STABLE value for an unchanged
 * event log — that is what the memoization in the selector layer buys us. A
 * hook that builds a fresh object inline would re-render on every unrelated
 * store change (a snackbar appearing, say) and trip Zustand's snapshot check.
 */

export const useGame = () => useGameStore((s) => s.game);
export const useEvents = () => useGameStore((s) => s.events);
export const useLoadStatus = () => useGameStore((s) => s.status);
export const useLoadError = () => useGameStore((s) => s.error);
export const useSnackbar = () => useGameStore((s) => s.snackbar);
export const useCanUndo = () => useGameStore((s) => s.undoStack.length > 0);

export function useTimeline(): DerivedTimeline | null {
  return useGameStore((s) => (s.game ? deriveTimeline(s.events, s.game) : null));
}

export function useOpinions(): DerivedOpinions | null {
  return useGameStore((s) => (s.events ? deriveOpinions(s.events) : null));
}

/** Primitive — always safe to select directly. */
export function usePhase() {
  return useGameStore((s) =>
    s.game ? deriveTimeline(s.events, s.game).phase : null,
  );
}

export function useCtaMode(): CtaMode | null {
  return useGameStore((s) => {
    if (!s.game) return null;
    const timeline = deriveTimeline(s.events, s.game);
    return timeline.isComplete ? "complete" : timeline.phase;
  });
}

/** Seats ascending. Stable as long as the game record is unchanged. */
export function usePlayers() {
  const game = useGame();
  const [cache] = useState(() => new WeakMap<object, ReturnType<typeof sortedBySeat>>());
  if (!game) return [];
  const hit = cache.get(game);
  if (hit) return hit;
  const sorted = sortedBySeat(game.players);
  cache.set(game, sorted);
  return sorted;
}

/**
 * False on the server and on the first client render, true afterwards.
 *
 * "use client" does NOT mean "not rendered on the server" — client components
 * are still prerendered into the initial HTML. Gating on this is what lets the
 * first render produce a skeleton without touching IndexedDB, so server and
 * client agree and there is no hydration mismatch.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
