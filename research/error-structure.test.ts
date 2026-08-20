import { it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments } from "@/lib/decision/sampler";
import { traceOne, type TalkSource } from "@/lib/decision/rollout";
import { syntheticRound, type SocialEvidence } from "@/lib/social";
import { buildDecisionState } from "@/lib/decision/state";
import type { GameRecord } from "@/lib/types/game";
import { llmAvailable, modelName, reportUsage } from "./llm-client";
import { llmTalk } from "./llm-talk";

/**
 * Not how often the table is wrong — how it is wrong.
 *
 * The two-parameter summary (signal quality, deception strength) predicts the
 * math-memory arm to within .008 of its win rate and overpredicts the
 * no-memory arm by .084. Since both arms were measured on the same axes and
 * the mean accuracies are nearly the same, whatever separates them is in the
 * SHAPE of the errors, not their size.
 *
 * Four things a synthetic table drawn independently cannot do, and a real one
 * might: pile onto the same innocent seat, be wrong TOGETHER rather than
 * merely be wrong, carry a mistake forward into later rounds, and treat
 * different seats unequally for reasons unrelated to the truth.
 *
 * Replays the frozen closed-loop configuration exactly — same seeds, same
 * arms, same prompts — so every language call is a cache hit and nothing here
 * costs anything or moves the result being audited. Nothing in the posterior,
 * the proposal policy or the evaluator is touched.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];
/** Below this a stance is an accusation; above its negation, support. */
const EDGE = 0.15;

interface Stance {
  speaker: string;
  target: string;
  valence: number;
  speakerEvil: boolean;
  targetEvil: boolean;
}

interface RoundLog {
  key: string;
  round: number;
  seats: readonly string[];
  stances: Stance[];
}

function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

/** log(n choose k), for the independence baseline. */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let out = 0;
  for (let i = 0; i < k; i += 1) out += Math.log(n - i) - Math.log(i + 1);
  return out;
}

interface Report {
  label: string;
  logs: RoundLog[];
}

/**
 * How concentrated the table's mistakes are.
 *
 * Wrong accusations spread evenly over the innocents are noise the posterior
 * shrugs off; the same wrong accusation from six seats is a false fact the
 * posterior has no defence against, because it looks exactly like six
 * independent readings.
 */
function falseConsensus(logs: readonly RoundLog[]): {
  entropy: number;
  topShare: number;
  cells: number;
  rightEntropy: number;
  rightTopShare: number;
  rightCells: number;
} {
  let entropy = 0;
  let topShare = 0;
  let cells = 0;
  let rightEntropy = 0;
  let rightTopShare = 0;
  let rightCells = 0;

  for (const log of logs) {
    for (const wrong of [true, false]) {
      const counts = new Map<string, number>();
      let total = 0;
      for (const s of log.stances) {
        if (s.speakerEvil) continue;
        if (s.valence >= -EDGE) continue;
        // A good speaker accusing a good seat is an error; accusing an evil
        // one is the job. Both are measured, so concentration can be read as
        // a vice or a virtue depending on which row it lands in.
        if (s.targetEvil === wrong) continue;
        counts.set(s.target, (counts.get(s.target) ?? 0) + 1);
        total += 1;
      }
      if (total < 3 || counts.size === 0) continue;
      let h = 0;
      let top = 0;
      for (const c of counts.values()) {
        const p = c / total;
        h -= p * Math.log(p);
        if (c > top) top = c;
      }
      // Against the number of targets of that kind actually on the table.
      const available = new Set(
        log.stances
          .filter((s) => !s.speakerEvil && s.targetEvil !== wrong)
          .map((s) => s.target),
      ).size;
      const norm = available > 1 ? h / Math.log(available) : 0;
      if (wrong) {
        entropy += norm;
        topShare += top / total;
        cells += 1;
      } else {
        rightEntropy += norm;
        rightTopShare += top / total;
        rightCells += 1;
      }
    }
  }

  return {
    entropy: cells ? entropy / cells : NaN,
    topShare: cells ? topShare / cells : NaN,
    cells,
    rightEntropy: rightCells ? rightEntropy / rightCells : NaN,
    rightTopShare: rightCells ? rightTopShare / rightCells : NaN,
    rightCells,
  };
}

