"use client";

import type { Player } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

/**
 * The atomic seat control. Seat number is huge because that is what people say
 * out loud; the name, if any, is secondary.
 */
export function PlayerChip({
  player,
  selected,
  disabled,
  badge,
  subtitle,
  tone = "default",
  onClick,
}: {
  player: Player;
  selected?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
  subtitle?: React.ReactNode;
  tone?: "default" | "leader";
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={onClick ? !!selected : undefined}
      className={cn(
        "relative flex min-h-[56px] flex-col items-center justify-center rounded-xl border px-1 py-1.5",
        "transition-colors disabled:opacity-40",
        selected
          ? "border-accent bg-accent text-accent-fg"
          : tone === "leader"
            ? "border-accent bg-accent-soft text-fg"
            : "border-border bg-surface-2 text-fg active:bg-surface-3",
      )}
    >
      <span className="text-lg font-semibold leading-none">{player.seat}</span>
      {player.name && (
        <span
          className={cn(
            "mt-0.5 max-w-full truncate text-[11px] leading-tight",
            selected ? "text-accent-fg/80" : "text-fg-muted",
          )}
        >
          {player.name}
        </span>
      )}
      {subtitle && (
        <span
          className={cn(
            "mt-0.5 text-[11px] leading-none",
            selected ? "text-accent-fg/80" : "text-fg-subtle",
          )}
        >
          {subtitle}
        </span>
      )}
      {badge && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-surface px-1 text-[10px] font-semibold shadow ring-1 ring-border">
          {badge}
        </span>
      )}
    </Tag>
  );
}

/**
 * Reused by the proposal builder, the opinion target picker, the vote recorder
 * and the players tab — hence the selection modes rather than four near-copies.
 */
export function PlayerGrid({
  players,
  mode = "none",
  selectedIds = [],
  disabledIds = [],
  leaderId,
  onSelect,
  renderSubtitle,
  renderBadge,
  columns = 5,
}: {
  players: Player[];
  mode?: "none" | "single" | "multi";
  selectedIds?: string[];
  disabledIds?: string[];
  leaderId?: string | null;
  onSelect?: (playerId: string) => void;
  renderSubtitle?: (player: Player) => React.ReactNode;
  renderBadge?: (player: Player) => React.ReactNode;
  columns?: 4 | 5;
}) {
  const selected = new Set(selectedIds);
  const disabled = new Set(disabledIds);
  return (
    <div
      className={cn(
        "grid gap-2",
        columns === 5 ? "grid-cols-5" : "grid-cols-4",
      )}
    >
      {players.map((player) => (
        <PlayerChip
          key={player.id}
          player={player}
          selected={mode !== "none" && selected.has(player.id)}
          disabled={disabled.has(player.id)}
          tone={leaderId === player.id ? "leader" : "default"}
          subtitle={renderSubtitle?.(player)}
          badge={renderBadge?.(player)}
          onClick={onSelect ? () => onSelect(player.id) : undefined}
        />
      ))}
    </div>
  );
}
