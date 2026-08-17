"use client";

import type { Player } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

export interface SeatBadge {
  text: string;
  color?: string;
  title?: string;
}

export interface SeatVisual {
  /** Filled — currently chosen (a team member, the target being rated…). */
  selected?: boolean;
  /** Transient emphasis: whose turn it is to be recorded. */
  ring?: "speaker" | null;
  /** Top-right chip: a rating, a vote mark, a 跳派 marker. */
  badge?: SeatBadge | null;
  /** Top-left chip: reserved for 车 (the current leader). */
  badgeLeft?: SeatBadge | null;
  /**
   * The private layer. Drawn as an outline plus a glyph so it never competes
   * with the public badges, and dashed when it is a read rather than knowledge.
   */
  mark?: { text: string; color: string; certain: boolean } | null;
  dimmed?: boolean;
  disabled?: boolean;
}

/**
 * The table, drawn as it actually sits.
 *
 * The user is pinned to six o'clock and everyone else is placed clockwise from
 * them, so the screen matches the room. At a real table nobody thinks "player
 * 3", they think "two seats to my left" — this removes that translation step.
 *
 * It is not only an input control: the same circle carries game state. Who is
 * leader, who is on the bus, and how a vote split across the table all read
 * spatially here, which a vertical list cannot show at all.
 *
 * Seats are rendered in SEAT ORDER in the DOM regardless of where they land
 * visually, so screen readers and keyboard traversal stay sane.
 */
export function RoundTable({
  players,
  viewerPlayerId,
  seatVisual,
  onSelect,
  center,
  label,
}: {
  /** Ascending by seat. */
  players: Player[];
  viewerPlayerId?: string | null;
  seatVisual?: (player: Player) => SeatVisual;
  onSelect?: (playerId: string) => void;
  center?: React.ReactNode;
  label?: string;
}) {
  const n = players.length;
  if (n === 0) return null;

  const viewerSeat =
    players.find((p) => p.id === viewerPlayerId)?.seat ?? players[0].seat;

  // Bigger tables need smaller seats; a 10-player ring still leaves ~38px of
  // gap between 51px seats on a 360px-wide phone, which is comfortable.
  const seatPct = n <= 6 ? 19 : n <= 8 ? 17 : 15.5;
  const radiusPct = 37;

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-[360px]"
      role="group"
      aria-label={label ?? "牌桌"}
    >
      {/* The table edge. Decorative — the seats carry all the meaning. */}
      <div
        aria-hidden
        className="absolute rounded-full border border-[color:var(--separator)]"
        style={{
          left: `${50 - radiusPct}%`,
          top: `${50 - radiusPct}%`,
          width: `${radiusPct * 2}%`,
          height: `${radiusPct * 2}%`,
        }}
      />

      {center && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-[46%] text-center">{center}</div>
        </div>
      )}

      {players.map((player) => {
        // Six o'clock is +90° in screen coordinates (y grows downward), and
        // increasing the angle from there sweeps clockwise round the face.
        const offset = (player.seat - viewerSeat + n) % n;
        const angle = ((90 + offset * (360 / n)) * Math.PI) / 180;
        const x = 50 + radiusPct * Math.cos(angle);
        const y = 50 + radiusPct * Math.sin(angle);

        const visual = seatVisual?.(player) ?? {};
        const isViewer = player.id === viewerPlayerId;
        const Tag = onSelect && !visual.disabled ? "button" : "div";

        return (
          <Tag
            key={player.id}
            {...(Tag === "button"
              ? {
                  type: "button" as const,
                  onClick: () => onSelect?.(player.id),
                  "aria-pressed": visual.selected ?? false,
                }
              : {})}
            aria-label={`${player.seat}号${player.name ? ` ${player.name}` : ""}${isViewer ? "（我）" : ""}`}
            className={cn(
              "absolute flex flex-col items-center justify-center rounded-full",
              "transition-[background-color,box-shadow,opacity] duration-150",
              visual.selected
                ? "bg-[color:var(--blue)] text-white"
                : "bg-[color:var(--bg-elevated)] text-[color:var(--label)]",
              !visual.selected && "shadow-[0_1px_3px_rgba(0,0,0,0.12)]",
              visual.ring === "speaker" && "ring-[3px] ring-[color:var(--blue)]",
              visual.dimmed && "opacity-35",
              visual.disabled && "pointer-events-none",
              Tag === "button" && "active:scale-95",
            )}
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: `${seatPct}%`,
              height: `${seatPct}%`,
              transform: "translate(-50%, -50%)",
              // Dashed outline reads as "this is my read", solid as "I know".
              ...(visual.mark && !visual.ring
                ? {
                    outline: `2.5px ${visual.mark.certain ? "solid" : "dashed"} ${visual.mark.color}`,
                    outlineOffset: "1px",
                  }
                : {}),
            }}
          >
            <span className="text-[clamp(15px,4.4vw,19px)] font-semibold leading-none">
              {player.seat}
            </span>

            {visual.mark ? (
              <span
                className="mt-0.5 text-[9px] font-semibold leading-none"
                style={{ color: visual.selected ? "#fff" : visual.mark.color }}
              >
                {visual.mark.text}
              </span>
            ) : isViewer ? (
              <span
                className={cn(
                  "mt-0.5 text-[9px] leading-none",
                  visual.selected
                    ? "text-white/80"
                    : "text-[color:var(--label-tertiary)]",
                )}
              >
                我
              </span>
            ) : (
              player.name && (
                <span
                  className={cn(
                    "mt-0.5 max-w-[86%] truncate text-[9px] leading-none",
                    visual.selected
                      ? "text-white/80"
                      : "text-[color:var(--label-secondary)]",
                  )}
                >
                  {player.name}
                </span>
              )
            )}

            {visual.badgeLeft && (
              <span
                title={visual.badgeLeft.title}
                className="absolute -left-1 -top-1 flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1 text-[11px] font-semibold text-white ring-2 ring-[color:var(--bg)]"
                style={{
                  backgroundColor: visual.badgeLeft.color ?? "var(--gray)",
                }}
              >
                {visual.badgeLeft.text}
              </span>
            )}

            {visual.badge && (
              <span
                title={visual.badge.title}
                className="absolute -right-1 -top-1 flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1 text-[11px] font-semibold text-white ring-2 ring-[color:var(--bg)]"
                style={{
                  backgroundColor: visual.badge.color ?? "var(--gray)",
                }}
              >
                {visual.badge.text}
              </span>
            )}
          </Tag>
        );
      })}
    </div>
  );
}

export const RATING_VAR: Record<number, string> = {
  1: "var(--rate-1)",
  2: "var(--rate-2)",
  3: "var(--rate-3)",
  4: "var(--rate-4)",
  5: "var(--rate-5)",
};
