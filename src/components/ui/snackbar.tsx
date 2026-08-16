"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useGameStore } from "@/lib/store/game-store";

const VISIBLE_MS = 6000;

/**
 * Single-slot transient message with an Undo action.
 *
 * Mis-taps are common in a live game, so undo has to be reachable without
 * hunting for it — it rides along with the confirmation of what was just saved.
 */
export function SnackbarHost() {
  const snackbar = useGameStore((s) => s.snackbar);
  const dismiss = useGameStore((s) => s.dismissSnackbar);
  const undo = useGameStore((s) => s.undo);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!snackbar) return;
    const timer = setTimeout(dismiss, VISIBLE_MS);
    return () => clearTimeout(timer);
    // Keyed on the snackbar id so each new message restarts the timer.
  }, [snackbar?.id, snackbar, dismiss]);

  if (!mounted || !snackbar || typeof document === "undefined") return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)]">
      <div
        role="status"
        aria-live="polite"
        className="animate-snackbar-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-border-strong bg-surface-3 px-3 py-2.5 shadow-lg"
      >
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {snackbar.message}
        </span>
        {snackbar.undoable && (
          <button
            onClick={() => void undo()}
            className="min-h-[36px] shrink-0 rounded-lg px-3 text-[13px] font-semibold text-accent active:bg-surface-2"
          >
            撤销
          </button>
        )}
        <button
          onClick={dismiss}
          aria-label="关闭提示"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-fg-subtle active:bg-surface-2"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
