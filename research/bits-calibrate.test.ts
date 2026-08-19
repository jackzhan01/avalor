import { it } from "vitest";
import { deriveRoleInference } from "@/lib/inference/roles";
import type { RoleType } from "@/lib/types/game";
import { corpusSplit, untilMission } from "./splits";

/**
 * What an entropy threshold actually buys, under the tempered posterior.
 *
 * The old ROLE_CERTAIN_BITS of 1.6 was inherited from the untempered model and
 * is not a claim we can make any more. This measures the thing the threshold
 * is supposed to mean — when we say "confident", how often are we right — on
 * VALIDATION, so the number is not read off the test set.
 */
it("measures accuracy against entropy on validation", () => {
  const validation = corpusSplit("validation", { limit: 300 });
  const rows: { role: RoleType; bits: number; hit: number }[] = [];

  for (const round of [2, 3, 4, 5]) {
    for (const { game, events, truth } of validation) {
      const pre = untilMission(events, round);
      if (!pre) continue;
      const inference = deriveRoleInference(pre, game);
      if (inference.contradictory) continue;
      for (const role of ["merlin", "percival", "morgana"] as RoleType[]) {
        const seat = truth.roles.get(role);
        if (!seat) continue;
        const bits = inference.entropyByRole.get(role);
        if (bits === undefined) continue;
        let best = "", bestP = -1;
        for (const player of game.players) {
          const p = inference.byPlayer.get(player.id)?.get(role) ?? 0;
          if (p > bestP) { bestP = p; best = player.id; }
        }
        rows.push({ role, bits, hit: best === seat ? 1 : 0 });
      }
    }
  }

  console.log("");
  console.log(`验证集 ${validation.length} 局，${rows.length} 个 (角色 × 时点) 观测`);
  console.log("");
  console.log("熵 <     命中率    覆盖率    样本");
  for (const t of [1.6, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2]) {
    const sel = rows.filter((r) => r.bits < t);
    if (sel.length < 20) {
      console.log(`${t.toFixed(1)}      样本不足 (${sel.length})`);
      continue;
    }
    const acc = sel.reduce((a, r) => a + r.hit, 0) / sel.length;
    console.log(
      `${t.toFixed(1)}     ${acc.toFixed(3)}    ${((sel.length / rows.length) * 100).toFixed(1)}%    ${sel.length}`,
    );
  }
  const all = rows.reduce((a, r) => a + r.hit, 0) / rows.length;
  console.log(`全部    ${all.toFixed(3)}    100%     ${rows.length}`);
}, 3_600_000);
