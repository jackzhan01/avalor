"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils/cn";

/**
 * iOS-style alert, reserved for destructive actions.
 *
 * Opinions, votes and notes never get one — they are undoable from the
 * snackbar, and a modal on every tap would destroy the recording speed the
 * whole product depends on.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-8">
      <div
        className="a-fade absolute inset-0 bg-black/30"
        onClick={onCancel}
        aria-hidden
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="a-fade relative w-full max-w-[270px] overflow-hidden rounded-[14px] bg-[color:var(--bg-elevated)] shadow-2xl"
      >
        <div className="px-4 py-4 text-center">
          <h2 className="t-headline">{title}</h2>
          <div className="t-footnote mt-1 text-[color:var(--label-secondary)]">
            {message}
          </div>
          {detail && (
            <div className="t-footnote mt-2 text-[color:var(--label-secondary)]">
              {detail}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 border-t border-[color:var(--separator)]">
          <button
            onClick={onCancel}
            className="t-body min-h-[44px] border-r border-[color:var(--separator)] text-[color:var(--blue)] active:bg-[color:var(--fill)]"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              "t-body min-h-[44px] font-semibold active:bg-[color:var(--fill)]",
              destructive ? "text-[color:var(--red)]" : "text-[color:var(--blue)]",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
