import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";

/**
 * How good would the room have to be?
 *
 * The public log tops out: a leader spending every bit of it perfectly still
 * puts evils on his round-five car at 0.565 of chance, and real leaders manage
 * 0.450. So the question is no longer whether social information is needed but
 * how much, and this measures it in a unit a real channel can later be scored
 * against — the correlation between a seat's expressed stance and the truth.
 *
 * Quality 0 is a table talking pure noise, which is the frozen structured
 * baseline. Quality 1 is a table of Merlins. The interesting number is where
 * the loading trajectory and the win rates cross the corpus.
 *
 * Talk enters through the same interface a language model will: seat-to-seat
 * stances with a speaker, a target, a time and an audience, aggregated into
 * log-odds and absorbed by the particle cloud as a likelihood. Nothing here
 * shortcuts into the answer.
 *
 * Corpus, by table size:
 *   good win   .448 / .414 / .461 / .311
 *   quest fail .391 / .426 / .417 / .477
 *   loading    0.896 / 0.773 / 0.630 / 0.622 / 0.405
 */
interface Arm {
  label: string;
  quality: number | readonly number[];
  deception?: number;
}

const ARMS: Arm[] = [
  { label: "q=0.00 沉默", quality: 0 },
  { label: "q=0.20", quality: 0.2 },
  { label: "q=0.30", quality: 0.3 },
  { label: "q=0.45", quality: 0.45 },
  { label: "q=0.59", quality: 0.59 },
  { label: "q=0.75", quality: 0.75 },
  { label: "q=0.30 但坏人不骗", quality: 0.3, deception: 0 },
  // The closed loop's measured coordinates, now that the dial means the
  // realised correlation rather than a coefficient one noise-scale removed.
  { label: "LLM 无记忆 实测 q=.265 骗=.385", quality: 0.265, deception: 0.385 },
  { label: "LLM 有记忆 实测 q=.290 骗=.215", quality: 0.29, deception: 0.215 },
];

it("sweeps how well the table reads people", async () => {

  console.log("");
  console.log("社会信号质量扫描（q = 表态与真相的相关性）");
  console.log("语料：好人胜率 .448/.414/.461/.311   任务失败 .391/.426/.417/.477");
  console.log("      载荷 0.896 / 0.773 / 0.630 / 0.622 / 0.405");

  for (const arm of ARMS) {
    console.log("");
    console.log(arm.label);
    console.log("人数  好人胜率  过车率  连否5次  任务失败率   载荷/轮");

    let winSum = 0;
    let failSum = 0;
    const pooledObserved = [0, 0, 0, 0, 0];
    const pooledExpected = [0, 0, 0, 0, 0];

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
      const worlds = sampleAssignments(state.events, state.game, 900, makeRng(99));

      let wins = 0;
      let proposals = 0;
      let approvals = 0;
      let quests = 0;
      let failed = 0;
      let hit = 0;
      const observed = [0, 0, 0, 0, 0];
      const expected = [0, 0, 0, 0, 0];

      for (let i = 0; i < worlds.length; i += 1) {
        const t = await traceOne(state, worlds[i], publicWorlds, makeRng(1000 + i), {
          quality: arm.quality,
          deception: arm.deception,
        });
        if (t.goodWon) wins += 1;
        proposals += t.proposals;
        approvals += t.approvals;
        quests += t.failCards.length;
        for (const f of t.failCards) if (f > 0) failed += 1;
        if (t.hitRejectionLimit) hit += 1;
        for (let r = 0; r < 5; r += 1) {
          observed[r] += t.byRoundObserved[r];
          expected[r] += t.byRoundExpected[r];
        }
      }

      const n = worlds.length;
      // Corpus weights, so the pooled trajectory is comparable to the target.
      const weight = { 7: 1427, 8: 857, 9: 408, 10: 309 }[count];
      winSum += (wins / n) * weight;
      failSum += (failed / Math.max(quests, 1)) * weight;
      for (let r = 0; r < 5; r += 1) {
        pooledObserved[r] += observed[r] * weight;
        pooledExpected[r] += expected[r] * weight;
      }

      console.log(
        `${String(count).padStart(2)} 人   ${(wins / n).toFixed(3)}   ${(approvals / proposals).toFixed(3)}   ${(hit / n).toFixed(3)}    ${(failed / Math.max(quests, 1)).toFixed(3)}       ${observed
          .map((o, r) => (expected[r] ? (o / expected[r]).toFixed(2) : " — "))
          .join(" ")}`,
      );
    }

    const total = 1427 + 857 + 408 + 309;
    console.log(
      `合并  ${(winSum / total).toFixed(3)}                     ${(failSum / total).toFixed(3)}       ${pooledObserved
        .map((o, r) => (pooledExpected[r] ? (o / pooledExpected[r]).toFixed(2) : " — "))
        .join(" ")}`,
    );
  }
}, 3_600_000);
