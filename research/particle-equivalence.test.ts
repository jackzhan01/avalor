import { it } from "vitest";
import {
  createFilter,
  marginals,
  roleMarginals,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
  type ParticleFilter,
} from "@/lib/decision/particle-filter";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { deriveSideInference } from "@/lib/inference";
import { computeRolesWith } from "@/lib/inference/roles";
import { evilCount, requiredFails } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * Is the particle filter the same engine as frozen Belief V1, or a different
 * one that happens to look similar?
 *
 * The rollout needs a read it can update event by event; the frozen engine
 * re-enumerates from scratch. Those agree only if the incremental factors are
 * literally the frozen factors — which is why particle-filter.ts imports them
 * rather than restating them, and why this file exists to check the claim on
 * real recorded games instead of on the argument alone.
 *
 * Belief V1 is the ORACLE here. Every gap is the filter's to explain.
 *
 * No social cue anywhere in this file. Belief V1 never heard the table talk,
 * so mixing it in would be comparing two different questions.
 */

const bits = (q: number) =>
  q <= 0 || q >= 1 ? 0 : -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

interface Arm {
  label: string;
  missions: boolean;
  votes: boolean;
  proposals: boolean;
}

const ARMS: Arm[] = [
  { label: "任务", missions: true, votes: false, proposals: false },
  { label: "任务+票", missions: true, votes: true, proposals: false },
  { label: "任务+票+车", missions: true, votes: true, proposals: true },
];

/**
 * The prior cloud, cached per table shape.
 *
 * Before anything happens the posterior depends only on how many seats there
 * are and which roles were dealt, so drawing it once per shape and relabelling
 * the seats is exact — and it saves enumerating 151,200 castings per game.
 */
const priorCache = new Map<string, Assignment[]>();

function priorWorlds(game: GameRecord, count: number): Assignment[] {
  const key = `${game.playerCount}|${[...(game.roleSet?.rolesIncluded ?? [])].sort().join(",")}|${count}`;
  const seats = game.players.map((p) => p.id);
  let cached = priorCache.get(key);
  if (!cached) {
    cached = sampleAssignments([], game, count, makeRng(20250817));
    priorCache.set(key, cached);
  }
  if (!cached.length) return [];
  // Cached under whatever seat ids the first game of this shape used. The
  // prior is exchangeable over seats, so relabelling by position is exact.
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

/**
 * Walk one real game, updating the filter on each structural event and handing
 * the caller the prefix and the cloud at that instant.
 */
function replay(
  events: GameEvent[],
  game: GameRecord,
  filter: ParticleFilter,
  arm: Arm,
  rng: () => number,
  at: (round: number, prefix: GameEvent[]) => void,
): void {
  const teamOf = new Map<string, { team: string[]; round: number }>();
  let successes = 0;
  let fails = 0;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const round = Math.min(Math.max(event.missionNumber, 1), 5);

    if (event.type === "proposal") {
      teamOf.set(event.id, { team: event.teamPlayerIds, round });
      if (arm.proposals) {
        updateOnProposal(
          filter,
          event.leaderId,
          event.teamPlayerIds,
          round,
          game.players.length,
          rng,
        );
      }
    } else if (event.type === "vote") {
      const src = teamOf.get(event.proposalId);
      if (arm.votes && src) {
        const cast = new Map<string, boolean>();
        for (const [seat, choice] of Object.entries(event.votes)) {
          // A recorded "unknown" is a non-observation, exactly as in the
          // frozen scorer: it must contribute nothing at all.
          if (choice === "approve") cast.set(seat, true);
          else if (choice === "reject") cast.set(seat, false);
        }
        updateOnVotes(filter, src.team, cast, src.round, rng);
      }
    } else if (event.type === "mission") {
      if (arm.missions && event.teamPlayerIds && event.failCount != null) {
        updateOnMission(
          filter,
          event.teamPlayerIds,
          event.failCount,
          requiredFails(game.playerCount as PlayerCount, round),
          successes,
          fails,
          rng,
        );
      }
    } else {
      continue;
    }

    at(round, events.slice(0, i + 1));

    if (event.type === "mission") {
      if (event.result === "success") successes += 1;
      else if (event.result === "fail") fails += 1;
    }
  }
}

