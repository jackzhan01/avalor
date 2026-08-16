/**
 * Fixture B — a full 10-player game, all five missions played out.
 *
 * Deliberately packed with the awkward cases:
 *   - a speaker→target pair rated three times (4 → 5 → 2)
 *   - pairs with NO opinion at all, for null-vs-3 assertions
 *   - a partial vote: some seats "unknown", some seats absent entirely
 *   - mission 4 at 10 players, which needs TWO fail cards
 *   - a mission result with failCount omitted
 *   - a mission that goes to the 5th proposal (hammer) without hitting the
 *     five-rejection auto-loss
 *   - five text notes
 *
 * 10-player team sizes: 3 / 4 / 4 / 5 / 5. Result track: 成功 失败 成功 失败 失败
 * → 坏人 3 轮，游戏在第 5 轮结束。
 */

import { allApprove, approveOnly, game } from "./builder";

export function tenPlayerGame() {
  return (
    game(10)
      .firstLeader(1)

      /* ── Mission 1 (3 上车) — 成功 ──────────────────────────────── */
      .opinion(1, 4, 4) // first of a three-link chain
      .opinion(2, 5, 3) // explicit 中立
      .opinion(3, 7, 5)
      .opinion(7, 3, 5) // mutual 强保

      .proposal(1, [1, 4, 7])
      .vote(approveOnly(10, [1, 2, 4, 7, 9, 10]), "passed")
      .mission("success", 0)

      /* ── Mission 2 (4 上车) — 失败，1 张坏票 ────────────────────── */
      .opinion(1, 4, 5) // second link: 4 → 5
      .opinion(5, 2, 2)
      .note(4, "一直很想上车，主动要位置")

      .proposal(2, [2, 4, 5, 8])
      .vote(approveOnly(10, [2, 4, 5, 6, 8, 10]), "passed")
      .mission("fail", 1)

      /* ── Mission 3 (4 上车) — 打到第 5 车才过 ───────────────────── */
      .opinion(1, 4, 2) // third link: 5 → 2, after the fail
      .opinion(3, 4, 1)
      .opinion(6, 8, 2)
      .note(null, "第二轮崩了之后，4 号被集火")

      .proposal(3, [3, 4, 6, 9])
      .vote(approveOnly(10, [3, 4]), "rejected")

      .proposal(4, [1, 4, 7, 10])
      .vote(approveOnly(10, [1, 4, 7]), "rejected")

      .proposal(5, [2, 5, 6, 8])
      .vote(approveOnly(10, [2, 5, 6, 8]), "rejected")

      .note(null, "已经连挂三次了，大家开始怕连挂 5 次直接输")

      .proposal(6, [1, 3, 6, 7])
      .vote(approveOnly(10, [1, 3, 6, 7]), "rejected")

      // 第 5 车，全票通过（再挂一次坏人就直接赢了）
      .proposal(7, [1, 3, 7, 9])
      .vote(allApprove(10), "passed")
      .mission("success", 0)

      /* ── Mission 4 (5 上车) — 10 人局要 2 张坏票才算失败 ─────────── */
      .opinion(9, 2, 2)
      .opinion(2, 9, 2) // mutual 踩
      .note(9, "投票和 2 号完全相反，已经连着三车了")

      .proposal(8, [1, 2, 3, 7, 9])
      // Partial vote: 5号/6号 recorded as 不清楚, 10号 never recorded at all.
      .vote(
        {
          1: "approve",
          2: "approve",
          3: "approve",
          4: "reject",
          5: "unknown",
          6: "unknown",
          7: "approve",
          8: "reject",
          9: "approve",
        },
        "passed",
      )
      .mission("fail", 2)

      /* ── Mission 5 (5 上车) — 失败，坏票数没记 ──────────────────── */
      .opinion(1, 2, 1)
      .opinion(3, 2, 1)
      .note(2, "最后一轮死活要上车")

      .proposal(9, [2, 4, 5, 6, 8])
      .vote(approveOnly(10, [2, 4, 5, 6, 8, 9]), "passed")
      .mission("fail") // failCount deliberately omitted — must read as null, not 0

      .build()
  );
}
