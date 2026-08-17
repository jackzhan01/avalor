"use client";

import { Sheet } from "@/components/ui/sheet";
import { RoleChooser } from "./role-chooser";
import { useGameStore } from "@/lib/store/game-store";
import { useGame } from "@/lib/store/hooks";
import { visionFor } from "@/lib/rules/avalon";
import type { RoleType } from "@/lib/types/game";

/**
 * Asked once, as soon as a new game opens.
 *
 * It cannot be dismissed by tapping away, because an unanswered role costs
 * more than a moment's friction: no vision, no win rate, and an endgame record
 * that is missing the one label that makes the whole game worth keeping.
 *
 * It is still not a dead end. Roles get dealt after people sit down, so a game
 * created while everyone is still arriving genuinely has no answer yet —
 * "还没发牌" defers, and the table then nags until it is filled in.
 */
export function RoleSetupSheet({
  open,
  onDefer,
  onPicked,
}: {
  open: boolean;
  onDefer: () => void;
  onPicked: (role: RoleType) => void;
}) {
  const game = useGame();
  const setViewerRole = useGameStore((s) => s.setViewerRole);

  if (!game || !open) return null;

  return (
    <Sheet
      open
      dismissible={false}
      onClose={onDefer}
      title="你这局是什么身份"
      subtitle="只有你看得到，选完带你点视野"
      layerKey="role-setup"
      footer={
        <button
          onClick={onDefer}
          className="t-body min-h-[44px] w-full rounded-[12px] bg-[color:var(--fill)] font-medium text-[color:var(--label)] active:opacity-70"
        >
          还没发牌，稍后填
        </button>
      }
    >
      <RoleChooser
        current={game.viewerRole}
        playerCount={game.playerCount}
        roleSet={game.roleSet}
        onPick={(role) => {
          void setViewerRole(role);
          onPicked(role);
        }}
      />

      <p className="t-footnote mt-5 px-1 leading-relaxed text-[color:var(--label-tertiary)]">
        {visionFor("percival", game.playerCount, game.roleSet)
          ? "各角色能看到几个人，已经按这局的人数算好了。"
          : ""}
        身份和视野都属于私有信息，导出公开记录时会被整层剥掉。
      </p>
    </Sheet>
  );
}
