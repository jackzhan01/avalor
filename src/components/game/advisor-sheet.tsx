"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { analyzeGame, type GameAnalysis } from "@/lib/decision/analyze";
import { useEvents, useGame } from "@/lib/store/hooks";
import type { GameRecord } from "@/lib/types/game";

/**
 * The decision layer, on screen.
 *
 * Everything here is computed on the device from the log and the rules. No
 * key, no request, no waiting on anyone else's server — which is why it can
 * sit next to the two features that DO leave the device without inheriting
 * their consent flow or their cost.
 *
 * The one thing this component must never do is round a coin flip into advice.
 * When the two moves are worth the same it says so, and shows the car's own
 * risk instead, clearly labelled as a different kind of claim.
 */

const seatOf = (game: GameRecord, id: string) =>
  game.players.find((p) => p.id === id)?.seat ?? "?";

const TONE: Record<string, { label: string; className: string }> = {
  strong: {
    label: "建议",
    className: "bg-[color:var(--fill-success)] text-[color:var(--label-inverse)]",
  },
  lean: {
    label: "略偏向",
    className: "bg-[color:var(--fill-secondary)] text-[color:var(--label-primary)]",
  },
  "too-close": {
    label: "太接近，两边都行",
    className: "bg-[color:var(--fill-secondary)] text-[color:var(--label-secondary)]",
  },
};

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="t-caption w-16 shrink-0 text-[color:var(--label-secondary)]">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--fill-tertiary)]">
        <div
          className="h-full rounded-full bg-[color:var(--label-secondary)]"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </div>
      <span className="t-caption w-10 shrink-0 text-right tabular-nums text-[color:var(--label-secondary)]">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

export function AdvisorSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const game = useGame();
  const events = useEvents();
  const [result, setResult] = useState<GameAnalysis | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open || !game) return;
    let cancelled = false;
    setWorking(true);
    setResult(null);
    /*
     * A ten-player rollout is a few hundred milliseconds of solid arithmetic,
     * which would freeze the tap that opened this. One frame of breathing room
     * lets the sheet paint first; the work then runs to completion.
     */
    const timer = setTimeout(() => {
      analyzeGame(events, game)
        .then((out) => {
          if (!cancelled) setResult(out);
        })
        .finally(() => {
          if (!cancelled) setWorking(false);
        });
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, game, events]);

  if (!game) return null;

  const decision = result?.decision;
  const tone = decision ? TONE[decision.confidence] : null;

  return (
    <Sheet open={open} onClose={onClose} title="该怎么走">
      <div className="flex flex-col gap-4 pb-2">
        {working && (
          <p className="t-body text-[color:var(--label-secondary)]">
            正在把还站得住的世界都跑一遍…
          </p>
        )}

        {result && !working && (
          <>
            {result.beliefs.contradictory && (
              <p className="t-body text-[color:var(--label-secondary)]">
                记录自相矛盾了 —— 没有任何一种身份分配能同时满足全部记录。先回时间线检查一下。
              </p>
            )}

            {result.currentTeam && (
              <section className="flex flex-col gap-2">
                <h3 className="t-headline">桌上这辆车</h3>
                <p className="t-body text-[color:var(--label-secondary)]">
                  {result.currentTeam.team.map((id) => `${seatOf(game, id)}号`).join("、")}
                </p>
                <Bar value={result.currentTeam.failRisk} label="崩车概率" />
                <p className="t-caption text-[color:var(--label-tertiary)]">
                  在所有合法车里排第 {Math.round(result.currentTeam.percentile * 100)} 百分位
                  （0 最干净）。
                </p>
              </section>
            )}

            {decision?.type === "vote" && tone && (
              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="t-headline">投票</h3>
                  <span className={`t-caption rounded-full px-2 py-0.5 ${tone.className}`}>
                    {decision.recommendation === "approve"
                      ? "上票"
                      : decision.recommendation === "reject"
                        ? "下票"
                        : tone.label}
                  </span>
                </div>
                <Bar value={decision.approve.win} label="上票胜率" />
                <Bar value={decision.reject.win} label="下票胜率" />
                <p className="t-caption tabular-nums text-[color:var(--label-tertiary)]">
                  差值 {(decision.delta * 100).toFixed(1)} ± {(decision.deltaSe * 100).toFixed(1)} 个百分点
                </p>
                <p className="t-body text-[color:var(--label-secondary)]">
                  {decision.explanation}
                </p>
              </section>
            )}

            {decision?.type === "proposal" && tone && (
              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="t-headline">点车</h3>
                  <span className={`t-caption rounded-full px-2 py-0.5 ${tone.className}`}>
                    {tone.label}
                  </span>
                </div>
                <p className="t-body">
                  {decision.recommended.team
                    .map((id) => `${seatOf(game, id)}号`)
                    .join("、")}
                </p>
                <Bar value={decision.recommended.failRisk} label="崩车概率" />
                <p className="t-body text-[color:var(--label-secondary)]">
                  {decision.explanation}
                </p>
                {decision.alternatives.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="t-caption text-[color:var(--label-tertiary)]">备选</p>
                    {decision.alternatives.map((option) => (
                      <p
                        key={option.team.join("-")}
                        className="t-caption tabular-nums text-[color:var(--label-secondary)]"
                      >
                        {option.team.map((id) => `${seatOf(game, id)}号`).join("、")} ·
                        崩车 {Math.round(option.failRisk * 100)}%
                        {option.estimate
                          ? ` · 胜率 ${Math.round(option.estimate.win * 100)}%`
                          : ""}
                      </p>
                    ))}
                  </div>
                )}
              </section>
            )}

            {!decision && (
              <p className="t-body text-[color:var(--label-secondary)]">
                {result.noDecisionReason === "no-viewer"
                  ? "先在开局设置里选一下你坐哪个位置，才能给你建议。"
                  : result.noDecisionReason === "no-side"
                    ? "先填一下你这局的身份 —— 不知道你要帮哪边赢，就没有建议可给。"
                    : "现在没有轮到你决定的事。等桌上点了车，或者轮到你点车再来。"}
              </p>
            )}

            <p className="t-caption text-[color:var(--label-tertiary)]">
              全部在这台设备上算出来的，不联网、不花钱。胜率是把还站得住的世界各跑一遍数出来的，
              所以带着正负号；差值落在噪声里的时候，它会直说两边都行。
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
