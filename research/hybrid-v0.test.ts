import { it } from "vitest";
import { renderBrief, seatBrief } from "@/lib/decision/brief";
import {
  createFilter,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
  type ParticleFilter,
} from "@/lib/decision/particle-filter";
import {
  DEFAULT_PROPOSAL,
  legalTeams,
  leaderView,
  teamRisk,
} from "@/lib/decision/proposal";
import { informationSets, evaluateActions } from "@/lib/decision/rollout";
import { buildDecisionState } from "@/lib/decision/state";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { publicView } from "@/lib/decision/public-view";
import { evilCount, requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { askJson, llmAvailable, modelName, reportUsage } from "./llm-client";
import { corpusSplit } from "./splits";

/**
 * Hybrid V0: the model proposes, the mathematics disposes.
 *
 * The structured arm said plainly what a language model is bad at here — asked
 * to pick a car outright it lands at 1.149 of chance loading, worse than
 * drawing names from a hat. That is a scoring failure, not necessarily a
 * generation failure, and the two are worth separating: a proposer only has to
 * put the right team SOMEWHERE in a short list, and something else can rank it.
 *
 * So the question is candidate recall. Over every legal team, ranked by the
 * frozen team utility, how often does the model's shortlist contain the best
 * one, or something near it? If recall is high the hybrid is worth building
 * even though the model cannot rank; if it is at chance the model is not
 * seeing anything the search would miss.
 *
 * Two evaluators, because they cost different amounts. The frozen utility runs
 * exhaustively over all legal teams at every point. The rollout Q engine —
 * which had to be taught to consume a propose action at all, it never did —
 * runs on a subset over a shortlist, to check the cheap ranking agrees with
 * the expensive one.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

const SYSTEM = `你在玩线下《阿瓦隆》，轮到你点车。你只知道简报里写的东西 —— 公开发生过的事，加上你自己身份带来的视野。

不要只给一个方案。给出 5 套你认为值得考虑的不同人选，按你自己的偏好从好到差排列。每套人数必须正好等于要求的人数，可以包含你自己。五套之间要有实际差别，不要只换一个人。

只输出 JSON，不要解释，不要 markdown 代码块：
{"candidates": [[座位号, ...], [座位号, ...], [座位号, ...], [座位号, ...], [座位号, ...]]}`;

const PRIOR = new Map<string, Assignment[]>();

function priorWorlds(game: GameRecord, count: number): Assignment[] {
  const key = `${game.playerCount}|${[...(game.roleSet?.rolesIncluded ?? [])].sort().join(",")}`;
  const seats = game.players.map((p) => p.id);
  let cached = PRIOR.get(key);
  if (!cached) {
    cached = sampleAssignments([], game, count, makeRng(20250820));
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

interface Point {
  game: GameRecord;
  prefix: GameEvent[];
  seats: string[];
  leader: string;
  round: number;
  size: number;
  brief: string;
  teams: readonly number[];
  /** Frozen utility per legal team, higher is better. Exhaustive. */
  utility: number[];
  evilMask: number;
  chance: number;
  filterSnapshot: ParticleFilter;
}

