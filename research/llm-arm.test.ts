import { it } from "vitest";
import { renderBrief, seatBrief } from "@/lib/decision/brief";
import {
  createFilter,
  marginals,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
} from "@/lib/decision/particle-filter";
import { approveProbability } from "@/lib/decision/policy";
import { chooseTeam, legalTeams, leaderView } from "@/lib/decision/proposal";
import { informationSets } from "@/lib/decision/rollout";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { evilCount, requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { askJson, llmAvailable, modelName, reportUsage } from "./llm-client";
import { corpusSplit } from "./splits";

/**
 * The language arm, structured only.
 *
 * It reads the same seat brief the math arm's information set is built from —
 * public log plus that seat's own legitimate sight, and nothing else. No
 * synthetic cue, no ground truth, and no inference block: handing it the
 * engine's own deductions would make it a hybrid wearing this arm's name.
 *
 * Both arms are scored at the SAME decision points from the same held-out real
 * games, so nothing here depends on either of them simulating well.
 *
 * Two calls per sampled proposal. The leader is asked who is evil and which
 * car he would put up; an off-team seat is asked who is evil and whether they
 * would approve. Answers are cached on disk, so a rerun costs nothing.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

const SYSTEM = `你在玩线下《阿瓦隆》。你只知道下面简报里写的东西 —— 公开发生过的事，加上你自己身份带来的视野。你不知道任何人的真实身份，除非简报明确告诉了你。

规则要点：好人要让三个任务成功，坏人要让三个任务失败，或者连续五辆车被否。坏人在任务里可以出坏票；好人不能。第四轮在 7 人及以上需要两张坏票才算失败。

只输出 JSON，不要解释，不要 markdown 代码块。字段：
{
  "evil": {"1": 0.0-1.0, "2": ..., ...},   // 每个座位号是坏人的概率，你自己的座位也要给
  "vote": "approve" | "reject",             // 只在问你投票时给
  "team": [座位号, ...]                      // 只在问你点车时给，人数必须正好
}
"evil" 里所有座位的概率之和应当接近场上坏人总数。`;

interface Point {
  playerCount: number;
  round: number;
  /** The seat being asked, and what it truly was. */
  seat: string;
  seatRole: RoleType;
  brief: string;
  seats: string[];
  evilTruth: Set<string>;
  /** Public-information posterior the math arm would use, restricted to sight. */
  mathEvil: Map<string, number>;
  kind: "leader" | "voter";
  /** For a voter: what they actually did. For a leader: the car he put up. */
  realApprove?: boolean;
  mathApprove?: number;
  realTeam?: string[];
  mathTeam?: string[];
  size?: number;
  /** True evils per seat, for scoring a proposed car. */
  chance?: number;
}

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

