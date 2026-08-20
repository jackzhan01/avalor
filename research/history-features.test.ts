import { it } from "vitest";
import {
  createFilter,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
} from "@/lib/decision/particle-filter";
import { legalTeams, leaderView, teamRisk } from "@/lib/decision/proposal";
import { informationSets } from "@/lib/decision/rollout";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * Does a leader pick from the posterior alone, or from the story so far?
 *
 * The team-level policy scores a car by one number: the posterior probability
 * it carries an evil. That reproduces real leaders on where their car lands in
 * the risk ordering, and still leaves the loading trajectory flat where real
 * leaders keep improving. The sighted roles turned out not to be the reason.
 *
 * So the question here is whether P(T | B_public, H) carries anything beyond
 * B_public — whether "she rode the quest that passed" and "those two were on
 * the one that failed" predict the choice after the posterior has had its say.
 * The posterior already absorbs both as EVIDENCE; the question is whether they
 * also act as STRUCTURE.
 *
 * Answered as a conditional logit over all legal teams, which is the same
 * softmax the policy already is, so the baseline and the extension are fitted
 * the same way and their likelihoods are comparable. The current policy's
 * coefficients came from moment matching, so they are refitted by maximum
 * likelihood here rather than compared against across methods.
 *
 * Uninformed good leaders only — Merlin is frozen and plays a different game.
 * No hidden roles anywhere: every feature is computable by any seat at the
 * table from the public log.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

/** Human-readable, and the order the coefficient vector is in. */
const FEATURES = [
  "风险",
  "自己上车",
  "上过成功任务的人",
  "上过失败任务的人",
  "与上一次成功车重叠",
  "与上一次失败车重叠",
  "与已通过的车最大重叠",
  "同车失败过的对子",
  "投票跟大势的程度",
  "带他的车过车率",
  "从没上过车的人",
] as const;

const NF = FEATURES.length;
const ROUNDS = 5;
/** Round-specific: risk and ride. The rest are pooled. */
const PER_ROUND = 2;
const NPARAM = PER_ROUND * ROUNDS + (NF - PER_ROUND);

function paramIndex(feature: number, round: number): number {
  return feature < PER_ROUND
    ? feature * ROUNDS + (round - 1)
    : PER_ROUND * ROUNDS + (feature - PER_ROUND);
}

interface Shot {
  round: number;
  teams: readonly number[];
  /** teams.length * NF, feature-major per team. */
  x: Float32Array;
  chosen: number;
}

const PRIOR = new Map<string, Assignment[]>();

function priorWorlds(game: GameRecord, count: number): Assignment[] {
  const key = `${game.playerCount}|${[...(game.roleSet?.rolesIncluded ?? [])].sort().join(",")}`;
  const seats = game.players.map((p) => p.id);
  let cached = PRIOR.get(key);
  if (!cached) {
    cached = sampleAssignments([], game, count, makeRng(20250819));
    PRIOR.set(key, cached);
  }
  if (!cached.length) return [];
  const from = [...cached[0].keys()];
  if (from.length !== seats.length) return [];
  return cached.map((world) => {
    const out = new Map<string, RoleType>();
    from.forEach((old, i) => {
      const role = world.get(old);
      if (role) out.set(seats[i], role);
    });
    return out as Assignment;
  });
}

