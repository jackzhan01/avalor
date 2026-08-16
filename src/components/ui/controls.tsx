"use client";

import { cn } from "@/lib/utils/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Shown alongside the label, never instead of it. */
  icon?: string;
  tone?: "default" | "good" | "evil";
}

/**
 * Two or three mutually exclusive choices: 上票/下票, 过/否, 成功/失败.
 *
 * Tone adds colour, but the label always carries the meaning on its own — the
 * app must stay readable without relying on red/green discrimination.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
}: {
  options: SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "grid gap-1.5",
        options.length === 2 ? "grid-cols-2" : "grid-cols-3",
      )}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const toneClass =
          option.tone === "good"
            ? "bg-good text-white border-good"
            : option.tone === "evil"
              ? "bg-evil text-white border-evil"
              : "bg-accent text-accent-fg border-accent";
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-xl border font-medium transition-colors",
              size === "md" ? "min-h-[48px] text-[15px]" : "min-h-[40px] text-sm",
              selected
                ? toneClass
                : "border-border bg-surface-2 text-fg active:bg-surface-3",
            )}
          >
            {option.icon && <span aria-hidden>{option.icon}</span>}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Numeric stepper for fail counts and player counts. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  formatValue,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label?: string;
  formatValue?: (value: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`${label ?? "数值"}减一`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-xl active:bg-surface-3 disabled:opacity-30"
      >
        −
      </button>
      <div className="min-w-16 text-center text-xl font-semibold tabular-nums">
        {formatValue ? formatValue(value) : value}
      </div>
      <button
        type="button"
        aria-label={`${label ?? "数值"}加一`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-xl active:bg-surface-3 disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

/** Row of discrete choices, e.g. fail counts 0/1/2/3 plus "不清楚". */
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
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-[44px] min-w-[52px] rounded-xl border px-3 font-medium transition-colors",
              selected
                ? "border-accent bg-accent text-accent-fg"
                : "border-border bg-surface-2 text-fg active:bg-surface-3",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
