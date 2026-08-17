"use client";

import { Sheet } from "@/components/ui/sheet";
import { ListGroup, ListRow } from "@/components/ui/list";
import { useGame, usePlayers, useTimeline } from "@/lib/store/hooks";
import { playerLabel } from "@/lib/format/labels";

/**
 * Override the suggested leader.
 *
 * The suggestion is anchored on the last leader who was actually voted on, so
 * it self-corrects after any override — which is exactly why overriding has to
 * be allowed. Someone passes, someone is skipped, the user mis-taps.
 */
export function LeaderPickerSheet({
  open,
  currentId,
  onClose,
  onPick,
}: {
  open: boolean;
  currentId: string | null;
  onClose: () => void;
  onPick: (playerId: string) => void;
}) {
  const game = useGame();
  const players = usePlayers();
  const timeline = useTimeline();
  if (!game || !open) return null;

  return (
    <Sheet
      open
      onClose={onClose}
      title="谁点这辆车"
      subtitle="按座位自动往下顺，改了之后也会跟着新的顺"
      layerKey="leader"
    >
      <ListGroup>
        {players.map((player) => (
          <ListRow
            key={player.id}
            label={playerLabel(game, player.id)}
            detail={
              timeline?.currentLeaderId === player.id ? "按顺序轮到他" : undefined
            }
            accessory={currentId === player.id ? "check" : "none"}
            onClick={() => onPick(player.id)}
          />
        ))}
      </ListGroup>
    </Sheet>
  );
}
