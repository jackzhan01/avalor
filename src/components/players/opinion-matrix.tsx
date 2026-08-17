"use client";

import Link from "next/link";
import { RATING_VAR } from "@/components/table/round-table";
import { useEvents, useGame, useOpinions, usePlayers } from "@/lib/store/hooks";

/**
 * Rows are the speaker, columns the target: 行说列。
 *
 * A circle is the right shape for entry; a grid is the right shape for
 * comparison. This is the comparison view — scanning a column tells you at a
 * glance who the table is on.
 *
 * An empty cell means the speaker never publicly said anything about that
 * player. It is NOT a 3, and it never renders as one.
 */
export function OpinionMatrix() {
  const game = useGame();
  const players = usePlayers();
  const opinions = useOpinions();
  const events = useEvents();

  if (!game || !opinions) return null;
  if (events.length === 0 || opinions.current.size === 0) {
    return (
      <p className="t-footnote px-1 py-6 text-center text-[color:var(--label-tertiary)]">
        还没有人表过态。
      </p>
    );
  }

  return (
    <div>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="border-separate border-spacing-[3px] text-center">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-[color:var(--bg)] pr-1 text-[10px] font-normal text-[color:var(--label-tertiary)]">
                说↓/被说→
              </th>
              {players.map((target) => (
                <th
                  key={target.id}
                  className="h-6 w-8 text-[12px] font-semibold text-[color:var(--label-secondary)]"
                >
                  {target.seat}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((speaker) => (
              <tr key={speaker.id}>
                <th className="sticky left-0 z-10 bg-[color:var(--bg)] pr-1 text-[12px] font-semibold text-[color:var(--label-secondary)]">
                  <Link href={`/game/${game.id}/players/${speaker.id}`}>
                    {speaker.seat}
                  </Link>
                </th>
                {players.map((target) => {
                  if (speaker.id === target.id) {
                    return (
                      <td
                        key={target.id}
                        className="h-8 w-8 rounded-[6px] bg-[color:var(--fill)]"
                        aria-label="自己"
                      />
                    );
                  }
                  const cell = opinions.current.get(speaker.id)?.get(target.id);
                  if (!cell) {
                    return (
                      <td
                        key={target.id}
                        className="h-8 w-8 rounded-[6px] bg-[color:var(--bg-elevated)] text-[color:var(--label-tertiary)]"
                        title={`${speaker.seat}号 没说过 ${target.seat}号`}
                      >
                        <span aria-hidden>·</span>
                        <span className="sr-only">没表过态</span>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={target.id}
                      className="relative h-8 w-8 rounded-[6px] text-[13px] font-semibold text-white"
                      style={{ backgroundColor: RATING_VAR[cell.rating] }}
                      title={`${speaker.seat}号 对 ${target.seat}号：${cell.rating}${cell.revisionCount > 1 ? `（改过 ${cell.revisionCount - 1} 次）` : ""}`}
                    >
                      {cell.rating}
                      {cell.revisionCount > 1 && (
                        <span
                          aria-hidden
                          className="absolute right-[3px] top-[3px] h-1 w-1 rounded-full bg-white/90"
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="t-caption mt-2 px-1 text-[color:var(--label-tertiary)]">
        行 = 谁说的，列 = 说谁。「·」是没表过态，跟明确的 3（中立）不一样。右上角小点表示改过口。
      </p>
    </div>
  );
}
