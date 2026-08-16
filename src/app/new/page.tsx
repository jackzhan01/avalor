"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as repo from "@/lib/db/repository";
import { PLAYER_COUNTS, evilCount, goodCount, teamSize } from "@/lib/rules/avalon";
import { validateRoleSet } from "@/lib/selectors/integrity";
import type { PlayerCount, RoleType } from "@/lib/types/game";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle, WarningBanner } from "@/components/ui/feedback";
import { cn } from "@/lib/utils/cn";

const ROLE_LABELS: { value: RoleType; label: string; side: "good" | "evil" }[] = [
  { value: "merlin", label: "梅林", side: "good" },
  { value: "percival", label: "派西维尔", side: "good" },
  { value: "loyal", label: "忠臣", side: "good" },
  { value: "morgana", label: "莫甘娜", side: "evil" },
  { value: "mordred", label: "莫德雷德", side: "evil" },
  { value: "assassin", label: "刺客", side: "evil" },
  { value: "oberon", label: "奥伯伦", side: "evil" },
  { value: "minion", label: "爪牙", side: "evil" },
];

export default function NewGamePage() {
  const router = useRouter();
  const [playerCount, setPlayerCount] = useState<PlayerCount>(10);
  const [names, setNames] = useState<Record<number, string>>({});
  const [firstLeaderSeat, setFirstLeaderSeat] = useState(1);
  const [roles, setRoles] = useState<RoleType[]>([]);
  const [showNames, setShowNames] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [creating, setCreating] = useState(false);

  const seats = useMemo(
    () => Array.from({ length: playerCount }, (_, i) => i + 1),
    [playerCount],
  );

  const roleWarning = validateRoleSet(
    roles.length > 0 ? { rolesIncluded: roles } : undefined,
    playerCount,
  );

  function changeCount(next: PlayerCount) {
    setPlayerCount(next);
    if (firstLeaderSeat > next) setFirstLeaderSeat(1);
  }

  async function start() {
    setCreating(true);
    try {
      const game = await repo.createGame({
        playerCount,
        names,
        firstLeaderSeat,
        ...(roles.length > 0 ? { roleSet: { rolesIncluded: roles } } : {}),
      });
      router.replace(`/game/${game.id}`);
    } catch {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-32 pt-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/"
          aria-label="返回"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted active:bg-surface-2"
        >
          <span aria-hidden className="text-lg">
            ←
          </span>
        </Link>
        <h1 className="text-xl font-semibold">开一局新的</h1>
      </div>

      <section className="mb-6">
        <SectionTitle>几个人</SectionTitle>
        <div className="grid grid-cols-6 gap-1.5">
          {PLAYER_COUNTS.map((count) => (
            <button
              key={count}
              onClick={() => changeCount(count)}
              aria-pressed={playerCount === count}
              className={cn(
                "min-h-[52px] rounded-xl border text-lg font-semibold transition-colors",
                playerCount === count
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-surface-2 active:bg-surface-3",
              )}
            >
              {count}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-fg-subtle">
          {goodCount(playerCount)} 好 {evilCount(playerCount)} 坏 · 每轮上车人数{" "}
          {seats.length > 0 &&
            [1, 2, 3, 4, 5]
              .map((m) => teamSize(playerCount, m))
              .join(" / ")}
        </p>
      </section>

      <section className="mb-6">
        <SectionTitle>第一个队长</SectionTitle>
        <div className="grid grid-cols-5 gap-1.5">
          {seats.map((seat) => (
            <button
              key={seat}
              onClick={() => setFirstLeaderSeat(seat)}
              aria-pressed={firstLeaderSeat === seat}
              className={cn(
                "min-h-[48px] rounded-xl border font-semibold transition-colors",
                firstLeaderSeat === seat
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-surface-2 active:bg-surface-3",
              )}
            >
              {seat}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-fg-subtle">
          之后每轮队长自动往下顺，随时可以手动改。
        </p>
      </section>

      <section className="mb-4">
        <button
          onClick={() => setShowNames((v) => !v)}
          className="flex min-h-[44px] w-full items-center justify-between rounded-xl border border-border bg-surface-2 px-3 text-left active:bg-surface-3"
        >
          <span className="text-[15px]">
            填名字 <span className="text-fg-subtle">（可跳过）</span>
          </span>
          <span aria-hidden className="text-fg-subtle">
            {showNames ? "▲" : "▼"}
          </span>
        </button>
        {showNames && (
          <Card className="mt-2 space-y-2">
            {seats.map((seat) => (
              <div key={seat} className="flex items-center gap-3">
                <span className="w-10 shrink-0 text-sm font-medium text-fg-muted">
                  {seat}号
                </span>
                <input
                  value={names[seat] ?? ""}
                  onChange={(e) =>
                    setNames((prev) => ({ ...prev, [seat]: e.target.value }))
                  }
                  placeholder="可留空"
                  className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 text-[15px] outline-none focus:border-accent"
                />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mb-6">
        <button
          onClick={() => setShowRoles((v) => !v)}
          className="flex min-h-[44px] w-full items-center justify-between rounded-xl border border-border bg-surface-2 px-3 text-left active:bg-surface-3"
        >
          <span className="text-[15px]">
            本局有哪些角色 <span className="text-fg-subtle">（可跳过）</span>
          </span>
          <span aria-hidden className="text-fg-subtle">
            {showRoles ? "▲" : "▼"}
          </span>
        </button>
        {showRoles && (
          <Card className="mt-2">
            <p className="mb-3 text-[12px] leading-relaxed text-fg-subtle">
              只记录这局有哪些角色，不需要知道谁是谁。这条信息现在不参与任何推理，只是存下来备用。
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_LABELS.map((role) => {
                const on = roles.includes(role.value);
                return (
                  <button
                    key={role.value}
                    onClick={() =>
                      setRoles((prev) =>
                        prev.includes(role.value)
                          ? prev.filter((r) => r !== role.value)
                          : [...prev, role.value],
                      )
                    }
                    aria-pressed={on}
                    className={cn(
                      "min-h-[40px] rounded-lg border px-3 text-sm transition-colors",
                      on
                        ? role.side === "evil"
                          ? "border-evil bg-evil text-white"
                          : "border-good bg-good text-white"
                        : "border-border bg-surface-2 active:bg-surface-3",
                    )}
                  >
                    {role.label}
                  </button>
                );
              })}
            </div>
            {roleWarning.severity === "warn" && (
              <WarningBanner className="mt-3">
                {roleWarning.message}
              </WarningBanner>
            )}
          </Card>
        )}
      </section>

      <div className="pb-safe fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-md">
          <Button size="lg" fullWidth onClick={start} disabled={creating}>
            {creating ? "正在开局…" : "开始记录"}
          </Button>
        </div>
      </div>
    </main>
  );
}
