"use client";

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "@/lib/store/game-store";
import { useGame } from "@/lib/store/hooks";

/**
 * A draft of what to say next.
 *
 * Private, like the role marks — it is your own thinking, not a record of the
 * game — so it hides with them and is stripped from a public export.
 */
export function Scratchpad({ visible }: { visible: boolean }) {
  const game = useGame();
  const setScratchpad = useGameStore((s) => s.setScratchpad);
  const [text, setText] = useState(game?.scratchpad ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt the stored value when the game loads or switches.
  useEffect(() => {
    setText(game?.scratchpad ?? "");
  }, [game?.id]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!game) return null;

  function onChange(next: string) {
    setText(next);
    // Typing shouldn't hit IndexedDB on every keystroke.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void setScratchpad(next), 500);
  }

  if (!visible) {
    return (
      <p className="t-footnote px-1 text-center text-[color:var(--label-tertiary)]">
        {text.trim().length > 0 ? "草稿已隐藏" : ""}
      </p>
    );
  }

  return (
    <div className="rounded-[10px] bg-[color:var(--bg-elevated)] p-2.5">
      <label
        htmlFor="scratchpad"
        className="t-caption mb-1 block px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]"
      >
        我的草稿 · 只有我看得到
      </label>
      <textarea
        id="scratchpad"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        placeholder="下一轮想说什么，先记这儿"
        className="t-footnote w-full resize-none bg-transparent px-1 outline-none placeholder:text-[color:var(--label-tertiary)]"
      />
    </div>
  );
}
