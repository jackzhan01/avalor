import { it } from "vitest";
import { publicView } from "@/lib/decision/public-view";
import { deriveSideInference } from "@/lib/inference";
import { weighHypotheses } from "@/lib/inference/soft";
import { evilCount } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { PlayerCount } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * Does the fourth car get approved because it is good, or because it is the
 * fourth?
 *
 * proposal_index was dropped from the belief layer for a good reason — knowing
 * a car is the fourth attempt tells you almost nothing about who is evil. But
 * it is not irrelevant to ACTION. A table that has rejected three cars is one
 * rejection from handing evil the game outright, and everyone at it knows the
 * count. The simulator has no such term, and it shows: it hits the five-reject
 * limit two to five times as often as real tables do.
 *
 * Everything here conditions only on what a voter has: the attempt number, who
 * is aboard, and the public posterior. Ground truth splits the report by side
 * and never enters the conditioning.
 *
 * Train + validation only.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

interface Cell {
  approve: number;
  total: number;
}

const cell = (): Cell => ({ approve: 0, total: 0 });
const grid = (n: number) => Array.from({ length: n }, cell);

function rate(c: Cell): string {
  return c.total ? (c.approve / c.total).toFixed(3) : "  —  ";
}

function line(label: string, cells: Cell[]): string {
  return `${label}  ${cells.map((c) => rate(c)).join("   ")}   ${cells
    .reduce((a, c) => a + c.total, 0)
    .toString()
    .padStart(7)}`;
}

it("audits approve rate against the rejection count", () => {
  // Train + validation: these offsets become policy parameters, so the test
  // half stays out of the fit.
  const games = [
    ...corpusSplit("train", { limit: 400 }),
    ...corpusSplit("validation", { limit: 400 }),
  ];

  // [attempt][side][aboard]
  const bySide = Array.from({ length: 5 }, () =>
    Array.from({ length: 2 }, () => grid(2)),
  );
  // [attempt][risk bucket], off-team voters only
  const byRisk = Array.from({ length: 5 }, () => grid(3));
  // [attempt][player count 7..10]
  const byCount = Array.from({ length: 5 }, () => grid(4));
  // How often the car actually passed, by attempt.
  const passed = grid(5);

  for (const { game: g, events, truth } of games) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const base = evilCount(g.playerCount as PlayerCount) / n;
    const countIndex = g.playerCount - 7;
    const teamOf = new Map<
      string,
      { team: string[]; attempt: number; risk: number }
    >();
    let attempt = 1;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];

      if (event.type === "proposal") {
        const view = publicView(events.slice(0, i) as GameEvent[], g);
        const side = deriveSideInference(view.events as GameEvent[], view.game);
        let expected = 0;
        if (!side.contradictory && side.surviving.length) {
          const weights = weighHypotheses(
            side.surviving,
            view.events as GameEvent[],
            view.game,
          );
          for (let h = 0; h < side.surviving.length; h += 1) {
            const w = weights[h];
            if (w <= 0) continue;
            let aboard = 0;
            for (const seat of event.teamPlayerIds) {
              if (side.surviving[h].isEvil(seat)) aboard += 1;
            }
            expected += w * aboard;
          }
        }
        const chance = event.teamPlayerIds.length * base;
        teamOf.set(event.id, {
          team: event.teamPlayerIds,
          attempt: Math.min(attempt, 5),
          risk: chance > 0 ? expected / chance : 1,
        });
        continue;
      }

      if (event.type === "vote") {
        const src = teamOf.get(event.proposalId);
        if (src) {
          const a = src.attempt - 1;
          const bucket = src.risk < 0.85 ? 0 : src.risk < 1.15 ? 1 : 2;
          passed[a].total += 1;
          if (event.finalResult === "passed") passed[a].approve += 1;

          for (const [seat, choice] of Object.entries(event.votes)) {
            if (choice !== "approve" && choice !== "reject") continue;
            const yes = choice === "approve";
            const evil = EVIL_ROLES.includes(truth.byPlayer.get(seat) ?? "");
            const aboard = src.team.includes(seat) ? 1 : 0;

            const c = bySide[a][evil ? 1 : 0][aboard];
            c.total += 1;
            if (yes) c.approve += 1;

            if (!aboard) {
              const r = byRisk[a][bucket];
              r.total += 1;
              if (yes) r.approve += 1;
            }

            if (countIndex >= 0 && countIndex < 4) {
              const k = byCount[a][countIndex];
              k.total += 1;
              if (yes) k.approve += 1;
            }
          }

          attempt = event.finalResult === "rejected" ? attempt + 1 : 1;
        }
        continue;
      }

      if (event.type === "mission") attempt = 1;
    }
  }

  console.log("");
  console.log(`连否压力审计：train+validation ${games.length} 局`);
  console.log("");
  console.log("车次              第1车    第2车    第3车    第4车    第5车     样本");
  console.log(
    line("车过了的比例      ", passed.map((c) => c)),
  );
  console.log("");
  console.log("上票率，按阵营与是否在车上");
  console.log("                  第1车    第2车    第3车    第4车    第5车     样本");
  for (const [side, si] of [["好人", 0], ["坏人", 1]] as const) {
    for (const [where, ai] of [["车下", 0], ["车上", 1]] as const) {
      console.log(
        line(
          `${side} ${where}         `,
          bySide.map((a) => a[si][ai]),
        ),
      );
    }
  }

  console.log("");
  console.log("上票率，车下投票者按公开车况（载荷/随机）");
  console.log("                  第1车    第2车    第3车    第4车    第5车     样本");
  for (const [label, bi] of [["干净 <0.85", 0], ["普通", 1], ["脏 >1.15", 2]] as const) {
    console.log(line(`${label.padEnd(12)}  `, byRisk.map((a) => a[bi])));
  }

  // The shift the rollout will apply, in logit space, relative to the
  // attempt-weighted pooled rate — so adding it leaves the pooled calibration
  // that BASE_APPROVE was measured at untouched and only redistributes it.
  const logit = (p: number) => Math.log(p / (1 - p));
  const shiftOf = (cells: Cell[]) => {
    let approve = 0;
    let total = 0;
    for (const c of cells) {
      approve += c.approve;
      total += c.total;
    }
    const pooled = logit(approve / total);
    return cells.map((c) =>
      c.total < 30 ? 0 : Number((logit(c.approve / c.total) - pooled).toFixed(3)),
    );
  };
  console.log("");
  console.log("拟合出的 logit 偏移（相对合并均值），粘进 ATTEMPT_SHIFT：");
  console.log(`  good: { off: [${shiftOf(bySide.map((a) => a[0][0])).join(", ")}], aboard: [${shiftOf(bySide.map((a) => a[0][1])).join(", ")}] },`);
  console.log(`  evil: { off: [${shiftOf(bySide.map((a) => a[1][0])).join(", ")}], aboard: [${shiftOf(bySide.map((a) => a[1][1])).join(", ")}] },`);

  console.log("");
  console.log("上票率，按人数");
  console.log("                  第1车    第2车    第3车    第4车    第5车     样本");
  for (let c = 0; c < 4; c += 1) {
    console.log(line(`${c + 7} 人            `, byCount.map((a) => a[c])));
  }
}, 3_600_000);
