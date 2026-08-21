import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne, type TalkSource } from "@/lib/decision/rollout";
import { syntheticRound, type SocialEvidence } from "@/lib/social";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";
import { llmAvailable, modelName, reportUsage, usageSoFar } from "./llm-client";
import { llmTalk } from "./llm-talk";
import {
  correlation,
  designEffect,
  falseConsensus,
  persistence,
  pileOn,
  type RoundLog,
} from "./social-metrics";

/**
 * The closed loop, rerun from scratch with correlated talk discounted.
 *
 * EvilOdds used to add one term per stance, so five seats reading the same
 * failed quest moved the belief five times as far as one. Measured on a
 * held-out block of simulated games, statements about one target in one round
 * carry intraclass correlation 0.123 for a table of models reasoning alone and
 * 0.270 once the posterior is fed back to the speakers it came from. Each
 * cluster's total is now divided by D = 1 + (m-1)rho.
 *
 * The question is NOT whether the win rate lands nearer the corpus. It is
 * whether discounting takes the damage out of shared mistakes without also
 * throwing away the times the table is right together — those look identical
 * from inside, which is the whole difficulty.
 *
 * Nothing else moved: Belief V1's factors, the proposal policy and the rollout
 * evaluator are all as they were.
 *
 * Corpus: win .426, quest failure .413, loading 0.896/0.773/0.630/0.622/0.405.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];
const WEIGHT: Record<number, number> = { 7: 1427, 8: 857, 9: 408, 10: 309 };

interface Arm {
  label: string;
  synthetic?: { quality: number; deception: number };
  llm?: { socialHistory: boolean; mathMemory: boolean };
}

const ARMS: Arm[] = [
  { label: "1 沉默（纯结构）" },
  { label: "2 合成社会信号", synthetic: { quality: 0.29, deception: 0.215 } },
  { label: "3 LLM 独立推理", llm: { socialHistory: false, mathMemory: false } },
  { label: "4 LLM + 社会历史", llm: { socialHistory: true, mathMemory: false } },
  { label: "5 LLM + 后验反馈", llm: { socialHistory: true, mathMemory: true } },
];

const clip = (p: number) => Math.min(0.999, Math.max(0.001, p));

interface Tally {
  games: number;
  wins: number;
  proposals: number;
  approvals: number;
  quests: number;
  failed: number;
  hitLimit: number;
  observed: number[];
  expected: number[];
}

const empty = (): Tally => ({
  games: 0,
  wins: 0,
  proposals: 0,
  approvals: 0,
  quests: 0,
  failed: 0,
  hitLimit: 0,
  observed: [0, 0, 0, 0, 0],
  expected: [0, 0, 0, 0, 0],
});

it("reruns the closed loop with correlated talk discounted", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const perSize = Number(process.env.LOOP_GAMES ?? 25);

  console.log("");
  console.log(`闭环重跑（已折算相关证据）：模型 ${modelName()}，每个人数 ${perSize} 局`);
  console.log("语料：胜率 .426   任务失败 .413   载荷 0.896/0.773/0.630/0.622/0.405");

  const rows: {
    label: string;
    tally: Map<number, Tally>;
    logs: RoundLog[];
    brier: { sum: number; n: number }[];
    q: { v: number[]; t: number[] };
    spent: number;
  }[] = [];

  for (const arm of ARMS) {
    const tally = new Map<number, Tally>();
    const logs: RoundLog[] = [];
    const brier = Array.from({ length: 5 }, () => ({ sum: 0, n: 0 }));
    const q = { v: [] as number[], t: [] as number[] };
    const before = usageSoFar();

    for (const count of [7, 8, 9, 10] as const) {
      const cell = empty();
      tally.set(count, cell);
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

      for (let i = 0; i < worlds.length; i += 1) {
        const assignment = worlds[i];
        const evilTruth = new Set(
          [...assignment.entries()]
            .filter(([, role]) => EVIL_ROLES.includes(role))
            .map(([seat]) => seat),
        );
        const key = `${count}-${i}`;

        const record = (evidence: readonly SocialEvidence[], round: number) => {
          logs.push({
            key,
            round,
            stances: evidence.map((e) => ({
              speaker: e.speakerId,
              target: e.targetId,
              valence: e.valence,
              speakerEvil: evilTruth.has(e.speakerId),
              targetEvil: evilTruth.has(e.targetId),
            })),
          });
          for (const e of evidence) {
            if (evilTruth.has(e.speakerId)) continue;
            q.v.push(e.valence);
            q.t.push(evilTruth.has(e.targetId) ? -1 : 1);
          }
        };

        /*
         * The belief the table acts on as each round opens — which for round
         * r+1 includes round r's talk. Hooked for every arm including the
         * silent one, so the Brier trajectories are measured identically.
         */
        const scoreRead = (read: ReadonlyMap<string, number>, round: number) => {
          const cellBrier = brier[Math.min(round, 5) - 1];
          for (const [seat, p] of read) {
            const y = evilTruth.has(seat) ? 1 : 0;
            cellBrier.sum += (clip(p) - y) ** 2;
            cellBrier.n += 1;
          }
        };

        let talk: TalkSource;
        if (arm.synthetic) {
          const spec = arm.synthetic;
          const talkRng = makeRng(7000 + i);
          talk = async (input) => {
            scoreRead(input.read, input.round);
            const out = syntheticRound(input.round, {
              seats: input.seats,
              evilSeats: evilTruth,
              quality: spec.quality,
              deception: spec.deception,
              rng: talkRng,
            }).map((one, k) => ({ ...one, sequence: input.sequence + k + 1 }));
            record(out, input.round);
            return out;
          };
        } else if (arm.llm) {
          const inner = llmTalk({
            socialHistory: arm.llm.socialHistory,
            mathMemory: arm.llm.mathMemory,
            onEvidence: record,
          });
          const wrapped: TalkSource = async (input) => {
            scoreRead(input.read, input.round);
            return inner(input);
          };
          wrapped.rho = inner.rho;
          talk = wrapped;
        } else {
          // Silent: no stances, but the same measurement path.
          talk = async (input) => {
            scoreRead(input.read, input.round);
            return [];
          };
        }

        const t = await traceOne(
          state,
          assignment,
          publicWorlds,
          makeRng(1000 + i),
          undefined,
          talk,
        );
        cell.games += 1;
        if (t.goodWon) cell.wins += 1;
        cell.proposals += t.proposals;
        cell.approvals += t.approvals;
        cell.quests += t.failCards.length;
        for (const f of t.failCards) if (f > 0) cell.failed += 1;
        if (t.hitRejectionLimit) cell.hitLimit += 1;
        for (let r = 0; r < 5; r += 1) {
          cell.observed[r] += t.byRoundObserved[r];
          cell.expected[r] += t.byRoundExpected[r];
        }
      }
    }

    rows.push({
      label: arm.label,
      tally,
      logs,
      brier,
      q,
      spent: usageSoFar().usd - before.usd,
    });
  }

  const pooled = (tally: Map<number, Tally>) => {
    let win = 0;
    let fail = 0;
    let weight = 0;
    let approvals = 0;
    let proposals = 0;
    let quests = 0;
    let hit = 0;
    const observed = [0, 0, 0, 0, 0];
    const expected = [0, 0, 0, 0, 0];
    for (const [count, t] of tally) {
      const w = WEIGHT[count];
      weight += w;
      win += (t.wins / t.games) * w;
      fail += (t.failed / Math.max(t.quests, 1)) * w;
      approvals += t.approvals * w;
      proposals += t.proposals * w;
      quests += t.quests * w;
      hit += (t.hitLimit / t.games) * w;
      for (let r = 0; r < 5; r += 1) {
        observed[r] += t.observed[r] * w;
        expected[r] += t.expected[r] * w;
      }
    }
    return {
      win: win / weight,
      fail: fail / weight,
      approval: approvals / Math.max(proposals, 1),
      perQuest: proposals / Math.max(quests, 1),
      hit: hit / weight,
      loading: observed.map((o, r) => (expected[r] ? o / expected[r] : NaN)),
    };
  };

  console.log("");
  console.log("结果");
  console.log("臂                好人胜率  任务失败  过车率  每轮提案  连否5   载荷 R1-R5");
  for (const { label, tally } of rows) {
    const p = pooled(tally);
    console.log(
      `${label.padEnd(16)} ${p.win.toFixed(3)}    ${p.fail.toFixed(3)}    ${p.approval.toFixed(3)}   ${p.perQuest.toFixed(2)}     ${p.hit.toFixed(3)}   ${p.loading
        .map((v) => (Number.isFinite(v) ? v.toFixed(2) : " — "))
        .join(" ")}`,
    );
  }

  console.log("");
  console.log("按人数的好人胜率（语料 .448 / .414 / .461 / .311）");
  console.log("臂                  7 人    8 人    9 人   10 人");
  for (const { label, tally } of rows) {
    console.log(
      `${label.padEnd(16)} ${[7, 8, 9, 10]
        .map((c) => {
          const t = tally.get(c)!;
          return (t.wins / t.games).toFixed(3);
        })
        .join("   ")}`,
    );
  }

  console.log("");
  console.log("阵营 Brier，按每轮开始时全桌共享的读数");
  console.log("臂                  第1轮   第2轮   第3轮   第4轮   第5轮");
  for (const { label, brier } of rows) {
    console.log(
      `${label.padEnd(16)} ${brier
        .map((b) => (b.n ? (b.sum / b.n).toFixed(4) : "  —   "))
        .join("  ")}`,
    );
  }

  console.log("");
  console.log("社会证据的结构");
  console.log("臂                实测q   簇内ρ  设计效应 折算后声音  错怪熵  最高占比 同踩倍数 持久化");
  for (const { label, logs, q } of rows) {
    if (!logs.some((l) => l.stances.length)) {
      console.log(`${label.padEnd(16)} （不说话）`);
      continue;
    }
    const d = designEffect(logs);
    const f = falseConsensus(logs);
    console.log(
      `${label.padEnd(16)} ${correlation(q.v, q.t).toFixed(3)}  ${d.rho.toFixed(3)}  ${d.design.toFixed(2)}×    ${d.voices.toFixed(2)}       ${f.entropy.toFixed(3)}   ${f.topShare.toFixed(3)}    ${pileOn(logs).toFixed(2)}×   ${persistence(logs).toFixed(2)}×`,
    );
  }

  console.log("");
  for (const { label, spent, tally } of rows) {
    if (spent <= 0) continue;
    const games = [...tally.values()].reduce((a, t) => a + t.games, 0);
    console.log(
      `${label}：$${spent.toFixed(4)} / ${games} 局 = 每局 $${(spent / games).toFixed(4)}`,
    );
  }
  reportUsage("闭环重跑");
}, 3_600_000);