/**
 * Are speakers correlated because they are right, or because they are wrong?
 *
 * Two seats that both spot the same evil agree for a reason the belief should
 * absorb. Two seats that both suspect the same innocent agree for a reason it
 * should not, and the aggregator has no way to tell them apart.
 */
function errorCorrelation(logs: readonly RoundLog[]): {
  onRight: number;
  onWrong: number;
  pairsRight: number;
  pairsWrong: number;
} {
  let right = 0;
  let wrong = 0;
  let pr = 0;
  let pw = 0;

  for (const log of logs) {
    const bySpeaker = new Map<string, Map<string, Stance>>();
    for (const s of log.stances) {
      if (s.speakerEvil) continue;
      if (!bySpeaker.has(s.speaker)) bySpeaker.set(s.speaker, new Map());
      bySpeaker.get(s.speaker)!.set(s.target, s);
    }
    const speakers = [...bySpeaker.keys()];
    for (let a = 0; a < speakers.length; a += 1) {
      for (let b = a + 1; b < speakers.length; b += 1) {
        const A = bySpeaker.get(speakers[a])!;
        const B = bySpeaker.get(speakers[b])!;
        const shared = [...A.keys()].filter(
          (t) => B.has(t) && t !== speakers[a] && t !== speakers[b],
        );
        // Split by whether the PAIR is pointing the right way on that target.
        for (const correct of [true, false]) {
          const picked = shared.filter((t) => {
            const want = A.get(t)!.targetEvil ? -1 : 1;
            const okA = Math.sign(A.get(t)!.valence || want) === want;
            const okB = Math.sign(B.get(t)!.valence || want) === want;
            return okA === correct && okB === correct;
          });
          if (picked.length < 3) continue;
          const r = correlation(
            picked.map((t) => A.get(t)!.valence),
            picked.map((t) => B.get(t)!.valence),
          );
          if (!Number.isFinite(r)) continue;
          if (correct) {
            right += r;
            pr += 1;
          } else {
            wrong += r;
            pw += 1;
          }
        }
      }
    }
  }

  return {
    onRight: pr ? right / pr : NaN,
    onWrong: pw ? wrong / pw : NaN,
    pairsRight: pr,
    pairsWrong: pw,
  };
}

/**
 * How often a whole table lands on one innocent, against independent chance.
 *
 * The independence baseline uses the arm's OWN rate of wrongly accusing a
 * given innocent, so a table that simply accuses more is not scored as more
 * conspiratorial.
 */
function pileOn(logs: readonly RoundLog[]): {
  observed: number;
  independent: number;
  cells: number;
} {
  let accusations = 0;
  let opportunities = 0;
  for (const log of logs) {
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil) continue;
      opportunities += 1;
      if (s.valence < -EDGE) accusations += 1;
    }
  }
  const p = opportunities ? accusations / opportunities : 0;

  let observed = 0;
  let independent = 0;
  let cells = 0;
  for (const log of logs) {
    const byTarget = new Map<string, { hit: number; seen: number }>();
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil) continue;
      if (!byTarget.has(s.target)) byTarget.set(s.target, { hit: 0, seen: 0 });
      const cell = byTarget.get(s.target)!;
      cell.seen += 1;
      if (s.valence < -EDGE) cell.hit += 1;
    }
    for (const { hit, seen } of byTarget.values()) {
      if (seen < 3) continue;
      cells += 1;
      if (hit >= 3) observed += 1;
      // P(at least 3 of `seen` accuse) under independence at rate p.
      let tail = 0;
      for (let k = 3; k <= seen; k += 1) {
        tail += Math.exp(
          logChoose(seen, k) + k * Math.log(Math.max(p, 1e-9)) +
            (seen - k) * Math.log(Math.max(1 - p, 1e-9)),
        );
      }
      independent += tail;
    }
  }

  return {
    observed: cells ? observed / cells : NaN,
    independent: cells ? independent / cells : NaN,
    cells,
  };
}

