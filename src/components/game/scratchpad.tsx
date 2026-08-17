"use client";

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "@/lib/store/game-store";
import { useGame } from "@/lib/store/hooks";

/**
 * A draft of what to say next.
 *
 * It has its own show/hide, independent of the role layers: what you plan to
 * say and what you know about people are different things, and tying them
 * together meant you couldn't glance at your own notes without also lighting
 * up everyone's role marks.
 *
 * It lives permanently under the table rather than appearing conditionally,
 * so the drafting space is always where you left it.
 */
export function Scratchpad() {
  const game = useGame();
  const setScratchpad = useGameStore((s) => s.setScratchpad);
  // Seeded once. The caller keys this component on the game id, so switching
  // games remounts it — no effect syncing back from the store, which would
  // otherwise race the debounced write and overwrite what is being typed.
  const [text, setText] = useState(game?.scratchpad ?? "");
  const [hidden, setHidden] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  if (hidden) {
    return (
      <button
        onClick={() => setHidden(false)}
        className="flex min-h-[44px] w-full items-center justify-between rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 active:opacity-70"
      >
        <span className="t-footnote text-[color:var(--label-secondary)]">
          我的草稿{text.trim().length > 0 ? " · 已隐藏" : " · 空"}
        </span>
        <span className="t-footnote font-medium text-[color:var(--blue)]">
          显示
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-[10px] bg-[color:var(--bg-elevated)] p-2.5">
      <div className="mb-1 flex items-center justify-between px-1">
        <label
          htmlFor="scratchpad"
          className="t-caption uppercase tracking-[0.06em] text-[color:var(--label-secondary)]"
        >
          我的草稿 · 只有我看得到
        </label>
        <button
          onClick={() => setHidden(true)}
          className="t-caption min-h-[28px] px-1 font-medium text-[color:var(--blue)] active:opacity-60"
        >
          隐藏
        </button>
      </div>
      <textarea
        id="scratchpad"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="下一轮想说什么，先记这儿"
        className="t-footnote w-full resize-none bg-transparent px-1 outline-none placeholder:text-[color:var(--label-tertiary)]"
      />
    </div>
  );
}
