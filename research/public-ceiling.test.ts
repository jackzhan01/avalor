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
import { evilCount, requiredFails, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, RoleType } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * How clean a car can an uninformed good leader build from the public log?
 *
 * Everything tried so far — the team-level softmax, the history features, the
 * separated Merlin — reproduces real leaders on public statistics and still
 * cannot reproduce their loading falling to 0.405 of chance by round five. If
 * the reason is that the public log simply does not contain enough to get
 * there, then no policy reading only the public log will ever get there, and
 * more features are wasted effort.
 *
 * So this measures the ceiling directly. For every real proposal by a good
 * leader who is not Merlin, take the legal team the frozen posterior says is
 * SAFEST — a leader who spends every bit of public information perfectly and
 * has no private sight beyond knowing his own side — and score it against the
 * ground truth. That is the best any public-information policy can do.
 *
 * If real leaders beat it, they are reading something the log does not record.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

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

interface Row {
  realEvil: number;
  oracleEvil: number;
  chance: number;
  realChance: number;
  oracleChance: number;
  proposals: number;
}

it("measures the best car the public log can build", () => {
  const games = corpusSplit("test", { limit: 500 });
  const rows: Row[] = Array.from({ length: 5 }, () => ({
    realEvil: 0,
    oracleEvil: 0,
    chance: 0,
    realChance: 0,
    oracleChance: 0,
    proposals: 0,
  }));
  const rng = makeRng(2718);

  for (const { game: g, events, truth } of games) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const base = evilCount(count) / n;
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const teamOf = new Map<string, { team: string[]; round: number }>();
    let successes = 0;
    let fails = 0;

    let evilMask = 0;
    seats.forEach((seat, i) => {
      if (EVIL_ROLES.includes(truth.byPlayer.get(seat) ?? "")) evilMask |= 1 << i;
    });

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;

      if (event.type === "proposal") {
        teamOf.set(event.id, { team: event.teamPlayerIds, round });
        const size = teamSize(count, round);
        const leader = event.leaderId;
        const role = truth.byPlayer.get(leader) ?? "loyal";

        if (
          event.teamPlayerIds.length === size &&
          !EVIL_ROLES.includes(role) &&
          role !== "merlin"
        ) {
          const teams = legalTeams(n, size);
          // The leader knows his own side and nothing else — the honest
          // information set of a loyal or Percival leader for this purpose.
          const risk = teamRisk(
            leaderView(filter, seats, info.get(leader)),
            teams,
            1,
          );
          let best = Infinity;
          let bestAt = 0;
          for (let t = 0; t < teams.length; t += 1) {
            if (risk[t] < best - 1e-12) {
              best = risk[t];
              bestAt = t;
            }
          }
          // Ties are common early; break them at random rather than by index,
          // which would quietly favour low seat numbers.
          const tied: number[] = [];
          for (let t = 0; t < teams.length; t += 1) {
            if (risk[t] <= best + 1e-12) tied.push(t);
          }
          bestAt = tied[Math.floor(rng() * tied.length) % tied.length];

          /*
           * Counted the way PROPOSAL_LOADING counts it, or the numbers are not
           * comparable to the 0.896 -> 0.405 target: only the seats the leader
           * ADDED, against a pool that excludes him. He is on his own car about
           * nine times in ten and he is good, so leaving him in both halves
           * dilutes every ratio toward zero.
           */
          const li = seats.indexOf(leader);
          const leaderBit = li >= 0 ? 1 << li : 0;
          const chanceEach = evilCount(count) / (n - 1);

          let realEvil = 0;
          let realAdded = 0;
          for (const seat of event.teamPlayerIds) {
            if (seat === leader) continue;
            realAdded += 1;
            if (EVIL_ROLES.includes(truth.byPlayer.get(seat) ?? "")) realEvil += 1;
          }
          const oracleMask = teams[bestAt] & ~leaderBit;
          let oracleEvil = 0;
          let oracleAdded = 0;
          for (let s = 0; s < n; s += 1) {
            if (!(oracleMask & (1 << s))) continue;
            oracleAdded += 1;
            if (evilMask & (1 << s)) oracleEvil += 1;
          }

          const row = rows[round - 1];
          row.proposals += 1;
          row.realEvil += realEvil;
          row.oracleEvil += oracleEvil;
          row.chance += ((realAdded + oracleAdded) / 2) * chanceEach;
          row.realChance += realAdded * chanceEach;
          row.oracleChance += oracleAdded * chanceEach;
        }

        updateOnProposal(filter, leader, event.teamPlayerIds, round, n, rng);
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
  console.log(`公开信息天花板：held-out ${games.length} 局，无视野好人车主`);
  console.log("载荷 = 车主额外加的人里的真坏人数 / 随机期望（与 PROPOSAL_LOADING 同口径）");
  console.log("");
  console.log("轮次   真人载荷   公开信息完美车主   语料目标   样本");
  const target = [0.896, 0.773, 0.63, 0.622, 0.405];
  rows.forEach((r, i) => {
    if (!r.proposals) return;
    console.log(
      `第${i + 1}轮   ${(r.realEvil / r.realChance).toFixed(3)}      ${(r.oracleEvil / r.oracleChance).toFixed(3)}              ${target[i].toFixed(3)}      ${r.proposals}`,
    );
  });
}, 3_600_000);