const popcount = (x: number) => {
  let v = x - ((x >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
};

/** What the public log says about each seat, carried forward through a game. */
interface History {
  rodeSuccess: number;
  rodeFail: number;
  everRode: number;
  lastSuccess: number;
  lastFail: number;
  approved: number[];
  /** seat → [times aboard a proposal, times that proposal passed]. */
  aboardTotal: number[];
  aboardPassed: number[];
  /** seat → [votes cast, votes that matched the outcome]. */
  votes: number[];
  agreed: number[];
  /** Pairs that rode a failed quest together, as seat*16+seat. */
  failPairs: Set<number>;
}

function collect(
  games: ReturnType<typeof corpusSplit>,
  onlyUninformedGood: boolean,
): Shot[] {
  const shots: Shot[] = [];

  for (const { game: g, events, truth } of games) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const rng = makeRng(6161);
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const index = new Map(seats.map((s, i) => [s, i]));

    const h: History = {
      rodeSuccess: 0,
      rodeFail: 0,
      everRode: 0,
      lastSuccess: 0,
      lastFail: 0,
      approved: [],
      aboardTotal: new Array(n).fill(0),
      aboardPassed: new Array(n).fill(0),
      votes: new Array(n).fill(0),
      agreed: new Array(n).fill(0),
      failPairs: new Set<number>(),
    };
    const teamOf = new Map<string, { team: string[]; round: number; mask: number }>();
    let successes = 0;
    let fails = 0;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;

      if (event.type === "proposal") {
        const size = teamSize(count, round);
        let mask = 0;
        for (const seat of event.teamPlayerIds) {
          const s = index.get(seat);
          if (s !== undefined) mask |= 1 << s;
        }
        teamOf.set(event.id, { team: event.teamPlayerIds, round, mask });

        const leader = event.leaderId;
        const role = truth.byPlayer.get(leader) ?? "loyal";
        const uninformedGood = !EVIL_ROLES.includes(role) && role !== "merlin";

        if (
          event.teamPlayerIds.length === size &&
          (!onlyUninformedGood || uninformedGood)
        ) {
          const teams = legalTeams(n, size);
          const chosen = teams.indexOf(mask);
          if (chosen >= 0) {
            // need = 1 throughout, matching the policy: the leader is avoiding
            // evils, not only quest failures. See proposal.ts.
            const risk = teamRisk(
              leaderView(filter, seats, info.get(leader)),
              teams,
              1,
            );
            const leaderBit = 1 << (index.get(leader) ?? 0);
            const x = new Float32Array(teams.length * NF);

            for (let t = 0; t < teams.length; t += 1) {
              const T = teams[t];
              const k = popcount(T);
              const base = t * NF;
              x[base + 0] = risk[t];
              x[base + 1] = T & leaderBit ? 1 : 0;
              x[base + 2] = popcount(T & h.rodeSuccess) / k;
              x[base + 3] = popcount(T & h.rodeFail) / k;
              x[base + 4] = h.lastSuccess ? popcount(T & h.lastSuccess) / k : 0;
              x[base + 5] = h.lastFail ? popcount(T & h.lastFail) / k : 0;
              let best = 0;
              for (const a of h.approved) {
                const o = popcount(T & a) / k;
                if (o > best) best = o;
              }
              x[base + 6] = best;
              let pairs = 0;
              for (const key of h.failPairs) {
                const a = key >> 4;
                const b = key & 15;
                if (T & (1 << a) && T & (1 << b)) pairs += 1;
              }
              x[base + 7] = k > 1 ? pairs / ((k * (k - 1)) / 2) : 0;
              let agree = 0;
              let passRate = 0;
              let never = 0;
              for (let s = 0; s < n; s += 1) {
                if (!(T & (1 << s))) continue;
                agree += h.votes[s] > 0 ? h.agreed[s] / h.votes[s] : 0.5;
                passRate +=
                  h.aboardTotal[s] > 0
                    ? h.aboardPassed[s] / h.aboardTotal[s]
                    : 0.5;
                if (!(h.everRode & (1 << s))) never += 1;
              }
              x[base + 8] = agree / k;
              x[base + 9] = passRate / k;
              x[base + 10] = never / k;
            }
            shots.push({ round, teams, x, chosen });
          }
        }

        updateOnProposal(filter, leader, event.teamPlayerIds, round, n, rng);
        continue;
      }

      if (event.type === "vote") {
        const src = teamOf.get(event.proposalId);
        if (!src) continue;
        const cast = new Map<string, boolean>();
        for (const [seat, choice] of Object.entries(event.votes)) {
          if (choice === "approve") cast.set(seat, true);
          else if (choice === "reject") cast.set(seat, false);
        }
        updateOnVotes(filter, src.team, cast, src.round, rng);

        const passed = event.finalResult === "passed";
        for (let s = 0; s < n; s += 1) {
          if (src.mask & (1 << s)) {
            h.aboardTotal[s] += 1;
            if (passed) h.aboardPassed[s] += 1;
          }
        }
        for (const [seat, yes] of cast) {
          const s = index.get(seat);
          if (s === undefined) continue;
          h.votes[s] += 1;
          if (yes === passed) h.agreed[s] += 1;
        }
        if (passed) h.approved.push(src.mask);
        continue;
      }

      if (event.type === "mission") {
        let mask = 0;
        for (const seat of event.teamPlayerIds ?? []) {
          const s = index.get(seat);
          if (s !== undefined) mask |= 1 << s;
        }
        if (event.teamPlayerIds && event.failCount != null) {
          updateOnMission(
            filter,
            event.teamPlayerIds,
            event.failCount,
            requiredFails(count, round),
            successes,
            fails,
            rng,
          );
        }
        h.everRode |= mask;
        if (event.result === "success") {
          successes += 1;
          h.rodeSuccess |= mask;
          h.lastSuccess = mask;
        } else if (event.result === "fail") {
          fails += 1;
          h.rodeFail |= mask;
          h.lastFail = mask;
          for (let a = 0; a < n; a += 1) {
            if (!(mask & (1 << a))) continue;
            for (let b = a + 1; b < n; b += 1) {
              if (mask & (1 << b)) h.failPairs.add((a << 4) | b);
            }
          }
        }
      }
    }
  }

  return shots;
}

