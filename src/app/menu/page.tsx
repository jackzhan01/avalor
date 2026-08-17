"use client";

import { useEffect, useState } from "react";
import * as repo from "@/lib/db/repository";
import { useHydrated } from "@/lib/store/hooks";
import { ListGroup, ListRow } from "@/components/ui/list";
import { PageHeader } from "@/components/ui/page-header";

/**
 * The menu behind the cover.
 *
 * The cover used to drop straight into setup, which made an in-progress game
 * awkward to get back to and left nowhere for anything that isn't a game.
 */
export default function MenuPage() {
  const hydrated = useHydrated();
  const [counts, setCounts] = useState<{ total: number; active: number } | null>(
    null,
  );

  useEffect(() => {
    if (!hydrated) return;
    void repo.listRecentGames(100).then((games) =>
      setCounts({
        total: games.length,
        active: games.filter((g) => g.status === "active").length,
      }),
    );
  }, [hydrated]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-10">
      <PageHeader back={{ href: "/", label: "返回封面" }} />

      <div className="mb-8">
        <h1
          className="text-[40px] leading-none"
          style={{ fontFamily: "var(--font-display)", letterSpacing: "0.08em" }}
        >
          Avalor
        </h1>
        <p className="t-subhead mt-2 text-[color:var(--label-secondary)]">
          阿瓦隆记录本
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <ListGroup>
          <ListRow
            label="新对局"
            detail="选人数、点座位，三步开始"
            href="/new"
            accessory="chevron"
          />
          <ListRow
            label="过往对局"
            detail={
              counts === null
                ? undefined
                : counts.total === 0
                  ? "还没有记录"
                  : `${counts.total} 局${counts.active > 0 ? ` · ${counts.active} 局进行中` : ""}`
            }
            href="/games"
            accessory="chevron"
          />
          <ListRow
            label="个人主页"
            detail="胜率、常玩角色"
            href="/profile"
            accessory="chevron"
          />
        </ListGroup>

        <p className="t-footnote px-1 text-[color:var(--label-tertiary)]">
          所有记录都存在这台设备上，不会上传。
        </p>
      </div>
    </main>
  );
}
