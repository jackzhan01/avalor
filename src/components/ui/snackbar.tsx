"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useGameStore } from "@/lib/store/game-store";

const VISIBLE_MS = 6000;

/**
 * Confirmation of what was just saved, with undo riding along.
 *
 * Mis-taps are constant in a live game, so undo has to arrive without being
 * hunted for — that is why it lives on the confirmation rather than in a menu.
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
  }, [snackbar?.id, snackbar, dismiss]);

  if (!mounted || !snackbar || typeof document === "undefined") return null;

  /*
   * Sits directly above the dock, not at the top of the screen.
   *
   * At the top it covered the round counter and the layer toggles — exactly
   * what you want to keep seeing while recording. Down here it also puts 撤销
   * within thumb reach, which is where an undo belongs.
   *
   * `--dock-h` is published by the dock itself and defaults to 0 on the pages
   * that have no dock.
   */
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3"
      style={{
        paddingBottom:
          "calc(env(safe-area-inset-bottom, 0px) + 3.6rem + var(--dock-h, 0px) + 0.5rem)",
      }}
    >
      <div
        role="status"
        aria-live="polite"
        className="a-rise pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-[14px] bg-[color:var(--bg-elevated)]/95 px-3 py-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.22)] backdrop-blur-xl"
      >
        <span className="t-footnote min-w-0 flex-1 truncate">
          {snackbar.message}
        </span>
        {snackbar.undoable && (
          <button
            onClick={() => void undo()}
            className="t-footnote min-h-[34px] shrink-0 rounded-lg px-2 font-semibold text-[color:var(--blue)] active:opacity-60"
          >
            撤销
          </button>
        )}
        <button
          onClick={dismiss}
          aria-label="关闭提示"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[color:var(--label-tertiary)] active:opacity-60"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
