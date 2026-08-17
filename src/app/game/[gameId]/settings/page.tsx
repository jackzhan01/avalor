"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ListAction, ListGroup, ListRow } from "@/components/ui/list";
import { ConfirmDialog } from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/controls";
import { InlineWarning } from "@/components/ui/feedback";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { downloadExport } from "@/lib/db/transfer";
import * as repo from "@/lib/db/repository";
import { getIntegrityWarnings } from "@/lib/selectors";
import type { WinningSide } from "@/lib/types/game";

export default function GameSettingsPage() {
  const router = useRouter();
  const game = useGame();
  const events = useEvents();
  const players = usePlayers();
  const timeline = useTimeline();
  const endGame = useGameStore((s) => s.endGame);
  const reopenGame = useGameStore((s) => s.reopenGame);
  const updatePlayer = useGameStore((s) => s.updatePlayer);

  const [winner, setWinner] = useState<WinningSide | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exported, setExported] = useState(false);

  if (!game || !timeline) return null;
  const warnings = getIntegrityWarnings(events, game);

  return (
    <main className="mx-auto max-w-md px-4 pb-10">
      <header className="pt-safe pb-4 pt-3">
        <Link
          href={`/game/${game.id}`}
          className="t-body -ml-2 mb-1 inline-flex min-h-[36px] items-center px-2 text-[color:var(--blue)]"
        >
          <span aria-hidden className="mr-0.5 text-[20px] leading-none">‹</span>
          牌桌
        </Link>
        <h1 className="t-large-title">对局设置</h1>
      </header>

      <div className="flex flex-col gap-7">
        <ListGroup>
          <ListRow label="人数" value={`${game.playerCount} 人`} />
          <ListRow label="记录条数" value={String(events.length)} />
          <ListRow
            label="比分"
            value={`好 ${timeline.successCount} — 坏 ${timeline.failCount}`}
          />
          <ListRow
            label="状态"
            value={game.status === "completed" ? "已结束" : "进行中"}
          />
        </ListGroup>

        <ListGroup header="座位" footer="改名字随时生效，座位号不会变。">
          {players.map((player) => (
            <div
              key={player.id}
              className="list-row flex items-center gap-3 px-4 py-1.5"
            >
              <span className="t-subhead w-11 shrink-0 text-[color:var(--label-secondary)]">
                {player.seat}号
                {game.viewerPlayerId === player.id && (
                  <span className="t-caption block text-[color:var(--blue)]">我</span>
                )}
              </span>
              <input
                defaultValue={player.name ?? ""}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name === (player.name ?? "")) return;
                  void updatePlayer(player.id, {
                    name: name.length > 0 ? name : undefined,
                  });
                }}
                placeholder="可留空"
                className="t-body min-h-[40px] w-full bg-transparent outline-none placeholder:text-[color:var(--label-tertiary)]"
              />
            </div>
          ))}
        </ListGroup>

        <ListGroup footer="数据只存在这台设备上，浏览器会清理长期没打开的网站数据。打完一局导一份最稳妥。">
          <ListAction
            label={exported ? "已导出，可以再导一次" : "导出 JSON"}
            onClick={() => {
              downloadExport(game, events);
              setExported(true);
            }}
          />
        </ListGroup>

        {warnings.length > 0 && (
          <section>
            <h2 className="t-footnote mb-2 px-1 uppercase tracking-[0.06em] text-[color:var(--label-secondary)]">
              记录里有几处对不上
            </h2>
            <div className="flex flex-col gap-1.5">
              {warnings.map((warning, i) => (
                <InlineWarning key={i}>{warning.message}</InlineWarning>
              ))}
            </div>
            <p className="t-footnote mt-2 px-1 text-[color:var(--label-tertiary)]">
              只是提醒，不会自动改动你记的内容。
            </p>
          </section>
        )}

        {game.status === "completed" ? (
          <ListGroup
            footer={
              game.winningSide === "good"
                ? "好人赢。"
                : game.winningSide === "evil"
                  ? "坏人赢。"
                  : "没记谁赢。"
            }
          >
            <ListAction label="重新打开继续记" onClick={() => void reopenGame()} />
          </ListGroup>
        ) : (
          <ListGroup header="结束这局" footer="谁赢了可以不选。结束后还能重新打开。">
            <div className="list-row p-3">
              <SegmentedControl
                value={winner}
                onChange={setWinner}
                options={[
                  { value: "good", label: "好人赢", tone: "good" },
                  { value: "evil", label: "坏人赢", tone: "evil" },
                ]}
              />
            </div>
            <ListAction label="结束对局" onClick={() => setConfirmEnd(true)} />
          </ListGroup>
        )}

        <ListGroup>
          <ListAction
            label="删除这局记录"
            destructive
            onClick={() => setConfirmDelete(true)}
          />
        </ListGroup>
      </div>

      <ConfirmDialog
        open={confirmEnd}
        title="结束这局？"
        message="结束之后还能重新打开。建议先导出一份备份。"
        confirmLabel="结束"
        destructive={false}
        onCancel={() => setConfirmEnd(false)}
        onConfirm={() => {
          void endGame(winner);
          setConfirmEnd(false);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除这局记录？"
        message={`共 ${events.length} 条记录，删掉之后没法恢复。`}
        confirmLabel="删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await repo.deleteGame(game.id);
          router.replace("/games");
        }}
      />
    </main>
  );
}
