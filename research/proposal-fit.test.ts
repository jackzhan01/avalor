import { it } from "vitest";
import {
  createFilter,
  updateOnMission,
  updateOnProposal,
  updateOnVotes,
} from "@/lib/decision/particle-filter";
import {
  legalTeams,
  leaderView,
  teamRisk,
  type ProposalParams,
} from "@/lib/decision/proposal";
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
 * Fit the team-level proposal policy to real leaders.
 *
 * The targets are PUBLIC statistics of the choice — where the chosen team sits
 * among all legal teams by posterior risk, how often the leader rides, how
 * often he takes a seat the table already suspects. Nothing here fits to who
 * was actually evil, so the loading trajectory the simulator produces
 * afterwards stays a prediction rather than a restatement of the target.
 *
 * The one exception is the evil leader's gain term, which is fitted to how
 * often real evil leaders actually took a teammate — that is a fact about
 * their behaviour, measurable only with the ground truth, and it plays the
 * same role as PROPOSAL_LOADING already does in the frozen likelihood.
 *
 * Train + validation only.
 */

const EVIL_ROLES = ["morgana", "mordred", "oberon", "assassin", "minion"];

interface Snapshot {
  round: number;
  evilLeader: boolean;
  /** loyal | merlin | percival | evil — for splitting the fit, never an input. */
  role: string;
  teams: readonly number[];
  /** Joint P(enough evils aboard to fail), under the leader's own view. */
  riskLeader: number[];
  /** The same, under the public view — what an evil leader has to manage. */
  riskPublic: number[];
  leaderBit: number;
  mateMask: number;
  /** Exact Belief V1 expected evils aboard, per legal team, for measurement. */
  expected: number[];
  /** The same, under the leader's own restricted posterior. */
  expectedPrivate: number[];
  realMask: number;
  realExpected: number;
  realRides: boolean;
  /** Real teammates aboard, over chance. Evil leaders only. */
  realMates: number;
  chanceMates: number;
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

function collect(games: ReturnType<typeof corpusSplit>): Snapshot[] {
  const shots: Snapshot[] = [];

  for (const { game: g, events, truth } of games) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const evilTotal = evilCount(count);
    const worlds = priorWorlds(g, 400);
    if (!worlds.length) continue;
    const filter = createFilter(worlds, seats);
    const rng = makeRng(8081);
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);
    const teamOf = new Map<string, { team: string[]; round: number }>();
    let successes = 0;
    let fails = 0;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const round = Math.min(Math.max(event.missionNumber, 1), 5);