function collect(perCell: number): Point[] {
  const points: Point[] = [];
  const filled = new Map<string, number>();
  const rng = makeRng(818);

  for (const { game: g, events, truth } of corpusSplit("test", { limit: 700 })) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const teamOf = new Map<string, { team: string[]; round: number }>();
    let evilMask = 0;
    seats.forEach((seat, i) => {
      if (EVIL_ROLES.includes(truth.byPlayer.get(seat) ?? "")) evilMask |= 1 << i;
    });
    let successes = 0;
    let fails = 0;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;

      if (event.type === "proposal") {
        teamOf.set(event.id, { team: event.teamPlayerIds, round });
        const size = teamSize(count, round);
        const leader = event.leaderId;
        const who = info.get(leader);
        const cell = `${count}-${round <= 2 ? "早" : "晚"}`;

        if (
          who &&
          who.side === "good" &&
          who.role !== "merlin" &&
          event.teamPlayerIds.length === size &&
          round !== 3 &&
          (filled.get(cell) ?? 0) < perCell
        ) {
          filled.set(cell, (filled.get(cell) ?? 0) + 1);
          const teams = legalTeams(n, size);
          const risk = teamRisk(leaderView(filter, seats, who), teams, 1);
          const li = seats.indexOf(leader);
          const leaderBit = li >= 0 ? 1 << li : 0;
          const r = round - 1;
          const beta = DEFAULT_PROPOSAL.goodRisk[r];
          const gamma = DEFAULT_PROPOSAL.ride[r];
          const utility = teams.map(
            (t, k) => -beta * risk[k] + (t & leaderBit ? gamma : 0),
          );

          points.push({
            game: g,
            prefix: events.slice(0, i) as GameEvent[],
            seats,
            leader,
            round,
            size,
            brief: renderBrief(
              seatBrief(g, events.slice(0, i) as GameEvent[], who, {
                legalTeams: [seats.slice(0, size)],
              }),
            ),
            teams,
            utility,
            evilMask,
            chance: (size * evilCount(count)) / n,
            filterSnapshot: {
              worlds: filter.worlds,
              evil: [...filter.evil],
              weights: [...filter.weights],
              seats,
            },
          });
        }

        updateOnProposal(filter, event.leaderId, event.teamPlayerIds, round, n, rng);
      } else if (event.type === "vote") {
        const src = teamOf.get(event.proposalId);
        if (src) {
          const cast = new Map<string, boolean>();
          for (const [seat, choice] of Object.entries(event.votes)) {
            if (choice === "approve") cast.set(seat, true);
            else if (choice === "reject") cast.set(seat, false);
          }
          updateOnVotes(filter, src.team, cast, src.round, rng);
        }
      } else if (event.type === "mission") {
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
        if (event.result === "success") successes += 1;
        else if (event.result === "fail") fails += 1;
      }
    }
  }

  return points;
}

