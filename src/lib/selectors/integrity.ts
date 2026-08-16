import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, RoleSetConfig } from "@/lib/types/game";
import { EVIL_ROLES } from "@/lib/types/game";
import type { IntegrityWarning } from "@/lib/types/derived";
import { evilCount } from "@/lib/rules/avalon";
import { deriveTimeline } from "./derive-timeline";

/**
 * Non-blocking anomalies in the recorded log: orphaned events, superseded
 * entries, vote patterns that contradict their own recorded result, fail counts
 * that don't line up with the rules.
 *
 * Every one of these is advisory. The app surfaces them as a badge and moves
 * on — the user's record is the record, even when it disagrees with the
 * rulebook (house rules exist, and half-remembered data is still data).
 */
export function getIntegrityWarnings(
  events: GameEvent[],
  game: GameRecord,
): IntegrityWarning[] {
  return deriveTimeline(events, game).warnings;
}

export function getWarningsForEvent(
  events: GameEvent[],
  game: GameRecord,
  eventId: string,
): IntegrityWarning[] {
  return getIntegrityWarnings(events, game).filter((w) => w.eventId === eventId);
}

/**
 * Role-set validation. Warn-only, and deliberately isolated from every other
 * selector: role configuration is inert metadata. The moment it feeds a
 * derivation, V1's "no inference" boundary is gone (spec §95).
 */
export function validateRoleSet(
  roleSet: RoleSetConfig | undefined,
  playerCount: GameRecord["playerCount"],
): { severity: "none" | "warn"; message?: string } {
  if (!roleSet || roleSet.rolesIncluded.length === 0) {
    return { severity: "none" };
  }
  const configuredEvil = roleSet.rolesIncluded.filter((r) =>
    EVIL_ROLES.includes(r),
  ).length;
  const expectedEvil = evilCount(playerCount);
  if (configuredEvil > expectedEvil) {
    return {
      severity: "warn",
      message: `${playerCount} 人局是 ${expectedEvil} 个坏人，你选了 ${configuredEvil} 个坏人角色。`,
    };
  }
  if (roleSet.rolesIncluded.length > playerCount) {
    return {
      severity: "warn",
      message: `选了 ${roleSet.rolesIncluded.length} 个角色，但只有 ${playerCount} 个人。`,
    };
  }
  return { severity: "none" };
}
