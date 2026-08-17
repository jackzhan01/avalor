"use client";

import { cn } from "@/lib/utils/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  tone?: "default" | "good" | "evil";
}

/**
 * Two or three mutually exclusive choices. The label always carries the
 * meaning on its own — colour is a second channel, never the only one.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="grid gap-1 rounded-[10px] bg-[color:var(--fill)] p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const tone =
          option.tone === "good"
            ? "var(--green)"
            : option.tone === "evil"
              ? "var(--red)"
              : "var(--bg-elevated)";
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "t-subhead min-h-[36px] rounded-[8px] font-medium transition-colors",
              selected
                ? option.tone && option.tone !== "default"
                  ? "text-white"
                  : "text-[color:var(--label)] shadow-sm"
                : "text-[color:var(--label-secondary)]",
            )}
            style={selected ? { backgroundColor: tone } : undefined}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Row of discrete values, e.g. fail counts plus "不清楚". */
export function ChoiceRow<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "t-body min-h-[44px] min-w-[52px] rounded-[10px] px-3 font-medium active:opacity-70",
            value === option.value
              ? "bg-[color:var(--blue)] text-white"
              : "bg-[color:var(--fill)] text-[color:var(--label)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
