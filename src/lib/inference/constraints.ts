/**
 * Hard constraints — the only thing allowed to eliminate a hypothesis.
 *
 * EVERY RULE IN THIS FILE MUST BE A THEOREM, NOT A HEURISTIC. If a hypothesis
 * survives here it is genuinely possible; if it dies, a rule of Avalon says it
 * cannot be. "He's been acting suspicious" has no place in this file — that is
 * scoring, and scoring goes somewhere else. The value of the whole layer comes
 * from this line being drawn strictly, because it is what lets the UI say
 * "ruled out" rather than "unlikely".
 *
 * Two omissions are deliberate and worth naming:
 *
 *   A SUCCESSFUL MISSION PROVES NOTHING. Evil may play success, so a clean
 *   quest eliminates no one. It is tempting to treat "1/3/5 succeeded" as
 *   evidence those three are good; it is not, and encoding it would produce
 *   confidently wrong answers.
 *
 *   WHAT THE LADY HOLDER ANNOUNCED PROVES NOTHING. The announcement is public
 *   and may be a lie. Only what the USER saw with their own token is hard, and
 *   that arrives here as a private role_mark, not as a lady_check.
 */

import { requiredFails } from "@/lib/rules/avalon";
import { getAllRoleMarks } from "@/lib/selectors";
import { deriveTimeline } from "@/lib/selectors/derive-timeline";
import type { GameEvent } from "@/lib/types/events";
import { EVIL_ROLES, type GameRecord } from "@/lib/types/game";
import { seatLabel } from "@/lib/format/labels";
import type { Elimination, Hypothesis } from "./types";
import { evilOnTeam } from "./hypotheses";

/** A named filter, so eliminations can be reported with a reason. */
interface Rule {
  kind: Elimination["kind"];
  reason: string;
  holds: (h: Hypothesis) => boolean;
}

/**
 * Every hard constraint the log currently supports, in the order a player would
 * explain them. Order changes nothing about the final set — set intersection is
 * commutative — but it decides which rule gets *credited* with an elimination,
 * and "my own role rules this out" is a better explanation than a mission
 * three rounds later.
 */
export function collectRules(
  events: GameEvent[],
  game: GameRecord,
): Rule[] {
  const rules: Rule[] = [];

  /* ── 1. The user's own side ──────────────────────────────────────────── */

  const me = game.viewerPlayerId;
  if (me && game.viewerRole) {
    const iAmEvil = EVIL_ROLES.includes(game.viewerRole);
    rules.push({
      kind: "viewer_side",
      reason: iAmEvil
        ? `我自己是坏人（${seatLabel(game, me)}）`
        : `我自己是好人（${seatLabel(game, me)}）`,
      holds: (h) => h.isEvil(me) === iAmEvil,
    });
  }

  /* ── 2. Vision: what the game told the user at deal time ─────────────── */

  const marks = getAllRoleMarks(events);
  const percivalPair: string[] = [];

  for (const [targetId, state] of marks) {
    // Guesses are the user's own reads. They are exactly the thing this layer
    // exists to check, so feeding them back in as fact would be circular.
    if (state.certainty !== "known") continue;
    const mark = state.mark;

    if (mark.kind === "side") {
      const shouldBeEvil = mark.side === "evil";
      rules.push({
        kind: "vision",
        reason: `我确定 ${seatLabel(game, targetId)} 是${shouldBeEvil ? "坏人" : "好人"}`,
        holds: (h) => h.isEvil(targetId) === shouldBeEvil,
      });
    } else if (mark.kind === "role") {
      const shouldBeEvil = EVIL_ROLES.includes(mark.role);
      rules.push({
        kind: "vision",
        reason: `我确定 ${seatLabel(game, targetId)} 的身份，是${shouldBeEvil ? "坏人" : "好人"}那边的`,
        holds: (h) => h.isEvil(targetId) === shouldBeEvil,
      });
    } else {
      // merlin_or_morgana constrains the PAIR, not either seat alone: on its
      // own it says nothing, since the seat could be either side.
      percivalPair.push(targetId);
    }
  }

  /* ── 3. Percival's pair: exactly one of the two is Morgana ───────────── */

  if (percivalPair.length === 2) {
    const [a, b] = percivalPair;
    rules.push({
      kind: "percival_pair",
      reason: `${seatLabel(game, a)} 和 ${seatLabel(game, b)} 里，正好一个是莫甘娜`,
      holds: (h) => (h.isEvil(a) ? 1 : 0) + (h.isEvil(b) ? 1 : 0) === 1,
    });
  }

  /* ── 4. Failed missions: every fail card came from an evil seat ──────── */

  const timeline = deriveTimeline(events, game);
  for (const mission of timeline.missions) {
    const team = mission.teamPlayerIds;
    if (!team || team.length === 0) continue;

    const need = requiredFails(game.playerCount, mission.missionNumber);
    // Two independent lower bounds, and the stronger one wins:
    //   - each recorded fail card must come from a distinct evil player
    //   - a mission recorded as failed had at least `need` of them, even when
    //     the user never counted the cards
    const byCards = mission.failCount ?? 0;
    const byResult = mission.result === "fail" ? need : 0;
    const minimum = Math.max(byCards, byResult);
    if (minimum <= 0) continue;

    rules.push({
      kind: "mission_fail",
      reason:
        mission.result === "fail"
          ? `第 ${mission.missionNumber} 轮崩了，车上至少 ${minimum} 个坏人`
          : `第 ${mission.missionNumber} 轮出了 ${minimum} 张坏票，车上至少这么多坏人`,
      holds: (h) => evilOnTeam(h, team) >= minimum,
    });
  }

  return rules;
}

/**
 * Apply the rules in order, recording what each one removed.
 *
 * The counts are per-rule "of what was still alive when this rule ran", which
 * is what makes the explanation readable — the user sees the space closing
 * down step by step rather than a single unexplained number.
 */
export function applyRules(
  hypotheses: Hypothesis[],
  rules: Rule[],
): { surviving: Hypothesis[]; eliminations: Elimination[] } {
  let surviving = hypotheses;
  const eliminations: Elimination[] = [];

  for (const rule of rules) {
    const before = surviving.length;
    surviving = surviving.filter(rule.holds);
    const eliminated = before - surviving.length;
    if (eliminated > 0) {
      eliminations.push({
        kind: rule.kind,
        reason: rule.reason,
        eliminated,
      });
    }
  }

  return { surviving, eliminations };
}
