"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { ListGroup, ListRow } from "@/components/ui/list";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RoleChooser } from "./role-chooser";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame } from "@/lib/store/hooks";
import {
  getIntendedTeam,
  getKnownSeats,
  getPlayerOpinions,
  getRoleClaim,
  getRoleMark,
} from "@/lib/selectors";
import { visionFor } from "@/lib/rules/avalon";
import { ROLE_LABELS, markLabel, playerLabel, seatList } from "@/lib/format/labels";
import type { RoleMark } from "@/lib/types/events";
import type { RoleType } from "@/lib/types/game";

type Layer = "root" | "mark" | "myRole" | "rename";

const MARK_CHOICES: { label: string; mark: RoleMark }[] = [
  { label: "坏人", mark: { kind: "side", side: "evil" } },
  { label: "好人", mark: { kind: "side", side: "good" } },
  { label: "梅林", mark: { kind: "role", role: "merlin" } },
  { label: "派西维尔", mark: { kind: "role", role: "percival" } },
  { label: "忠臣", mark: { kind: "role", role: "loyal" } },
  { label: "莫甘娜", mark: { kind: "role", role: "morgana" } },
  { label: "莫德雷德", mark: { kind: "role", role: "mordred" } },
  { label: "刺客", mark: { kind: "role", role: "assassin" } },
  { label: "奥伯伦", mark: { kind: "role", role: "oberon" } },
  { label: "爪牙", mark: { kind: "role", role: "minion" } },
];

