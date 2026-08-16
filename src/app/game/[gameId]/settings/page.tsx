"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle, WarningBanner } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/controls";
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
    <main className="mx-auto max-w-md">
      <header className="pt-safe sticky top-0 z-30 border-b border-border bg-bg/95 px-4 pb-3 pt-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Link
            href={`/game/${game.id}`}
            aria-label="返回对局"
            className="-ml-2 flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted active:bg-surface-2"
          >
            <span aria-hidden>←</span>
          </Link>
          <h1 className="text-lg font-semibold">对局设置</h1>
        </div>
      </header>

      <div className="space-y-6 px-4 pb-10 pt-4">
        <section>
          <SectionTitle>这局</SectionTitle>
          <Card>
            <p className="text-[14px]">
              {game.playerCount} 人局 · 共 {events.length} 条记录
            </p>
            <p className="mt-1 text-[13px] text-fg-muted">
              好人 {timeline.successCount} — 坏人 {timeline.failCount} ·
              {game.status === "completed" ? " 已结束" : " 进行中"}
            </p>
          </Card>
        </section>

        <section>
          <SectionTitle>改名字</SectionTitle>
          <Card className="space-y-2">
            {players.map((player) => (
              <div key={player.id} className="flex items-center gap-3">
                <span className="w-10 shrink-0 text-sm font-medium text-fg-muted">
                  {player.seat}号
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
                  className="min-h-[44px] w-full rounded-lg border border-border bg-surface-2 px-3 text-[15px] outline-none focus:border-accent"
                />
              </div>
            ))}
          </Card>
        </section>

        <section>
          <SectionTitle>导出记录</SectionTitle>
          <Card>
            <p className="mb-3 text-[13px] leading-relaxed text-fg-muted">
              导出成 JSON 存一份。数据只存在这台设备上，浏览器会清理长期没打开的网站数据
              —— 打完一局导一份最稳妥。
            </p>
            <Button
              variant="secondary"
              fullWidth
              onClick={() => {
                downloadExport(game, events);
                setExported(true);
              }}
            >
              {exported ? "已导出，可以再导一次" : "导出 JSON"}
            </Button>
          </Card>
        </section>

        {warnings.length > 0 && (
          <section>
            <SectionTitle>记录里的几处对不上</SectionTitle>
            <div className="space-y-1.5">
              {warnings.map((warning, i) => (
                <WarningBanner key={i}>{warning.message}</WarningBanner>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-fg-subtle">
              这些只是提醒，不影响记录，也不会自动改动你记的内容。
            </p>
          </section>
        )}

        <section>
          <SectionTitle>结束这局</SectionTitle>
          <Card>
            {game.status === "completed" ? (
              <>
                <p className="mb-3 text-[13px] text-fg-muted">
                  这局已经结束
                  {game.winningSide === "good"
                    ? "，好人赢。"
                    : game.winningSide === "evil"
                      ? "，坏人赢。"
                      : "，没记谁赢。"}
                </p>
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => void reopenGame()}
                >
                  重新打开继续记
                </Button>
              </>
            ) : (
              <>
                <p className="mb-2 text-[13px] text-fg-muted">
                  谁赢了？（可以不选）
                </p>
                <SegmentedControl
                  value={winner}
                  onChange={setWinner}
                  options={[
                    { value: "good", label: "好人赢", tone: "good" },
                    { value: "evil", label: "坏人赢", tone: "evil" },
                  ]}
                />
                <Button
                  variant="secondary"
                  fullWidth
                  className="mt-3"
                  onClick={() => setConfirmEnd(true)}
                >
                  结束对局
                </Button>
              </>
            )}
          </Card>
        </section>

        <section>
          <SectionTitle>危险操作</SectionTitle>
          <Button
            variant="danger"
            fullWidth
            onClick={() => setConfirmDelete(true)}
          >
            删除这局记录
          </Button>
        </section>
      </div>

      <ConfirmDialog
        open={confirmEnd}
        title="结束这局？"
        message="结束之后还能重新打开继续记。建议先导出一份 JSON 备份。"
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
          router.replace("/");
        }}
      />
    </main>
  );
}
