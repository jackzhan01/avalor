import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne, type TalkSource } from "@/lib/decision/rollout";
import { syntheticRound } from "@/lib/social";
import { buildDecisionState } from "@/lib/decision/state";
import type { SocialEvidence } from "@/lib/social";
import type { GameRecord } from "@/lib/types/game";
import { llmAvailable, modelName, reportUsage, usageSoFar } from "./llm-client";
import { llmTalk } from "./llm-talk";

/**
 * The first closed loop: models talk inside the simulation they are shaping.
 *
 * Everything before this measured the model against recorded games, or ran the
 * simulator on coordinates measured from the model. Here it actually plays —
 * each round every seat reads the public log of the game being simulated,
 * speaks, and its stances go into the particle posterior before anyone
 * proposes or votes. The talk changes the read, the read changes the car, the
 * car changes what there is to talk about.
 *
 * Four arms, all through the same TalkSource path so nothing differs except
 * who is speaking:
 *
 *   1  structured only, silence
 *   2  the frozen synthetic generator at the model's measured coordinates
 *   3  models talking, with only the public log
 *   4  models talking, handed the posterior as external belief memory
 *
 * Corpus, by table size:
 *   good win   .448 / .414 / .461 / .311   pooled .426
 *   quest fail .391 / .426 / .417 / .477   pooled .413
 *   loading    0.896 / 0.773 / 0.630 / 0.622 / 0.405
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];
const WEIGHT: Record<number, number> = { 7: 1427, 8: 857, 9: 408, 10: 309 };

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

/** Pearson, the unit the synthetic quality dial is defined in. */
function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

interface Arm {
  label: string;
  synthetic?: { quality: number; deception: number };
  llm?: { mathMemory: boolean };
}

/**
 * How much two speakers agree, beyond agreeing with the truth.
 *
 * The synthetic generator draws every stance independently, so n speakers
 * carry n independent readings. A real table does not work that way — everyone
 * read the same log — and if the language arm's stances are strongly
 * correlated then its nominal quality buys far less than the sweep assumed.
 * Measured as the mean pairwise correlation between speakers' valence vectors
 * over the seats they both spoke about.
 */
function speakerAgreement(
  rows: readonly { speakerId: string; targetId: string; valence: number }[],
): number {
  const bySpeaker = new Map<string, Map<string, number>>();
  for (const one of rows) {
    if (!bySpeaker.has(one.speakerId)) bySpeaker.set(one.speakerId, new Map());
    bySpeaker.get(one.speakerId)!.set(one.targetId, one.valence);
  }
  const speakers = [...bySpeaker.keys()];
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < speakers.length; a += 1) {
    for (let b = a + 1; b < speakers.length; b += 1) {
      const A = bySpeaker.get(speakers[a])!;
      const B = bySpeaker.get(speakers[b])!;
      const shared = [...A.keys()].filter(
        (t) => B.has(t) && t !== speakers[a] && t !== speakers[b],
      );
      if (shared.length < 3) continue;
      const r = correlation(
        shared.map((t) => A.get(t)!),
        shared.map((t) => B.get(t)!),
      );
      if (Number.isFinite(r)) {
        sum += r;
        pairs += 1;
      }
    }
  }
  return pairs ? sum / pairs : NaN;
}

const ARMS: Arm[] = [
  { label: "1 结构数学，不说话" },
  // Wrapped as a TalkSource rather than left on the built-in path, so its
  // stances go through the same measurement hook the language arms do. That
  // is what makes the speaker-correlation numbers comparable at all.
  { label: "2 合成信号，坐在 LLM 实测坐标上 q=.29 骗=.22", synthetic: { quality: 0.29, deception: 0.215 } },
  { label: "3 LLM 说话，无数学记忆", llm: { mathMemory: false } },
  { label: "4 LLM 说话 + 数学后验记忆", llm: { mathMemory: true } },
];

