/**
 * 意向车 and 跳派 — the two non-rating things a player publicly states.
 *
 * Same discipline as opinions, for the same reason: these are PUBLIC
 * EXPRESSION, not truth. Nothing is ever overwritten, the current value is
 * just the last link of the chain, and "never said anything" is null — not a
 * default, not an empty team, not "didn't claim".
 */

import type {
  GameEvent,
  IntendedTeamEvent,
  RoleClaimEvent,
} from "@/lib/types/events";
import { isIntendedTeamEvent, isRoleClaimEvent } from "@/lib/types/events";
import { memoizeByRef, memoizeKeyed } from "@/lib/utils/memo";

export interface DerivedStatements {
  /** playerId → every 意向车 they stated, ascending. */
  intendedTeams: Map<string, IntendedTeamEvent[]>;
  /** playerId → every 跳派 / 反跳, ascending. */
  roleClaims: Map<string, RoleClaimEvent[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function computeStatements(events: GameEvent[]): DerivedStatements {
  const intendedTeams = new Map<string, IntendedTeamEvent[]>();
  const roleClaims = new Map<string, RoleClaimEvent[]>();

  for (const event of events) {
    if (isIntendedTeamEvent(event)) push(intendedTeams, event.playerId, event);
    else if (isRoleClaimEvent(event)) push(roleClaims, event.playerId, event);
  }

  // Defensive sort: an imported log could arrive out of order, and picking the
  // wrong "latest" fails silently.
  for (const chain of intendedTeams.values())
    chain.sort((a, b) => a.sequence - b.sequence);
  for (const chain of roleClaims.values())
    chain.sort((a, b) => a.sequence - b.sequence);

  return { intendedTeams, roleClaims };
}

export const deriveStatements = memoizeByRef(computeStatements);

/* ── 意向车 ────────────────────────────────────────────────────────────── */

/** Their most recent stated team. `null` = they never said who they'd take. */
export function getIntendedTeam(
  events: GameEvent[],
  playerId: string,
): IntendedTeamEvent | null {
  const chain = deriveStatements(events).intendedTeams.get(playerId);
  return chain && chain.length > 0 ? chain[chain.length - 1] : null;
}

/** Every team they have said they'd take, oldest first. Nothing overwritten. */
export function getIntendedTeamHistory(
  events: GameEvent[],
  playerId: string,
): IntendedTeamEvent[] {
  return deriveStatements(events).intendedTeams.get(playerId) ?? [];
}

/* ── 跳派 ──────────────────────────────────────────────────────────────── */

export interface RoleClaimState {
  claimed: boolean;
  eventId: string;
  sequence: number;
  missionNumber: number;
  /** How many times they have flipped, so a wobbler is visible. */
  revisionCount: number;
}

/**
 * `null` means they have never said anything either way — which is NOT the
 * same as having explicitly retracted a claim (`claimed: false`).
 */
export function getRoleClaim(
  events: GameEvent[],
  playerId: string,
): RoleClaimState | null {
  const chain = deriveStatements(events).roleClaims.get(playerId);
  if (!chain || chain.length === 0) return null;
  const latest = chain[chain.length - 1];
  return {
    claimed: latest.claimed,
    eventId: latest.id,
    sequence: latest.sequence,
    missionNumber: latest.missionNumber,
    revisionCount: chain.length,
  };
}

export function getRoleClaimHistory(
  events: GameEvent[],
  playerId: string,
): RoleClaimEvent[] {
  return deriveStatements(events).roleClaims.get(playerId) ?? [];
}

/** Everyone currently claiming Percival. Two claimants is the interesting case. */
export const getClaimants = memoizeByRef((events: GameEvent[]): string[] => {
  const out: string[] = [];
  for (const [playerId, chain] of deriveStatements(events).roleClaims) {
    if (chain.length > 0 && chain[chain.length - 1].claimed) out.push(playerId);
  }
  return out;
});

/* ── Cross-cutting ─────────────────────────────────────────────────────── */

/**
 * Everything one player has publicly stated, for their detail page.
 *
 * Note this deliberately does NOT include the proposals they made as leader:
 * those are actions, not statements, and keeping them apart is what makes
 * "said 1/3/5, took 2/4/6" legible.
 */
export const getPlayerStatements = memoizeKeyed(
  (
    events: GameEvent[],
    playerId: string,
  ): {
    intendedTeams: IntendedTeamEvent[];
    roleClaims: RoleClaimEvent[];
    currentIntendedTeam: IntendedTeamEvent | null;
    currentRoleClaim: RoleClaimState | null;
  } => ({
    intendedTeams: getIntendedTeamHistory(events, playerId),
    roleClaims: getRoleClaimHistory(events, playerId),
    currentIntendedTeam: getIntendedTeam(events, playerId),
    currentRoleClaim: getRoleClaim(events, playerId),
  }),
);