/** How many of the oracle's k likeliest evils the filter also puts in its top k. */
function topKAgreement(
  seats: readonly string[],
  a: Map<string, number>,
  b: Map<string, number>,
  k: number,
): number {
  const top = (m: Map<string, number>) =>
    new Set(
      [...seats].sort((x, y) => (m.get(y) ?? 0) - (m.get(x) ?? 0)).slice(0, k),
    );
  const left = top(a);
  let hit = 0;
  for (const seat of top(b)) if (left.has(seat)) hit += 1;
  return hit / k;
}

interface Bucket {
  mae: number;
  seats: number;
  entParticle: number;
  entOracle: number;
  agree: number;
  checks: number;
}

const emptyBuckets = (): Bucket[] =>
  Array.from({ length: 5 }, () => ({
    mae: 0,
    seats: 0,
    entParticle: 0,
    entOracle: 0,
    agree: 0,
    checks: 0,
  }));

it("tracks frozen Belief V1 through a real game", () => {
  const games = corpusSplit("test", { limit: 140 });
  const PARTICLES = 500;

  console.log("");
  console.log("粒子滤波 vs 冻结 Belief V1 边层（同一批因子，逐事件对照）");
  console.log(`留出局 ${games.length} 局，粒子数 ${PARTICLES}`);

  for (const arm of ARMS) {
    const buckets = emptyBuckets();

    for (const { game: g, events } of games) {
      const view = publicView(events as GameEvent[], g);
      const worlds = priorWorlds(view.game, PARTICLES);
      if (!worlds.length) continue;
      const seats = view.game.players.map((p) => p.id);
      const filter = createFilter(worlds, seats);
      const rng = makeRng(991);
      const k = evilCount(view.game.playerCount as PlayerCount);

      replay(
        view.events as GameEvent[],
        view.game,
        filter,
        arm,
        rng,
        (round, prefix) => {
          const oracle = deriveSideInference(prefix, view.game);
          if (oracle.contradictory) return;
          const mine = marginals(filter);
          const bucket = buckets[round - 1];
          for (const seat of seats) {
            const p = mine.get(seat) ?? 0;
            const q = oracle.evilProbability.get(seat) ?? 0;
            bucket.mae += Math.abs(p - q);
            bucket.entParticle += bits(p);
            bucket.entOracle += bits(q);
            bucket.seats += 1;
          }
          bucket.agree += topKAgreement(seats, mine, oracle.evilProbability, k);
          bucket.checks += 1;
        },
      );
    }

    console.log("");
    console.log(`证据 = ${arm.label}`);
    console.log("轮次   阵营 MAE   粒子熵   真值熵   熵差      前k一致  检查点");
    buckets.forEach((b, r) => {
      if (!b.checks) return;
      const ep = b.entParticle / b.seats;
      const eo = b.entOracle / b.seats;
      const gap = ep - eo;
      console.log(
        `第${r + 1}轮   ${(b.mae / b.seats).toFixed(4)}     ${ep.toFixed(4)}   ${eo.toFixed(4)}   ${gap >= 0 ? "+" : ""}${gap.toFixed(4)}   ${(b.agree / b.checks).toFixed(3)}    ${b.checks}`,
      );
    });
  }
}, 3_600_000);

