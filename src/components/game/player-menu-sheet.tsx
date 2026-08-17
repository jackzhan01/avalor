"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { ListGroup, ListRow } from "@/components/ui/list";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame } from "@/lib/store/hooks";
import {
  getIntendedTeam,
  getPlayerOpinions,
  getRoleClaim,
  getRoleMark,
} from "@/lib/selectors";
import { visionFor } from "@/lib/rules/avalon";
import {
  ROLE_LABELS,
  markLabel,
  playerLabel,
  seatList,
} from "@/lib/format/labels";
import type { RoleMark } from "@/lib/types/events";
import type { RoleType } from "@/lib/types/game";
import { EVIL_ROLES, GOOD_ROLES } from "@/lib/types/game";

type Layer = "root" | "mark" | "myRole";

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
  { label: "梅林或莫甘娜", mark: { kind: "merlin_or_morgana" } },
];

/**
 * What one player can be recorded as. Three public attributes, plus the
 * private read on them — and, on your own seat, your own role.
 *
 * Nothing deeper is shown until it is asked for: three rows, then a layer.
 */
export function PlayerMenuSheet({
  playerId,
  privateVisible,
  onRevealPrivate,
  onClose,
  onPickOpinion,
  onPickIntendedTeam,
  onOpenNote,
  onStartVision,
}: {
  playerId: string | null;
  privateVisible: boolean;
  onRevealPrivate: () => void;
  onClose: () => void;
  onPickOpinion: () => void;
  onPickIntendedTeam: () => void;
  onOpenNote: () => void;
  onStartVision: (role: RoleType) => void;
}) {
  const game = useGame();
  const events = useEvents();
  const addEvent = useGameStore((s) => s.addEvent);
  const updateGameRole = useGameStore((s) => s.setViewerRole);
  const [layer, setLayer] = useState<Layer>("root");

  if (!game || !playerId) return null;

  const isSelf = game.viewerPlayerId === playerId;
  const { expressed } = getPlayerOpinions(events, playerId);
  const intended = getIntendedTeam(events, playerId);
  const claim = getRoleClaim(events, playerId);
  const mark = getRoleMark(events, playerId);

  function close() {
    setLayer("root");
    onClose();
  }

  if (layer === "mark") {
    return (
      <Sheet
        open
        onClose={close}
        onBack={() => setLayer("root")}
        title={`我觉得 ${playerLabel(game, playerId)} 是`}
        subtitle="只有你看得到，不会出现在公开记录里"
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
      <Sheet
        open
        onClose={close}
        onBack={() => setLayer("root")}
        title="我这局是什么角色"
        subtitle="选完会带你点出你看到的人"
        layerKey="myRole"
      >
        <ListGroup header="好人">
          {GOOD_ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              current={game.viewerRole}
              onPick={pickOwnRole}
            />
          ))}
        </ListGroup>
        <div className="mt-6">
          <ListGroup header="坏人">
            {EVIL_ROLES.map((role) => (
              <RoleRow
                key={role}
                role={role}
                current={game.viewerRole}
                onPick={pickOwnRole}
              />
            ))}
          </ListGroup>
        </div>
      </Sheet>
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
        {/* The private layer stays hidden until asked for, even in here — the
            whole point is that a glance at the phone gives nothing away. */}
        <ListGroup header="只有我知道的" footer="不会出现在公开记录里。">
          <ListRow
            label="我觉得他是"
            value={
              !privateVisible
                ? "已隐藏"
                : mark
                  ? `${markLabel(mark.mark)}${mark.certainty === "known" ? "（确定）" : ""}`
                  : "没标记"
            }
            accessory="chevron"
            onClick={() => {
              if (!privateVisible) onRevealPrivate();
              setLayer("mark");
            }}
          />
          {isSelf && (
            <ListRow
              label="我这局的角色"
              value={
                !privateVisible
                  ? "已隐藏"
                  : game.viewerRole
                    ? ROLE_LABELS[game.viewerRole]
                    : "没设"
              }
              accessory="chevron"
              onClick={() => {
                if (!privateVisible) onRevealPrivate();
                setLayer("myRole");
              }}
            />
          )}
        </ListGroup>
      </div>

      <div className="mt-6">
        <ListGroup footer="保踩、意向车都表达不了的，写这里。">
          <ListRow label="记一条备注" accessory="chevron" onClick={onOpenNote} />
        </ListGroup>
      </div>
    </Sheet>
  );

  function pickOwnRole(role: RoleType) {
    void updateGameRole(role);
    const vision = visionFor(role, game!.playerCount, game!.roleSet);
    setLayer("root");
    if (vision) {
      close();
      onStartVision(role);
    }
  }
}

function RoleRow({
  role,
  current,
  onPick,
}: {
  role: RoleType;
  current?: RoleType;
  onPick: (role: RoleType) => void;
}) {
  return (
    <ListRow
      label={ROLE_LABELS[role]}
      accessory={current === role ? "check" : "none"}
      onClick={() => onPick(role)}
    />
  );
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