export function PlayerMenuSheet({
  playerId,
  visionVisible,
  guessVisible,
  onRevealVision,
  onRevealGuess,
  onClose,
  onPickOpinion,
  onPickIntendedTeam,
  onOpenNote,
  onStartVision,
}: {
  playerId: string | null;
  visionVisible: boolean;
  guessVisible: boolean;
  onRevealVision: () => void;
  onRevealGuess: () => void;
  onClose: () => void;
  onPickOpinion: () => void;
  onPickIntendedTeam: () => void;
  onOpenNote: () => void;
  onStartVision: (role: RoleType) => void;
}) {
  const game = useGame();
  const events = useEvents();
  const addEvent = useGameStore((s) => s.addEvent);
  const changeViewerRole = useGameStore((s) => s.changeViewerRole);
  const updatePlayer = useGameStore((s) => s.updatePlayer);
  const [layer, setLayer] = useState<Layer>("root");
  const [pendingRole, setPendingRole] = useState<RoleType | null>(null);
  const [name, setName] = useState("");

  if (!game || !playerId) return null;

  const isSelf = game.viewerPlayerId === playerId;
  const player = game.players.find((p) => p.id === playerId);
  const { expressed } = getPlayerOpinions(events, playerId);
  const intended = getIntendedTeam(events, playerId);
  const claim = getRoleClaim(events, playerId);
  const mark = getRoleMark(events, playerId);
  const knownCount = getKnownSeats(events).length;

  // Whichever layer this seat's mark belongs to has to be revealed to show it.
  const markVisible =
    mark === null
      ? guessVisible
      : mark.certainty === "known"
        ? visionVisible
        : guessVisible;

  function close() {
    setLayer("root");
    setPendingRole(null);
    onClose();
  }

  function applyRole(role: RoleType) {
    void changeViewerRole(role);
    const vision = visionFor(role, game!.playerCount, game!.roleSet);
    setPendingRole(null);
    setLayer("root");
    if (vision) {
      close();
      onStartVision(role);
    }
  }

  if (layer === "rename") {
    return (
      <Sheet
        open
        onClose={close}
        onBack={() => setLayer("root")}
        title={`${player?.seat}号 叫什么`}
        layerKey="rename"
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="留空就只用座位号"
          className="t-body w-full rounded-[10px] bg-[color:var(--bg-elevated)] px-3.5 py-3 outline-none placeholder:text-[color:var(--label-tertiary)]"
        />
        <Button
          className="mt-3"
          fullWidth
          onClick={() => {
            const trimmed = name.trim();
            void updatePlayer(playerId!, {
              name: trimmed.length > 0 ? trimmed : undefined,
            });
            setLayer("root");
          }}
        >
          保存
        </Button>
      </Sheet>
    );
  }

  if (layer === "mark") {
    return (
      <Sheet
        open
        onClose={close}
        onBack={() => setLayer("root")}
        title={`我觉得 ${playerLabel(game, playerId)} 是`}
        subtitle="只有你看得到，不会进公开记录"
        layerKey="mark"
      >
        <ListGroup>
          {MARK_CHOICES.map((choice) => (
            <ListRow
              key={choice.label}
              label={choice.label}
              accessory={
                mark && markLabel(mark.mark) === choice.label ? "check" : "none"
              }
              onClick={() => {
                void addEvent({
                  type: "role_mark",
                  targetId: playerId!,
                  mark: choice.mark,
                  certainty: "guess",
                });
                setLayer("root");
              }}
            />
          ))}
        </ListGroup>
        {mark && (
          <div className="mt-6">
            <ListGroup>
              <ListRow
                label="清除标记"
                destructive
                onClick={() => {
                  void addEvent({
                    type: "role_mark",
                    targetId: playerId!,
                    mark: null,
                    certainty: "guess",
                  });
                  setLayer("root");
                }}
              />
            </ListGroup>
          </div>
        )}
      </Sheet>
    );
  }

  if (layer === "myRole") {
    return (
      <>
        <Sheet
          open
          onClose={close}
          onBack={() => setLayer("root")}
          title="我这局是什么角色"
          subtitle="选完会带你点出你看到的人"
          layerKey="myRole"
        >
          <RoleChooser
            current={game.viewerRole}
            playerCount={game.playerCount}
            roleSet={game.roleSet}
            onPick={requestRole}
          />
        </Sheet>

        <ConfirmDialog
          open={pendingRole !== null}
          title="换身份会清掉视野"
          message={`你之前按「${game.viewerRole ? ROLE_LABELS[game.viewerRole] : "旧身份"}」记下的 ${knownCount} 个视野标记会被删除，然后重新问你一次。你自己推测的标记不受影响。`}
          confirmLabel="换"
          onCancel={() => setPendingRole(null)}
          onConfirm={() => applyRole(pendingRole!)}
        />
      </>
    );
  }

  return (
    <Sheet
      open
      onClose={close}
      title={playerLabel(game, playerId)}
      subtitle={isSelf ? "这是你自己" : "记他说了什么"}
      layerKey="menu"
    >
      <ListGroup header="他公开说的">
        <ListRow
          label="他怎么看别人"
          value={expressed.length > 0 ? `${expressed.length} 人` : "还没说"}
          accessory="chevron"
          onClick={onPickOpinion}
        />
        <ListRow
          label="他想带谁上车"
          value={intended ? seatList(game, intended.teamPlayerIds) : "还没说"}
          accessory="chevron"
          onClick={onPickIntendedTeam}
        />
        <ListRow
          label="跳派"
          detail={
            claim && claim.revisionCount > 1
              ? `改过 ${claim.revisionCount - 1} 次`
              : undefined
          }
          value={
            <Switch
              checked={claim?.claimed === true}
              label={`${playerLabel(game, playerId)} 跳派`}
              onChange={(next) =>
                void addEvent({
                  type: "role_claim",
                  playerId: playerId!,
                  claimed: next,
                })
              }
            />
          }
        />
      </ListGroup>

      <div className="mt-6">
        <ListGroup header="只有我知道的" footer="不会进公开记录。">
          <ListRow
            label="我觉得他是"
            value={
              !markVisible
                ? "已隐藏"
                : mark
                  ? `${markLabel(mark.mark)}${mark.certainty === "known" ? "（视野）" : ""}`
                  : "没标记"
            }
            accessory="chevron"
            onClick={() => {
              if (!guessVisible) onRevealGuess();
              setLayer("mark");
            }}
          />
          {isSelf && (
            <ListRow
              label="我这局的角色"
              value={
                !visionVisible
                  ? "已隐藏"
                  : game.viewerRole
                    ? ROLE_LABELS[game.viewerRole]
                    : "没设"
              }
              accessory="chevron"
              onClick={() => {
                if (!visionVisible) onRevealVision();
                setLayer("myRole");
              }}
            />
          )}
        </ListGroup>
      </div>

      <div className="mt-6">
        <ListGroup>
          <ListRow
            label="改名字"
            value={player?.name ?? "没填"}
            accessory="chevron"
            onClick={() => {
              setName(player?.name ?? "");
              setLayer("rename");
            }}
          />
          <ListRow label="记一条备注" accessory="chevron" onClick={onOpenNote} />
        </ListGroup>
      </div>
    </Sheet>
  );

  function requestRole(role: RoleType) {
    if (role === game!.viewerRole) {
      setLayer("root");
      return;
    }
    // Only warn when there is actually vision to lose.
    if (knownCount > 0) setPendingRole(role);
    else applyRole(role);
  }
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-[color:var(--green)]" : "bg-[color:var(--fill-2)]"
      }`}
    >
      <span
        className="absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-[left]"
        style={{ left: checked ? "22px" : "2px" }}
      />
    </button>
  );
}