/** Does a mistake made early survive, and does it get louder? */
function persistence(logs: readonly RoundLog[]): {
  given: number;
  without: number;
  lift: number;
  strengthen: number;
  pairs: number;
} {
  const byGame = new Map<string, Map<number, Map<string, number>>>();
  for (const log of logs) {
    if (!byGame.has(log.key)) byGame.set(log.key, new Map());
    const rounds = byGame.get(log.key)!;
    const mean = new Map<string, { sum: number; n: number }>();
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil) continue;
      if (!mean.has(s.target)) mean.set(s.target, { sum: 0, n: 0 });
      const cell = mean.get(s.target)!;
      cell.sum += s.valence;
      cell.n += 1;
    }
    const out = new Map<string, number>();
    for (const [target, cell] of mean) out.set(target, cell.sum / cell.n);
    rounds.set(log.round, out);
  }

  let givenHit = 0;
  let givenN = 0;
  let withoutHit = 0;
  let withoutN = 0;
  let deltaSum = 0;
  let deltaN = 0;

  for (const rounds of byGame.values()) {
    const ordered = [...rounds.keys()].sort((a, b) => a - b);
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const now = rounds.get(ordered[i])!;
      const next = rounds.get(ordered[i + 1])!;
      for (const [target, value] of now) {
        const later = next.get(target);
        if (later === undefined) continue;
        const suspectedNow = value < -EDGE;
        const suspectedLater = later < -EDGE;
        if (suspectedNow) {
          givenN += 1;
          if (suspectedLater) givenHit += 1;
          deltaSum += later - value;
          deltaN += 1;
        } else {
          withoutN += 1;
          if (suspectedLater) withoutHit += 1;
        }
      }
    }
  }

  const given = givenN ? givenHit / givenN : NaN;
  const without = withoutN ? withoutHit / withoutN : NaN;
  return {
    given,
    without,
    lift: without > 0 ? given / without : NaN,
    // Negative means the suspicion hardened.
    strengthen: deltaN ? deltaSum / deltaN : NaN,
    pairs: givenN + withoutN,
  };
}

/** Accusation and support rates by what the target really was, plus spread. */
function calibration(logs: readonly RoundLog[]): {
  accuseEvil: number;
  accuseGood: number;
  supportEvil: number;
  supportGood: number;
  heterogeneity: number;
} {
  let ae = 0;
  let ne = 0;
  let ag = 0;
  let ng = 0;
  let se = 0;
  let sg = 0;
  const perSeat = new Map<string, { hit: number; seen: number }>();

  for (const log of logs) {
    for (const s of log.stances) {
      if (s.speakerEvil) continue;
      if (s.targetEvil) {
        ne += 1;
        if (s.valence < -EDGE) ae += 1;
        if (s.valence > EDGE) se += 1;
      } else {
        ng += 1;
        if (s.valence < -EDGE) ag += 1;
        if (s.valence > EDGE) sg += 1;
        const key = `${log.key}|${s.target}`;
        if (!perSeat.has(key)) perSeat.set(key, { hit: 0, seen: 0 });
        const cell = perSeat.get(key)!;
        cell.seen += 1;
        if (s.valence < -EDGE) cell.hit += 1;
      }
    }
  }

  const p = ng ? ag / ng : 0;
  // Variance of the per-innocent accusation rate, over the binomial variance
  // it would have if every innocent were equally exposed. Above 1 means some
  // seats attract fire for reasons that have nothing to do with being evil.
  let excess = 0;
  let seats = 0;
  for (const { hit, seen } of perSeat.values()) {
    if (seen < 4) continue;
    const rate = hit / seen;
    excess += ((rate - p) ** 2) / Math.max((p * (1 - p)) / seen, 1e-9);
    seats += 1;
  }

  return {
    accuseEvil: ne ? ae / ne : NaN,
    accuseGood: p,
    supportEvil: ne ? se / ne : NaN,
    supportGood: ng ? sg / ng : NaN,
    heterogeneity: seats ? excess / seats : NaN,
  };
}

interface Arm {
  label: string;
  synthetic?: { quality: number; deception: number; consensus?: number };
  llm?: { mathMemory: boolean };
}

const ARMS: Arm[] = [
  { label: "合成 共识=0（独立）", synthetic: { quality: 0.29, deception: 0.215 } },
  { label: "合成 共识=0.3", synthetic: { quality: 0.29, deception: 0.215, consensus: 0.3 } },
  { label: "合成 共识=0.5", synthetic: { quality: 0.29, deception: 0.215, consensus: 0.5 } },
  { label: "合成 共识=0.7", synthetic: { quality: 0.29, deception: 0.215, consensus: 0.7 } },
  { label: "LLM 无数学记忆", llm: { mathMemory: false } },
  { label: "LLM + 数学后验", llm: { mathMemory: true } },
];

