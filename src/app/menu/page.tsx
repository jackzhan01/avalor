"use client";

import { useEffect, useState } from "react";
import * as repo from "@/lib/db/repository";
import { useHydrated } from "@/lib/store/hooks";
import { ListGroup, ListRow } from "@/components/ui/list";
import { PageHeader } from "@/components/ui/page-header";
import { AccountGroup } from "@/components/account/account-group";
import { LATEST_VERSION, hasUnseenUpdates } from "@/lib/updates";

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
  /*
   * The dot only appears for someone who has actually used the thing. A brand
   * new install has not missed an update, it has missed everything, and
   * greeting a first run with an unread badge is just noise.
   */
  const [unseen, setUnseen] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    void repo.listRecentGames(100).then((games) => {
      setCounts({
        total: games.length,
        active: games.filter((g) => g.status === "active").length,
      });
      setUnseen(games.length > 0 && hasUnseenUpdates());
    });
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
          阿瓦隆 AI 助手
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
          <ListRow
            label={
              <span className="flex items-center gap-2">
                更新了什么
                {unseen && (
                  <span
                    aria-label="有没看过的更新"
                    className="size-1.5 rounded-full bg-[color:var(--red)]"
                  />
                )}
              </span>
            }
            detail={`当前 v${LATEST_VERSION}`}
            href="/updates"
            accessory="chevron"
          />
        </ListGroup>

        {/* The where-your-data-lives line lives on this group's footer now:
            two of them stacked said the same thing twice, and one of them
            was out of date the moment backup shipped. */}
        <AccountGroup />
      </div>
    </main>
  );
}