/** Sample decision points, stratified by table size and by early versus late. */
function collectPoints(perCell: number): Point[] {
  const points: Point[] = [];
  const filled = new Map<string, number>();
  const rng = makeRng(515);

  for (const { game: g, events, truth } of corpusSplit("test", { limit: 900 })) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const evilTruth = new Set(
      seats.filter((s) => EVIL_ROLES.includes(truth.byPlayer.get(s) ?? "")),
    );
    const teamOf = new Map<string, { team: string[]; round: number }>();
    let successes = 0;
    let fails = 0;
    // Which car of this round it is. The attempt number is the strongest
    // single driver of a real vote — the hammer passes 98% of the time — so
    // handing the math arm a constant 1 would be scoring a crippled version
    // of it. The model sees it too: the brief says "第 1 轮第 2 车".
    let attempt = 1;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;

      if (event.type === "proposal") {
        teamOf.set(event.id, { team: event.teamPlayerIds, round });
        const size = teamSize(count, round);
        const phase = round <= 2 ? "早" : round >= 4 ? "晚" : "中";
        const cell = `${count}-${phase}`;

        if (
          event.teamPlayerIds.length === size &&
          phase !== "中" &&
          (filled.get(cell) ?? 0) < perCell
        ) {
          filled.set(cell, (filled.get(cell) ?? 0) + 1);
          const prefix = events.slice(0, i) as GameEvent[];
          const leader = event.leaderId;
          const leaderInfo = info.get(leader);
          const teams = legalTeams(n, size);

          if (leaderInfo) {
            const mine = leaderView(filter, seats, leaderInfo);
            const evil = new Map<string, number>();
            for (const seat of seats) evil.set(seat, 0);
            for (const [mask, w] of mine) {
              for (let s = 0; s < n; s += 1) {
                if (mask & (1 << s)) evil.set(seats[s], (evil.get(seats[s]) ?? 0) + w);
              }
            }
            points.push({
              playerCount: n,
              round,
              seat: leader,
              seatRole: truth.byPlayer.get(leader) ?? "loyal",
              brief: renderBrief(
                seatBrief(g, prefix, leaderInfo, {
                  legalTeams: [teams.length ? seats.slice(0, size) : []],
                }),
              ),
              seats,
              evilTruth,
              mathEvil: evil,
              kind: "leader",
              realTeam: event.teamPlayerIds,
              mathTeam: chooseTeam(
                seats,
                size,
                1,
                leader,
                leaderInfo,
                filter,
                round,
                rng,
              ),
              size,
              chance: (size * evilCount(count)) / n,
            });

            // And one off-team voter at the same instant.
            const off = seats.filter((s) => !event.teamPlayerIds.includes(s));
            const voter = off[Math.floor(rng() * off.length) % Math.max(1, off.length)];
            const voterInfo = voter ? info.get(voter) : undefined;
            const vote = events[i + 1];
            if (voterInfo && vote?.type === "vote") {
              const choice = vote.votes[voter];
              if (choice === "approve" || choice === "reject") {
                const theirs = leaderView(filter, seats, voterInfo);
                const evilV = new Map<string, number>();
                for (const seat of seats) evilV.set(seat, 0);
                for (const [mask, w] of theirs) {
                  for (let s = 0; s < n; s += 1) {
                    if (mask & (1 << s)) {
                      evilV.set(seats[s], (evilV.get(seats[s]) ?? 0) + w);
                    }
                  }
                }
                const read = event.teamPlayerIds.reduce(
                  (sum, s) => sum + (evilV.get(s) ?? 0),
                  0,
                );
                points.push({
                  playerCount: n,
                  round,
                  seat: voter,
                  seatRole: truth.byPlayer.get(voter) ?? "loyal",
                  brief: renderBrief(
                    seatBrief(g, prefix.concat(event), voterInfo, {
                      proposedTeam: event.teamPlayerIds,
                    }),
                  ),
                  seats,
                  evilTruth,
                  mathEvil: evilV,
                  kind: "voter",
                  realApprove: choice === "approve",
                  mathApprove: approveProbability(
                    voterInfo,
                    event.teamPlayerIds,
                    read,
                    attempt,
                  ),
                });
              }
            }
          }
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
          attempt = event.finalResult === "rejected" ? attempt + 1 : 1;
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
        attempt = 1;
      }
    }
  }

  return points;
}

const clip = (p: number) => Math.min(0.999, Math.max(0.001, p));

interface Score {
  brier: number;
  logLoss: number;
  seats: number;
  topHit: number;
  topTotal: number;
  voteRight: number;
  voteLog: number;
  votes: number;
  load: number;
  loadChance: number;
  teams: number;
  parsed: number;
  asked: number;
}

const empty = (): Score => ({
  brier: 0,
  logLoss: 0,
  seats: 0,
  topHit: 0,
  topTotal: 0,
  voteRight: 0,
  voteLog: 0,
  votes: 0,
  load: 0,
  loadChance: 0,
  teams: 0,
  parsed: 0,
  asked: 0,
});

function scoreFaction(score: Score, point: Point, evil: Map<string, number>): void {
  for (const seat of point.seats) {
    const p = clip(evil.get(seat) ?? 0);
    const y = point.evilTruth.has(seat) ? 1 : 0;
    score.brier += (p - y) ** 2;
    score.logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    score.seats += 1;
  }
  const k = point.evilTruth.size;
  const top = [...point.seats]
    .sort((a, b) => (evil.get(b) ?? 0) - (evil.get(a) ?? 0))
    .slice(0, k);
  for (const seat of top) if (point.evilTruth.has(seat)) score.topHit += 1;
  score.topTotal += k;
}

function line(label: string, s: Score): string {
  const rate = (a: number, b: number) => (b ? (a / b).toFixed(3) : "  —  ");
  return (
    `${label.padEnd(20)} ${rate(s.brier, s.seats)}   ${rate(s.logLoss, s.seats)}   ` +
    `${rate(s.topHit, s.topTotal)}   ${rate(s.voteRight, s.votes)}   ${rate(s.voteLog, s.votes)}   ` +
    `${s.loadChance ? (s.load / s.loadChance).toFixed(3) : "  —  "}   ${s.parsed}/${s.asked}`
  );
}

