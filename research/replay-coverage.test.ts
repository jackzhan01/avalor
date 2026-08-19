import { it } from "vitest";
import { corpusSplit } from "./splits";
import type { RoleType } from "@/lib/types/game";

/**
 * How many decision points the corpus actually contains, and of what kind.
 *
 * Coverage only. The logged winner is NOT a counterfactual label for the
 * actions nobody took — knowing that evil won after a seat approved says
 * nothing about what would have happened had they rejected. This exists to
 * size the problem and to feed off-policy evaluation later.
 */
it("counts decision points by kind, round, table size and side", () => {
  const all = (["train", "validation", "test"] as const).flatMap((s) =>
    corpusSplit(s).map((c) => ({ ...c, split: s })),
  );

  let votes = 0;
  let proposals = 0;
  const byRound = new Map<number, { vote: number; propose: number }>();
  const byCount = new Map<number, { vote: number; propose: number }>();
  const bySide = new Map<string, { vote: number; propose: number }>();
  const bump = (
    map: Map<unknown, { vote: number; propose: number }>,
    key: unknown,
    kind: "vote" | "propose",
    by = 1,
  ) => {
    let c = map.get(key);
    if (!c) map.set(key, (c = { vote: 0, propose: 0 }));
    c[kind] += by;
  };

  for (const { game, events, truth } of all) {
    let mission = 1;
    for (const event of events) {
      if (event.type === "mission") { mission = Math.min(mission + 1, 5); continue; }

      if (event.type === "proposal") {
        proposals += 1;
        bump(byRound, mission, "propose");
        bump(byCount, game.playerCount, "propose");
        const role = truth.byPlayer.get(event.leaderId);
        const side = role ? sideOf(role) : "unknown";
        bump(bySide, side, "propose");
      }

      if (event.type === "vote") {
        const n = Object.values(event.votes).filter(
          (v) => v === "approve" || v === "reject",
        ).length;
        votes += n;
        bump(byRound, mission, "vote", n);
        bump(byCount, game.playerCount, "vote", n);
        for (const [seat, choice] of Object.entries(event.votes)) {
          if (choice !== "approve" && choice !== "reject") continue;
          const role = truth.byPlayer.get(seat);
          bump(bySide, role ? sideOf(role) : "unknown", "vote");
        }
      }
    }
  }

  console.log("");
  console.log(`语料 ${all.length} 局：投票决策点 ${votes}，发车决策点 ${proposals}`);
  console.log("");
  console.log("按轮次      投票      发车");
  for (const r of [1, 2, 3, 4, 5]) {
    const c = byRound.get(r);
    if (c) console.log(`第 ${r} 轮  ${String(c.vote).padStart(9)} ${String(c.propose).padStart(9)}`);
  }
  console.log("");
  console.log("按人数      投票      发车");
  for (const n of [7, 8, 9, 10]) {
    const c = byCount.get(n);
    if (c) console.log(`${n} 人    ${String(c.vote).padStart(9)} ${String(c.propose).padStart(9)}`);
  }
  console.log("");
  console.log("按阵营      投票      发车");
  for (const [side, c] of bySide) {
    console.log(`${side.padEnd(8)} ${String(c.vote).padStart(9)} ${String(c.propose).padStart(9)}`);
  }
}, 1_800_000);

function sideOf(role: RoleType): "good" | "evil" {
  return role === "morgana" || role === "mordred" || role === "oberon" ||
    role === "assassin" || role === "minion"
    ? "evil"
    : "good";
}
