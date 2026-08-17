"use client";

import type { Player, TurnDirection } from "@/lib/types/game";
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
  /** Bottom chip: reserved for 女 (the 湖中女神 token). */
  badgeBottom?: SeatBadge | null;
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
  seatDirection = "cw",
  leaderDirection,
  seatVisual,
  onSelect,
  center,
  label,
}: {
  /** Ascending by seat. */
  players: Player[];
  viewerPlayerId?: string | null;
  /** Which way seat numbers run on screen. */
  seatDirection?: TurnDirection;
  /** Draws the 车主 rotation arrow when set. */
  leaderDirection?: TurnDirection;
  seatVisual?: (player: Player) => SeatVisual;
  onSelect?: (playerId: string) => void;
  center?: React.ReactNode;
  label?: string;
}) {
  const n = players.length;
  if (n === 0) return null;

  const viewerSeat =
    players.find((p) => p.id === viewerPlayerId)?.seat ?? players[0].seat;

  // Seats are as large as the ring allows: at 10 players this leaves ~20px of
  // gap between 63px targets on a 360px phone, which is comfortable to hit.
  const seatPct = n <= 6 ? 23 : n <= 8 ? 20 : 17.5;
  const radiusPct = 37;
  const sweep = seatDirection === "cw" ? 1 : -1;

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-[360px]"
      role="group"
      aria-label={label ?? "牌桌"}
    >
      {/* The table edge, plus — when the caller asks for it — an arc showing
          which way the 车主 passes, so the rotation is visible rather than
          something you have to remember. */}
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full"
      >
        <circle
          cx="50"
          cy="50"
          r={radiusPct}
          fill="none"
          stroke="var(--separator)"
          strokeWidth="0.4"
        />
        {leaderDirection && (
          <LeaderArc
            direction={leaderDirection}
            // Clear of the seats: they occupy radiusPct ± seatPct/2, and the
            // seats grow at smaller tables, so a fixed inset would slide under
            // them exactly where it did before.
            radius={radiusPct - seatPct / 2 - 4}
          />
        )}
      </svg>

      {center && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {/* Narrow enough to stay inside the rotation arc at every table size. */}
        <div className="max-w-[36%] text-center">{center}</div>
        </div>
      )}

      {players.map((player) => {
        // Six o'clock is +90° in screen coordinates (y grows downward), and
        // increasing the angle from there sweeps clockwise round the face.
        const offset = (player.seat - viewerSeat + n) % n;
        const angle = ((90 + sweep * offset * (360 / n)) * Math.PI) / 180;
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
              // Hover matters on a pointer device: a circle of similar targets
              // gives no other cue about which one you are about to hit.
              Tag === "button" &&
                "active:scale-95 hover:brightness-95 hover:ring-2 hover:ring-[color:var(--blue)]/45 dark:hover:brightness-110",
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
            {/* Seat number and name are set at the same size on purpose: at a
                table people are called by either, and the name is not
                secondary once it is filled in. */}
            <span className={cn(SEAT_TEXT, "font-semibold")}>{player.seat}</span>

            {visual.mark ? (
              <span
                className={cn(SEAT_TEXT, "mt-px font-semibold")}
                style={{ color: visual.selected ? "#fff" : visual.mark.color }}
              >
                {visual.mark.text}
              </span>
            ) : player.name ? (
              <span
                className={cn(
                  SEAT_TEXT,
                  "mt-px max-w-[88%] truncate",
                  visual.selected
                    ? "text-white/85"
                    : "text-[color:var(--label-secondary)]",
                )}
              >
                {player.name}
              </span>
            ) : (
              isViewer && (
                <span
                  className={cn(
                    SEAT_TEXT,
                    "mt-px",
                    visual.selected
                      ? "text-white/85"
                      : "text-[color:var(--label-tertiary)]",
                  )}
                >
                  我
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

            {visual.badgeBottom && (
              <span
                title={visual.badgeBottom.title}
                className="absolute -bottom-1 left-1/2 flex h-[19px] min-w-[19px] -translate-x-1/2 items-center justify-center rounded-full px-1 text-[11px] font-semibold text-white ring-2 ring-[color:var(--bg)]"
                style={{
                  backgroundColor: visual.badgeBottom.color ?? "var(--gray)",
                }}
              >
                {visual.badgeBottom.text}
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

const SEAT_TEXT = "text-[clamp(13px,3.7vw,16px)] leading-none";

/** A short arc with an arrowhead, drawn at the top of the ring. */
function LeaderArc({
  direction,
  radius,
}: {
  direction: TurnDirection;
  radius: number;
}) {
  const at = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return [50 + radius * Math.cos(rad), 50 + radius * Math.sin(rad)] as const;
  };
  // A 60° arc across the top, swept in the direction the lead travels.
  const [x1, y1] = at(direction === "cw" ? -120 : -60);
  const [x2, y2] = at(direction === "cw" ? -60 : -120);
  const sweepFlag = direction === "cw" ? 1 : 0;
  // Arrowhead sits at the end of the arc, rotated to follow the tangent.
  const headAngle = direction === "cw" ? -60 : -120;
  const tangent = headAngle + (direction === "cw" ? 90 : -90);

  return (
    <g stroke="var(--label-tertiary)" fill="none" strokeWidth="0.9">
      {/* Native tooltip: the arrow is unlabelled by design, so hovering has to
          be able to answer "what is this". */}
      <title>车主按这个方向轮换</title>
      <path
        d={`M ${x1} ${y1} A ${radius} ${radius} 0 0 ${sweepFlag} ${x2} ${y2}`}
        strokeLinecap="round"
      />
      <polygon
        points="0,-1.8 4,0 0,1.8"
        fill="var(--label-tertiary)"
        stroke="none"
        transform={`translate(${x2} ${y2}) rotate(${tangent})`}
      />
      {/* A fat invisible stroke over the same path, so the tooltip has
          something big enough to actually hover. */}
      <path
        d={`M ${x1} ${y1} A ${radius} ${radius} 0 0 ${sweepFlag} ${x2} ${y2}`}
        stroke="transparent"
        strokeWidth="7"
      />
    </g>
  );
}

export const RATING_VAR: Record<number, string> = {
  1: "var(--rate-1)",
  2: "var(--rate-2)",
  3: "var(--rate-3)",
  4: "var(--rate-4)",
  5: "var(--rate-5)",
};
