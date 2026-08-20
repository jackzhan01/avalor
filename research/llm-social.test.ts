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
import { applySocial } from "@/lib/decision/social-update";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { EvilOdds, type SocialEvidence } from "@/lib/social";
import { requiredFails } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { askJson, llmAvailable, modelName, reportUsage } from "./llm-client";
import { corpusSplit } from "./splits";

/**
 * Is the model's table talk worth listening to?
 *
 * The synthetic sweep gave the number this has to clear. A stance-truth
 * correlation near 0.40 closes most of the structured-information gap; below
 * roughly 0.3 the channel is worse than silence, because when the good players
 * are guessing the only seats with signal are the ones lying. So the question
 * for a language channel is not "does it help" but "which side of that line
 * does it land on".
 *
 * The corpus has no dialogue — checked, zero games carry a chat field — so
 * there is no human transcript to extract from and that arm cannot be run on
 * this data. What CAN be measured, and is what the research question actually
 * asks, is the signal a model GENERATES: give each seat its own brief, ask what
 * it thinks of the others, and measure the correlation of the answer with the
 * truth it was never told.
 *
 * Stances come back through the same SocialEvidence schema the synthetic
 * channel uses and are absorbed the same way — as a likelihood over worlds,
 * never as an override of the posterior.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

const SYSTEM = `你在玩线下《阿瓦隆》。你只知道简报里写的东西 —— 公开发生过的事，加上你自己身份带来的视野。

现在是自由发言环节。请给出你对场上每一个其他座位的当前态度。像真人一样：好人应当尽力找出坏人；坏人应当保护自己的队友、把火力引向好人，同时别做得太明显。

只输出 JSON，不要解释，不要 markdown 代码块：
{"stances": [{"seat": 座位号, "valence": -1.0到1.0, "confidence": 0.0到1.0}, ...]}

valence：-1 = 强踩（我认为他是坏人），0 = 看不清，+1 = 强保（我认为他是好人）。
confidence：你对这个判断本身有多确定。
每一个其他座位都要给，不要给自己。`;

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

/** Pearson correlation, which is the same unit the synthetic q is defined in. */
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

interface Moment {
  game: GameRecord;
  prefix: GameEvent[];
  round: number;
  seats: string[];
  evilTruth: Set<string>;
  info: ReadonlyMap<string, ReturnType<typeof informationSets> extends Map<string, infer V> ? V : never>;
  filter: ParticleFilter;
  sequence: number;
}

/** Replay a game with the frozen filter, snapshotting after missions 1 and 3. */
function moments(limit: number): Moment[] {
  const out: Moment[] = [];

  for (const { game: g, events, truth } of corpusSplit("test", { limit: 400 })) {
    if (out.length >= limit * 2) break;
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const rng = makeRng(313);
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const evilTruth = new Set(
      seats.filter((s) => EVIL_ROLES.includes(truth.byPlayer.get(s) ?? "")),
    );
    const teamOf = new Map<string, { team: string[]; round: number }>();
    let successes = 0;
    let fails = 0;
    let missions = 0;
    const taken: Moment[] = [];

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
          taken.push({
            game: g,
            prefix: events.slice(0, i + 1) as GameEvent[],
            round: missions,
            seats,
            evilTruth,
            info,
            // A copy, so later replay does not mutate what the moment captured.
            filter: {
              worlds: filter.worlds,
              evil: [...filter.evil],
              weights: [...filter.weights],
              seats,
            },
            sequence: event.sequence,
          });
        }
      }
    }
    out.push(...taken);
  }

  return out;
}

const clip = (p: number) => Math.min(0.999, Math.max(0.001, p));

