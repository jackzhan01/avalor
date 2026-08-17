"use client";

import type { Player } from "@/lib/types/game";
import { cn } from "@/lib/utils/cn";

/**
 * Flat seat picker, used only where a circle would be overkill — the edit
 * sheet, mostly. Live recording goes through the round table.
 */
export function SeatPicker({
  players,
  selectedIds = [],
  mode = "multi",
  onSelect,
}: {
  players: Player[];
  selectedIds?: string[];
  mode?: "single" | "multi";
  onSelect: (playerId: string) => void;
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="flex flex-wrap gap-1.5" role="group">
      {players.map((player) => {
        const on = selected.has(player.id);
        return (
          <button
            key={player.id}
            type="button"
            aria-pressed={on}
            aria-label={`${player.seat}号${player.name ? ` ${player.name}` : ""}`}
            onClick={() => onSelect(player.id)}
            className={cn(
              "flex min-h-[48px] min-w-[52px] flex-col items-center justify-center rounded-[10px] px-2 active:opacity-70",
              on
                ? "bg-[color:var(--blue)] text-white"
                : "bg-[color:var(--fill)] text-[color:var(--label)]",
            )}
          >
            <span className="text-[16px] font-semibold leading-none">
              {player.seat}
            </span>
            {player.name && (
              <span
                className={cn(
                  "mt-0.5 max-w-[52px] truncate text-[10px] leading-none",
                  on ? "text-white/80" : "text-[color:var(--label-secondary)]",
                )}
              >
                {player.name}
              </span>
            )}
          </button>
        );
      })}
      <span className="sr-only">{mode === "single" ? "单选" : "多选"}</span>
    </div>
  );
}