/** Conditional-logit log-likelihood and its gradient. */
function objective(
  shots: readonly Shot[],
  theta: Float64Array,
  active: readonly number[],
  grad: Float64Array | null,
): number {
  if (grad) grad.fill(0);
  let total = 0;
  const u: number[] = [];

  for (const shot of shots) {
    const m = shot.teams.length;
    u.length = m;
    let best = -Infinity;
    for (let t = 0; t < m; t += 1) {
      let s = 0;
      for (const f of active) s += theta[paramIndex(f, shot.round)] * shot.x[t * NF + f];
      u[t] = s;
      if (s > best) best = s;
    }
    let sum = 0;
    for (let t = 0; t < m; t += 1) {
      u[t] = Math.exp(u[t] - best);
      sum += u[t];
    }
    total += Math.log(u[shot.chosen] / sum);
    if (!grad) continue;
    for (let t = 0; t < m; t += 1) {
      const p = u[t] / sum;
      const w = (t === shot.chosen ? 1 : 0) - p;
      if (w === 0) continue;
      for (const f of active) grad[paramIndex(f, shot.round)] += w * shot.x[t * NF + f];
    }
  }
  return total / shots.length;
}

/** Plain Adam. The problem is concave, so anything that climbs gets there. */
function fit(shots: readonly Shot[], active: readonly number[]): Float64Array {
  const theta = new Float64Array(NPARAM);
  const grad = new Float64Array(NPARAM);
  const m = new Float64Array(NPARAM);
  const v = new Float64Array(NPARAM);
  const lr = 0.35;
  for (let step = 1; step <= 700; step += 1) {
    objective(shots, theta, active, grad);
    for (let i = 0; i < NPARAM; i += 1) {
      m[i] = 0.9 * m[i] + 0.1 * grad[i];
      v[i] = 0.999 * v[i] + 0.001 * grad[i] * grad[i];
      const mh = m[i] / (1 - Math.pow(0.9, step));
      const vh = v[i] / (1 - Math.pow(0.999, step));
      theta[i] += (lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
  }
  return theta;
}

/** Where the real team lands in the model's own ranking, and how often it tops it. */
function ranking(
  shots: readonly Shot[],
  theta: Float64Array,
  active: readonly number[],
): { rank: number; top1: number; top10: number } {
  let rank = 0;
  let top1 = 0;
  let top10 = 0;
  for (const shot of shots) {
    const m = shot.teams.length;
    const u = new Array<number>(m);
    for (let t = 0; t < m; t += 1) {
      let s = 0;
      for (const f of active) s += theta[paramIndex(f, shot.round)] * shot.x[t * NF + f];
      u[t] = s;
    }
    // Mid-rank again. A model with only the ride term scores every car
    // containing the leader identically, and a strictly-above count would
    // report it as ranking the real one first every time.
    const mine = u[shot.chosen];
    let above = 0;
    let tied = 0;
    for (let t = 0; t < m; t += 1) {
      if (u[t] > mine + 1e-9) above += 1;
      else if (u[t] >= mine - 1e-9) tied += 1;
    }
    const place = above + (tied - 1) / 2;
    rank += 1 - place / m;
    if (place < 1) top1 += 1;
    if (place < 10) top10 += 1;
  }
  return {
    rank: rank / shots.length,
    top1: top1 / shots.length,
    top10: top10 / shots.length,
  };
}

it("asks whether the story so far predicts the car", () => {
  const train = collect(
    [
      ...corpusSplit("train", { limit: 300 }),
      ...corpusSplit("validation", { limit: 300 }),
    ],
    true,
  );
  const held = collect(corpusSplit("test", { limit: 400 }), true);

  console.log("");
  console.log(
    `历史结构特征：train+validation ${train.length} 个提案，held-out ${held.length} 个`,
  );
  console.log("只用无视野好人车主。所有特征都只读公开日志。");

  const BASE = [0, 1];
  const ALL = Array.from({ length: NF }, (_, i) => i);

  const models: { name: string; active: number[] }[] = [
    { name: "只有自己上车（无风险项）", active: [1] },
    { name: "当前策略：风险 + 自己上车", active: BASE },
    { name: "加全部历史结构特征", active: ALL },
  ];

  console.log("");
  console.log("模型                        留出对数似然  排名分位  top-1   top-10");
  const fitted: Record<string, Float64Array> = {};
  for (const model of models) {
    const theta = fit(train, model.active);
    fitted[model.name] = theta;
    const ll = objective(held, theta, model.active, null);
    const r = ranking(held, theta, model.active);
    console.log(
      `${model.name.padEnd(26)}  ${ll.toFixed(4)}      ${r.rank.toFixed(4)}   ${r.top1.toFixed(3)}   ${r.top10.toFixed(3)}`,
    );
  }

  for (const name of ["当前策略：风险 + 自己上车", "加全部历史结构特征"]) {
    const theta = fitted[name];
    const row = (f: number) =>
      Array.from({ length: ROUNDS }, (_, r) => theta[paramIndex(f, r + 1)].toFixed(3));
    console.log("");
    console.log(`${name} 的系数，可粘贴：`);
    console.log(`  risk: [${row(0).join(", ")}],`);
    console.log(`  ride: [${row(1).join(", ")}],`);
    if (name.startsWith("加")) {
      const hist = Array.from({ length: NF - PER_ROUND }, (_, k) =>
        theta[paramIndex(k + PER_ROUND, 1)].toFixed(3),
      );
      console.log(`  history: [${hist.join(", ")}],`);
    }
  }

  // Which features actually carry the improvement: drop one at a time.
  console.log("");
  console.log("逐个剔除（相对全模型的留出对数似然损失，越大越重要）");
  const full = objective(held, fitted["加全部历史结构特征"], ALL, null);
  const drops: { name: string; loss: number; coef: number }[] = [];
  for (let f = 2; f < NF; f += 1) {
    const active = ALL.filter((k) => k !== f);
    const theta = fit(train, active);
    const ll = objective(held, theta, active, null);
    drops.push({
      name: FEATURES[f],
      loss: full - ll,
      coef: fitted["加全部历史结构特征"][paramIndex(f, 1)],
    });
  }
  drops.sort((a, b) => b.loss - a.loss);
  for (const d of drops) {
    console.log(
      `  ${d.name.padEnd(22)} 损失 ${d.loss >= 0 ? "+" : ""}${d.loss.toFixed(4)}   系数 ${d.coef.toFixed(3)}`,
    );
  }

  console.log("");
  console.log("全模型系数");
  for (let f = 0; f < NF; f += 1) {
    const theta = fitted["加全部历史结构特征"];
    if (f < PER_ROUND) {
      const perRound = Array.from({ length: ROUNDS }, (_, r) =>
        theta[paramIndex(f, r + 1)].toFixed(2),
      ).join(", ");
      console.log(`  ${FEATURES[f].padEnd(22)} 按轮 [${perRound}]`);
    } else {
      console.log(`  ${FEATURES[f].padEnd(22)} ${theta[paramIndex(f, 1)].toFixed(3)}`);
    }
  }
}, 3_600_000);
