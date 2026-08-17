"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const box = useRef<HTMLTextAreaElement>(null);

  /*
   * Grow with the text instead of scrolling inside a fixed three rows.
   *
   * Collapsing to `auto` first is what makes it shrink again — `scrollHeight`
   * of an element already tall enough reports the height it has, not the
   * height it needs, so measuring without the reset only ever grows.
   *
   * Past the cap it scrolls, with the bar hidden. Pagination was the other
   * idea and is not worth it here: text that reflows between pages as you
   * type means owning the caret across page boundaries, and no editor does
   * this because the answer people already expect is a taller box.
   */
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (!hidden) fit();
  }, [hidden, fit]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!game) return null;

  function onChange(next: string) {
    setText(next);
    fit();
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
        ref={box}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="下一轮想说什么，先记这儿"
        style={{
          minHeight: "3.6rem",
          /*
           * Stops just short of the dock. The dock publishes its own measured
           * height, so this holds in vote mode where it is two rows tall —
           * a fixed cap would have slid under it exactly then.
           */
          maxHeight: "calc(58dvh - var(--dock-h, 0px))",
        }}
        className="t-footnote no-scrollbar w-full resize-none overflow-y-auto bg-transparent px-1 outline-none placeholder:text-[color:var(--label-tertiary)]"
      />
    </div>
  );
}
