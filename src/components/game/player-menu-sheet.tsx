"use client";

import { Sheet } from "@/components/ui/sheet";
import { ListGroup, ListRow } from "@/components/ui/list";
import { useGameStore } from "@/lib/store/game-store";
import { useEvents, useGame } from "@/lib/store/hooks";
import {
  getIntendedTeam,
  getPlayerOpinions,
  getRoleClaim,
} from "@/lib/selectors";
import { playerLabel, seatList } from "@/lib/format/labels";

/**
 * What one player can be recorded as having said. Three things, one screen,
 * nothing deeper shown until it is asked for.
 *
 * 跳派 is a switch rather than a sub-screen: it is binary, so making the user
 * navigate for it would be a level of depth that buys nothing.
 */
export function PlayerMenuSheet({
  playerId,
  onClose,
  onPickOpinion,
  onPickIntendedTeam,
  onOpenNote,
}: {
  playerId: string | null;
  onClose: () => void;
  onPickOpinion: () => void;
  onPickIntendedTeam: () => void;
  onOpenNote: () => void;
}) {
  const game = useGame();
  const events = useEvents();
  const addEvent = useGameStore((s) => s.addEvent);

  if (!game || !playerId) return null;

  const { expressed } = getPlayerOpinions(events, playerId);
  const intended = getIntendedTeam(events, playerId);
  const claim = getRoleClaim(events, playerId);
  const claimed = claim?.claimed === true;

  return (
    <Sheet
      open
      onClose={onClose}
      title={playerLabel(game, playerId)}
      subtitle="记他说了什么"
      layerKey="menu"
    >
      <ListGroup>
        <ListRow
          label="他怎么看别人"
          value={expressed.length > 0 ? `${expressed.length} 人` : "还没说"}
          accessory="chevron"
          onClick={onPickOpinion}
        />
        <ListRow
          label="他想带谁上车"
          value={
            intended ? seatList(game, intended.teamPlayerIds) : "还没说"
          }
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
              checked={claimed}
              label={`${playerLabel(game, playerId)} 跳派`}
              onChange={(next) => {
                void addEvent({ type: "role_claim", playerId, claimed: next });
              }}
            />
          }
        />
      </ListGroup>

      <div className="mt-6">
        <ListGroup footer="保踩、意向车都表达不了的，写这里。">
          <ListRow label="记一条备注" accessory="chevron" onClick={onOpenNote} />
        </ListGroup>
      </div>
    </Sheet>
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
