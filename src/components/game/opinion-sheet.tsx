"use client";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { RatingChips } from "@/components/ui/rating-chips";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers } from "@/lib/store/hooks";
import { getCurrentOpinion, getOpinionHistory } from "@/lib/selectors";
import { playerLabel, seatLabel } from "@/lib/format/labels";
import type { Rating } from "@/lib/types/events";

/**
 * 保踩录入 — the highest-frequency interaction in the app.
 *
 * Tap a seat on the main screen, tap a rating: two taps, saved, no Save button.
 * The sheet stays open so a player who runs through their whole read ("我保 3，
 * 踩 5，7 看不清") can be recorded in one pass.
 */
export function OpinionSheet({
  speakerId,
  onClose,
}: {
  speakerId: string | null;
  onClose: () => void;
}) {
  const game = useGame();
  const events = useEvents();
  const players = usePlayers();
  const addEvent = useGameStore((s) => s.addEvent);
  const deleteEvent = useGameStore((s) => s.deleteEvent);

  if (!game || !speakerId) return null;

  const targets = players.filter((p) => p.id !== speakerId);

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={`${playerLabel(game, speakerId)} 怎么看别人`}
      subtitle="点数字直接存，不用再按保存。记录的是他公开表达的态度。"
    >
      <div className="space-y-2.5">
        {targets.map((target) => {
          const current = getCurrentOpinion(events, speakerId, target.id);
          const history = getOpinionHistory(events, speakerId, target.id);

          return (
            <div key={target.id} className="flex items-center gap-3">
              <div className="w-[4.5rem] shrink-0">
                <div className="text-[15px] font-medium leading-tight">
                  {seatLabel(game, target.id)}
                </div>
                {target.name && (
                  <div className="truncate text-[11px] text-fg-subtle">
                    {target.name}
                  </div>
                )}
                {history.length > 1 && (
                  <div className="text-[10px] text-fg-subtle">
                    改过 {history.length - 1} 次
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <RatingChips
                  ariaLabel={`${seatLabel(game, speakerId)} 对 ${seatLabel(game, target.id)} 的态度`}
                  value={current?.rating ?? null}
                  onChange={(rating: Rating) => {
                    // Re-tapping the current value is a no-op: it would add an
                    // event that changes nothing and clutter the history.
                    if (current?.rating === rating) return;
                    void addEvent({
                      type: "opinion",
                      speakerId,
                      targetId: target.id,
                      rating,
                    });
                  }}
                  onClear={
                    current
                      ? () => void deleteEvent(current.eventId)
                      : undefined
                  }
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-fg-subtle">
        空着 = 没表过态，跟明确说「看不清」（3）不是一回事，所以不会自动填 3。
        改口不会覆盖旧记录，时间线里能看到完整的变化。
      </p>
    </BottomSheet>
  );
}
