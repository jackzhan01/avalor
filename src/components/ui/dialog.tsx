"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";

/**
 * Confirmation for destructive actions only.
 *
 * Opinions, votes and quick notes never get one — they are undoable from the
 * snackbar, and a modal on every tap would destroy the interaction speed the
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
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="animate-fade-in absolute inset-0 bg-black/50"
        onClick={onCancel}
        aria-hidden
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="animate-fade-in relative w-full max-w-sm rounded-2xl border border-border bg-surface p-4 shadow-2xl"
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-2 text-sm text-fg-muted">{message}</div>
        {detail && (
          <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">
            {detail}
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
