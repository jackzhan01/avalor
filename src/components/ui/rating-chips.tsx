"use client";

import type { Rating } from "@/lib/types/events";
import { RATING_LABELS } from "@/lib/selectors";
import { RATING_VAR } from "@/components/table/round-table";
import { cn } from "@/lib/utils/cn";

/**
 * Read-only rating chip for timelines, matrices and player pages.
 *
 * `null` renders as a dash, NOT as a 3 — "never said anything about them" and
 * "explicitly said 看不清" are different facts, and the UI has to keep showing
 * them differently or the data discipline is pointless.
 */
export function RatingBadge({
  rating,
  className,
  muted,
}: {
  rating: Rating | null;
  className?: string;
  muted?: boolean;
}) {
  if (rating === null) {
    return (
      <span
        className={cn("text-[color:var(--label-tertiary)]", className)}
        title="没表过态"
      >
        —<span className="sr-only">没表过态</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[6px] px-1",
        "text-[13px] font-semibold text-white",
        muted && "opacity-45",
        className,
      )}
      style={{ backgroundColor: RATING_VAR[rating] }}
      title={RATING_LABELS[rating]}
    >
      {rating}
    </span>
  );
}

/** Editable 1–5 row, used only in the edit sheet. Live entry uses the dock. */
export function RatingChips({
  value,
  onChange,
}: {
  value: Rating | null;
  onChange: (rating: Rating) => void;
}) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="保踩程度">
      {([1, 2, 3, 4, 5] as Rating[]).map((rating) => {
        const active = value === rating;
        return (
          <button
            key={rating}
            type="button"
            aria-pressed={active}
            aria-label={`${rating} ${RATING_LABELS[rating]}`}
            onClick={() => onChange(rating)}
            className={cn(
              "flex min-h-[50px] flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] active:opacity-75",
              active ? "text-white" : "text-[color:var(--label)]",
            )}
            style={{
              backgroundColor: active ? RATING_VAR[rating] : "var(--fill)",
            }}
          >
            <span className="text-[18px] font-semibold leading-none">{rating}</span>
            <span
              className={cn(
                "text-[10px] leading-none",
                active ? "text-white/85" : "text-[color:var(--label-secondary)]",
              )}
            >
              {RATING_LABELS[rating]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
