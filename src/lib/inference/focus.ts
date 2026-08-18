/**
 * What THIS seat should be looking at.
 *
 * The engine computes every marginal regardless of who is holding the phone —
 * inference doesn't care. But the same numbers matter enormously differently
 * depending on the role: handing Merlin a ranked list of "who is evil" is
 * useless, he saw them at the deal. His open question is who Percival is, so
 * that the two of them can cooperate, and — in a Mordred game — which evil he
 * was never shown.
 *
 * So this module holds the ONE piece of the feature that is deliberately
 * role-subjective, kept apart from the engine so that the engine stays a
 * statement about the game rather than a statement about the player. It is
 * pure data plus one function; nothing here can change a probability.
 */

import { rolesInPlay } from "@/lib/rules/avalon";
import { getClaimants } from "@/lib/selectors";
import type { GameEvent } from "@/lib/types/events";
import { EVIL_ROLES, type GameRecord, type RoleType } from "@/lib/types/game";

export interface FocusItem {
  /** "sides" = who is evil at all; "role" = where one named role sits. */
  kind: "sides" | "role";
  role?: RoleType;
  /** Shown as the section heading. */
  label: string;
  /** Why this is what you should be looking at, in one line. */
  why: string;
}

/** What the table is currently solving for. */
export type InferenceTarget =
  | { kind: "sides" }
  | { kind: "role"; role: RoleType };

/**
 * Every target worth offering at this table, best-first.
 *
 * Sides always lead the list, but they are NOT always the default — see
 * `defaultTarget`. An evil player already knows the sides; putting that in
 * front of them is showing them the one thing they cannot learn anything from.
 *
 * Filler roles are excluded (there are several 忠臣, so "where is 忠臣" is not
 * a question), and so is the user's own role, which they are not looking for.
 */
export function availableTargets(
  events: GameEvent[],
  game: GameRecord,
): { target: InferenceTarget; label: string }[] {
  const out: { target: InferenceTarget; label: string }[] = [
    { target: { kind: "sides" }, label: "阵营" },
  ];

  const named: RoleType[] = [
    "merlin",
    "percival",
    "morgana",
    "mordred",
    "assassin",
    "oberon",
  ];
  const inPlay = new Set(rolesInPlay(game.playerCount, game.roleSet));
  const claimants = getClaimants(events).length;

  for (const role of named) {
    if (!inPlay.has(role) || role === game.viewerRole) continue;
    out.push({
      target: { kind: "role", role },
      label:
        role === "percival" && claimants >= 2
          ? "真派"
          : SHORT_LABELS[role],
    });
  }
  return out;
}

/** Chip-sized names. The table already speaks in these. */
const SHORT_LABELS: Record<RoleType, string> = {
  merlin: "梅林",
  percival: "派",
  morgana: "莫甘娜",
  mordred: "莫德雷德",
  assassin: "刺客",
  oberon: "奥伯伦",
  loyal: "忠臣",
  minion: "爪牙",
};

/**
 * Where to start, given who the user is.
 *
 * This is the fix for a real complaint: an evil player opened the layer and
 * saw a table of 100%/0% telling them exactly what they were dealt. Their
 * sides are settled from the first second, so the interesting question is
 * always somewhere else — which is precisely what `inferenceFocus` already
 * ranks. It just wasn't wired to anything.
 */
export function defaultTarget(
  events: GameEvent[],
  game: GameRecord,
): InferenceTarget {
  const first = inferenceFocus(events, game)[0];
  if (!first) return { kind: "sides" };
  return first.kind === "role" && first.role
    ? { kind: "role", role: first.role }
    : { kind: "sides" };
}

/**
 * Ranked, most important first. Empty when the user hasn't said who they are —
 * without a role there is no subjective ordering to give, and guessing one
 * would be inventing an agenda for them.
 */
export function inferenceFocus(
  events: GameEvent[],
  game: GameRecord,
): FocusItem[] {
  const role = game.viewerRole;
  if (!role) return [];

  const inPlay = new Set(rolesInPlay(game.playerCount, game.roleSet));
  const has = (r: RoleType) => inPlay.has(r);
  const claimants = getClaimants(events).length;
  const items: FocusItem[] = [];

  const findMerlin: FocusItem = {
    kind: "role",
    role: "merlin",
    label: "谁是梅林",
    why:
      role === "loyal"
        ? "认出来是为了保护他 —— 千万别公开点破，那等于把他交给刺客"
        : "找到他，这局就赢一半",
  };
  const findRealPercival: FocusItem = {
    kind: "role",
    role: "percival",
    label: claimants >= 2 ? `谁是真派（${claimants} 个人跳了）` : "谁是派西维尔",
    why:
      claimants >= 2
        ? "跳派的不止一个，其中至少一个在骗人"
        : "认出他，好人方才能配合起来",
  };
  const readSides: FocusItem = {
    kind: "sides",
    label: "谁是坏人",
    why: "先把阵营分清楚，再谈具体身份",
  };

  if (role === "merlin") {
    // He already knows the evils — except the one the rules hide from him.
    if (has("percival")) items.push(findRealPercival);
    if (has("mordred")) {
      items.push({
        kind: "role",
        role: "mordred",
        label: "谁是莫德雷德",
        why: "他在你的视野之外，是你唯一看不见的那个坏人",
      });
    }
    if (has("assassin")) {
      items.push({
        kind: "role",
        role: "assassin",
        label: "哪个是刺客",
        why: "局末这一刀冲你来，知道是谁才好防",
      });
    }
  } else if (role === "percival") {
    items.push(findMerlin);
    if (has("morgana")) {
      items.push({
        kind: "role",
        role: "morgana",
        label: "哪个是莫甘娜",
        why: "你看到的两个人里，另一个就是她",
      });
    }
    items.push(readSides);
  } else if (role === "loyal") {
    // No vision at all: sides first, and only then the harder question.
    items.push(readSides);
    if (has("merlin")) items.push(findMerlin);
  } else if (EVIL_ROLES.includes(role)) {
    items.push({
      ...findMerlin,
      why:
        role === "assassin"
          ? "局末你要动手，现在就得锁定人选"
          : "找到梅林，刺客才有的刺",
    });
    if (has("percival")) items.push(findRealPercival);
    if (role === "oberon") {
      items.push({
        kind: "sides",
        label: "谁是你的队友",
        why: "你是奥伯伦，队友不认得你，你也不认得他们",
      });
    }
  }

  return items;
}
