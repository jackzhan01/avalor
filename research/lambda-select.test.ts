import { it } from "vitest";
import { computeRolesWith } from "@/lib/inference/roles";
import { deriveSideInference } from "@/lib/inference/side";
import { EVIL_ROLES, type RoleType } from "@/lib/types/game";
import { corpusSplit, untilMission } from "./splits";

/**
 * Choosing lambda. Validation only — test is not opened here.
 *
 * The previous selection is void: it ran against a loader that told the model
 * the wrong line-up, so it was fitting to a harness bug.
 */
const EVIL = new Set<RoleType>(EVIL_ROLES);
const LAMBDAS = [0, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1];

it("sweeps lambda on validation", () => {
  const validation = corpusSplit("validation", { limit: 260 });
  console.log("");
  console.log(`验证集 ${validation.length} 局`);
  console.log("");
  console.log("λ       阵营Brier R3   阵营Brier R5   阵营LogLoss R5   梅林Top1 R5   派西Top1 R5   最大阵营分歧");

  for (const lambda of LAMBDAS) {
    let b3 = 0, n3 = 0, b5 = 0, n5 = 0, ll5 = 0;
    let mTop = 0, mGames = 0, pTop = 0, pGames = 0, maxGap = 0;

    for (const round of [3, 5]) {
      for (const { game, events, evil, truth } of validation) {
        const pre = untilMission(events, round);
        if (!pre) continue;
        const roles = computeRolesWith(pre, game, { roleTemperature: lambda });
        if (roles.contradictory) continue;
        const side = deriveSideInference(pre, game);
        const truthEvil = new Set(evil);

        for (const player of game.players) {
          let p = 0;
          for (const r of EVIL) p += roles.byPlayer.get(player.id)?.get(r) ?? 0;
          const y = truthEvil.has(player.id) ? 1 : 0;
          if (round === 3) { b3 += (p - y) ** 2; n3 += 1; }
          else {
            b5 += (p - y) ** 2; n5 += 1;
            ll5 -= y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
          }
          maxGap = Math.max(maxGap, Math.abs(p - (side.evilProbability.get(player.id) ?? 0)));
        }

        if (round !== 5) continue;
        for (const [role, hit, games] of [
          ["merlin", () => mTop++, () => mGames++],
          ["percival", () => pTop++, () => pGames++],
        ] as const) {
          const seat = truth.roles.get(role as RoleType);
          if (!seat) continue;
          games();
          let best = "", bestP = -1;
          for (const player of game.players) {
            const p = roles.byPlayer.get(player.id)?.get(role as RoleType) ?? 0;
            if (p > bestP) { bestP = p; best = player.id; }
          }
          if (best === seat) hit();
        }
      }
    }

    console.log(
      String(lambda).padEnd(8) +
        (b3 / n3).toFixed(4).padStart(12) +
        (b5 / n5).toFixed(4).padStart(15) +
        (ll5 / n5).toFixed(4).padStart(17) +
        (mTop / mGames).toFixed(4).padStart(14) +
        (pTop / pGames).toFixed(4).padStart(14) +
        maxGap.toFixed(4).padStart(15),
    );
  }
}, 3_600_000);