it("asks whether the model can at least name the right car", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const perCell = Number(process.env.HYBRID_PER_CELL ?? 15);
  const points = collect(perCell);
  console.log("");
  console.log(`Hybrid V0：模型 ${modelName()}，${points.length} 个点车决策`);
  console.log("只取无视野的好人车主，输入与数学臂完全一致");

  let asked = 0;
  let parsed = 0;
  let candidates = 0;
  let recall1 = 0;
  let recallTop1pct = 0;
  let recallTop5pct = 0;
  let chanceTop1pct = 0;
  let chanceTop5pct = 0;
  /** True evil loading of each strategy's chosen car. */
  const load = { math: 0, hybrid: 0, llm: 0, real: 0, chance: 0 };
  /** Where each strategy's car sits in the exhaustive utility ranking. */
  const rank = { hybrid: 0, llm: 0, n: 0 };
  const qCheck: { hybridBest: number; mathBest: number; llmFirst: number; n: number } = {
    hybridBest: 0,
    mathBest: 0,
    llmFirst: 0,
    n: 0,
  };
  const qBudget = Number(process.env.HYBRID_Q_POINTS ?? 20);

  for (const point of points) {
    asked += 1;
    const order = point.utility
      .map((u, k) => ({ u, k }))
      .sort((a, b) => b.u - a.u);
    const rankOf = new Map(order.map((entry, place) => [entry.k, place]));
    const total = order.length;
    const top1 = Math.max(1, Math.ceil(total * 0.01));
    const top5 = Math.max(1, Math.ceil(total * 0.05));

    const evilsIn = (mask: number) => popcount(mask & point.evilMask);
    load.math += evilsIn(point.teams[order[0].k]);
    load.chance += point.chance;

    const answer = await askJson(SYSTEM, point.brief);
    const raw = Array.isArray(answer?.candidates) ? answer.candidates : null;
    if (!raw) continue;

    const indices: number[] = [];
    for (const row of raw as unknown[]) {
      if (!Array.isArray(row)) continue;
      const ids = [
        ...new Set(
          (row as unknown[])
            .map((v) => Number(v) - 1)
            .filter((s) => Number.isInteger(s) && s >= 0 && s < point.seats.length),
        ),
      ];
      if (ids.length !== point.size) continue;
      let mask = 0;
      for (const s of ids) mask |= 1 << s;
      const k = point.teams.indexOf(mask);
      if (k >= 0 && !indices.includes(k)) indices.push(k);
    }
    if (!indices.length) continue;
    parsed += 1;
    candidates += indices.length;

    const places = indices.map((k) => rankOf.get(k) ?? total);
    const best = Math.min(...places);
    if (best === 0) recall1 += 1;
    if (best < top1) recallTop1pct += 1;
    if (best < top5) recallTop5pct += 1;
    // What a shortlist of the same size drawn blind would have managed.
    const m = indices.length;
    chanceTop1pct += 1 - Math.pow(1 - top1 / total, m);
    chanceTop5pct += 1 - Math.pow(1 - top5 / total, m);

    const hybridK = indices.reduce((a, b) =>
      point.utility[a] >= point.utility[b] ? a : b,
    );
    const llmK = indices[0];
    load.hybrid += evilsIn(point.teams[hybridK]);
    load.llm += evilsIn(point.teams[llmK]);
    rank.hybrid += 1 - (rankOf.get(hybridK) ?? total) / total;
    rank.llm += 1 - (rankOf.get(llmK) ?? total) / total;
    rank.n += 1;

    // The expensive check, on a subset: does the rollout agree with the cheap
    // ranking about which of these cars is worth putting up?
    if (qCheck.n < qBudget) {
      const asLeader: GameRecord = {
        ...point.game,
        viewerPlayerId: point.leader,
        viewerRole: "loyal",
      };
      const state = buildDecisionState(point.prefix, asLeader);
      if (state.viewerSide === "good") {
        const teamOfIndex = (k: number) =>
          point.seats.filter((_, s) => point.teams[k] & (1 << s));
        const values = evaluateActions(
          state,
          [
            { kind: "propose", team: teamOfIndex(order[0].k) },
            { kind: "propose", team: teamOfIndex(hybridK) },
            { kind: "propose", team: teamOfIndex(llmK) },
          ],
          { worlds: 200, seed: 4242 },
        );
        if (values.length === 3) {
          qCheck.mathBest += values[0].q;
          qCheck.hybridBest += values[1].q;
          qCheck.llmFirst += values[2].q;
          qCheck.n += 1;
        }
      }
    }
  }

  const rate = (a: number, b: number) => (b ? (a / b).toFixed(3) : "  —  ");
  console.log("");
  console.log(`可解析 ${parsed}/${asked}，平均每次给出 ${rate(candidates, parsed)} 套合法且互异的方案`);
  console.log("");
  console.log("候选召回：模型的短名单里有没有数学最优/接近最优的那辆车");
  console.log(`  命中第 1 名        ${rate(recall1, parsed)}`);
  console.log(`  命中前 1%          ${rate(recallTop1pct, parsed)}   同样长度的盲选 ${rate(chanceTop1pct, parsed)}`);
  console.log(`  命中前 5%          ${rate(recallTop5pct, parsed)}   同样长度的盲选 ${rate(chanceTop5pct, parsed)}`);

  console.log("");
  console.log("三种策略选出的车（真实坏人载荷 / 随机；越低越好）");
  console.log(`  穷举数学最优      ${rate(load.math, load.chance)}`);
  console.log(`  混合（模型出候选，数学挑）  ${rate(load.hybrid, load.chance)}`);
  console.log(`  纯模型（它排第一的那套）    ${rate(load.llm, load.chance)}`);

  console.log("");
  console.log("所选车在穷举效用排序中的分位（1 = 最优）");
  console.log(`  混合  ${rate(rank.hybrid, rank.n)}     纯模型  ${rate(rank.llm, rank.n)}`);

  if (qCheck.n) {
    console.log("");
    console.log(`rollout Q 抽查（${qCheck.n} 个点，每点 200 个世界）`);
    console.log(
      `  数学最优 ${(qCheck.mathBest / qCheck.n).toFixed(4)}   混合 ${(qCheck.hybridBest / qCheck.n).toFixed(4)}   纯模型 ${(qCheck.llmFirst / qCheck.n).toFixed(4)}`,
    );
    console.log("  Q 的绝对标定尚未通过验收，这里只用它做同点位的相对排序检查。");
  }

  console.log("");
  reportUsage("Hybrid V0");
}, 3_600_000);
