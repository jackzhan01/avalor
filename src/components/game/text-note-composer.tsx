"use client";

import { useState } from "react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { PlayerGrid } from "@/components/ui/player-grid";
import { useGameStore } from "@/lib/store/game-store";
import { usePlayers } from "@/lib/store/hooks";

/**
 * Escape hatch for everything pairwise ratings can't express: "3号说2号和5号
 * 不可能都是好人", conditional claims, role claims, table reads.
 *
 * Deliberately unstructured — forcing natural language into categories mid-game
 * would cost more time than it saves.
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
  const players = usePlayers();
  const addEvent = useGameStore((s) => s.addEvent);
  const [playerId, setPlayerId] = useState<string | null>(defaultPlayerId ?? null);
  const [text, setText] = useState("");

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) return;
    await addEvent({
      type: "text",
      ...(playerId ? { playerId } : {}),
      text: trimmed,
    });
    setText("");
    setPlayerId(defaultPlayerId ?? null);
    onClose();
  }

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        setText("");
        onClose();
      }}
      title="记一条"
      subtitle="没法用保踩表达的都写这里"
      footer={
        <Button
          size="lg"
          fullWidth
          disabled={text.trim().length === 0}
          onClick={() => void save()}
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
        className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-[15px] outline-none focus:border-accent"
      />

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">
            关于谁 <span className="font-normal normal-case">（可不选）</span>
          </span>
          {playerId && (
            <button
              onClick={() => setPlayerId(null)}
              className="min-h-[32px] rounded-lg px-2 text-[13px] text-accent active:bg-surface-2"
            >
              取消选择
            </button>
          )}
        </div>
        <PlayerGrid
          players={players}
          mode="single"
          selectedIds={playerId ? [playerId] : []}
          onSelect={(id) => setPlayerId((prev) => (prev === id ? null : id))}
        />
      </div>
    </BottomSheet>
  );
}
