"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/lib/store/game-store";
import { useGame, usePlayers } from "@/lib/store/hooks";
import { seatLabel } from "@/lib/format/labels";
import { cn } from "@/lib/utils/cn";

/**
 * Escape hatch for what保踩 and 意向车 can't express: conditional claims,
 * "2号和5号不可能都是好人", table reads.
 *
 * Deliberately unstructured — forcing natural language into categories
 * mid-game costs more time than it saves.
 */
export function TextNoteComposer({
  open,
  onClose,
  defaultPlayerId,
}: {
  open: boolean;
  onClose: () => void;
  defaultPlayerId?: string | null;
}) {
  const game = useGame();
  const players = usePlayers();
  const addEvent = useGameStore((s) => s.addEvent);
  const [playerId, setPlayerId] = useState<string | null>(defaultPlayerId ?? null);
  const [text, setText] = useState("");

  if (!game || !open) return null;

  return (
    <Sheet
      open
      onClose={() => {
        setText("");
        onClose();
      }}
      title="记一条"
      layerKey="note"
      trailing={<span className="w-16" />}
      footer={
        <Button
          size="lg"
          fullWidth
          disabled={text.trim().length === 0}
          onClick={() => {
            void addEvent({
              type: "text",
              ...(playerId ? { playerId } : {}),
              text: text.trim(),
            });
            setText("");
            setPlayerId(defaultPlayerId ?? null);
            onClose();
          }}
        >
          记下来
        </Button>
      }
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        autoFocus
        placeholder="比如：3号说 2号 和 5号 不可能都是好人"
        className="t-body w-full rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-3 outline-none placeholder:text-[color:var(--label-tertiary)]"
      />

      <p className="t-footnote mb-2 mt-5 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
        关于谁（可不选）
      </p>
      <div className="flex flex-wrap gap-1.5">
        {players.map((player) => (
          <button
            key={player.id}
            onClick={() => setPlayerId((prev) => (prev === player.id ? null : player.id))}
            aria-pressed={playerId === player.id}
            className={cn(
              "t-subhead min-h-[44px] min-w-[52px] rounded-[10px] px-3 font-medium active:opacity-70",
              playerId === player.id
                ? "bg-[color:var(--blue)] text-white"
                : "bg-[color:var(--bg-elevated)] text-[color:var(--label)]",
            )}
          >
            {seatLabel(game, player.id)}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