it("measures the signal quality of model-generated table talk", async () => {
  if (!llmAvailable()) {
    console.log("没有 OPENAI_API_KEY，跳过");
    return;
  }
  const limit = Number(process.env.LLM_SOCIAL_GAMES ?? 6);
  const picked = moments(limit);

  console.log("");
  console.log(`LLM 社会证据臂：模型 ${modelName()}，${picked.length} 个时刻`);
  console.log("语料无对话文本，所以测的是模型自己产生的表态，走同一套 SocialEvidence schema");

  // valence against truth-sign, split by the speaker's real side.
  const good = { v: [] as number[], t: [] as number[] };
  const evil = { v: [] as number[], t: [] as number[] };
  const byRound = new Map<number, { v: number[]; t: number[] }>();
  let stances = 0;
  let refused = 0;

  // What absorbing the talk does to the public read.
  let brierBefore = 0;
  let brierAfter = 0;
  let seatsScored = 0;

  for (const moment of picked) {
    const evidence: SocialEvidence[] = [];
    const seatNumber = (id: string) => moment.seats.indexOf(id) + 1;

    for (const speaker of moment.seats) {
      const who = moment.info.get(speaker);
      if (!who) continue;
      const brief = renderBrief(
        seatBrief(moment.game, moment.prefix, who, { upTo: moment.sequence }),
      );
      const answer = await askJson(SYSTEM, brief);
      const rows = answer?.stances;
      if (!Array.isArray(rows)) {
        refused += 1;
        continue;
      }
      const speakerEvil = moment.evilTruth.has(speaker);

      for (const row of rows as Record<string, unknown>[]) {
        const target = moment.seats[Number(row.seat) - 1];
        if (!target || target === speaker) continue;
        const valence = Math.min(1, Math.max(-1, Number(row.valence)));
        if (!Number.isFinite(valence)) continue;
        const confidence = Math.min(
          1,
          Math.max(0, Number(row.confidence ?? 0.5)),
        );
        // +1 when the target really is good, -1 when evil: the direction an
        // accurate stance points, and the same convention the sweep used.
        const truth = moment.evilTruth.has(target) ? -1 : 1;

        (speakerEvil ? evil : good).v.push(valence);
        (speakerEvil ? evil : good).t.push(truth);
        if (!speakerEvil) {
          if (!byRound.has(moment.round)) byRound.set(moment.round, { v: [], t: [] });
          const cell = byRound.get(moment.round)!;
          cell.v.push(valence);
          cell.t.push(truth);
        }
        stances += 1;

        evidence.push({
          sequence: moment.sequence + evidence.length + 1,
          missionNumber: moment.round,
          speakerId: speaker,
          targetId: target,
          valence,
          confidence,
          source: "dialogue",
          audience: null,
        });
      }
      void seatNumber;
    }

    // Absorb it exactly as the simulator would, and see what it buys.
    const before = marginals(moment.filter);
    const odds = new EvilOdds();
    const credibility = new Map<string, number>();
    for (const seat of moment.seats) {
      credibility.set(seat, Math.max(0, 1 - (before.get(seat) ?? 0)));
    }
    odds.absorb(evidence, moment.round, credibility);
    applySocial(moment.filter, odds.snapshot());
    const after = marginals(moment.filter);

    for (const seat of moment.seats) {
      const y = moment.evilTruth.has(seat) ? 1 : 0;
      brierBefore += (clip(before.get(seat) ?? 0) - y) ** 2;
      brierAfter += (clip(after.get(seat) ?? 0) - y) ** 2;
      seatsScored += 1;
    }
  }

  const q = correlation(good.v, good.t);
  const d = -correlation(evil.v, evil.t);

  console.log("");
  console.log(`表态总数 ${stances}，拒答/格式坏 ${refused} 次`);
  console.log("");
  console.log("和合成扫描同一单位（表态与真相的相关性）");
  console.log(`  好人说话的 q      ${q.toFixed(3)}      合成扫描里 q≈0.40 关闭缺口，q≲0.30 反而不如沉默`);
  console.log(`  坏人的欺骗强度    ${d.toFixed(3)}      合成扫描默认 0.60`);
  for (const round of [1, 3]) {
    const cell = byRound.get(round);
    if (cell && cell.v.length > 2) {
      console.log(
        `  第 ${round} 个任务后的 q  ${correlation(cell.v, cell.t).toFixed(3)}   （${cell.v.length} 条）`,
      );
    }
  }

  console.log("");
  console.log("吸收进粒子云之后的公开读数");
  console.log(
    `  阵营 Brier  ${(brierBefore / seatsScored).toFixed(4)} → ${(brierAfter / seatsScored).toFixed(4)}`,
  );

  console.log("");
  reportUsage("LLM 社会臂");
}, 3_600_000);
