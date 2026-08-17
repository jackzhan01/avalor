"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RoundTable } from "@/components/table/round-table";
import { Button } from "@/components/ui/button";
import { ListGroup, ListRow } from "@/components/ui/list";
import { Sheet } from "@/components/ui/sheet";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { getAllRoleMarks } from "@/lib/selectors";
import { EVIL_ROLES, GOOD_ROLES, type RoleType } from "@/lib/types/game";
import {
  ROLE_LABELS,
  markColor,
  markShort,
  playerLabel,
  seatLabel,
} from "@/lib/format/labels";

type Step = "waiting" | "target" | "reveal";

/**
 * The assassination phase, and the reveal that closes the game out.
 *
 * The reveal is the point of the whole exercise beyond note-taking: with true
 * roles attached, a recorded game stops being a pile of observations and
 * becomes a labelled one — public statements, actions, outcomes, and the
 * answer. It is also the moment where honest bookkeeping matters most, so the
 * roles live on the players and the assassin's target is its own field, rather
 * than being inferred from anything.
 */
export default function EndgamePage() {
  const router = useRouter();
  const game = useGame();
  const players = usePlayers();
  const events = useEvents();
  const timeline = useTimeline();
  const revealEndgame = useGameStore((s) => s.revealEndgame);

  const [step, setStep] = useState<Step>("waiting");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, RoleType | undefined>>({});
  const [editingSeat, setEditingSeat] = useState<string | null>(null);

  if (!game || !timeline) return null;

  const marks = getAllRoleMarks(events);
  const viewerIsEvil =
    game.viewerRole !== undefined && EVIL_ROLES.includes(game.viewerRole);

  // Prefilled from what the user already believes, so the reveal is a
  // confirmation rather than ten fresh decisions.
  function roleFor(playerId: string): RoleType | undefined {
    if (roles[playerId] !== undefined) return roles[playerId];
    const mark = marks.get(playerId);
    if (mark?.mark.kind === "role") return mark.mark.role;
    return undefined;
  }

  const merlinSeat = players.find((p) => roleFor(p.id) === "merlin");
  const assassinHitMerlin =
    targetId !== null && merlinSeat !== undefined && targetId === merlinSeat.id;
  const filledCount = players.filter((p) => roleFor(p.id) !== undefined).length;

  return (
    <main className="mx-auto max-w-md px-4 pb-32">
      <header className="pt-safe pb-4 pt-3">
        <Link
          href={`/game/${game.id}`}
          className="t-body -ml-2 mb-1 inline-flex min-h-[36px] items-center px-2 text-[color:var(--blue)]"
        >
          <span aria-hidden className="mr-0.5 text-[20px] leading-none">‹</span>
          牌桌
        </Link>
        <h1 className="t-large-title">
          {step === "waiting" ? "刺杀环节" : step === "target" ? "刺了谁" : "复盘"}
        </h1>
      </header>

      {step === "waiting" && (
        <section className="a-push flex flex-col gap-5">
          {viewerIsEvil ? (
            <>
              <div className="rounded-[12px] bg-[color:var(--red)] px-4 py-3 text-white">
                <p className="t-headline">该你们动手了</p>
                <p className="t-footnote mt-0.5 text-white/85">
                  下面是你这局记下的所有标记，帮你想想梅林是谁。
                </p>
              </div>

              <ListGroup header="我的标记">
                {players.map((player) => {
                  const mark = marks.get(player.id);
                  return (
                    <ListRow
                      key={player.id}
                      label={playerLabel(game, player.id)}
                      detail={
                        mark
                          ? mark.certainty === "known"
                            ? "视野"
                            : "我的推测"
                          : undefined
                      }
                      value={
                        mark ? (
                          <span
                            className="t-footnote rounded-[5px] px-1.5 font-semibold text-white"
                            style={{ backgroundColor: markColor(mark.mark) }}
                          >
                            {markShort(mark.mark)}
                          </span>
                        ) : (
                          <span className="text-[color:var(--label-tertiary)]">
                            没标记
                          </span>
                        )
                      }
                    />
                  );
                })}
              </ListGroup>
            </>
          ) : (
            <div className="rounded-[12px] bg-[color:var(--bg-elevated)] px-4 py-6 text-center">
              <p className="t-title3">对面正在商量刺杀</p>
              <p className="t-subhead mt-2 text-[color:var(--label-secondary)]">
                好人已经拿下三轮。现在绷住 ——
                <br />
                别看梅林，别给任何反应。
              </p>
              <p className="t-footnote mt-4 text-[color:var(--label-tertiary)]">
                这一段没什么可记的，等结果就行。
              </p>
            </div>
          )}

          <Button size="lg" fullWidth onClick={() => setStep("target")}>
            刺杀结束
          </Button>
        </section>
      )}

      {step === "target" && (
        <section className="a-push flex flex-col gap-4">
          <p className="t-subhead text-[color:var(--label-secondary)]">
            点一下被刺的那个人。如果这局没有刺杀，直接跳过。
          </p>
          <RoundTable
            players={players}
            viewerPlayerId={game.viewerPlayerId}
            seatDirection={game.seatDirection ?? "cw"}
            seatVisual={(p) => ({ selected: p.id === targetId })}
            onSelect={(id) => setTargetId((prev) => (prev === id ? null : id))}
            center={
              <p className="t-footnote pointer-events-none text-[color:var(--label-secondary)]">
                {targetId ? seatLabel(game, targetId) : "点被刺的人"}
              </p>
            }
            label="选择被刺杀的玩家"
          />
          <div className="flex gap-2">
            <Button
              variant="gray"
              className="flex-1"
              onClick={() => {
                setTargetId(null);
                setStep("reveal");
              }}
            >
              没有刺杀
            </Button>
            <Button
              className="flex-1"
              disabled={!targetId}
              onClick={() => setStep("reveal")}
            >
              下一步
            </Button>
          </div>
        </section>
      )}

      {step === "reveal" && (
        <section className="a-push flex flex-col gap-5">
          <p className="t-subhead text-[color:var(--label-secondary)]">
            把每个人的真实身份填上。已经标记过的会自动填好，核对一下就行 ——
            这一步让整局记录变成能复盘、也能拿来分析的完整数据。
          </p>

          <ListGroup header={`真实身份（${filledCount} / ${players.length}）`}>
            {players.map((player) => (
              <ListRow
                key={player.id}
                label={playerLabel(game, player.id)}
                detail={player.id === targetId ? "被刺杀" : undefined}
                value={
                  roleFor(player.id) ? (
                    ROLE_LABELS[roleFor(player.id)!]
                  ) : (
                    <span className="text-[color:var(--label-tertiary)]">没填</span>
                  )
                }
                accessory="chevron"
                onClick={() => setEditingSeat(player.id)}
              />
            ))}
          </ListGroup>

          {targetId && (
            <div className="rounded-[12px] bg-[color:var(--bg-elevated)] px-4 py-3">
              <p className="t-subhead">
                {assassinHitMerlin
                  ? "刺中了梅林 —— 坏人翻盘。"
                  : merlinSeat
                    ? "没刺中梅林 —— 好人赢。"
                    : "填上梅林是谁，就能算出结果。"}
              </p>
            </div>
          )}

          <Button
            size="lg"
            fullWidth
            onClick={async () => {
              const finalRoles: Record<string, RoleType | undefined> = {};
              for (const player of players) finalRoles[player.id] = roleFor(player.id);
              await revealEndgame({
                ...(targetId ? { assassinTargetId: targetId } : {}),
                roles: finalRoles,
                winningSide: assassinHitMerlin ? "evil" : "good",
              });
              router.replace(`/game/${game.id}/timeline`);
            }}
          >
            存下来，结束这局
          </Button>

          <p className="t-footnote text-center text-[color:var(--label-tertiary)]">
            没填全也能存，之后还能在设置里补。
          </p>
        </section>
      )}

      {editingSeat && (
        <Sheet
          open
          onClose={() => setEditingSeat(null)}
          title={`${playerLabel(game, editingSeat)} 是什么身份`}
          layerKey={editingSeat}
        >
          <ListGroup header="好人">
            {GOOD_ROLES.map((role) => (
              <ListRow
                key={role}
                label={ROLE_LABELS[role]}
                accessory={roleFor(editingSeat) === role ? "check" : "none"}
                onClick={() => {
                  setRoles((prev) => ({ ...prev, [editingSeat]: role }));
                  setEditingSeat(null);
                }}
              />
            ))}
          </ListGroup>
          <div className="mt-6">
            <ListGroup header="坏人">
              {EVIL_ROLES.map((role) => (
                <ListRow
                  key={role}
                  label={ROLE_LABELS[role]}
                  accessory={roleFor(editingSeat) === role ? "check" : "none"}
                  onClick={() => {
                    setRoles((prev) => ({ ...prev, [editingSeat]: role }));
                    setEditingSeat(null);
                  }}
                />
              ))}
            </ListGroup>
          </div>
        </Sheet>
      )}
    </main>
  );
}
