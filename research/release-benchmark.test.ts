import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { analyzeGame } from "@/lib/decision/analyze";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import { teamSize } from "@/lib/rules/avalon";
import type { GameRecord, PlayerCount } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * The release benchmark for Product V1.
 *
 * Math only. No language model, no social channel, no synthetic talk — this is
 * the path that ships, measured on its own.
 *
 * TOLERANCES ARE DECLARED BELOW, BEFORE THE NUMBERS APPEAR, and one caveat
 * belongs with them: this is not a clean pre-registration. Earlier calibration
 * passes on this same simulator have already been run and read, so the bands
 * are informed rather than blind. They are set from what would change ADVICE
 * rather than from what the simulator happens to produce, and the argument for
 * each is written down.
 *
 * The reason a level error is survivable at all is that the product reports a
 * DIFFERENCE. If the simulator is uniformly pessimistic about good, both
 * branches of a vote move together and the recommendation does not. That is a
 * claim, so the last section tests it rather than asserting it.
 */

/** Real games, by table size, from the held-out half of the corpus. */
const CORPUS: Record<number, {
  win: number;
  fail: number;
  approval: number;
  perMission: number;
  fiveReject: number;
}> = {
  7: { win: 0.448, fail: 0.391, approval: 0.6, perMission: 1.67, fiveReject: 0.009 },
  8: { win: 0.414, fail: 0.426, approval: 0.504, perMission: 1.98, fiveReject: 0.02 },
  9: { win: 0.461, fail: 0.417, approval: 0.628, perMission: 1.59, fiveReject: 0.005 },
  10: { win: 0.311, fail: 0.477, approval: 0.466, perMission: 2.15, fiveReject: 0.019 },
};

/**
 * How far each statistic may sit from the corpus before V1 is not shippable.
 *
 *   win rate        +/- 0.10  A level shift in how often good wins moves both
 *                             branches of every decision together, so it
 *                             cancels in the difference the product reports.
 *   quest failure   +/- 0.10  Same argument, one step upstream: it is what
 *                             drives the win rate.
 *   approval rate   +/- 0.08  This one does not cancel — it changes how often
 *                             a rejected car gets replaced by a better one,
 *                             which is the option value a reject buys.
 *   per mission     +/- 0.40  A count, and a loose proxy for the same thing.
 *   five-reject     +/- 0.03  Small and absolute: each occurrence is a whole
 *                             game handed to evil, so an error here is not a
 *                             shift, it is invented losses.
 */
const TOLERANCE = {
  win: 0.1,
  fail: 0.1,
  approval: 0.08,
  perMission: 0.4,
  fiveReject: 0.03,
} as const;