async function collect(arm: Arm, perSize: number): Promise<RoundLog[]> {
  const logs: RoundLog[] = [];

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

    for (let i = 0; i < worlds.length; i += 1) {
      const assignment = worlds[i];
      const seats = [...assignment.keys()];
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
          seats,
          stances: evidence.map((e) => ({
            speaker: e.speakerId,
            target: e.targetId,
            valence: e.valence,
            speakerEvil: evilTruth.has(e.speakerId),
            targetEvil: evilTruth.has(e.targetId),
          })),
        });
      };

      let talk: TalkSource | undefined;
      if (arm.synthetic) {
        const spec = arm.synthetic;
        const talkRng = makeRng(7000 + i);
        // One per game, so a shared mistake survives into later rounds.
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
        talk = llmTalk({ mathMemory: arm.llm.mathMemory, onEvidence: record });
      }

      await traceOne(state, assignment, publicWorlds, makeRng(1000 + i), undefined, talk);
    }
  }

  return logs;
}

it("audits the shape of the table's mistakes", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const perSize = Number(process.env.LOOP_GAMES ?? 25);
  console.log("");
  console.log(`社会误差结构审计：模型 ${modelName()}，每个人数 ${perSize} 局`);
  console.log("重放冻结的闭环配置，语言调用全部命中缓存");

  const reports: Report[] = [];
  for (const arm of ARMS) {
    reports.push({ label: arm.label, logs: await collect(arm, perSize) });
  }

  console.log("");
  console.log("一、错怪的集中度（好人说话者踩到真好人身上）");
  console.log("臂                  归一化熵   最高目标占比   样本   对照：踩对坏人的熵/占比");
  for (const { label, logs } of reports) {
    const f = falseConsensus(logs);
    console.log(
      `${label.padEnd(18)} ${f.entropy.toFixed(3)}      ${f.topShare.toFixed(3)}       ${f.cells}    ${f.rightEntropy.toFixed(3)} / ${f.rightTopShare.toFixed(3)}`,
    );
  }

  console.log("");
  console.log("二、说对时的相关 vs 说错时的相关");
  console.log("臂                  说对   说错   差    （对数）");
  for (const { label, logs } of reports) {
    const e = errorCorrelation(logs);
    console.log(
      `${label.padEnd(18)} ${e.onRight.toFixed(3)}  ${e.onWrong.toFixed(3)}  ${(e.onWrong - e.onRight >= 0 ? "+" : "")}${(e.onWrong - e.onRight).toFixed(3)}   ${e.pairsRight}/${e.pairsWrong}`,
    );
  }

  console.log("");
  console.log("三、整桌压同一个好人：实际 vs 同等踩率下的独立基线");
  console.log("臂                  ≥3 人同踩   独立基线   倍数");
  for (const { label, logs } of reports) {
    const p = pileOn(logs);
    console.log(
      `${label.padEnd(18)} ${p.observed.toFixed(3)}       ${p.independent.toFixed(3)}      ${(p.observed / p.independent).toFixed(2)}×`,
    );
  }

  console.log("");
  console.log("四、错怪会不会传下去（对真好人的均值 valence）");
  console.log("臂                  已被怀疑→下轮仍被怀疑   未被怀疑→下轮被怀疑   倍数   均值变化");
  for (const { label, logs } of reports) {
    const p = persistence(logs);
    console.log(
      `${label.padEnd(18)} ${p.given.toFixed(3)}                  ${p.without.toFixed(3)}                ${p.lift.toFixed(2)}×   ${(p.strengthen >= 0 ? "+" : "")}${p.strengthen.toFixed(3)}`,
    );
  }

  console.log("");
  console.log("五、按目标真身份的踩/保率，以及座位间的不均");
  console.log("臂                  踩坏人  踩好人  保坏人  保好人   座位不均（1 = 二项）");
  for (const { label, logs } of reports) {
    const c = calibration(logs);
    console.log(
      `${label.padEnd(18)} ${c.accuseEvil.toFixed(3)}  ${c.accuseGood.toFixed(3)}  ${c.supportEvil.toFixed(3)}  ${c.supportGood.toFixed(3)}   ${c.heterogeneity.toFixed(2)}`,
    );
  }

  console.log("");
  reportUsage("误差结构审计");
}, 3_600_000);
