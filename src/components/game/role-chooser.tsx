"use client";

import { ListGroup, ListRow } from "@/components/ui/list";
import { visionFor } from "@/lib/rules/avalon";
import { ROLE_LABELS } from "@/lib/format/labels";
import type { PlayerCount, RoleSetConfig, RoleType } from "@/lib/types/game";
import { EVIL_ROLES, GOOD_ROLES } from "@/lib/types/game";

/**
 * The role list, shared by the mandatory prompt at game start and the "change
 * my role" layer in a player's menu, so the two can never drift apart.
 *
 * Each row says up front how many seats that role will ask you to point at.
 * A player who knows the rules can then catch a wrong role set before it
 * silently produces the wrong vision.
 */
export function RoleChooser({
  current,
  playerCount,
  roleSet,
  onPick,
}: {
  current?: RoleType;
  playerCount: PlayerCount;
  roleSet?: RoleSetConfig;
  onPick: (role: RoleType) => void;
}) {
  function detail(role: RoleType): string {
    const vision = visionFor(role, playerCount, roleSet);
    if (!vision) return "看不到任何人";
    return `${vision.prompt} · ${vision.count} 个`;
  }

  return (
    <>
      <ListGroup header="好人">
        {GOOD_ROLES.map((role) => (
          <ListRow
            key={role}
            label={ROLE_LABELS[role]}
            detail={detail(role)}
            accessory={current === role ? "check" : "none"}
            onClick={() => onPick(role)}
          />
        ))}
      </ListGroup>
      <div className="mt-6">
        <ListGroup header="坏人">
          {EVIL_ROLES.map((role) => (
            <ListRow
              key={role}
              label={ROLE_LABELS[role]}
              detail={detail(role)}
              accessory={current === role ? "check" : "none"}
              onClick={() => onPick(role)}
            />
          ))}
        </ListGroup>
      </div>
    </>
  );
}
