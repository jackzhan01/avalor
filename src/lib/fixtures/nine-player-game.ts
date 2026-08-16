/**
 * Fixture A — a 9-player game, three missions played, stopped mid-game.
 *
 * Exercises: multiple rejected proposals in one mission, mission numbering
 * across a fail, partial opinion coverage, a self-opinion, text notes, and a
 * terminal state of "a proposal is on the table with no vote yet" (phase =
 * voting), which is where a real notebook usually sits when you look at it.
 *
 * 9-player team sizes: 3 / 4 / 4 / 5 / 5
 */

import { allApprove, approveOnly, game } from "./builder";

export function ninePlayerGame() {
  return (
    game(9, { 1: "Jack", 3: "Amy", 6: "Mike" })
      .firstLeader(1)

      /* ── Mission 1 (3 上车) ─────────────────────────────────────── */
      .opinion(1, 3, 4)
      .opinion(1, 6, 2)
      .opinion(3, 1, 4)
      .opinion(4, 6, 2)

      // 1号点车，被否 4-5
      .proposal(1, [1, 2, 3])
      .vote(approveOnly(9, [1, 2, 3, 9]), "rejected")

      .opinion(2, 1, 2)
      .opinion(6, 4, 1)

      // 2号点车，也被否
      .proposal(2, [2, 4, 6])
      .vote(approveOnly(9, [2, 4, 6]), "rejected")

      .note(6, "被踩之后一直在解释，语速明显变快")

      // 3号点车，过了
      .proposal(3, [1, 3, 5])
      .vote(approveOnly(9, [1, 2, 3, 5, 7, 9]), "passed")
      .mission("success", 0)

      /* ── Mission 2 (4 上车) ─────────────────────────────────────── */
      .opinion(1, 5, 5)
      .opinion(5, 1, 5)
      .opinion(3, 6, 2)
      .opinion(7, 2, 3) // explicit 中立 — must stay distinguishable from null

      .proposal(4, [1, 3, 4, 5])
      .vote(approveOnly(9, [4, 6, 8]), "rejected")

      .opinion(2, 4, 2)

      .proposal(5, [2, 4, 6, 8])
      .vote(approveOnly(9, [2, 4, 5, 6, 8]), "passed")
      .mission("fail", 1)

      /* ── Mission 3 (4 上车) ─────────────────────────────────────── */
      // Opinions shift hard after the fail.
      .opinion(1, 4, 1)
      .opinion(1, 6, 1)
      .opinion(3, 4, 1)
      .opinion(5, 8, 2)
      .opinion(9, 2, 2)
      .opinion(4, 4, 5) // 自己保自己 — allowed, renders on the diagonal
      .note(null, "2/4/6/8 那趟车崩了，桌上现在主要在锤 4 和 6")

      .proposal(6, [1, 2, 3, 6])
      .vote(allApprove(9), "passed")
      .mission("success", 0)

      /* ── Mission 4 — 车已点，还没投票 ────────────────────────────── */
      .opinion(7, 9, 4)
      .opinion(9, 7, 4)
      .proposal(7, [1, 3, 5, 7, 9])

      .build()
  );
}
