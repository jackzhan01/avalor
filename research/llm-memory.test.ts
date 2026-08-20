import { it } from "vitest";
import { renderBrief, seatBrief } from "@/lib/decision/brief";
import {
  createFilter,
  marginals,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
  type ParticleFilter,
} from "@/lib/decision/particle-filter";
import { informationSets } from "@/lib/decision/rollout";
import { leaderView } from "@/lib/decision/proposal";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { requiredFails } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { askJson, llmAvailable, modelName, reportUsage } from "./llm-client";
import { corpusSplit } from "./splits";

/**
 * Why does the model not get better as a game goes on?
 *
 * The structured arm sharpens almost not at all across a game — faction Brier
 * 0.179 early to 0.185 late, where the mathematics goes 0.131 to 0.108 — and
 * its table talk shows the same flatness, q 0.300 after the first quest and
 * 0.327 after the third. Something is not accumulating.
 *
 * Three candidate explanations, one arm each:
 *
 *   implicit    it is handed the whole log and expected to re-derive
 *               everything each time. If this is the problem, it is a
 *               reasoning-depth limit and prompting will not fix it.
 *   carried     it writes down its own read after the first quest and is
 *               handed that back later. If this closes the gap, the model can
 *               reason but cannot re-reason a long log from scratch.
 *   assisted    it is handed the frozen posterior as a starting point. This is
 *               no longer a pure language arm and is here as a ceiling: it
 *               says what is left for language to add once the arithmetic is
 *               done for it.
 *
 * The same seat is asked at the same two moments in all three arms, so the
 * only thing that varies is what it carries in.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

const BASE = `你在玩线下《阿瓦隆》。你只知道简报里写的东西 —— 公开发生过的事，加上你自己身份带来的视野。

只输出 JSON，不要解释，不要 markdown 代码块：
{"evil": {"1": 0.0-1.0, "2": ..., ...}, "notes": "一两句话，记下你现在的判断和理由，之后你还会看到它"}
"evil" 要给场上每一个座位（包括你自己），所有概率之和应当接近场上坏人总数。`;

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

interface Snap {
  prefix: GameEvent[];
  sequence: number;
  missions: number;
  read: Map<string, number>;
}

interface Case {
  game: GameRecord;
  seats: string[];
  seat: string;
  info: ReturnType<typeof informationSets> extends Map<string, infer V> ? V : never;
  evilTruth: Set<string>;
  early: Snap;
  late: Snap;
}

/** Replay, and snapshot the same seat after the first and third quests. */
function cases(limit: number): Case[] {
  const out: Case[] = [];
  const rng = makeRng(606);

  for (const { game: g, events, truth } of corpusSplit("test", { limit: 500 })) {
    if (out.length >= limit) break;
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
    // An uninformed good seat: nothing private to lean on, so the whole
    // question is whether it accumulates the public game.
    const seat = seats.find(
      (s) => !evilTruth.has(s) && truth.byPlayer.get(s) === "loyal",
    );
    if (!seat) continue;
    const who = info.get(seat);
    if (!who) continue;

    const teamOf = new Map<string, { team: string[]; round: number }>();
    let successes = 0;
    let fails = 0;
    let missions = 0;
    const snaps: Snap[] = [];

    const readNow = (f: ParticleFilter) => {
      const view = leaderView(f, seats, who);
      const read = new Map<string, number>();
      for (const s of seats) read.set(s, 0);
      for (const [mask, w] of view) {
        for (let s = 0; s < n; s += 1) {
          if (mask & (1 << s)) read.set(seats[s], (read.get(seats[s]) ?? 0) + w);
        }
      }
      return read;
    };

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5);

      if (event.type === "proposal") {
        updateOnProposal(filter, event.leaderId, event.teamPlayerIds, round, n, rng);
        teamOf.set(event.id, { team: event.teamPlayerIds, round });
      } else if (event.type === "vote") {
        const src = teamOf.get(event.proposalId);
        if (src) {
          const cast = new Map<string, boolean>();
          for (const [s, choice] of Object.entries(event.votes)) {
            if (choice === "approve") cast.set(s, true);
            else if (choice === "reject") cast.set(s, false);
          }
          updateOnVotes(filter, src.team, cast, src.round, rng);
        }
      } else if (event.type === "mission") {
        if (event.teamPlayerIds && event.failCount != null) {
          updateOnMission(
            filter,
            event.teamPlayerIds,
            event.failCount,
            requiredFails(count, round as 1 | 2 | 3 | 4 | 5),
            successes,
            fails,
            rng,
          );
        }
        if (event.result === "success") successes += 1;
        else if (event.result === "fail") fails += 1;
        missions += 1;
        if (missions === 1 || missions === 3) {
          snaps.push({
            prefix: events.slice(0, i + 1) as GameEvent[],
            sequence: event.sequence,
            missions,
            read: readNow(filter),
          });
        }
      }
    }

    if (snaps.length === 2) {
      out.push({ game: g, seats, seat, info: who, evilTruth, early: snaps[0], late: snaps[1] });
    }
  }

  return out;
}

const clip = (p: number) => Math.min(0.999, Math.max(0.001, p));

