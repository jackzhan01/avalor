/**
 * A structural auditor for observations.
 *
 * Searching a serialised observation for the string "merlin" does not work:
 * the public `game_start` event legitimately lists which roles are in the
 * deck, and the final `game_end` legitimately reveals the whole deal. A
 * leakage test that grepped for role names would either be permanently red or
 * would have to whitelist so much that it stopped meaning anything.
 *
 * So this walks the object instead, records WHERE each suspicious thing was
 * found, and lets the test say which paths are allowed. Every finding carries
 * its path, so a failure names the field rather than saying "something
 * leaked".
 */

import { GOOD_ROLES, EVIL_ROLES } from "@/lib/types/game";
import type { Observation } from "../core/observation";
import type { RoleType, Seat } from "../core/types";

const ROLE_NAMES = new Set<string>([...GOOD_ROLES, ...EVIL_ROLES]);

export interface Finding {
  readonly path: string;
  readonly what: string;
  readonly value: unknown;
}

type Visitor = (path: string, value: unknown) => void;

function walk(value: unknown, path: string, visit: Visitor): void {
  visit(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, visit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, visit);
    }
  }
}

/** Every path at which a key with this name appears. */
export function pathsWithKey(root: unknown, key: string): string[] {
  const hits: string[] = [];
  walk(root, "", (path, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (key in (value as Record<string, unknown>)) hits.push(path || "<root>");
    }
  });
  return hits;
}

/** Every path holding one of the eight role names as a string value. */
export function pathsWithRoleName(root: unknown): { path: string; role: RoleType }[] {
  const hits: { path: string; role: RoleType }[] = [];
  walk(root, "", (path, value) => {
    if (typeof value === "string" && ROLE_NAMES.has(value)) {
      hits.push({ path, role: value as RoleType });
    }
  });
  return hits;
}

/**
 * Role names an observation exposes OUTSIDE the public log.
 *
 * The public log is excluded because everything in it is, by definition,
 * something the whole table saw — `game_start` naming the deck, `game_end`
 * revealing the deal, a player publicly claiming to be Percival. What is
 * interesting is the rest of the observation: the seat's own role, its
 * knowledge, its memory, and the evil roster once that is legal.
 */
export function privateRoleMentions(
  observation: Observation,
): { path: string; role: RoleType }[] {
  const { publicLog: _ignored, ...rest } = observation;
  void _ignored;
  return pathsWithRoleName(rest);
}

/** Keys that must never appear anywhere inside an observation. */
export const FORBIDDEN_KEYS: readonly string[] = [
  "deal",
  "bySeat",
  "byRole",
  "pendingVotes",
  "missionCards",
  "privateLog",
  "evilSeats",
  "goodSeats",
  "ladyPending",
];

export function forbiddenKeyFindings(observation: Observation): Finding[] {
  const findings: Finding[] = [];
  for (const key of FORBIDDEN_KEYS) {
    for (const path of pathsWithKey(observation, key)) {
      findings.push({ path, what: `forbidden key "${key}"`, value: key });
    }
  }
  return findings;
}

/**
 * Objects that look like somebody's private memory.
 *
 * An observation must contain exactly one — its own. Shape-matching rather
 * than path-matching so a future refactor that nests memory somewhere else
 * still gets caught.
 */
export function memoryLikeObjects(observation: Observation): string[] {
  const hits: string[] = [];
  walk(observation, "", (path, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if ("beliefs" in record && "commitments" in record && "intentions" in record) {
      hits.push(path || "<root>");
    }
  });
  return hits;
}

/** Lady results reachable from this observation, whoever they belong to. */
export function ladyResultHolders(observation: Observation): Seat[] {
  const holders: Seat[] = [];
  walk(observation, "", (_path, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if ("trueSide" in record && "holder" in record && "target" in record) {
      holders.push(record.holder as Seat);
    }
  });
  return holders;
}
