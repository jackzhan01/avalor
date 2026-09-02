/**
 * The private evil mission-card coordination convention.
 *
 * A HOUSE STRATEGY, NOT A RULE. Nothing here changes what the referee accepts:
 * any evil rider may still legally play FAIL, and `applyAction` will take it.
 * What this file defines is a CONVENTION the mutually aware evil players agree
 * to follow, the way a real table of experienced players agrees not to
 * double-fail a one-fail mission. The referee stays a referee.
 *
 * WHY IT EXISTS. Seed 1's second mission produced THREE fail cards on a
 * four-person team that needed one. Every evil rider independently decided to
 * sabotage, and the result told the whole table that 1–4 contained at least
 * three villains — which is exactly what happened in the M5.3 Terra game, and
 * exactly why good won it. Uncoordinated sabotage is not aggressive play; it is
 * the evil team publishing its own roster through the one channel nobody can
 * dispute.
 *
 * THE ORDER IS FIXED AND ROLE-BASED. The numbers are:
 *
 *     Mordred 1  ·  Morgana 2  ·  Assassin 3
 *
 * and the LARGEST number acts first. So the sabotage decision belongs to the
 * Assassin, then Morgana, then Mordred:
 *
 *     Assassin → Morgana → Mordred
 *
 * The direction was ambiguous when this file was first written and has been
 * settled by the table owner. It is worth being explicit about what it buys,
 * because the opposite reading is also arguable and somebody will ask:
 *
 *   THE ASSASSIN IS ALREADY ON THE MISSION. A seat that rides a failed team is
 *   under suspicion whoever played the card, so the marginal exposure of also
 *   playing it is small — while Mordred's whole value is a clean public record
 *   that Merlin cannot contradict, and spending it on a fail card that anybody
 *   else present could have played is the most expensive way to buy one fail.
 *
 *   AND MORDRED IS THE LAST RESERVE. Keeping him undesignated for as long as
 *   possible means the evil team still has one rider whose record is unspent
 *   when the late missions arrive.
 *
 * `DESIGNATE_LOWEST_PRIORITY_FIRST` below is the one constant that expresses
 * the direction, and it is `false`.
 *
 * OBERON IS NOT IN IT, AND THAT IS THE POINT. He is not mutually aware, so he
 * cannot be told the order and the others are not told he is aboard. An extra
 * fail from Oberon therefore remains possible, and it is not a bug to be
 * corrected — it is the cost of the role, and suppressing it would be the
 * simulator playing the game on evil's behalf.
 *
 * WHAT THE CONVENTION DOES NOT TOUCH. Proposals, votes, speech, claims,
 * retractions, Lady, assassination. It governs one decision: the card.
 */

import type { RoleType } from "@/lib/types/game";
import type { Deal } from "./deal";
import type { Seat } from "./types";

/** The three roles that know each other. Oberon is deliberately absent. */
export type CoordinationRole = "mordred" | "morgana" | "assassin";

/**
 * Priority. The HIGHEST number acts first — see `DESIGNATE_LOWEST_PRIORITY_FIRST`.
 *
 * A CONSTANT, not a heuristic. The whole value of a convention is that every
 * seat derives the same answer without talking, so the order cannot depend on
 * the position, the round, or anything a model gets to weigh.
 */
export const COORDINATION_PRIORITY: Readonly<Record<CoordinationRole, number>> =
  Object.freeze({ mordred: 1, morgana: 2, assassin: 3 });

/**
 * Which end of the priority table acts first.
 *
 * `false` (settled): the LARGEST number acts first — Assassin (3), then
 * Morgana (2), then Mordred (1). This is the table owner's rule.
 *
 * `true` would designate from priority 1 upward. Kept expressible rather than
 * deleted, because the direction is a real strategic choice and the constant is
 * the one place it lives; everything downstream reads `orderedRiders`.
 */
export const DESIGNATE_LOWEST_PRIORITY_FIRST = false;

const COORDINATED_ROLES: readonly RoleType[] = ["mordred", "morgana", "assassin"];

export function isCoordinationRole(role: RoleType): role is CoordinationRole {
  return COORDINATED_ROLES.includes(role);
}

export interface CoordinationRider {
  readonly seat: Seat;
  readonly role: CoordinationRole;
  /** 1-based position in the priority order among THIS mission's riders. */
  readonly rank: number;
  readonly designated: boolean;
}

/**
 * What one evil rider is told about this mission.
 *
 * Given ONLY to a mutually aware evil seat that is actually on the team. Note
 * what it does not contain: any mention of Oberon, of seats not on the mission,
 * or of anything about the good side. `observationFor` gates it and the
 * leakage sweep in `observation.test.ts` proves the gate holds for every seat
 * at every moment of every game.
 */
export interface MissionCoordination {
  readonly missionNumber: number;
  /** Fail cards this mission needs, from the referee's own rules. */
  readonly failsRequired: number;
  /** Mutually aware evil riders, in priority order. Never includes Oberon. */
  readonly riders: readonly CoordinationRider[];
  /** How many of them are designated: `min(failsRequired, riders.length)`. */
  readonly designatedCount: number;
  /** Is the seat reading this one of them? */
  readonly designated: boolean;
}

export interface CoordinationInput {
  readonly deal: Deal;
  readonly seat: Seat;
  readonly team: readonly Seat[];
  readonly missionNumber: number;
  readonly failsRequired: number;
}

/**
 * The coordination context for one seat, or null if it gets none.
 *
 * Null for: every good seat, Oberon, and any evil seat not on this mission.
 * Returning null rather than an empty object matters — a caller that receives
 * an object has to remember to check a flag, and a caller that receives null
 * cannot forget.
 */
