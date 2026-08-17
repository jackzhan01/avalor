/**
 * Personal stats, computed from finished games on this device.
 *
 * A game only counts toward a win rate when both halves are known: which side
 * the user was on, and which side won. Everything else is reported as
 * "unrated" rather than being folded in with a guess — a win rate built on
 * assumptions is worse than no win rate.
 */

import type { GameRecord, RoleType } from "@/lib/types/game";
import { EVIL_ROLES } from "@/lib/types/game";

export interface SideRecord {
  played: number;
  won: number;
}

export interface ProfileStats {
  total: number;
  completed: number;
  /** Games where the user's side and the winning side are both recorded. */
  rated: number;
  wins: number;
  asGood: SideRecord;
  asEvil: SideRecord;
  roleCounts: Partial<Record<RoleType, number>>;
  byPlayerCount: Record<number, number>;
  totalEvents: number;
}

export function isEvilRole(role: RoleType): boolean {
  return EVIL_ROLES.includes(role);
}

export function computeProfileStats(
  games: GameRecord[],
  eventCounts: Record<string, number> = {},
): ProfileStats {
  const stats: ProfileStats = {
    total: games.length,
    completed: 0,
    rated: 0,
    wins: 0,
    asGood: { played: 0, won: 0 },
    asEvil: { played: 0, won: 0 },
    roleCounts: {},
    byPlayerCount: {},
    totalEvents: 0,
  };

  for (const game of games) {
    stats.byPlayerCount[game.playerCount] =
      (stats.byPlayerCount[game.playerCount] ?? 0) + 1;
    stats.totalEvents += eventCounts[game.id] ?? 0;

    if (game.status === "completed") stats.completed += 1;

    if (game.viewerRole) {
      stats.roleCounts[game.viewerRole] =
        (stats.roleCounts[game.viewerRole] ?? 0) + 1;
    }

    // Both halves required. A missing role or a missing winner leaves the
    // game unrated rather than defaulting either way.
    if (!game.viewerRole || !game.winningSide) continue;

    const evil = isEvilRole(game.viewerRole);
    const won = evil ? game.winningSide === "evil" : game.winningSide === "good";

    stats.rated += 1;
    if (won) stats.wins += 1;
    const side = evil ? stats.asEvil : stats.asGood;
    side.played += 1;
    if (won) side.won += 1;
  }

  return stats;
}

/** Percentage as an integer, or null when there is nothing to divide by. */
export function winRate(record: SideRecord): number | null {
  if (record.played === 0) return null;
  return Math.round((record.won / record.played) * 100);
}

export function mostPlayedRole(
  stats: ProfileStats,
): { role: RoleType; count: number } | null {
  let best: { role: RoleType; count: number } | null = null;
  for (const [role, count] of Object.entries(stats.roleCounts)) {
    if (!count) continue;
    if (!best || count > best.count) best = { role: role as RoleType, count };
  }
  return best;
}
