"use client";

import type { Rating } from "@/lib/types/events";
import { RATING_LABELS } from "@/lib/selectors/opinions";
import { cn } from "@/lib/utils/cn";

const RATINGS: Rating[] = [1, 2, 3, 4, 5];

const CHIP_COLOR: Record<Rating, string> = {
  1: "var(--rate-1)",
  2: "var(--rate-2)",
  3: "var(--rate-3)",
  4: "var(--rate-4)",
  5: "var(--rate-5)",
};

/**
 * The core input of the whole app: one tap records an opinion.
 *
 * Two rules this component exists to honour:
 *
 *  1. `value === null` means "never expressed an opinion" and renders as NO
 *     selection. It is never shown as a 3. A 3 is an explicit "看不清".
 *  2. The digit is always visible. Colour is a second channel, never the only
 *     one — the app gets used in dim rooms by people who may not distinguish
 *     red from green.
 */
export function RatingChips({
  value,
  onChange,
  onClear,
  size = "md",
  ariaLabel,
}: {
  value: Rating | null;
  onChange: (rating: Rating) => void;
  onClear?: () => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={ariaLabel}
    >
      {RATINGS.map((rating) => {
        const selected = value === rating;
        return (
          <button
            key={rating}
            type="button"
            aria-pressed={selected}
            aria-label={`${rating} ${RATING_LABELS[rating]}`}
            onClick={() => onChange(rating)}
            style={
              selected
                ? { backgroundColor: CHIP_COLOR[rating], borderColor: CHIP_COLOR[rating] }
                : { color: CHIP_COLOR[rating] }
            }
            className={cn(
              "flex flex-1 flex-col items-center justify-center rounded-lg border font-semibold",
              "transition-colors active:brightness-95",
              size === "md" ? "min-h-[44px] min-w-[44px]" : "min-h-[38px] min-w-[38px]",
              selected
                ? "text-white shadow-sm"
                : "border-border bg-surface-2",
            )}
          >
            <span className={size === "md" ? "text-base leading-none" : "text-sm leading-none"}>
              {rating}
            </span>
            {size === "md" && (
              <span
                className={cn(
                  "mt-0.5 text-[10px] font-normal leading-none",
                  selected ? "text-white/85" : "text-fg-subtle",
                )}
              >
                {RATING_LABELS[rating]}
              </span>
            )}
          </button>
        );
      })}

      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="清除这条评价"
          disabled={value === null}
          className={cn(
            "ml-0.5 flex shrink-0 items-center justify-center rounded-lg border border-border",
            "text-fg-subtle active:bg-surface-2 disabled:opacity-30",
            size === "md" ? "h-[44px] w-[34px]" : "h-[38px] w-[30px]",
          )}
        >
          <span aria-hidden className="text-sm leading-none">
            ✕
          </span>
        </button>
      )}
    </div>
  );
}

/** Compact read-only badge for timelines and matrices. */
export function RatingBadge({
  rating,
  className,
}: {
  rating: Rating | null;
  className?: string;
}) {
  if (rating === null) {
    return (
      <span
        className={cn("text-fg-subtle", className)}
        aria-label="没有表过态"
        title="没有表过态"
      >
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-[13px] font-semibold text-white",
        className,
      )}
      style={{ backgroundColor: CHIP_COLOR[rating] }}
      title={RATING_LABELS[rating]}
    >
      {rating}
    </span>
  );
}

export { CHIP_COLOR };
