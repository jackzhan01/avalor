"use client";

import type { Rating } from "@/lib/types/events";
import { RATING_LABELS } from "@/lib/selectors";
import { RATING_VAR } from "@/components/table/round-table";
import { cn } from "@/lib/utils/cn";

/**
 * The banner that keeps "who is speaking" visible.
 *
 * Without it the table is ambiguous: two consecutive taps on the same circle
 * mean different things (first who is talking, then who they are talking
 * about). This is what stops that from being a guessing game.
 */
export function ModeBanner({
  title,
  hint,
  onCancel,
  cancelLabel = "完成",
  action,
}: {
  title: React.ReactNode;
  hint?: string;
  onCancel: () => void;
  cancelLabel?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="a-rise sticky top-0 z-30 border-b border-[color:var(--separator)] bg-[color:var(--blue)] px-4 py-2.5 text-white">
      <div className="mx-auto flex max-w-md items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="t-subhead truncate font-semibold">{title}</p>
          {hint && <p className="t-caption truncate text-white/75">{hint}</p>}
        </div>
        {action && (
          <button
            onClick={action.onClick}
            className="t-footnote min-h-[36px] shrink-0 rounded-lg bg-white/20 px-2.5 font-semibold active:opacity-60"
          >
            {action.label}
          </button>
        )}
        <button
          onClick={onCancel}
          className="t-subhead -mr-2 min-h-[36px] shrink-0 rounded-lg px-2 font-semibold active:opacity-60"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

/** Docked container for whatever the current mode needs at thumb height. */
function Dock({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-safe fixed inset-x-0 bottom-[4.25rem] z-30 px-3">
      <div className="a-rise mx-auto max-w-md rounded-[14px] border border-[color:var(--separator)] bg-[color:var(--bg-elevated)] p-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.18)]">
        {children}
      </div>
    </div>
  );
}

/** 1–5 in one row. The digit is always visible; colour is the second channel. */
export function RatingDock({
  targetLabel,
  current,
  onPick,
  onClear,
}: {
  targetLabel: string;
  current: Rating | null;
  onPick: (rating: Rating) => void;
  onClear?: () => void;
}) {
  return (
    <Dock>
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="t-footnote text-[color:var(--label-secondary)]">
          怎么看 <span className="font-semibold text-[color:var(--label)]">{targetLabel}</span>
        </p>
        {onClear && current !== null && (
          <button
            onClick={onClear}
            className="t-footnote text-[color:var(--red)] active:opacity-60"
          >
            清除
          </button>
        )}
      </div>
      <div className="flex gap-1.5">
        {([1, 2, 3, 4, 5] as Rating[]).map((rating) => {
          const active = current === rating;
          return (
            <button
              key={rating}
              onClick={() => onPick(rating)}
              aria-pressed={active}
              aria-label={`${rating} ${RATING_LABELS[rating]}`}
              className={cn(
                "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px]",
                "active:opacity-75",
                active ? "text-white" : "text-[color:var(--label)]",
              )}
              style={{
                backgroundColor: active ? RATING_VAR[rating] : "var(--fill)",
              }}
            >
              <span className="text-[19px] font-semibold leading-none">
                {rating}
              </span>
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
    </Dock>
  );
}

/** Team building: how many picked, expected size, and one confirm. */
export function TeamDock({
  selected,
  expected,
  confirmLabel,
  onConfirm,
  warning,
}: {
  selected: number;
  expected: number;
  confirmLabel: string;
  onConfirm: () => void;
  warning?: string;
}) {
  return (
    <Dock>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <p className="t-footnote text-[color:var(--label-secondary)]">
          已选{" "}
          <span className="font-semibold tabular-nums text-[color:var(--label)]">
            {selected}
          </span>{" "}
          / {expected} 人
        </p>
        {warning && (
          <p className="t-caption text-[color:var(--orange)]">{warning}</p>
        )}
      </div>
      <button
        onClick={onConfirm}
        disabled={selected === 0}
        className="t-body min-h-[48px] w-full rounded-[12px] bg-[color:var(--blue)] font-semibold text-white active:opacity-80 disabled:opacity-40"
      >
        {confirmLabel}
      </button>
    </Dock>
  );
}

/** Vote: live tallies plus the two explicit outcome buttons. */
export function VoteDock({
  approve,
  reject,
  unknown,
  unrecorded,
  onResult,
  onSetAll,
}: {
  approve: number;
  reject: number;
  unknown: number;
  unrecorded: number;
  onResult: (result: "passed" | "rejected") => void;
  onSetAll: (choice: "approve" | "reject") => void;
}) {
  return (
    <Dock>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <p className="t-footnote tabular-nums text-[color:var(--label-secondary)]">
          <span className="font-semibold text-[color:var(--green)]">上 {approve}</span>
          {"  "}
          <span className="font-semibold text-[color:var(--red)]">下 {reject}</span>
          {unknown > 0 && <span>{"  "}不清楚 {unknown}</span>}
          {unrecorded > 0 && <span>{"  "}未记 {unrecorded}</span>}
        </p>
        <div className="flex gap-1">
          <button
            onClick={() => onSetAll("approve")}
            className="t-caption min-h-[30px] rounded-md bg-[color:var(--fill)] px-2 active:opacity-70"
          >
            全上
          </button>
          <button
            onClick={() => onSetAll("reject")}
            className="t-caption min-h-[30px] rounded-md bg-[color:var(--fill)] px-2 active:opacity-70"
          >
            全下
          </button>
        </div>
      </div>
      {/* The outcome is recorded explicitly, never inferred: partial vote data
          would produce a confidently wrong answer. */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onResult("rejected")}
          className="t-body min-h-[48px] rounded-[12px] bg-[color:var(--red)] font-semibold text-white active:opacity-80"
        >
          车被否
        </button>
        <button
          onClick={() => onResult("passed")}
          className="t-body min-h-[48px] rounded-[12px] bg-[color:var(--green)] font-semibold text-white active:opacity-80"
        >
          车过了
        </button>
      </div>
    </Dock>
  );
}

/** Idle state: the one primary action for the current phase, plus a note. */
export function PrimaryDock({
  primaryLabel,
  onPrimary,
  onNote,
}: {
  primaryLabel: string | null;
  onPrimary: () => void;
  onNote: () => void;
}) {
  return (
    <Dock>
      <div className="flex gap-2">
        {primaryLabel && (
          <button
            onClick={onPrimary}
            className="t-body min-h-[48px] flex-1 rounded-[12px] bg-[color:var(--blue)] font-semibold text-white active:opacity-80"
          >
            {primaryLabel}
          </button>
        )}
        <button
          onClick={onNote}
          className={cn(
            "t-body min-h-[48px] rounded-[12px] bg-[color:var(--fill)] px-4 font-semibold text-[color:var(--label)] active:opacity-70",
            !primaryLabel && "flex-1",
          )}
        >
          记一条
        </button>
      </div>
    </Dock>
  );
}
