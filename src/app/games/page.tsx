"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import * as repo from "@/lib/db/repository";
import type { GameSummary } from "@/lib/db/repository";
import { useHydrated } from "@/lib/store/hooks";
import { ListGroup, ListRow } from "@/components/ui/list";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatGameDate } from "@/lib/format/labels";

export default function GamesPage() {
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
    // hint below is only worth showing to someone browsing in a tab.
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as { standalone?: boolean }).standalone === true,
    );
  }, [hydrated, refresh]);

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-16">
      <header className="pt-safe flex items-center justify-between pb-1 pt-3">
        <Link
          href="/menu"
          aria-label="返回菜单"
          className="t-body -ml-2 flex min-h-[44px] items-center px-2 text-[color:var(--blue)]"
        >
          <span aria-hidden className="text-[20px] leading-none">‹</span>
        </Link>
      </header>

      <h1 className="t-large-title mb-6">之前的对局</h1>

      {!hydrated || games === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[60px] w-full" />
          <Skeleton className="h-[60px] w-full" />
        </div>
      ) : games.length === 0 ? (
        <EmptyState
          title="还没有记录过对局"
          action={
            <Link href="/new">
              <Button>开一局</Button>
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          <ListGroup>
            {games.map((game) => (
              <ListRow
                key={game.id}
                href={`/game/${game.id}`}
                label={`${game.playerCount} 人局`}
                detail={`${formatGameDate(game.createdAt)} · ${game.eventCount} 条记录`}
                value={
                  <span
                    className={
                      game.status === "completed"
                        ? "t-footnote text-[color:var(--label-tertiary)]"
                        : "t-footnote text-[color:var(--blue)]"
                    }
                  >
                    {game.status === "completed" ? "已结束" : "进行中"}
                  </span>
                }
                accessory="chevron"
              />
            ))}
          </ListGroup>

          <ListGroup footer="删掉之后没法恢复。">
            {games.map((game) => (
              <ListRow
                key={game.id}
                label={`删除 ${game.playerCount} 人局 · ${formatGameDate(game.createdAt)}`}
                destructive
                onClick={() => setPendingDelete(game)}
              />
            ))}
          </ListGroup>
        </div>
      )}

      {hydrated && !standalone && (
        <p className="t-footnote mt-8 px-1 text-[color:var(--label-secondary)]">
          记录只存在这台设备上。建议把本页
          <strong className="font-semibold text-[color:var(--label)]">
            「添加到主屏幕」
          </strong>
          —— 浏览器会清理长期没打开的网站数据，装成 App 后就不会被清掉。
        </p>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这局记录？"
        message={
          pendingDelete
            ? `${pendingDelete.playerCount} 人局，共 ${pendingDelete.eventCount} 条记录。`
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
