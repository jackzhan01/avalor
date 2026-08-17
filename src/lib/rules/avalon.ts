/**
 * Official Avalon rules tables.
 *
 * Pure data + pure functions. No event dependency, no inference. Everything
 * here is advisory: the app warns when the table disagrees with what the user
 * recorded, but never blocks a save. Users play house rules, and users mistype.
 */

import type { PlayerCount, RoleSetConfig, RoleType } from "@/lib/types/game";
import type { RoleMark } from "@/lib/types/events";

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

/**
 * What a role lets its holder see at the start of the game.
 *
 * This is not inference — it is the rulebook. It only tells the app HOW MANY
 * seats the user should be able to point at and what the resulting mark means;
 * the user does the pointing, because only they saw the reveal.
 */
export interface Vision {
  /** How many seats they should be pointing at. */
  count: number;
  mark: RoleMark;
  prompt: string;
  hint?: string;
}

const EVIL_ROLE_SET: readonly RoleType[] = [
  "morgana",
  "mordred",
  "assassin",
  "oberon",
  "minion",
];

/**
 * What to assume about an optional role when the game's role set was never
 * configured — which is the common case, since configuring it is optional.
 *
 * These defaults are per-role on purpose. Treating every unconfigured role as
 * absent looks tidy and is wrong: Mordred and Oberon really are absent from a
 * plain game, but MORGANA IS NOT OPTIONAL ALONGSIDE PERCIVAL. Percival exists
 * in a setup precisely so that Morgana can muddy his read; a Percival with no
 * Morgana would simply be handed Merlin, which nobody plays.
 */
const ASSUMED_WHEN_UNCONFIGURED: Partial<Record<RoleType, boolean>> = {
  mordred: false,
  oberon: false,
  morgana: true,
};

export function visionFor(
  role: RoleType,
  playerCount: PlayerCount,
  roleSet?: RoleSetConfig,
): Vision | null {
  // An explicit role set is always trusted; the assumption only fills a gap.
  const inPlay = (r: RoleType) =>
    roleSet
      ? roleSet.rolesIncluded.includes(r)
      : (ASSUMED_WHEN_UNCONFIGURED[r] ?? false);
  const evils = evilCount(playerCount);

  if (role === "loyal") return null;

  // Oberon is hidden from his own side and sees nobody.
  if (role === "oberon") return null;

  if (EVIL_ROLE_SET.includes(role)) {
    const others = evils - 1 - (inPlay("oberon") ? 1 : 0);
    if (others <= 0) return null;
    return {
      count: others,
      mark: { kind: "side", side: "evil" },
      prompt: "点出你的队友",
      hint: inPlay("oberon")
        ? "奥伯伦不参与互认，不用点他。"
        : undefined,
    };
  }

  if (role === "merlin") {
    const seen = evils - (inPlay("mordred") ? 1 : 0);
    if (seen <= 0) return null;
    return {
      count: seen,
      mark: { kind: "side", side: "evil" },
      prompt: "点出你看到的坏人",
      hint: inPlay("mordred") ? "莫德雷德在梅林视野之外。" : undefined,
    };
  }

  if (role === "percival") {
    const morgana = inPlay("morgana");
    return {
      count: morgana ? 2 : 1,
      mark: morgana ? { kind: "merlin_or_morgana" } : { kind: "role", role: "merlin" },
      prompt: morgana ? "点出你看到的两个人" : "点出你看到的梅林",
      hint: morgana ? "你分不清谁是梅林、谁是莫甘娜。" : undefined,
    };
  }

  return null;
}

const VALID_PLAYER_COUNTS: readonly PlayerCount[] = [5, 6, 7, 8, 9, 10];

export function isPlayerCount(n: number): n is PlayerCount {
  return (VALID_PLAYER_COUNTS as readonly number[]).includes(n);
}

export const PLAYER_COUNTS = VALID_PLAYER_COUNTS;