      if (event.type === "proposal") {
        const size = teamSize(count, round as 1 | 2 | 3 | 4 | 5);
        teamOf.set(event.id, { team: event.teamPlayerIds, round });

        if (event.teamPlayerIds.length === size) {
          const view = publicView(events.slice(0, i) as GameEvent[], g);
          const side = deriveSideInference(view.events as GameEvent[], view.game);
          if (!side.contradictory && side.surviving.length) {
            const weights = weighHypotheses(
              side.surviving,
              view.events as GameEvent[],
              view.game,
            );
            const teams = legalTeams(n, size);
            const leader = event.leaderId;
            const li = seats.indexOf(leader);
            const evilLeader = EVIL_ROLES.includes(truth.byPlayer.get(leader) ?? "");
            const who = info.get(leader);

            // Exact expected evils per legal team, for the percentile measure,
            // both as the table sees it and as this leader does.
            const role = truth.byPlayer.get(leader) ?? "loyal";
            const live: number[] = [];
            let liveTotal = 0;
            for (let h = 0; h < side.surviving.length; h += 1) {
              const hyp = side.surviving[h];
              let ok = hyp.isEvil(leader) === evilLeader;
              if (ok && who) {
                for (const s2 of who.visibleEvil) {
                  if (!hyp.isEvil(s2)) { ok = false; break; }
                }
                if (ok) {
                  for (const s2 of who.knownEvil) {
                    if (!hyp.isEvil(s2)) { ok = false; break; }
                  }
                }
                if (ok && who.pair) {
                  ok = who.pair.filter((id) => hyp.isEvil(id)).length === 1;
                }
              }
              const w = ok ? weights[h] : 0;
              live.push(w);
              liveTotal += w;
            }
            const expected = new Array<number>(teams.length).fill(0);
            const expectedPrivate = new Array<number>(teams.length).fill(0);
            for (let h = 0; h < side.surviving.length; h += 1) {
              const w = weights[h];
              const q = liveTotal > 0 ? live[h] / liveTotal : 0;
              if (w <= 0 && q <= 0) continue;
              let mask = 0;
              for (let s = 0; s < n; s += 1) {
                if (side.surviving[h].isEvil(seats[s])) mask |= 1 << s;
              }
              for (let t = 0; t < teams.length; t += 1) {
                let bits = teams[t] & mask;
                let k = 0;
                while (bits) {
                  bits &= bits - 1;
                  k += 1;
                }
                expected[t] += w * k;
                expectedPrivate[t] += q * k;
              }
            }

            let realMask = 0;
            for (const seat of event.teamPlayerIds) {
              const s = seats.indexOf(seat);
              if (s >= 0) realMask |= 1 << s;
            }
            const realIndex = teams.indexOf(realMask);

            let mateMask = 0;
            if (evilLeader && who) {
              for (const mate of who.knownEvil) {
                const s = seats.indexOf(mate);
                if (s >= 0) mateMask |= 1 << s;
              }
            }
            let realMates = 0;
            for (const seat of event.teamPlayerIds) {
              if (seat !== leader && who?.knownEvil.has(seat)) realMates += 1;
            }

            if (realIndex >= 0) {
              const need = 1;
              const mine = leaderView(filter, seats, evilLeader ? undefined : who);
              const pub = leaderView(filter, seats, undefined);
              shots.push({
                round,
                evilLeader,
                role,
                teams,
                riskLeader: teamRisk(mine, teams, need),
                riskPublic: teamRisk(pub, teams, need),
                leaderBit: li >= 0 ? 1 << li : 0,
                mateMask,
                expected,
                expectedPrivate,
                realMask,
                realExpected: expected[realIndex],
                realRides: event.teamPlayerIds.includes(leader),
                realMates,
                chanceMates:
                  ((size - 1) * Math.max(0, (who?.knownEvil.size ?? 0))) /
                  Math.max(1, n - 1),
              });
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
      }
      void evilTotal;
    }
  }

  return shots;
}

/** Softmax over legal teams, then the statistics the fit is scored on. */
function simulate(
  shot: Snapshot,
  beta: number,
  gamma: number,
  gain: number,
  rng: () => number,
  publicWeight = 0,
): {
  expected: number;
  expectedPrivate: number;
  rides: boolean;
  mates: number;
  mask: number;
} {
  const risk = shot.evilLeader ? shot.riskPublic : shot.riskLeader;
  const utility = new Array<number>(shot.teams.length);
  let best = -Infinity;
  for (let t = 0; t < shot.teams.length; t += 1) {
    let u = -beta * risk[t] + (shot.teams[t] & shot.leaderBit ? gamma : 0);
    if (publicWeight) u -= publicWeight * shot.riskPublic[t];
    if (gain) {
      let bits = shot.teams[t] & shot.mateMask;
      let k = 0;
      while (bits) {
        bits &= bits - 1;
        k += 1;
      }
      u += gain * k;
    }
    utility[t] = u;
    if (u > best) best = u;
  }
  let total = 0;
  for (let t = 0; t < shot.teams.length; t += 1) {
    utility[t] = Math.exp(utility[t] - best);
    total += utility[t];
  }
  let target = rng() * total;
  let pick = shot.teams.length - 1;
  for (let t = 0; t < shot.teams.length; t += 1) {
    target -= utility[t];
    if (target <= 0) {
      pick = t;
      break;
    }
  }
  let bits = shot.teams[pick] & shot.mateMask;
  let mates = 0;
  while (bits) {
    bits &= bits - 1;
    mates += 1;
  }
  return {
    expected: shot.expected[pick],
    expectedPrivate: shot.expectedPrivate[pick],
    rides: (shot.teams[pick] & shot.leaderBit) !== 0,
    mates,
    mask: shot.teams[pick],
  };
}

/** Mean percentile of a team's risk among all legal teams. */
function percentileOf(shot: Snapshot, value: number): number {
  return midRank(shot.expected, value);
}

/**
 * Mid-rank, not strictly-below.
 *
 * Before the first vote every legal team carries exactly the same risk, so a
 * strictly-below count reports 0 for all of them and the statistic collapses
 * — which left round one unidentified and let the fit wander onto a beta that
 * reproduced the percentile and got the loading badly wrong. Counting half of
 * each tie is the standard repair and applies to real and simulated alike.
 */
function midRank(values: readonly number[], value: number): number {
  let below = 0;
  let equal = 0;
  for (const e of values) {
    if (e < value - 1e-12) below += 1;
    else if (e <= value + 1e-12) equal += 1;
  }
  return (below + equal / 2) / values.length;
}

/** The same, ordered by what the leader himself can see. */
function privatePercentileOf(shot: Snapshot, value: number): number {
  return midRank(shot.expectedPrivate, value);
}

it("fits the team-level proposal policy on train and validation", () => {
  const games = [
    ...corpusSplit("train", { limit: 260 }),
    ...corpusSplit("validation", { limit: 260 }),
  ];
  const shots = collect(games);
  console.log("");
  console.log(`提案拟合：train+validation ${games.length} 局，${shots.length} 个提案快照`);

  const fitted: Record<
    "goodRisk" | "evilRisk" | "evilGain" | "ride" | "rideEvil" | "merlinRisk" | "merlinPublic",
    number[]
  > = {
    goodRisk: [],
    evilRisk: [],
    evilGain: [],
    ride: [],
    rideEvil: [],
    merlinRisk: [],
    merlinPublic: [],
  };

  for (const side of ["good", "evil"] as const) {
    const wantEvil = side === "evil";
    console.log("");
    console.log(
      side === "good" ? "好人车主" : "坏人车主",
      "— 目标 = 真实分位 / 真实自己上车率" + (wantEvil ? " / 真实带队友" : ""),
    );
    console.log("轮次    β      γ      η      分位 真实→模拟    上车 真实→模拟   带队友 真实→模拟   样本");

    for (let r = 1; r <= 5; r += 1) {
      const rows = shots.filter(
        (s) => s.round === r && s.evilLeader === wantEvil && s.role !== "merlin",
      );
      if (!rows.length) {
        (wantEvil ? fitted.evilRisk : fitted.goodRisk).push(6);
        (wantEvil ? fitted.rideEvil : fitted.ride).push(4);
        if (wantEvil) fitted.evilGain.push(0.5);
        continue;
      }

      const realPct =
        rows.reduce((a, s) => a + percentileOf(s, s.realExpected), 0) / rows.length;
      const realRide = rows.filter((s) => s.realRides).length / rows.length;
      const realMate =
        rows.reduce((a, s) => a + s.realMates, 0) /
        Math.max(1e-9, rows.reduce((a, s) => a + s.chanceMates, 0));

      const score = (beta: number, gamma: number, gain: number) => {
        const rng = makeRng(555 + r);
        let pct = 0;
        let ride = 0;
        let mates = 0;
        let chance = 0;
        for (const s of rows) {
          const got = simulate(s, beta, gamma, gain, rng);
          pct += percentileOf(s, got.expected);
          if (got.rides) ride += 1;
          mates += got.mates;
          chance += s.chanceMates;
        }
        return {
          pct: pct / rows.length,
          ride: ride / rows.length,
          mate: chance > 0 ? mates / chance : 0,
        };
      };

      // Coordinate search. Each target moves monotonically in its own
      // parameter, so a bisection per coordinate converges in a few passes.
      let beta = 6;
      let gamma = 4;
      let gain = wantEvil ? 0.5 : 0;
      for (let pass = 0; pass < 6; pass += 1) {
        let lo = 0;
        let hi = 90;
        for (let step = 0; step < 24; step += 1) {
          const mid = (lo + hi) / 2;
          if (score(mid, gamma, gain).pct > realPct) lo = mid;
          else hi = mid;
        }
        beta = (lo + hi) / 2;

        lo = -2;
        hi = 20;
        for (let step = 0; step < 22; step += 1) {
          const mid = (lo + hi) / 2;
          if (score(beta, mid, gain).ride < realRide) lo = mid;
          else hi = mid;
        }
        gamma = (lo + hi) / 2;

        if (wantEvil) {
          // Real evil leaders take a teammate LESS often than a policy that
          // only minimises public risk stumbles into, so this has to be free
          // to go negative — they are hiding, not stacking.
          lo = -6;
          hi = 6;
          for (let step = 0; step < 24; step += 1) {
            const mid = (lo + hi) / 2;
            if (score(beta, gamma, mid).mate < realMate) lo = mid;
            else hi = mid;
          }
          gain = (lo + hi) / 2;
        }
      }

      const got = score(beta, gamma, gain);
      (wantEvil ? fitted.evilRisk : fitted.goodRisk).push(
        Number(beta.toFixed(2)),
      );
      (wantEvil ? fitted.rideEvil : fitted.ride).push(Number(gamma.toFixed(2)));
      if (wantEvil) fitted.evilGain.push(Number(gain.toFixed(2)));

      console.log(
        `第${r}轮  ${beta.toFixed(2).padStart(6)} ${gamma.toFixed(2).padStart(6)} ${gain.toFixed(2).padStart(6)}   ` +
          `${realPct.toFixed(3)}→${got.pct.toFixed(3)}    ${realRide.toFixed(3)}→${got.ride.toFixed(3)}   ` +
          `${realMate.toFixed(3)}→${got.mate.toFixed(3)}      ${rows.length}`,
      );
    }
  }

  console.log("");
  console.log("梅林 — 目标 = 真实私有分位 / 真实公开分位");
  console.log("轮次    β^M     λ      私有 真实→模拟    公开 真实→模拟   样本");
  for (let r = 1; r <= 5; r += 1) {
    const rows = shots.filter((s) => s.round === r && s.role === "merlin");
    if (rows.length < 20) {
      fitted.merlinRisk.push(fitted.goodRisk[r - 1] ?? 10);
      fitted.merlinPublic.push(0);
      continue;
    }
    const realPriv =
      rows.reduce((a, s) => a + privatePercentileOf(s, s.expectedPrivate[
        s.teams.indexOf(s.realMask)
      ] ?? 0), 0) / rows.length;
    const realPub =
      rows.reduce((a, s) => a + percentileOf(s, s.realExpected), 0) / rows.length;
    const gamma = fitted.ride[r - 1] ?? 1;

    const score = (beta: number, publicWeight: number) => {
      const rng = makeRng(909 + r);
      let priv = 0;
      let pub = 0;
      for (const s of rows) {
        const got = simulate(s, beta, gamma, 0, rng, publicWeight);
        priv += privatePercentileOf(s, got.expectedPrivate);
        pub += percentileOf(s, got.expected);
      }
      return { priv: priv / rows.length, pub: pub / rows.length };
    };

    // Both coefficients push their own percentile down, and each one raises
    // the other's, so the coordinate search has to alternate until it settles.
    let beta = fitted.goodRisk[r - 1] ?? 10;
    let publicWeight = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      let lo = 0;
      let hi = 150;
      for (let step = 0; step < 24; step += 1) {
        const mid = (lo + hi) / 2;
        if (score(mid, publicWeight).priv > realPriv) lo = mid;
        else hi = mid;
      }
      beta = (lo + hi) / 2;
      lo = 0;
      hi = 150;
      for (let step = 0; step < 24; step += 1) {
        const mid = (lo + hi) / 2;
        if (score(beta, mid).pub > realPub) lo = mid;
        else hi = mid;
      }
      publicWeight = (lo + hi) / 2;
    }
    const got = score(beta, publicWeight);
    fitted.merlinRisk.push(Number(beta.toFixed(2)));
    fitted.merlinPublic.push(Number(publicWeight.toFixed(2)));
    console.log(
      `第${r}轮  ${beta.toFixed(2).padStart(6)} ${publicWeight.toFixed(2).padStart(6)}   ` +
        `${realPriv.toFixed(3)}→${got.priv.toFixed(3)}    ${realPub.toFixed(3)}→${got.pub.toFixed(3)}     ${rows.length}`,
    );
  }

  console.log("");
  console.log("拟合结果，粘进 DEFAULT_PROPOSAL：");
  console.log(`  goodRisk: [${fitted.goodRisk.join(", ")}],`);
  console.log(`  evilRisk: [${fitted.evilRisk.join(", ")}],`);
  console.log(`  evilGain: [${fitted.evilGain.join(", ")}],`);
  console.log(`  ride: [${fitted.ride.join(", ")}],`);
  console.log(`  rideEvil: [${fitted.rideEvil.join(", ")}],`);
  console.log(`  merlinRisk: [${fitted.merlinRisk.join(", ")}],`);
  console.log(`  merlinPublic: [${fitted.merlinPublic.join(", ")}],`);
}, 3_600_000);
