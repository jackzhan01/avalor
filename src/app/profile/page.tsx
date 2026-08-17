"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as repo from "@/lib/db/repository";
import { useHydrated } from "@/lib/store/hooks";
import { ListGroup, ListRow } from "@/components/ui/list";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import {
  computeProfileStats,
  mostPlayedRole,
  winRate,
  type ProfileStats,
} from "@/lib/stats/profile";
import { ROLE_LABELS } from "@/lib/format/labels";

export default function ProfilePage() {
  const hydrated = useHydrated();
  const [stats, setStats] = useState<ProfileStats | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    void repo
      .listAllGames()
      .then(({ games, eventCounts }) =>
        setStats(computeProfileStats(games, eventCounts)),
      );
  }, [hydrated]);

  const overall = stats
    ? winRate({ played: stats.rated, won: stats.wins })
    : null;
  const favourite = stats ? mostPlayedRole(stats) : null;

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-10">
      <PageHeader back={{ href: "/menu", label: "返回菜单" }} title="个人主页" />

      {!hydrated || stats === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : stats.total === 0 ? (
        <EmptyState
          title="还没有对局数据"
          hint="打完并复盘几局，这里就有东西看了。"
          action={
            <Link href="/new">
              <Button>开一局</Button>
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-7">
          <div className="flex gap-2">
            <StatTile
              label="总胜率"
              value={overall === null ? "—" : `${overall}%`}
              detail={
                stats.rated > 0 ? `${stats.wins} / ${stats.rated} 局` : "还没数据"
              }
            />
            <StatTile
              label="记录过"
              value={String(stats.total)}
              detail={`${stats.completed} 局已结束`}
            />
          </div>

          <ListGroup
            header="分阵营"
            footer="只统计既填了自己身份、又记了胜负的对局。缺一半的不算进来，猜出来的胜率没有意义。"
          >
            <ListRow
              label="当好人"
              detail={`${stats.asGood.played} 局`}
              value={
                winRate(stats.asGood) === null
                  ? "—"
                  : `${winRate(stats.asGood)}%`
              }
            />
            <ListRow
              label="当坏人"
              detail={`${stats.asEvil.played} 局`}
              value={
                winRate(stats.asEvil) === null
                  ? "—"
                  : `${winRate(stats.asEvil)}%`
              }
            />
            {stats.total - stats.rated > 0 && (
              <ListRow
                label="没法统计"
                detail="缺身份或缺胜负"
                value={String(stats.total - stats.rated)}
              />
            )}
          </ListGroup>

          <ListGroup header="拿到过的角色">
            {favourite === null ? (
              <ListRow
                label="还没填过自己的身份"
                detail="对局里点自己的座位就能填"
              />
            ) : (
              Object.entries(stats.roleCounts)
                .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                .map(([role, count]) => (
                  <ListRow
                    key={role}
                    label={ROLE_LABELS[role as keyof typeof ROLE_LABELS]}
                    value={`${count} 局`}
                  />
                ))
            )}
          </ListGroup>

          <ListGroup header="常玩局型">
            {Object.entries(stats.byPlayerCount)
              .sort((a, b) => Number(a[0]) - Number(b[0]))
              .map(([count, games]) => (
                <ListRow
                  key={count}
                  label={`${count} 人局`}
                  value={`${games} 局`}
                />
              ))}
          </ListGroup>

          <ListGroup header="累计">
            <ListRow label="记录条数" value={String(stats.totalEvents)} />
          </ListGroup>

          <p className="t-footnote px-1 leading-relaxed text-[color:var(--label-tertiary)]">
            这些数字全部由这台设备上的对局算出来，没有账号，也没有上传。
            日后如果加了账号，会先明确告诉你要同步什么。
          </p>
        </div>
      )}
    </main>
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex-1 rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-3">
      <p className="t-caption uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
        {label}
      </p>
      <p className="mt-1 text-[28px] font-bold leading-none tabular-nums">
        {value}
      </p>
      <p className="t-caption mt-1 text-[color:var(--label-tertiary)]">{detail}</p>
    </div>
  );
}
