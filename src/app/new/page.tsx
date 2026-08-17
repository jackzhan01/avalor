"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as repo from "@/lib/db/repository";
import { PLAYER_COUNTS, evilCount, goodCount, teamSize } from "@/lib/rules/avalon";
import { validateRoleSet } from "@/lib/selectors";
import { useHydrated } from "@/lib/store/hooks";
import type { PlayerCount, RoleType } from "@/lib/types/game";
import { Button } from "@/components/ui/button";
import { ListGroup, ListRow } from "@/components/ui/list";
import { InlineWarning } from "@/components/ui/feedback";
import { cn } from "@/lib/utils/cn";

const ROLES: { value: RoleType; label: string; side: "good" | "evil" }[] = [
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
  const hydrated = useHydrated();
  const [playerCount, setPlayerCount] = useState<PlayerCount>(10);
  const [viewerSeat, setViewerSeat] = useState(1);
  const [firstLeaderSeat, setFirstLeaderSeat] = useState(1);
  const [names, setNames] = useState<Record<number, string>>({});
  const [roles, setRoles] = useState<RoleType[]>([]);
  const [showNames, setShowNames] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [creating, setCreating] = useState(false);
  const [hasHistory, setHasHistory] = useState(false);

  const seats = useMemo(
    () => Array.from({ length: playerCount }, (_, i) => i + 1),
    [playerCount],
  );

  useEffect(() => {
    if (!hydrated) return;
    void repo.listRecentGames(1).then((games) => setHasHistory(games.length > 0));
  }, [hydrated]);

  function changeCount(next: PlayerCount) {
    setPlayerCount(next);
    if (viewerSeat > next) setViewerSeat(1);
    if (firstLeaderSeat > next) setFirstLeaderSeat(1);
  }

  const roleWarning = validateRoleSet(
    roles.length > 0 ? { rolesIncluded: roles } : undefined,
    playerCount,
  );

  async function start() {
    setCreating(true);
    try {
      const created = await repo.createGame({
        playerCount,
        names,
        viewerSeat,
        firstLeaderSeat,
        ...(roles.length > 0 ? { roleSet: { rolesIncluded: roles } } : {}),
      });
      router.replace(`/game/${created.id}`);
    } catch {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-32">
      <header className="pt-safe flex items-center justify-between pb-1 pt-3">
        <Link
          href="/"
          aria-label="返回封面"
          className="t-body -ml-2 flex min-h-[44px] items-center px-2 text-[color:var(--blue)]"
        >
          <span aria-hidden className="mr-0.5 text-[20px] leading-none">‹</span>
        </Link>
        {hasHistory && (
          <Link
            href="/games"
            className="t-body min-h-[44px] px-1 leading-[44px] text-[color:var(--blue)]"
          >
            之前的对局
          </Link>
        )}
      </header>

      <h1 className="t-large-title mb-6">开一局</h1>

      <div className="flex flex-col gap-6">
        <ListGroup
          header="几个人"
          footer={`${goodCount(playerCount)} 好 ${evilCount(playerCount)} 坏 · 每轮上车 ${[1, 2, 3, 4, 5].map((m) => teamSize(playerCount, m)).join(" / ")}`}
        >
          <div className="grid grid-cols-6 gap-1.5 p-3">
            {PLAYER_COUNTS.map((count) => (
              <NumberKey
                key={count}
                value={count}
                active={playerCount === count}
                onClick={() => changeCount(count)}
              />
            ))}
          </div>
        </ListGroup>

        {/* The view anchor: it pins the user to six o'clock so the on-screen
            table matches where everyone actually sits. */}
        <ListGroup
          header="我坐几号"
          footer="牌桌上你会固定在最下方，其他人按顺时针排开。如果这局大家不按号叫人，留着 1 号就行。"
        >
          <div className="grid grid-cols-5 gap-1.5 p-3">
            {seats.map((seat) => (
              <NumberKey
                key={seat}
                value={seat}
                active={viewerSeat === seat}
                onClick={() => setViewerSeat(seat)}
              />
            ))}
          </div>
        </ListGroup>

        <ListGroup
          header="第一个队长"
          footer="之后每轮自动往下顺，点车时随时能改。"
        >
          <div className="grid grid-cols-5 gap-1.5 p-3">
            {seats.map((seat) => (
              <NumberKey
                key={seat}
                value={seat}
                active={firstLeaderSeat === seat}
                onClick={() => setFirstLeaderSeat(seat)}
              />
            ))}
          </div>
        </ListGroup>

        <ListGroup>
          <ListRow
            label="填名字"
            value={
              Object.values(names).filter((n) => n?.trim()).length > 0
                ? `${Object.values(names).filter((n) => n?.trim()).length} 个`
                : "可跳过"
            }
            accessory="chevron"
            onClick={() => setShowNames((v) => !v)}
          />
          {showNames &&
            seats.map((seat) => (
              <div key={seat} className="list-row flex items-center gap-3 px-4 py-1.5">
                <span className="t-subhead w-11 shrink-0 text-[color:var(--label-secondary)]">
                  {seat}号
                </span>
                <input
                  value={names[seat] ?? ""}
                  onChange={(e) =>
                    setNames((prev) => ({ ...prev, [seat]: e.target.value }))
                  }
                  placeholder="可留空"
                  className="t-body min-h-[40px] w-full bg-transparent outline-none placeholder:text-[color:var(--label-tertiary)]"
                />
              </div>
            ))}
        </ListGroup>

        <ListGroup
          footer={
            showRoles
              ? "只记这局有哪些角色，不需要知道谁是谁。这条信息现在不参与任何推理。"
              : undefined
          }
        >
          <ListRow
            label="本局有哪些角色"
            value={roles.length > 0 ? `${roles.length} 个` : "可跳过"}
            accessory="chevron"
            onClick={() => setShowRoles((v) => !v)}
          />
          {showRoles && (
            <div className="list-row p-3">
              <div className="flex flex-wrap gap-1.5">
                {ROLES.map((role) => {
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
                        "t-subhead min-h-[40px] rounded-[10px] px-3 font-medium active:opacity-70",
                        on
                          ? role.side === "evil"
                            ? "bg-[color:var(--red)] text-white"
                            : "bg-[color:var(--green)] text-white"
                          : "bg-[color:var(--fill)] text-[color:var(--label)]",
                      )}
                    >
                      {role.label}
                    </button>
                  );
                })}
              </div>
              {roleWarning.severity === "warn" && (
                <InlineWarning className="mt-3">
                  {roleWarning.message}
                </InlineWarning>
              )}
            </div>
          )}
        </ListGroup>
      </div>

      <div className="pb-safe fixed inset-x-0 bottom-0 border-t border-[color:var(--separator)] bg-[color:var(--bg)]/92 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto max-w-md">
          <Button size="lg" fullWidth onClick={start} disabled={creating}>
            {creating ? "正在开局…" : "开始记录"}
          </Button>
        </div>
      </div>
    </main>
  );
}

function NumberKey({
  value,
  active,
  onClick,
}: {
  value: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "min-h-[48px] rounded-[10px] text-[17px] font-semibold active:opacity-70",
        active
          ? "bg-[color:var(--blue)] text-white"
          : "bg-[color:var(--fill)] text-[color:var(--label)]",
      )}
    >
      {value}
    </button>
  );
}
