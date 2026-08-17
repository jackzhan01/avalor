"use client";

import { useRef } from "react";
import type { Rating } from "@/lib/types/events";
import { RATING_LABELS } from "@/lib/selectors";
import { RATING_VAR } from "@/components/table/round-table";
import { useBottomSurface } from "@/lib/utils/bottom-surface";
import { cn } from "@/lib/utils/cn";

/**
 * Everything the current mode needs, docked at thumb height.
 *
 * The mode context lives here rather than in a top banner on purpose: a banner
 * displaced the real header, hiding the round, the score and the vision
 * toggles exactly when the user is deepest in a flow. Down here it sits next
 * to the controls it describes and covers nothing.
 */
export function Dock({ children }: { children: React.ReactNode }) {
  const card = useRef<HTMLDivElement>(null);

  /*
   * Publish the dock's real height so the snackbar can sit directly on top of
   * it. The dock changes height with the mode — one row for a rating, two for
   * a vote — so any fixed offset would either overlap it or leave a gap.
   */
  useBottomSurface(card, "--dock-h");

  return (
    <div className="pb-safe fixed inset-x-0 bottom-[3.6rem] z-30 px-3">
      <div
        ref={card}
        className="a-rise mx-auto max-w-md rounded-[14px] border border-[color:var(--separator)] bg-[color:var(--bg-elevated)] p-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
      >
        {children}
      </div>
    </div>
  );
}

/** Names the mode and offers the way out of it. */
export function DockHeader({
  title,
  hint,
  action,
  onCancel,
  cancelLabel = "完成",
}: {
  title: React.ReactNode;
  hint?: string;
  action?: { label: string; onClick: () => void };
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <div className="min-w-0 flex-1">
        <p className="t-subhead truncate font-semibold">{title}</p>
        {hint && (
          <p className="t-caption truncate text-[color:var(--label-secondary)]">
            {hint}
          </p>
        )}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="t-caption min-h-[32px] shrink-0 rounded-lg bg-[color:var(--fill)] px-2.5 font-medium active:opacity-70"
        >
          {action.label}
        </button>
      )}
      {onCancel && (
        <button
          onClick={onCancel}
          className="t-subhead min-h-[32px] shrink-0 rounded-lg px-1.5 font-semibold text-[color:var(--blue)] active:opacity-60"
        >
          {cancelLabel}
        </button>
      )}
    </div>
  );
}

/** 1–5 in one row. The digit is always visible; colour is the second channel. */
export function RatingRow({
  current,
  onPick,
}: {
  current: Rating | null;
  onPick: (rating: Rating) => void;
}) {
  return (
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
              "active:opacity-75 hover:brightness-95 dark:hover:brightness-110",
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
                active
                  ? "text-white/85"
                  : "text-[color:var(--label-secondary)]",
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

/**
 * One confirm button plus a live count.
 *
 * When the count is wrong the button locks rather than warning after the fact:
 * a car sent with the wrong number of people is a mis-tap far more often than
 * it is a house rule, and it is a structural event that drags a vote and a
 * mission behind it. The override keeps the unusual table possible, but makes
 * it a deliberate second tap instead of something you do by accident.
 */
export function ConfirmRow({
  selected,
  expected,
  label,
  onConfirm,
  disabled,
  mismatch,
  onOverride,
}: {
  selected: number;
  expected?: number;
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  /** Text explaining why the count is off. Locks the button when present. */
  mismatch?: string;
  /** Offered alongside the mismatch; unlocks the button. */
  onOverride?: () => void;
}) {
  const locked = disabled ?? (selected === 0 || mismatch !== undefined);

  return (
    <>
      {expected !== undefined && !mismatch && (
        <p className="t-footnote mb-2 px-1 text-[color:var(--label-secondary)]">
          已选{" "}
          <span className="font-semibold tabular-nums text-[color:var(--label)]">
            {selected}
          </span>{" "}
          / {expected} 人
        </p>
      )}

      {mismatch && (
        <div className="mb-2 flex items-center gap-2 rounded-[10px] bg-[color:var(--fill)] px-2.5 py-2">
          <span className="t-footnote min-w-0 flex-1 text-[color:var(--orange)]">
            {mismatch}
          </span>
          {onOverride && (
            <button
              onClick={onOverride}
              className="t-footnote min-h-[32px] shrink-0 rounded-lg px-2 font-semibold text-[color:var(--blue)] active:opacity-60"
            >
              仍要记
            </button>
          )}
        </div>
      )}

      <button
        onClick={onConfirm}
        disabled={locked}
        className="t-body min-h-[48px] w-full rounded-[12px] bg-[color:var(--blue)] font-semibold text-white active:opacity-80 disabled:opacity-40"
      >
        {label}
      </button>
    </>
  );
}

/** Vote: live tallies plus the two explicit outcome buttons. */
export function VoteRow({
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
    <>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <p className="t-footnote tabular-nums text-[color:var(--label-secondary)]">
          <span className="font-semibold text-[color:var(--green)]">
            上 {approve}
          </span>
          {"  "}
          <span className="font-semibold text-[color:var(--red)]">
            下 {reject}
          </span>
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
    </>
  );
}

/** Idle: the one primary action for the current phase, plus a note. */
export function PrimaryRow({
  primaryLabel,
  onPrimary,
  onNote,
}: {
  primaryLabel: string | null;
  onPrimary: () => void;
  onNote: () => void;
}) {
  return (
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
  );
}