function scoreRead(
  evilTruth: Set<string>,
  seats: string[],
  read: Map<string, number>,
): { brier: number; log: number; hit: number; k: number } {
  let brier = 0;
  let log = 0;
  for (const seat of seats) {
    const p = clip(read.get(seat) ?? 0);
    const y = evilTruth.has(seat) ? 1 : 0;
    brier += (p - y) ** 2;
    log += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const k = evilTruth.size;
  const top = [...seats].sort((a, b) => (read.get(b) ?? 0) - (read.get(a) ?? 0)).slice(0, k);
  let hit = 0;
  for (const s of top) if (evilTruth.has(s)) hit += 1;
  return { brier: brier / seats.length, log: log / seats.length, hit, k };
}

/** Read the model's answer, rescaled to the evil count the rules impose. */
function readOf(
  answer: Record<string, unknown> | null,
  seats: string[],
  want: number,
): Map<string, number> | null {
  if (!answer || typeof answer.evil !== "object" || answer.evil === null) return null;
  const raw = answer.evil as Record<string, unknown>;
  const read = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < seats.length; i += 1) {
    const v = Number(raw[String(i + 1)]);
    const p = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    read.set(seats[i], p);
    total += p;
  }
  if (total > 0) {
    for (const s of seats) read.set(s, Math.min(0.999, ((read.get(s) ?? 0) * want) / total));
  }
  return read;
}

it("asks what the model needs in order to accumulate a game", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const limit = Number(process.env.MEMORY_GAMES ?? 30);
  const picked = cases(limit);
  console.log("");
  console.log(`记忆消融：模型 ${modelName()}，${picked.length} 局，同一个无视野好人座位`);

  const arms = ["隐式（只有日志）", "自带笔记", "数学后验辅助"] as const;
  const totals = new Map<string, { early: ReturnType<typeof scoreRead>[]; late: ReturnType<typeof scoreRead>[] }>();
  const math = { early: [] as ReturnType<typeof scoreRead>[], late: [] as ReturnType<typeof scoreRead>[] };
  for (const arm of arms) totals.set(arm, { early: [], late: [] });

  const seatLine = (seats: string[], read: Map<string, number>) =>
    seats
      .map((s, i) => `${i + 1}号 ${(read.get(s) ?? 0).toFixed(2)}`)
      .join("，");

  for (const one of picked) {
    const want = one.evilTruth.size;
    math.early.push(scoreRead(one.evilTruth, one.seats, one.early.read));
    math.late.push(scoreRead(one.evilTruth, one.seats, one.late.read));

    const briefAt = (snap: Snap) =>
      renderBrief(seatBrief(one.game, snap.prefix, one.info, { upTo: snap.sequence }));

    // 1. Implicit: the log, twice, independently.
    for (const [snap, bucket] of [
      [one.early, "early"],
      [one.late, "late"],
    ] as const) {
      const read = readOf(await askJson(BASE, briefAt(snap)), one.seats, want);
      if (read) totals.get(arms[0])![bucket].push(scoreRead(one.evilTruth, one.seats, read));
    }

    // 2. Carried: its own note from the first quest comes back at the third.
    const firstAnswer = await askJson(BASE, briefAt(one.early));
    const firstRead = readOf(firstAnswer, one.seats, want);
    if (firstRead) totals.get(arms[1])!.early.push(scoreRead(one.evilTruth, one.seats, firstRead));
    const note = typeof firstAnswer?.notes === "string" ? firstAnswer.notes : "";
    const carried = `${briefAt(one.late)}

## 我在第 1 个任务之后写下的判断
${note || "（当时没记）"}
${firstRead ? `当时我给的坏人概率：${seatLine(one.seats, firstRead)}` : ""}`;
    const lateRead = readOf(await askJson(BASE, carried), one.seats, want);
    if (lateRead) totals.get(arms[1])!.late.push(scoreRead(one.evilTruth, one.seats, lateRead));

    // 3. Assisted: handed the frozen posterior. Not a language arm — a ceiling.
    for (const [snap, bucket] of [
      [one.early, "early"],
      [one.late, "late"],
    ] as const) {
      const assisted = `${briefAt(snap)}

## 一个纯逻辑的排除法引擎给出的当前概率（它只看得到公开信息，没有我的视野）
${seatLine(one.seats, snap.read)}`;
      const read = readOf(await askJson(BASE, assisted), one.seats, want);
      if (read) totals.get(arms[2])![bucket].push(scoreRead(one.evilTruth, one.seats, read));
    }
  }

  const mean = (rows: ReturnType<typeof scoreRead>[], pick: (r: ReturnType<typeof scoreRead>) => number) =>
    rows.length ? rows.reduce((a, r) => a + pick(r), 0) / rows.length : NaN;
  const hitRate = (rows: ReturnType<typeof scoreRead>[]) => {
    let hit = 0;
    let k = 0;
    for (const r of rows) {
      hit += r.hit;
      k += r.k;
    }
    return k ? hit / k : NaN;
  };

  const row = (label: string, early: ReturnType<typeof scoreRead>[], late: ReturnType<typeof scoreRead>[]) => {
    const be = mean(early, (r) => r.brier);
    const bl = mean(late, (r) => r.brier);
    console.log(
      `${label.padEnd(18)} ${be.toFixed(4)} → ${bl.toFixed(4)}  ${(bl - be >= 0 ? "+" : "")}${(bl - be).toFixed(4)}   ` +
        `${hitRate(early).toFixed(3)} → ${hitRate(late).toFixed(3)}   ${early.length}/${late.length}`,
    );
  };

  console.log("");
  console.log("阵营 Brier 第1个任务后 → 第3个任务后（负的变化 = 学到了东西），以及前k命中");
  console.log("臂                 Brier 早→晚        变化      前k命中 早→晚   样本");
  row("数学（粒子）", math.early, math.late);
  for (const arm of arms) {
    const cell = totals.get(arm)!;
    row(arm, cell.early, cell.late);
  }

  console.log("");
  reportUsage("记忆消融");
}, 3_600_000);
