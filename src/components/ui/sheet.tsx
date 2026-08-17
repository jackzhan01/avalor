"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBottomSurface } from "@/lib/utils/bottom-surface";
import { cn } from "@/lib/utils/cn";

/**
 * Bottom sheet with a grabber and an optional back button.
 *
 * Everything that records something lives in one of these. Layered flows push
 * a new title + body into the same sheet rather than opening a second one, so
 * the user is never more than one "back" from where they started — and never
 * sees two levels of options at once.
 */
export function Sheet({
  open,
  onClose,
  onBack,
  title,
  subtitle,
  trailing,
  footer,
  /** Changes when the layer changes, to drive the push/pop animation. */
  layerKey,
  direction = "push",
  dismissible = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  footer?: React.ReactNode;
  layerKey?: string;
  direction?: "push" | "pop";
  /**
   * When false the backdrop and Escape do nothing: the sheet is asking
   * something the caller needs an actual answer to. Such a sheet must still
   * offer a way forward in its own body — a dead end is never acceptable.
   */
  dismissible?: boolean;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (onBack) onBack();
      else if (dismissible) onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose, onBack, dismissible]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  /*
   * A sheet reaches from the bottom edge upward and covers the tab bar and the
   * dock, so it — not the dock — is what the snackbar has to clear while one is
   * open. The sheet also grows and shrinks as its layers change, which is why
   * the height is measured rather than assumed.
   */
  useBottomSurface(panel, "--sheet-h", open);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        className="a-fade absolute inset-0 bg-black/40"
        onClick={dismissible ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className="a-sheet relative flex max-h-[90dvh] flex-col rounded-t-[14px] bg-[color:var(--bg)] outline-none"
      >
        {/* Grabber */}
        <div className="flex justify-center pb-1 pt-2" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-[color:var(--label-quaternary)]" />
        </div>

        <div className="relative flex min-h-[44px] items-center px-2">
          <div className="w-16 shrink-0">
            {onBack && (
              <button
                onClick={onBack}
                className="t-body flex min-h-[44px] items-center gap-0.5 px-2 text-[color:var(--blue)]"
              >
                <span aria-hidden className="text-[20px] leading-none">‹</span>
                返回
              </button>
            )}
          </div>
          <div className="min-w-0 flex-1 px-1 text-center">
            <h2 className="t-headline truncate">{title}</h2>
            {subtitle && (
              <p className="t-caption truncate text-[color:var(--label-secondary)]">
                {subtitle}
              </p>
            )}
          </div>
          <div className="flex w-16 shrink-0 justify-end">
            {trailing ??
              (dismissible ? (
                <button
                  onClick={onClose}
                  className="t-body min-h-[44px] px-2 text-[color:var(--blue)]"
                >
                  完成
                </button>
              ) : null)}
          </div>
        </div>

        <div
          key={layerKey}
          className={cn(
            "flex-1 overflow-y-auto px-4 pb-4 pt-2",
            direction === "push" ? "a-push" : "a-pop",
          )}
          style={{ overscrollBehaviorY: "contain" }}
        >
          {children}
        </div>

        {footer && (
          <div className="pb-safe border-t border-[color:var(--separator)] px-4 py-3">
            {footer}
          </div>
        )}
        {!footer && <div className="pb-safe" />}
      </div>
    </div>,
    document.body,
  );
}