it("runs the closed loop and compares four arms", async () => {
  const wantLlm = ARMS.some((a) => a.llm);
  if (wantLlm && !llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const perSize = Number(process.env.LOOP_GAMES ?? 20);
  const sizes = [7, 8, 9, 10] as const;

  console.log("");
  console.log(`闭环社会推演：模型 ${modelName()}，每个人数 ${perSize} 局`);
  console.log("语料：好人胜率 .448/.414/.461/.311（合并 .426）  任务失败 .391/.426/.417/.477（合并 .413）");
  console.log("      载荷 0.896 / 0.773 / 0.630 / 0.622 / 0.405");

  for (const arm of ARMS) {
    const bySize = new Map<number, Tally>();
    // Signal quality of whatever this arm's talk turned out to be.
    const good = { v: [] as number[], t: [] as number[] };
    const evil = { v: [] as number[], t: [] as number[] };
    const byRound = new Map<number, { v: number[]; t: number[] }>();
    const agree: number[] = [];
    const before = usageSoFar();

    for (const count of sizes) {
      const tally = empty();
      bySize.set(count, tally);
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

        const agreement: number[] = [];
        const record = (evidence: readonly SocialEvidence[], round: number) => {
          for (const one of evidence) {
            // +1 when the target really is good, -1 when evil.
            const truth = evilTruth.has(one.targetId) ? -1 : 1;
            const cell = evilTruth.has(one.speakerId) ? evil : good;
            cell.v.push(one.valence);
            cell.t.push(truth);
            if (!evilTruth.has(one.speakerId)) {
              if (!byRound.has(round)) byRound.set(round, { v: [], t: [] });
              const r = byRound.get(round)!;
              r.v.push(one.valence);
              r.t.push(truth);
            }
          }
          const good_only = evidence.filter((e) => !evilTruth.has(e.speakerId));
          const r = speakerAgreement(good_only);
          if (Number.isFinite(r)) agreement.push(r);
        };

        let talk: TalkSource | undefined;
        if (arm.synthetic) {
          const spec = arm.synthetic;
          const talkRng = makeRng(7000 + i);
          talk = async (input) => {
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
        }
        if (arm.llm) {
          talk = llmTalk({ mathMemory: arm.llm.mathMemory, onEvidence: record });
        }

        const t = await traceOne(
          state,
          assignment,
          publicWorlds,
          makeRng(1000 + i),
          undefined,
          talk,
        );
        agree.push(...agreement);
        tally.games += 1;
        if (t.goodWon) tally.wins += 1;
        tally.proposals += t.proposals;
        tally.approvals += t.approvals;
        tally.quests += t.failCards.length;
        for (const f of t.failCards) if (f > 0) tally.failed += 1;
        if (t.hitRejectionLimit) tally.hitLimit += 1;
        for (let r = 0; r < 5; r += 1) {
          tally.observed[r] += t.byRoundObserved[r];
          tally.expected[r] += t.byRoundExpected[r];
        }
      }
    }

    const after = usageSoFar();
    const spent = after.usd - before.usd;
    const calls = after.calls - before.calls + (after.cached - before.cached);
    const played = [...bySize.values()].reduce((a, t) => a + t.games, 0);

    console.log("");
    console.log(arm.label);
    console.log("人数  好人胜率  过车率  每轮提案  连否5次  任务失败率   载荷/轮");
    let winSum = 0;
    let failSum = 0;
    let weightSum = 0;
    const pooledObserved = [0, 0, 0, 0, 0];
    const pooledExpected = [0, 0, 0, 0, 0];
    for (const count of sizes) {
      const t = bySize.get(count)!;
      const w = WEIGHT[count];
      weightSum += w;
      winSum += (t.wins / t.games) * w;
      failSum += (t.failed / Math.max(t.quests, 1)) * w;
      for (let r = 0; r < 5; r += 1) {
        pooledObserved[r] += t.observed[r] * w;
        pooledExpected[r] += t.expected[r] * w;
      }
      console.log(
        `${String(count).padStart(2)} 人   ${(t.wins / t.games).toFixed(3)}   ${(t.approvals / Math.max(t.proposals, 1)).toFixed(3)}   ${(t.proposals / Math.max(t.quests, 1)).toFixed(2)}     ${(t.hitLimit / t.games).toFixed(3)}    ${(t.failed / Math.max(t.quests, 1)).toFixed(3)}       ${t.observed
          .map((o, r) => (t.expected[r] ? (o / t.expected[r]).toFixed(2) : " — "))
          .join(" ")}`,
      );
    }
    console.log(
      `合并  ${(winSum / weightSum).toFixed(3)}                            ${(failSum / weightSum).toFixed(3)}       ${pooledObserved
        .map((o, r) => (pooledExpected[r] ? (o / pooledExpected[r]).toFixed(2) : " — "))
        .join(" ")}`,
    );

    if (good.v.length > 2) {
      const q = correlation(good.v, good.t);
      const d = -correlation(evil.v, evil.t);
      const trend = [1, 2, 3, 4, 5]
        .map((r) => {
          const cell = byRound.get(r);
          return cell && cell.v.length > 20
            ? `第${r}轮 ${correlation(cell.v, cell.t).toFixed(2)}`
            : null;
        })
        .filter(Boolean)
        .join("  ");
      console.log(
        `  实测信号：好人 q=${q.toFixed(3)}   坏人欺骗=${d.toFixed(3)}   说话人之间相关=${
          agree.length ? (agree.reduce((a, b) => a + b, 0) / agree.length).toFixed(3) : " — "
        }   （${good.v.length + evil.v.length} 条表态）`,
      );
      console.log(`  分轮 q：${trend}`);
    }
    if (calls > 0) {
      console.log(
        `  ${calls} 次调用 / ${played} 局 = 每局 ${(calls / played).toFixed(1)} 次，花费 $${spent.toFixed(4)}（每局 $${(spent / played).toFixed(4)}）`,
      );
    }
  }

  console.log("");
  reportUsage("闭环总计");
}, 3_600_000);
