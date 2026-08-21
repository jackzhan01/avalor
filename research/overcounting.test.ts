import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne, type TalkSource } from "@/lib/decision/rollout";
import { EvilOdds, syntheticRound, type SocialEvidence } from "@/lib/social";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";
import { llmAvailable, modelName, reportUsage } from "./llm-client";
import { llmTalk } from "./llm-talk";

/**
 * How much is the aggregator counting the same thing twice?
 *
 * EvilOdds adds one term per stance. Six seats saying a target looks bad move
 * the log-odds six times as far as one seat does, which is right if the six
 * looked independently and wrong if they all read the same failed quest and
 * reached the same conclusion. The error-structure audit says the model's
 * table is the second case: its stances about one target are correlated well
 * beyond what the target's real side explains.
 *
 * This measures the size of that mistake before anything is changed about it.
 *
 * The standard quantity is the design effect. For a cluster of n correlated
 * observations with intraclass correlation rho, the information they carry is
 * that of n / (1 + (n-1)rho) independent ones, so the aggregator overstates by
 * a factor of 1 + (n-1)rho. Rho comes from a one-way variance decomposition
 * over (game, round, target) clusters, after removing the mean stance for
 * targets of that true side — so a target being genuinely evil is not counted
 * as speakers agreeing for no reason.
 *
 * Nothing here changes the aggregator. It is a measurement.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

interface Cluster {
  values: number[];
  targetEvil: boolean;
}

interface Arm {
  label: string;
  synthetic?: { quality: number; deception: number; consensus?: number };
  llm?: { socialHistory: boolean; mathMemory: boolean };
}

const ARMS: Arm[] = [
  { label: "合成 共识=0（独立）", synthetic: { quality: 0.29, deception: 0.215 } },
  { label: "合成 共识=0.3", synthetic: { quality: 0.29, deception: 0.215, consensus: 0.3 } },
  { label: "A 独立推理", llm: { socialHistory: false, mathMemory: false } },
  { label: "D 只加后验", llm: { socialHistory: false, mathMemory: true } },
];

/**
 * One-way intraclass correlation over clusters, after centring by target side.
 *
 * rho = (MSB - MSW) / (MSB + (n0 - 1) MSW), the usual ANOVA estimator, with n0
 * the size-corrected mean cluster size so unequal clusters do not bias it.
 */
function intraclass(clusters: readonly Cluster[]): {
  rho: number;
  meanSize: number;
  design: number;
  clusters: number;
} {
  const usable = clusters.filter((c) => c.values.length >= 2);
  if (usable.length < 2) return { rho: NaN, meanSize: NaN, design: NaN, clusters: 0 };

  // Centre each side's stances on that side's own mean.
  const mean = { evil: 0, evilN: 0, good: 0, goodN: 0 };
  for (const c of usable) {
    for (const v of c.values) {
      if (c.targetEvil) {
        mean.evil += v;
        mean.evilN += 1;
      } else {
        mean.good += v;
        mean.goodN += 1;
      }
    }
  }
  const centre = (c: Cluster) =>
    c.targetEvil ? mean.evil / Math.max(mean.evilN, 1) : mean.good / Math.max(mean.goodN, 1);

  let total = 0;
  let n = 0;
  for (const c of usable) {
    for (const v of c.values) {
      total += v - centre(c);
      n += 1;
    }
  }
  const grand = total / n;

  let ssBetween = 0;
  let ssWithin = 0;
  let sumSq = 0;
  for (const c of usable) {
    const k = c.values.length;
    const m = c.values.reduce((a, v) => a + (v - centre(c)), 0) / k;
    ssBetween += k * (m - grand) ** 2;
    for (const v of c.values) ssWithin += (v - centre(c) - m) ** 2;
    sumSq += k * k;
  }
  const groups = usable.length;
  const msBetween = ssBetween / Math.max(groups - 1, 1);
  const msWithin = ssWithin / Math.max(n - groups, 1);
  const n0 = (n - sumSq / n) / Math.max(groups - 1, 1);
  const rho = (msBetween - msWithin) / Math.max(msBetween + (n0 - 1) * msWithin, 1e-12);
  const meanSize = n / groups;
  return {
    rho: Math.max(0, rho),
    meanSize,
    design: 1 + (meanSize - 1) * Math.max(0, rho),
    clusters: groups,
  };
}

/**
 * What the aggregator actually accumulates, against what it would accumulate
 * if the cluster were collapsed to its effective number of independent voices.
 */
function accumulated(
  clusters: readonly { evidence: SocialEvidence[]; round: number }[],
  design: number,
): { asIs: number; discounted: number } {
  let asIs = 0;
  let discounted = 0;
  for (const { evidence, round } of clusters) {
    const odds = new EvilOdds({ decay: 1 });
    odds.absorb(evidence, round);
    for (const value of odds.snapshot().values()) {
      asIs += Math.abs(value);
      discounted += Math.abs(value) / Math.max(design, 1);
    }
  }
  return { asIs, discounted };
}