it("scores the structured LLM arm against the math arm", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过 LLM 臂");
    return;
  }

  const perCell = Number(process.env.LLM_PER_CELL ?? 8);
  const points = collectPoints(perCell);
  console.log("");
  console.log(`LLM 结构臂：模型 ${modelName()}，${points.length} 个决策点`);
  console.log("输入与数学臂完全一致：公开日志 + 该座位自己的视野，无社会线索、无真身份、无排除法结论");

  const math = { all: empty(), byCount: new Map<number, Score>(), byPhase: new Map<string, Score>() };
  const llm = { all: empty(), byCount: new Map<number, Score>(), byPhase: new Map<string, Score>() };
  const bucket = (
    arm: typeof math,
    point: Point,
  ): Score[] => {
    const phase = point.round <= 2 ? "早（1-2 轮）" : "晚（4-5 轮）";
    if (!arm.byCount.has(point.playerCount)) arm.byCount.set(point.playerCount, empty());
    if (!arm.byPhase.has(phase)) arm.byPhase.set(phase, empty());
    return [arm.all, arm.byCount.get(point.playerCount)!, arm.byPhase.get(phase)!];
  };

  for (const point of points) {
    const seatNumber = (id: string) => point.seats.indexOf(id) + 1;

    for (const target of bucket(math, point)) {
      target.asked += 1;
      target.parsed += 1;
      scoreFaction(target, point, point.mathEvil);
      if (point.kind === "voter" && point.mathApprove != null) {
        const p = clip(point.mathApprove);
        const y = point.realApprove ? 1 : 0;
        if ((p >= 0.5) === Boolean(y)) target.voteRight += 1;
        target.voteLog += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
        target.votes += 1;
      }
      if (point.kind === "leader" && point.mathTeam) {
        for (const seat of point.mathTeam) if (point.evilTruth.has(seat)) target.load += 1;
        target.loadChance += point.chance ?? 0;
        target.teams += 1;
      }
    }

    const answer = await askJson(SYSTEM, point.brief);
    const targets = bucket(llm, point);
    for (const target of targets) target.asked += 1;
    if (!answer || typeof answer.evil !== "object" || answer.evil === null) continue;

    const raw = answer.evil as Record<string, unknown>;
    const evil = new Map<string, number>();
    let total = 0;
    for (const seat of point.seats) {
      const value = Number(raw[String(seatNumber(seat))]);
      const p = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      evil.set(seat, p);
      total += p;
    }
    // Rescaled to the number of evils the rules put here — the same constraint
    // the math arm satisfies by construction. Without it the two are not being
    // asked the same question.
    const want = point.evilTruth.size;
    if (total > 0) {
      for (const seat of point.seats) {
        evil.set(seat, Math.min(0.999, ((evil.get(seat) ?? 0) * want) / total));
      }
    }

    for (const target of targets) {
      target.parsed += 1;
      scoreFaction(target, point, evil);
    }

    if (point.kind === "voter" && point.realApprove != null) {
      const said = answer.vote === "approve";
      for (const target of targets) {
        if (said === point.realApprove) target.voteRight += 1;
        // A hard choice scored as a probability, clipped: the model was not
        // asked for a number and pretending otherwise would flatter it.
        target.voteLog += -Math.log(said === point.realApprove ? 0.9 : 0.1);
        target.votes += 1;
      }
    }

    if (point.kind === "leader" && Array.isArray(answer.team) && point.size) {
      const picked = (answer.team as unknown[])
        .map((v) => point.seats[Number(v) - 1])
        .filter((s): s is string => Boolean(s));
      const unique = [...new Set(picked)];
      if (unique.length === point.size) {
        for (const target of targets) {
          for (const seat of unique) if (point.evilTruth.has(seat)) target.load += 1;
          target.loadChance += point.chance ?? 0;
          target.teams += 1;
        }
      }
    }
  }

  const header =
    "                     阵营Brier 阵营logloss 前k命中 投票一致 投票logloss 载荷/随机 可解析";
  console.log("");
  console.log("总计");
  console.log(header);
  console.log(line("数学（粒子后验）", math.all));
  console.log(line("LLM（结构臂）", llm.all));

  console.log("");
  console.log("按人数");
  console.log(header);
  for (const count of [7, 8, 9, 10]) {
    const m = math.byCount.get(count);
    const l = llm.byCount.get(count);
    if (m) console.log(line(`数学 ${count} 人`, m));
    if (l) console.log(line(`LLM  ${count} 人`, l));
  }

  console.log("");
  console.log("早轮 vs 晚轮");
  console.log(header);
  for (const phase of ["早（1-2 轮）", "晚（4-5 轮）"]) {
    const m = math.byPhase.get(phase);
    const l = llm.byPhase.get(phase);
    if (m) console.log(line(`数学 ${phase}`, m));
    if (l) console.log(line(`LLM  ${phase}`, l));
  }

  console.log("");
  reportUsage();
}, 3_600_000);