it("converges on the oracle as the cloud grows", () => {
  const games = corpusSplit("test", { limit: 60 });
  const arm = ARMS[2];

  console.log("");
  console.log("收敛性：粒子数 → 各轮阵营 MAE（证据 = 任务+票+车）");
  console.log("粒子数   第1轮     第2轮     第3轮     第4轮     第5轮");

  for (const n of [60, 120, 250, 500, 1000]) {
    const buckets = emptyBuckets();
    for (const { game: g, events } of games) {
      const view = publicView(events as GameEvent[], g);
      const worlds = priorWorlds(view.game, n);
      if (!worlds.length) continue;
      const seats = view.game.players.map((p) => p.id);
      const filter = createFilter(worlds, seats);
      const rng = makeRng(4242);
      replay(
        view.events as GameEvent[],
        view.game,
        filter,
        arm,
        rng,
        (round, prefix) => {
          const oracle = deriveSideInference(prefix, view.game);
          if (oracle.contradictory) return;
          const mine = marginals(filter);
          const bucket = buckets[round - 1];
          for (const seat of seats) {
            bucket.mae += Math.abs(
              (mine.get(seat) ?? 0) - (oracle.evilProbability.get(seat) ?? 0),
            );
            bucket.seats += 1;
          }
          bucket.checks += 1;
        },
      );
    }
    const cells = buckets
      .map((b) => (b.seats ? (b.mae / b.seats).toFixed(4) : "  —   "))
      .join("    ");
    console.log(`${String(n).padEnd(6)}   ${cells}`);
  }
}, 3_600_000);

it("reports what the role layer adds that the filter cannot", () => {
  const games = corpusSplit("test", { limit: 40 });
  const arm = ARMS[2];
  const PARTICLES = 500;

  // Faction gap against the CANONICAL posterior (role layer, lambda 0.4), and
  // how much of that same gap already sits between the two frozen layers —
  // that part is role evidence, which no faction-level filter can recover.
  const mine = emptyBuckets();
  const between = emptyBuckets();
  const roleMae = Array.from({ length: 5 }, () => ({ sum: 0, n: 0 }));

  for (const { game: g, events } of games) {
    const view = publicView(events as GameEvent[], g);
    const worlds = priorWorlds(view.game, PARTICLES);
    if (!worlds.length) continue;
    const seats = view.game.players.map((p) => p.id);
    const filter = createFilter(worlds, seats);
    const rng = makeRng(777);
    let lastRound = 0;

    replay(
      view.events as GameEvent[],
      view.game,
      filter,
      arm,
      rng,
      (round, prefix) => {
        // Round boundaries only — the role layer enumerates every casting.
        const last = prefix[prefix.length - 1];
        if (last.type !== "mission" || round === lastRound) return;
        lastRound = round;

        const side = deriveSideInference(prefix, view.game);
        if (side.contradictory) return;
        const roles = computeRolesWith(prefix, view.game);
        const read = marginals(filter);
        const rows = roleMarginals(filter);

        for (const seat of seats) {
          let canonical = 0;
          for (const [role, p] of roles.byPlayer.get(seat) ?? []) {
            if (EVIL_ROLES.includes(role)) canonical += p;
          }
          mine[round - 1].mae += Math.abs((read.get(seat) ?? 0) - canonical);
          between[round - 1].mae += Math.abs(
            (side.evilProbability.get(seat) ?? 0) - canonical,
          );
          mine[round - 1].seats += 1;
          between[round - 1].seats += 1;

          const truth = roles.byPlayer.get(seat);
          const guess = rows.get(seat);
          if (truth && guess) {
            for (const [role, p] of truth) {
              roleMae[round - 1].sum += Math.abs(p - (guess.get(role) ?? 0));
              roleMae[round - 1].n += 1;
            }
          }
        }
        mine[round - 1].checks += 1;
      },
    );
  }

  console.log("");
  console.log("完整冻结证据：粒子 vs 角色层（canonical，λ=0.4）");
  console.log("轮次   粒子 vs 角色层   边层 vs 角色层   角色边际 MAE   局数");
  mine.forEach((b, r) => {
    if (!b.checks) return;
    console.log(
      `第${r + 1}轮   ${(b.mae / b.seats).toFixed(4)}           ${(between[r].mae / between[r].seats).toFixed(4)}           ${(roleMae[r].sum / roleMae[r].n).toFixed(4)}         ${b.checks}`,
    );
  });
}, 3_600_000);
