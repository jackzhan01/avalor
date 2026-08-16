"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import * as repo from "@/lib/db/repository";
import type { GameSummary } from "@/lib/db/repository";
import { useHydrated } from "@/lib/store/hooks";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, SectionTitle, Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/dialog";
import { formatGameDate } from "@/lib/format/labels";

export default function HomePage() {
  const hydrated = useHydrated();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GameSummary | null>(null);
  const [standalone, setStandalone] = useState(true);

  const refresh = useCallback(async () => {
    setGames(await repo.listRecentGames());
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void refresh();
    // An installed PWA is exempt from Safari's 7-day storage cleanup, so the
    // hint below is only worth showing to people browsing in a tab.
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        // iOS Safari predates the display-mode media query for this.
        (navigator as { standalone?: boolean }).standalone === true,
    );
  }, [hydrated, refresh]);

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-10 pt-8">
      <header className="mb-7">
        <h1 className="text-[2.6rem] font-semibold leading-none tracking-tight">
          Avalor
        </h1>
        <p className="mt-2 text-sm text-fg-muted">阿瓦隆记录本</p>
      </header>

      <Link href="/new" className="block">
        <Button size="lg" fullWidth>
          开一局新的
        </Button>
      </Link>

      <section className="mt-8">
        <SectionTitle>最近的对局</SectionTitle>

        {!hydrated || games === null ? (
          <div className="space-y-2">
            <Skeleton className="h-[68px] w-full" />
            <Skeleton className="h-[68px] w-full" />
          </div>
        ) : games.length === 0 ? (
          <EmptyState
            title="还没有记录过对局"
            hint="开一局，边打边记。"
          />
        ) : (
          <ul className="space-y-2">
            {games.map((game) => (
              <li key={game.id}>
                <Card className="flex items-center gap-3 p-0">
                  <Link
                    href={`/game/${game.id}`}
                    className="min-w-0 flex-1 px-3 py-3"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-[15px] font-medium">
                        {game.playerCount} 人局
                      </span>
                      <span
                        className={
                          game.status === "completed"
                            ? "text-[12px] text-fg-subtle"
                            : "text-[12px] font-medium text-accent"
                        }
                      >
                        {game.status === "completed" ? "已结束" : "进行中"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12px] text-fg-subtle">
                      {formatGameDate(game.createdAt)} · {game.eventCount} 条记录
                    </p>
                  </Link>
                  <button
                    onClick={() => setPendingDelete(game)}
                    aria-label="删除这局记录"
                    className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg-subtle active:bg-surface-2"
                  >
                    <span aria-hidden>🗑</span>
                  </button>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hydrated && !standalone && (
        <p className="mt-8 rounded-xl bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-fg-muted">
          记录只存在这台设备上。建议把本页
          <strong className="font-medium text-fg">「添加到主屏幕」</strong>
          —— 浏览器会清理长期没打开的网站数据，装成 App 后就不会被清掉。
        </p>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这局记录？"
        message={
          pendingDelete
            ? `${pendingDelete.playerCount} 人局，共 ${pendingDelete.eventCount} 条记录。删掉之后没法恢复。`
            : ""
        }
        confirmLabel="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await repo.deleteGame(pendingDelete.id);
          setPendingDelete(null);
          await refresh();
        }}
      />
    </main>
  );
}