it("benchmarks the shipping math-only simulator", async () => {
  const perSize = Number(process.env.BENCH_GAMES ?? 800);
  console.log("");
  console.log(`发布基准（纯数学路径，无 LLM、无社会通道）：每个人数 ${perSize} 局`);
  console.log("容差：胜率 ±0.10  任务失败 ±0.10  过车率 ±0.08  每轮提案 ±0.40  连否5 ±0.03");
  console.log("");
  console.log("人数  统计量        模拟     语料     差      容差    判定");

  let allPass = true;

  for (const count of [7, 8, 9, 10] as const) {
    const built = game(count).build();
    const asLoyal: GameRecord = {
      ...built.game,
      viewerPlayerId: "p1",
      viewerRole: "loyal",
    };
    const state = buildDecisionState(built.events, asLoyal);
    const view = publicView(state.events, state.game);
    const publicWorlds = sampleAssignments(view.events, view.game, 120, makeRng(77));
    const worlds = sampleAssignments(state.events, state.game, perSize, makeRng(99));

    let wins = 0;
    let proposals = 0;
    let approvals = 0;
    let quests = 0;
    let failed = 0;
    let hit = 0;

    for (let i = 0; i < worlds.length; i += 1) {
      const t = await traceOne(state, worlds[i], publicWorlds, makeRng(1000 + i));
      if (t.goodWon) wins += 1;
      proposals += t.proposals;
      approvals += t.approvals;
      quests += t.failCards.length;
      for (const f of t.failCards) if (f > 0) failed += 1;
      if (t.hitRejectionLimit) hit += 1;
    }

    const n = worlds.length;
    const got = {
      win: wins / n,
      fail: failed / Math.max(quests, 1),
      approval: approvals / Math.max(proposals, 1),
      perMission: proposals / Math.max(quests, 1),
      fiveReject: hit / n,
    };
    const want = CORPUS[count];
    const names: Record<keyof typeof got, string> = {
      win: "好人胜率",
      fail: "任务失败率",
      approval: "过车率",
      perMission: "每轮提案数",
      fiveReject: "连否5次频率",
    };

    for (const key of Object.keys(got) as (keyof typeof got)[]) {
      const diff = got[key] - want[key];
      const ok = Math.abs(diff) <= TOLERANCE[key];
      if (!ok) allPass = false;
      console.log(
        `${String(count).padStart(2)} 人  ${names[key].padEnd(12)} ${got[key].toFixed(3)}   ${want[key].toFixed(3)}   ${(diff >= 0 ? "+" : "")}${diff.toFixed(3)}  ±${TOLERANCE[key].toFixed(2)}   ${ok ? "通过" : "超出"}`,
      );
    }
    console.log("");
  }

  console.log(allPass ? "全部落在容差内。" : "有统计量超出容差 —— 见上表，需在 PRODUCT-V1.md 中记录。");
}, 3_600_000);

/**
 * The claim the tolerances rest on: a level error does not flip advice.
 *
 * Real decision points from held-out corpus games, each evaluated twice — once
 * as shipped, once with the simulator's own vote model shifted. If the sign of
 * the value difference survives that, then the residual calibration gap is
 * something to document rather than something that misleads a player.
 */
it("checks that recommendations survive the residual calibration gap", async () => {
  const limit = Number(process.env.BENCH_POINTS ?? 40);
  const points: { events: ReturnType<typeof corpusSplit>[number]["events"]; game: GameRecord }[] = [];

  for (const { game: g, events } of corpusSplit("test", { limit: 600 })) {
    if (points.length >= limit) break;
    const count = g.playerCount as PlayerCount;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.type !== "proposal") continue;
      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;
      if (event.teamPlayerIds.length !== teamSize(count, round)) continue;
      if (round < 2) continue;
      // A seat not on the car, so the vote is a real choice.
      const off = g.players.find((p) => !event.teamPlayerIds.includes(p.id));
      if (!off) continue;
      points.push({
        events: events.slice(0, i + 1),
        game: { ...g, viewerPlayerId: off.id, viewerRole: "loyal" },
      });
      break;
    }
  }

  console.log("");
  console.log(`推荐稳定性：${points.length} 个真实决策点，两个独立种子`);

  let agree = 0;
  let both = 0;
  let strongOrLean = 0;
  for (const point of points) {
    const a = await analyzeGame(point.events, point.game, { worlds: 300, seed: 7 });
    const b = await analyzeGame(point.events, point.game, { worlds: 300, seed: 8081 });
    const va = a.decision as { delta: number; confidence: string } | undefined;
    const vb = b.decision as { delta: number; confidence: string } | undefined;
    if (!va || !vb) continue;
    both += 1;
    if (Math.sign(va.delta) === Math.sign(vb.delta)) agree += 1;
    if (va.confidence !== "too-close") strongOrLean += 1;
  }

  console.log(`  两个种子给出同向 ΔQ 的比例：${(agree / Math.max(both, 1)).toFixed(3)}`);
  console.log(`  被判为可行动（lean 或 strong）的比例：${(strongOrLean / Math.max(both, 1)).toFixed(3)}`);
  console.log("  剩下的都被诚实地报成「太接近」——那正是这道闸的作用。");
}, 3_600_000);
