"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as repo from "@/lib/db/repository";
import { PLAYER_COUNTS, evilCount, goodCount, teamSize } from "@/lib/rules/avalon";
import { useHydrated } from "@/lib/store/hooks";
import type { Player, PlayerCount } from "@/lib/types/game";
import { RoundTable } from "@/components/table/round-table";
import { cn } from "@/lib/utils/cn";

type Step = "count" | "me" | "leader";

/**
 * Setup, one question per screen.
 *
 * Steps two and three are answered by tapping the round table itself, which
 * does double duty: picking your seat rotates the circle so you land at six
 * o'clock, and that rotation teaches what the circle means before the game
 * even starts. Names and role configuration are optional and live in game
 * settings — nothing that can be skipped belongs in the way of starting.
 */
export default function NewGamePage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [step, setStep] = useState<Step>("count");
  const [playerCount, setPlayerCount] = useState<PlayerCount>(10);
  const [viewerSeat, setViewerSeat] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [hasHistory, setHasHistory] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    void repo.listRecentGames(1).then((g) => setHasHistory(g.length > 0));
  }, [hydrated]);

  /** Stand-in seats: the real game record does not exist yet. */
  const seats: Player[] = useMemo(
    () => Array.from({ length: playerCount }, (_, i) => ({ id: `s${i + 1}`, seat: i + 1 })),
    [playerCount],
  );

  async function create(firstLeaderSeat: number) {
    setCreating(true);
    try {
      const created = await repo.createGame({
        playerCount,
        viewerSeat: viewerSeat ?? 1,
        firstLeaderSeat,
      });
      router.replace(`/game/${created.id}`);
    } catch {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-8">
      <header className="pt-safe flex items-center justify-between pb-2 pt-3">
        <button
          onClick={() => {
            if (step === "count") router.push("/menu");
            else if (step === "me") setStep("count");
            else setStep("me");
          }}
          aria-label="返回"
          className="t-body -ml-2 flex min-h-[44px] items-center px-2 text-[color:var(--blue)]"
        >
          <span aria-hidden className="text-[20px] leading-none">‹</span>
        </button>
        {step === "count" && hasHistory && (
          <Link
            href="/games"
            className="t-body min-h-[44px] px-1 leading-[44px] text-[color:var(--blue)]"
          >
            之前的对局
          </Link>
        )}
      </header>

      {step === "count" && (
        <section className="a-push flex flex-1 flex-col">
          <h1 className="t-large-title">几人局</h1>
          <p className="t-subhead mt-1 text-[color:var(--label-secondary)]">
            {goodCount(playerCount)} 好 {evilCount(playerCount)} 坏 · 每轮上车{" "}
            {[1, 2, 3, 4, 5].map((m) => teamSize(playerCount, m)).join(" / ")}
          </p>

          <div className="mt-8 grid grid-cols-3 gap-2.5">
            {PLAYER_COUNTS.map((count) => (
              <button
                key={count}
                onClick={() => {
                  setPlayerCount(count);
                  setViewerSeat(null);
                  setStep("me");
                }}
                // Hovering previews the split below, so the number you are
                // about to press is never a blind choice.
                onFocus={() => setPlayerCount(count)}
                onMouseEnter={() => setPlayerCount(count)}
                className={cn(
                  "flex min-h-[86px] items-center justify-center rounded-[14px] text-[30px] font-semibold",
                  "bg-[color:var(--bg-elevated)] text-[color:var(--label)]",
                  "transition-colors active:opacity-70",
                  "hover:bg-[color:var(--blue)] hover:text-white",
                  "focus-visible:bg-[color:var(--blue)] focus-visible:text-white",
                )}
              >
                {count}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "me" && (
        <section className="a-push flex flex-1 flex-col">
          <h1 className="t-large-title">你是几号位</h1>
          <p className="t-subhead mt-1 text-[color:var(--label-secondary)]">
            点一下你自己的位置，牌桌会转过来，把你放到最下方。
          </p>
          <p className="t-footnote mt-2 rounded-[10px] bg-[color:var(--fill)] px-3 py-2 text-[color:var(--label-secondary)]">
            如果这局没规定号码，直接点 1 号位当自己就行。
          </p>
          <div className="mt-6">
            <RoundTable
              players={seats}
              viewerPlayerId={viewerSeat ? `s${viewerSeat}` : "s1"}
              seatVisual={(p) => ({ selected: p.id === `s${viewerSeat}` })}
              onSelect={(id) => {
                const seat = Number(id.slice(1));
                setViewerSeat(seat);
                // Let the rotation land before moving on.
                setTimeout(() => setStep("leader"), 260);
              }}
              center={
                <p className="t-footnote pointer-events-none text-[color:var(--label-secondary)]">
                  点你自己
                </p>
              }
              label="选择你的座位"
            />
          </div>
        </section>
      )}

      {step === "leader" && (
        <section className="a-push flex flex-1 flex-col">
          <h1 className="t-large-title">谁是第一个车主</h1>
          <p className="t-subhead mt-1 text-[color:var(--label-secondary)]">
            之后每轮自动往下顺，随时能改。
          </p>
          <div className="mt-8">
            <RoundTable
              players={seats}
              viewerPlayerId={`s${viewerSeat ?? 1}`}
              seatVisual={() => ({})}
              onSelect={(id) => {
                if (creating) return;
                void create(Number(id.slice(1)));
              }}
              center={
                <p className="t-footnote pointer-events-none text-[color:var(--label-secondary)]">
                  {creating ? "开局中…" : "点第一个车主"}
                </p>
              }
              label="选择第一个车主"
            />
          </div>
        </section>
      )}
    </main>
  );
}
