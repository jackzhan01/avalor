"use client";

import Link from "next/link";
import { CHIP_COLOR } from "@/components/ui/rating-chips";
import { useEvents, useGame, useOpinions, usePlayers } from "@/lib/store/hooks";
import { cn } from "@/lib/utils/cn";

/**
 * Rows are the speaker, columns the target: "行 对 列 的看法".
 *
 * An empty cell means the speaker never publicly said anything about that
 * player. It is NOT a 3 — that distinction is the whole reason the underlying
 * data model refuses to default missing opinions to neutral.
 */
export function OpinionMatrix() {
  const game = useGame();
  const players = usePlayers();
  const opinions = useOpinions();
  const events = useEvents();

  if (!game || !opinions) return null;
  if (events.length === 0 || opinions.current.size === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-[13px] text-fg-subtle">
        还没有人表过态。
      </p>
    );
  }

  return (
    <div>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="border-separate border-spacing-0.5 text-center text-[13px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-bg pr-1 text-[11px] font-normal text-fg-subtle">
                看↓/被看→
              </th>
              {players.map((target) => (
                <th
                  key={target.id}
                  className="h-7 w-8 text-[12px] font-semibold text-fg-muted"
                >
                  {target.seat}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((speaker) => (
              <tr key={speaker.id}>
                <th className="sticky left-0 z-10 bg-bg pr-1 text-[12px] font-semibold text-fg-muted">
                  <Link href={`/game/${game.id}/players/${speaker.id}`}>
                    {speaker.seat}
                  </Link>
                </th>
                {players.map((target) => {
                  if (speaker.id === target.id) {
                    return (
                      <td
                        key={target.id}
                        className="h-8 w-8 rounded bg-surface-2"
                        aria-label="自己"
                      />
                    );
                  }
                  const cell = opinions.current.get(speaker.id)?.get(target.id);
                  if (!cell) {
                    return (
                      <td
                        key={target.id}
                        className="h-8 w-8 rounded border border-border text-fg-subtle"
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
                      className={cn(
                        "relative h-8 w-8 rounded font-semibold text-white",
                      )}
                      style={{ backgroundColor: CHIP_COLOR[cell.rating] }}
                      title={`${speaker.seat}号 对 ${target.seat}号：${cell.rating}${cell.revisionCount > 1 ? `（改过 ${cell.revisionCount - 1} 次）` : ""}`}
                    >
                      {cell.rating}
                      {cell.revisionCount > 1 && (
                        <span
                          aria-hidden
                          className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-white/90"
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

      <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
        行 = 谁说的，列 = 说谁。空格「·」是没表过态，跟明确的 3（中立）不一样。
        右上角有小白点表示改过口。
      </p>
    </div>
  );
}
