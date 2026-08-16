"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils/cn";

/**
 * The container for every recorder in the app.
 *
 * Bottom-anchored because the whole interaction model assumes one-handed use:
 * the controls a player reaches for mid-game must be in the lower half of the
 * screen, never the top.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Stop the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        className="animate-fade-in absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "animate-sheet-in relative flex max-h-[88dvh] flex-col",
          "rounded-t-2xl border-t border-border bg-surface shadow-2xl outline-none",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-[13px] text-fg-muted">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg-muted active:bg-surface-2"
          >
            <span aria-hidden className="text-xl leading-none">
              ✕
            </span>
          </button>
        </div>

        <div className="no-overscroll flex-1 overflow-y-auto px-4 py-4">
          {children}
        </div>

        {footer && (
          <div className="pb-safe border-t border-border bg-surface px-4 py-3">
            {footer}
          </div>
        )}
        {!footer && <div className="pb-safe" />}
      </div>
    </div>,
    document.body,
  );
}
