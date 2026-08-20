import { it } from "vitest";
import {
  createFilter,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
} from "@/lib/decision/particle-filter";
import { chooseTeam } from "@/lib/decision/proposal";
import { informationSets } from "@/lib/decision/rollout";
import { publicView } from "@/lib/decision/public-view";
import { makeRng, sampleAssignments, type Assignment } from "@/lib/decision/sampler";
import { deriveSideInference } from "@/lib/inference";
import { weighHypotheses } from "@/lib/inference/soft";
import { evilCount, requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * Who does a leader actually put on his car, given what the table knows?
 *
 * The simulator's bias sat in team selection: its good leaders started as
 * clean as real ones and never improved, while real ones cut their evil
 * loading from 0.90 of chance to 0.41 across five rounds. This measures the
 * real behaviour and the policy's behaviour on THE SAME INPUTS — same table,
 * same round, same public posterior — so any gap is the chooser and not the
 * simulator's dynamics.
 *
 * Held-out games. The policy was fitted on train and validation.
 *
 * True roles appear only to split the report by the leader's side and to build
 * his legitimate information set. Nothing in the policy path reads them.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (start: number) => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

interface Row {
  picked: [number, number, number];
  offered: [number, number, number];
  loadObserved: number;
  loadExpected: number;
  percentile: number;
  rides: number;
  proposals: number;
}

const emptyRow = (): Row => ({
  picked: [0, 0, 0],
  offered: [0, 0, 0],
  loadObserved: 0,
  loadExpected: 0,
  percentile: 0,
  rides: 0,
  proposals: 0,
});

const emptyRows = () => Array.from({ length: 5 }, emptyRow);

/** Low / medium / high, cut relative to what a blind pick would give. */
function bucketOf(risk: number, base: number): 0 | 1 | 2 {
  if (risk < base * 0.85) return 0;
  if (risk < base * 1.15) return 1;
  return 2;
}

function record(
  row: Row,
  seats: readonly string[],
  team: readonly string[],
  leader: string,
  risk: ReadonlyMap<string, number>,
  base: number,
  teamEvil: (t: readonly string[]) => number,
  alternatives: readonly number[],
  chance: number,
): void {
  row.proposals += 1;
  if (team.includes(leader)) row.rides += 1;
  for (const seat of seats) {
    if (seat === leader) continue;
    const b = bucketOf(risk.get(seat) ?? 0, base);
    row.offered[b] += 1;
    if (team.includes(seat)) row.picked[b] += 1;
  }
  const chosen = teamEvil(team);
  row.loadObserved += chosen;
  row.loadExpected += chance;
  let below = 0;
  let equal = 0;
  for (const alt of alternatives) {
    if (alt < chosen - 1e-12) below += 1;
    else if (alt <= chosen + 1e-12) equal += 1;
  }
  // Mid-rank: before the first vote every legal team ties exactly, and a
  // strictly-below count would report zero for all of them.
  row.percentile += (below + equal / 2) / Math.max(1, alternatives.length);
}

function report(title: string, rows: Row[]): void {
  console.log("");
  console.log(title);
  console.log("轮次   低危选中  中危选中  高危选中   载荷/随机   在全部合法车中的分位  自己上车  样本");
  rows.forEach((r, i) => {
    if (!r.proposals) return;
    const rate = (a: number, b: number) => (b ? (a / b).toFixed(3) : "  —  ");
    console.log(
      `第${i + 1}轮   ${rate(r.picked[0], r.offered[0])}     ${rate(r.picked[1], r.offered[1])}     ${rate(r.picked[2], r.offered[2])}      ${(r.loadObserved / r.loadExpected).toFixed(3)}        ${(r.percentile / r.proposals).toFixed(3)}            ${(r.rides / r.proposals).toFixed(3)}    ${r.proposals}`,
    );
  });
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

it("audits real and simulated team selection on matched inputs", () => {
  const games = corpusSplit("test", { limit: 400 });

  const real = { good: emptyRows(), evil: emptyRows() };
  const sim = { good: emptyRows(), evil: emptyRows() };

  for (const { game: g, events, truth } of games) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const base = evilCount(count) / n;
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const rng = makeRng(31337);
    const teamOf = new Map<string, { team: string[]; round: number }>();
    let successes = 0;
    let fails = 0;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;

      if (event.type === "proposal") {
        teamOf.set(event.id, { team: event.teamPlayerIds, round });
        const size = teamSize(count, round);

        if (event.teamPlayerIds.length === size) {
          const view = publicView(events.slice(0, i) as GameEvent[], g);
          const side = deriveSideInference(view.events as GameEvent[], view.game);
          if (!side.contradictory && side.surviving.length) {
            const weights = weighHypotheses(
              side.surviving,
              view.events as GameEvent[],
              view.game,
            );
            // Joint, not per-seat: E[#evil aboard] over weighted worlds.
            const teamEvil = (team: readonly string[]) => {
              let total = 0;
              for (let h = 0; h < side.surviving.length; h += 1) {
                const w = weights[h];
                if (w <= 0) continue;
                let aboard = 0;
                for (const seat of team) {
                  if (side.surviving[h].isEvil(seat)) aboard += 1;
                }
                total += w * aboard;
              }
              return total;
            };
            const alternatives = combinations(n, size).map((idx) =>
              teamEvil(idx.map((j) => seats[j])),
            );
            const chance = size * base;
            const leader = event.leaderId;
            const bucket = EVIL_ROLES.includes(truth.byPlayer.get(leader) ?? "")
              ? "evil"
              : "good";

            record(
              real[bucket][round - 1],
              seats,
              event.teamPlayerIds,
              leader,
              side.evilProbability,
              base,
              teamEvil,
              alternatives,
              chance,
            );

            const picked = chooseTeam(
              seats,
              size,
              requiredFails(count, round),
              leader,
              info.get(leader),
              filter,
              round,
              rng,
            );
            record(
              sim[bucket][round - 1],
              seats,
              picked,
              leader,
              side.evilProbability,
              base,
              teamEvil,
              alternatives,
              chance,
            );
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

  console.log("");
  console.log(`提案行为审计：held-out ${games.length} 局，输入完全匹配`);
  report("真实 · 好人车主", real.good);
  report("模拟 · 好人车主（团队级选择模型）", sim.good);
  report("真实 · 坏人车主", real.evil);
  report("模拟 · 坏人车主（团队级选择模型）", sim.evil);
}, 3_600_000);
