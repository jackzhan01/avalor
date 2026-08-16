/**
 * Official Avalon rules tables.
 *
 * Pure data + pure functions. No event dependency, no inference. Everything
 * here is advisory: the app warns when the table disagrees with what the user
 * recorded, but never blocks a save. Users play house rules, and users mistype.
 */

import type { PlayerCount } from "@/lib/types/game";

/** Team size per mission (index 0 = mission 1). */
export const TEAM_SIZES: Record<
  PlayerCount,
  readonly [number, number, number, number, number]
> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
} as const;

/** Number of evil players at each table size. */
export const EVIL_COUNTS: Record<PlayerCount, number> = {
  5: 2,
  6: 2,
  7: 3,
  8: 3,
  9: 3,
  10: 4,
} as const;

/** Five consecutive rejected proposals in one mission hands the win to evil. */
export const MAX_PROPOSAL_ATTEMPTS = 5;

export const TOTAL_MISSIONS = 5;

/** Missions a side needs to win the mission track. */
export const MISSIONS_TO_WIN = 3;

export function teamSize(
  playerCount: PlayerCount,
  missionNumber: number,
): number {
  return TEAM_SIZES[playerCount][missionNumber - 1];
}

/**
 * Mission 4 requires TWO fail cards at 7+ players. Every other mission needs one.
 *
 * This is the ONLY home for that rule. Three consumers read it: the mission
 * recorder's hint, the timeline's mission summary, and the integrity warnings.
 *
 * It is deliberately NOT used to compute `result` from `failCount` — `result`
 * is what the user recorded and is authoritative; `failCount` is optional.
 */
export function requiredFails(
  playerCount: PlayerCount,
  missionNumber: number,
): 1 | 2 {
  return missionNumber === 4 && playerCount >= 7 ? 2 : 1;
}

export function evilCount(playerCount: PlayerCount): number {
  return EVIL_COUNTS[playerCount];
}

export function goodCount(playerCount: PlayerCount): number {
  return playerCount - EVIL_COUNTS[playerCount];
}

export type TeamSizeWarning = {
  /** Never "error" — this must not block a save. */
  severity: "none" | "warn";
  expected: number;
  selected: number;
  message?: string;
};

/**
 * Warn-only team size check (spec §51). Returns severity "warn" on a mismatch;
 * the caller shows a banner and still offers to save.
 */
export function getTeamSizeWarning(
  playerCount: PlayerCount,
  missionNumber: number,
  selectedCount: number,
): TeamSizeWarning {
  const expected = teamSize(playerCount, missionNumber);
  if (selectedCount === expected) {
    return { severity: "none", expected, selected: selectedCount };
  }
  return {
    severity: "warn",
    expected,
    selected: selectedCount,
    message: `第 ${missionNumber} 轮通常是 ${expected} 个人上车，你选了 ${selectedCount} 个。`,
  };
}

const VALID_PLAYER_COUNTS: readonly PlayerCount[] = [5, 6, 7, 8, 9, 10];

export function isPlayerCount(n: number): n is PlayerCount {
  return (VALID_PLAYER_COUNTS as readonly number[]).includes(n);
}

export const PLAYER_COUNTS = VALID_PLAYER_COUNTS;