async function collect(
  arm: Arm,
  perSize: number,
  /**
   * Which block of simulated games to draw.
   *
   * rho becomes a model parameter, so it must not be estimated on the games it
   * is then evaluated on. `block` moves every seed, which is what a held-out
   * split looks like when the data is generated rather than recorded.
   */
  block = 0,
): Promise<{ clusters: Cluster[]; byRound: { evidence: SocialEvidence[]; round: number }[] }> {
  const clusters: Cluster[] = [];
  const byRound: { evidence: SocialEvidence[]; round: number }[] = [];

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
    const worlds = sampleAssignments(state.events, state.game, perSize, makeRng(99 + block));

    for (let i = 0; i < worlds.length; i += 1) {
      const assignment = worlds[i];
      const evilTruth = new Set(
        [...assignment.entries()]
          .filter(([, role]) => EVIL_ROLES.includes(role))
          .map(([seat]) => seat),
      );

      const record = (evidence: readonly SocialEvidence[], round: number) => {
        // Only what good speakers said; an evil speaker's agreement with
        // another evil speaker is coordination, which is a different subject.
        const honest = evidence.filter((e) => !evilTruth.has(e.speakerId));
        byRound.push({ evidence: [...honest], round });
        const byTarget = new Map<string, number[]>();
        for (const e of honest) {
          if (!byTarget.has(e.targetId)) byTarget.set(e.targetId, []);
          byTarget.get(e.targetId)!.push(e.valence);
        }
        for (const [target, values] of byTarget) {
          clusters.push({ values, targetEvil: evilTruth.has(target) });
        }
      };

      let talk: TalkSource | undefined;
      if (arm.synthetic) {
        const spec = arm.synthetic;
        const talkRng = makeRng(7000 + block * 977 + i);
        const sharedNoise = new Map<string, number>();
        talk = async (input) => {
          const out = syntheticRound(input.round, {
            seats: input.seats,
            evilSeats: evilTruth,
            quality: spec.quality,
            deception: spec.deception,
            consensus: spec.consensus,
            sharedNoise,
            rng: talkRng,
          }).map((one, k) => ({ ...one, sequence: input.sequence + k + 1 }));
          record(out, input.round);
          return out;
        };
      }
      if (arm.llm) {
        // rho forced to zero: this run measures what the raw channel does, so
        // the correction must not already be inside the thing being measured.
        talk = llmTalk({
          socialHistory: arm.llm.socialHistory,
          mathMemory: arm.llm.mathMemory,
          rho: 0,
          onEvidence: record,
        });
      }

      await traceOne(
        state,
        assignment,
        publicWorlds,
        makeRng(1000 + block * 977 + i),
        undefined,
        talk,
      );
    }
  }

  return { clusters, byRound };
}

it("measures how far the aggregator over-counts correlated talk", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const perSize = Number(process.env.LOOP_GAMES ?? 25);
  console.log("");
  console.log(`聚合过计数审计：模型 ${modelName()}，每个人数 ${perSize} 局`);
  console.log("按 (局, 轮, 目标) 分簇，扣掉目标真实阵营的均值之后做单因素方差分解");
  console.log("");
  console.log("臂                  簇内相关 ρ  平均簇大小  设计效应  有效独立声音  簇数");

  for (const arm of ARMS) {
    const { clusters, byRound } = await collect(arm, perSize);
    const stats = intraclass(clusters);
    const acc = accumulated(byRound, stats.design);
    console.log(
      `${arm.label.padEnd(18)} ${stats.rho.toFixed(3)}       ${stats.meanSize.toFixed(2)}      ${stats.design.toFixed(2)}×     ${(stats.meanSize / stats.design).toFixed(2)}        ${stats.clusters}`,
    );
    console.log(
      `                   聚合器累积的 |log-odds| 合计 ${acc.asIs.toFixed(0)}，` +
        `按设计效应折算后应为 ${acc.discounted.toFixed(0)}`,
    );
  }

  console.log("");
  reportUsage("过计数审计");
}, 3_600_000);

it("estimates rho on a held-out block of simulated games", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const perSize = Number(process.env.RHO_GAMES ?? 10);
  console.log("");
  console.log(`ρ 估计（留出局，与后面评测用的那批完全不同）：每个人数 ${perSize} 局`);
  console.log("聚合折算在这一步强制关掉，否则测的是修正之后的东西");
  console.log("");
  console.log("生成方式                簇内相关 ρ  平均簇大小  设计效应  簇数");

  const REGIMES: Arm[] = [
    { label: "independent（合成独立）", synthetic: { quality: 0.29, deception: 0.215 } },
    { label: "llm（无后验反馈）", llm: { socialHistory: false, mathMemory: false } },
    { label: "llm-feedback（有后验反馈）", llm: { socialHistory: false, mathMemory: true } },
  ];

  for (const arm of REGIMES) {
    const { clusters } = await collect(arm, perSize, 1);
    const stats = intraclass(clusters);
    console.log(
      `${arm.label.padEnd(24)} ${stats.rho.toFixed(3)}       ${stats.meanSize.toFixed(2)}      ${stats.design.toFixed(2)}×     ${stats.clusters}`,
    );
  }

  console.log("");
  reportUsage("ρ 估计");
}, 3_600_000);
