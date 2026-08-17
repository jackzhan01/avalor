"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/lib/store/game-store";
import { useGame, usePlayers } from "@/lib/store/hooks";
import { playerLabel, seatLabel } from "@/lib/format/labels";
import { cn } from "@/lib/utils/cn";

/**
 * Escape hatch for what 保踩 and 意向车 can't express: conditional claims,
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
  /** Set when opened from a player: the note is already about them. */
  defaultPlayerId?: string | null;
}) {
  const game = useGame();
  const players = usePlayers();
  const addEvent = useGameStore((s) => s.addEvent);
  const [playerId, setPlayerId] = useState<string | null>(defaultPlayerId ?? null);
  const [text, setText] = useState("");
  // Opened from a seat, the subject is already decided — asking again would be
  // re-answering a question the user just answered by tapping that seat.
  const [detached, setDetached] = useState(false);
  const preset = defaultPlayerId != null && !detached;

  if (!game || !open) return null;

  return (
    <Sheet
      open
      onClose={() => {
        setText("");
        setDetached(false);
        onClose();
      }}
      title="记一条"
      subtitle={preset ? `关于 ${playerLabel(game, defaultPlayerId!)}` : undefined}
      layerKey="note"
      trailing={<span className="w-16" />}
      footer={
        <Button
          size="lg"
          fullWidth
          disabled={text.trim().length === 0}
          onClick={() => {
            const attachTo = preset ? defaultPlayerId : playerId;
            void addEvent({
              type: "text",
              ...(attachTo ? { playerId: attachTo } : {}),
              text: text.trim(),
            });
            setText("");
            setDetached(false);
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
        placeholder={
          preset
            ? `${seatLabel(game, defaultPlayerId!)} 说了什么？`
            : "比如：3号说 2号 和 5号 不可能都是好人"
        }
        className="t-body w-full rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-3 outline-none placeholder:text-[color:var(--label-tertiary)]"
      />

      {preset ? (
        <div className="mt-3 flex items-center justify-between rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-2.5">
          <span className="t-footnote text-[color:var(--label-secondary)]">
            这条记在{" "}
            <span className="font-semibold text-[color:var(--label)]">
              {playerLabel(game, defaultPlayerId!)}
            </span>{" "}
            名下
          </span>
          <button
            onClick={() => {
              setDetached(true);
              setPlayerId(null);
            }}
            className="t-footnote font-medium text-[color:var(--blue)] active:opacity-60"
          >
            换个人
          </button>
        </div>
      ) : (
        <>
          <p className="t-footnote mb-2 mt-5 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
            关于谁（可不选）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {players.map((player) => (
              <button
                key={player.id}
                onClick={() =>
                  setPlayerId((prev) => (prev === player.id ? null : player.id))
                }
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
        </>
      )}
    </Sheet>
  );
}