export function coordinationFor(input: CoordinationInput): MissionCoordination | null {
  const { deal, seat, team } = input;
  const role = deal.bySeat[seat];
  if (!isCoordinationRole(role)) return null;
  if (!team.includes(seat)) return null;

  const riders = orderedRiders(deal, team);
  const designatedCount = Math.min(input.failsRequired, riders.length);
  const withDesignation: CoordinationRider[] = riders.map((r, i) => ({
    ...r,
    rank: i + 1,
    designated: i < designatedCount,
  }));

  return {
    missionNumber: input.missionNumber,
    failsRequired: input.failsRequired,
    riders: withDesignation,
    designatedCount,
    designated: withDesignation.some((r) => r.seat === seat && r.designated),
  };
}

/**
 * The mutually aware evil riders on this team, sorted by role priority.
 *
 * Ties are impossible — each of the three roles appears at most once in a deal
 * — so the sort is total and identical for every seat that computes it. That is
 * what makes the convention derivable without anybody communicating.
 */
export function orderedRiders(
  deal: Deal,
  team: readonly Seat[],
): readonly Omit<CoordinationRider, "designated">[] {
  return team
    .map((seat) => ({ seat, role: deal.bySeat[seat] }))
    .filter((r): r is { seat: Seat; role: CoordinationRole } => isCoordinationRole(r.role))
    .sort((a, b) => {
      // Descending by default: the largest priority number acts first.
      const d = COORDINATION_PRIORITY[a.role] - COORDINATION_PRIORITY[b.role];
      return DESIGNATE_LOWEST_PRIORITY_FIRST ? d : -d;
    })
    .map((r, i) => ({ seat: r.seat, role: r.role, rank: i + 1 }));
}

/* ── Enforcement ────────────────────────────────────────────────────────── */

/**
 * Is this card legal under the convention?
 *
 * Two things it deliberately does NOT do:
 *
 *   It does not force a designated rider to FAIL. Playing SUCCESS to stay
 *   hidden is a real line, and one the convention exists to make available
 *   rather than to remove.
 *
 *   It does not rewrite anything. A non-designated rider that plays FAIL gets a
 *   named violation and the bounded repair path — the same treatment a
 *   malformed cognition block gets. Silently turning the card into SUCCESS
 *   would produce a game whose record disagrees with what the agent decided,
 *   which is worse than either outcome.
 */
export function coordinationViolation(
  coordination: MissionCoordination | null,
  card: "success" | "fail",
): string | null {
  if (!coordination) return null;
  if (card !== "fail") return null;
  if (coordination.designated) return null;

  const designated = coordination.riders
    .filter((r) => r.designated)
    .map((r) => `${r.seat}号`)
    .join("、");
  return (
    `坏人协调违规：这一轮需要 ${coordination.failsRequired} 张失败票，` +
    `按固定顺序（刺客 → 莫甘娜 → 莫德雷德）指定出牌的是 ${designated}，你不在其中。` +
    `非指定的互认坏人默认出成功，不要自己再加一张失败票 —— ` +
    `多出来的失败票会把你们这一队的人数直接告诉牌桌。改出 success。`
  );
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

const ROLE_WORD: Readonly<Record<CoordinationRole, string>> = {
  mordred: "莫德雷德",
  morgana: "莫甘娜",
  assassin: "刺客",
};

/**
 * The coordination context, as the designated seat reads it.
 *
 * PRIVATE. Rendered into the planner's own-private-facts layer and nowhere
 * else — never into the public table view, never into the spokesperson prompt,
 * never into a replay. `spokesperson.ts` has no field through which it could
 * arrive.
 *
 * It says what the seat MAY do, not what it must. A designated rider that plays
 * SUCCESS to stay hidden has followed the convention; the convention only
 * forbids an undesignated rider adding a second fail card.
 */
export function renderMissionCoordination(c: MissionCoordination): string {
  const lines = [
    "## 坏人出牌协调（房规约定，只有互相认识的坏人看得到）",
    "",
    `第 ${c.missionNumber} 轮需要 **${c.failsRequired} 张失败票**才算挂。`,
    "",
    "这一车上互相认识的坏人，按固定顺序（刺客 → 莫甘娜 → 莫德雷德）：",
    "",
  ];
  for (const r of c.riders) {
    lines.push(
      `- 第 ${r.rank} 位　${r.seat}号（${ROLE_WORD[r.role]}）` +
        `${r.designated ? "　**← 指定出牌人**" : ""}`,
    );
  }
  lines.push(
    "",
    c.designated
      ? "**你是这一轮的指定出牌人。** 出 fail 还是 success 由你决定：" +
        "要推进破坏就出 fail；如果这一轮藏住自己更值钱，出 success 也是完全正当的一手。"
      : "**你不是指定出牌人 —— 出 success。** 不要自己再加一张失败票。",
    "",
    "**为什么有这条约定：** 多出来的失败票不是更狠，是在公开报数。" +
      "一辆四人车开出三张失败票，等于当众告诉牌桌这四个人里至少有三个坏人 —— " +
      "裁判会把这条算术直接写进事实表，谁都不用推。",
    "",
    "**这条约定只管这一张牌。** 发车、投票、发言、跳身份、退水、刺杀，全都不受它约束。",
    "",
    "**注意：这份名单只列出互相认识的坏人。** 车上还有没有别的坏人，你不知道，",
    "也不要假设没有 —— 结算出来的失败票可能比你们商定的多。",
  );
  return lines.join("\n");
}
