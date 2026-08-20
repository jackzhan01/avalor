import { it } from "vitest";
import { informationSets } from "@/lib/decision/rollout";
import { publicView } from "@/lib/decision/public-view";
import { deriveSideInference } from "@/lib/inference";
import { weighHypotheses } from "@/lib/inference/soft";
import { evilCount, teamSize } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { PlayerCount, RoleType } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * Does Merlin use what he sees?
 *
 * The proposal policy reproduces real leaders on public statistics but its
 * loading trajectory plateaus where real leaders keep improving. The obvious
 * patch — a bigger beta for the roles with sight — assumes they are simply
 * risk-minimising harder. They may be doing the opposite: a Merlin who never
 * once puts a seat he can see on his car has told the assassin exactly who he
 * is, so some of his apparent sloppiness may be deliberate.
 *
 * This distinguishes the two. For each leader it measures where his chosen
 * team sits among all legal teams under TWO orderings: the public posterior,
 * which everyone shares, and his own posterior restricted to what he can see.
 * A loyal leader has nothing extra, so the two agree for him and he is the
 * control. If Merlin sits near zero on the public ordering but well above zero
 * on his private one, he is declining to use his sight.
 *
 * True roles split the report and build the information sets. Nothing is fit
 * here — this is a measurement.
 */

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
  publicPct: number;
  privatePct: number;
  /** Seats the leader can SEE are evil, aboard his own car. */
  seenAboard: number;
  /** What a blind pick of the same size would have given. */
  seenChance: number;
  /** Cars where he had a legal team with none of them and took one anyway. */
  avoidable: number;
  tookAnyway: number;
  proposals: number;
}

const emptyRow = (): Row => ({
  publicPct: 0,
  privatePct: 0,
  seenAboard: 0,
  seenChance: 0,
  avoidable: 0,
  tookAnyway: 0,
  proposals: 0,
});

const emptyRows = () => Array.from({ length: 5 }, emptyRow);

it("measures whether sighted leaders spend what they know", () => {
  const games = corpusSplit("test", { limit: 500 });
  const rows: Record<string, Row[]> = {
    loyal: emptyRows(),
    merlin: emptyRows(),
    percival: emptyRows(),
  };

  for (const { game: g, events, truth } of games) {
    const seats = g.players.map((p) => p.id);
    const n = seats.length;
    const count = g.playerCount as PlayerCount;
    const base = evilCount(count) / n;
    const info = informationSets(truth.byPlayer as ReadonlyMap<string, RoleType>);

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.type !== "proposal") continue;

      const leader = event.leaderId;
      const role = truth.byPlayer.get(leader);
      if (role !== "loyal" && role !== "merlin" && role !== "percival") continue;

      const round = Math.min(Math.max(event.missionNumber, 1), 5) as 1 | 2 | 3 | 4 | 5;
      const size = teamSize(count, round);
      if (event.teamPlayerIds.length !== size) continue;

      const view = publicView(events.slice(0, i) as GameEvent[], g);
      const side = deriveSideInference(view.events as GameEvent[], view.game);
      if (side.contradictory || !side.surviving.length) continue;
      const weights = weighHypotheses(
        side.surviving,
        view.events as GameEvent[],
        view.game,
      );
      const who = info.get(leader);
      if (!who) continue;

      /*
       * The same posterior, restricted to the worlds this leader's own sight
       * still allows. Merlin's sightings must be evil; Percival knows exactly
       * one of his pair is (the Morgana of the two). Everyone knows their own
       * side. Nothing else is assumed.
       */
      const live: number[] = [];
      let liveTotal = 0;
      for (let h = 0; h < side.surviving.length; h += 1) {
        const hyp = side.surviving[h];
        let ok = !hyp.isEvil(leader);
        if (ok && role === "merlin") {
          for (const seen of who.visibleEvil) {
            if (!hyp.isEvil(seen)) {
              ok = false;
              break;
            }
          }
        }
        if (ok && role === "percival" && who.pair) {
          ok = who.pair.filter((id) => hyp.isEvil(id)).length === 1;
        }
        const w = ok ? weights[h] : 0;
        live.push(w);
        liveTotal += w;
      }
      if (liveTotal <= 0) continue;

      const teams = combinations(n, size);
      const publicRisk = new Array<number>(teams.length).fill(0);
      const privateRisk = new Array<number>(teams.length).fill(0);
      for (let h = 0; h < side.surviving.length; h += 1) {
        const pw = weights[h];
        const qw = live[h] / liveTotal;
        if (pw <= 0 && qw <= 0) continue;
        let mask = 0;
        for (let s = 0; s < n; s += 1) {
          if (side.surviving[h].isEvil(seats[s])) mask |= 1 << s;
        }
        for (let t = 0; t < teams.length; t += 1) {
          let bits = 0;
          for (const s of teams[t]) if (mask & (1 << s)) bits += 1;
          publicRisk[t] += pw * bits;
          privateRisk[t] += qw * bits;
        }
      }

      let chosen = 0;
      for (const seat of event.teamPlayerIds) {
        const s = seats.indexOf(seat);
        if (s >= 0) chosen |= 1 << s;
      }
      let chosenIndex = -1;
      for (let t = 0; t < teams.length; t += 1) {
        let mask = 0;
        for (const s of teams[t]) mask |= 1 << s;
        if (mask === chosen) {
          chosenIndex = t;
          break;
        }
      }
      if (chosenIndex < 0) continue;

      const pct = (arr: number[]) => {
        const value = arr[chosenIndex];
        let below = 0;
        let equal = 0;
        for (const v of arr) {
          if (v < value - 1e-12) below += 1;
          else if (v <= value + 1e-12) equal += 1;
        }
        return (below + equal / 2) / arr.length;
      };

      const row = rows[role][round - 1];
      row.proposals += 1;
      row.publicPct += pct(publicRisk);
      row.privatePct += pct(privateRisk);

      // What he could actually see, and whether he had any way to avoid it.
      const seen = new Set(who.visibleEvil);
      if (role === "percival" && who.pair) {
        // Percival cannot name the evil of his pair, so nothing counts as seen.
        seen.clear();
      }
      if (seen.size) {
        const aboard = event.teamPlayerIds.filter((id) => seen.has(id)).length;
        row.seenAboard += aboard;
        row.seenChance += (size * seen.size) / n;
        // Could he have filled the car without any of them?
        if (n - seen.size >= size) {
          row.avoidable += 1;
          if (aboard > 0) row.tookAnyway += 1;
        }
      }
    }
  }

  console.log("");
  console.log(`视野使用审计：held-out ${games.length} 局`);
  console.log("分位 = 所选车在全部合法车中的风险排名，0 = 最干净的那辆");
  for (const role of ["loyal", "merlin", "percival"] as const) {
    console.log("");
    console.log(
      { loyal: "忠臣车主（对照，无额外视野）", merlin: "梅林车主", percival: "派西维尔车主" }[role],
    );
    console.log("轮次   公开分位   私有分位   看得见的坏人上车/随机   本可避开却带了   样本");
    rows[role].forEach((r, i) => {
      if (!r.proposals) return;
      const load = r.seenChance > 0 ? (r.seenAboard / r.seenChance).toFixed(3) : "  —  ";
      const took = r.avoidable > 0 ? (r.tookAnyway / r.avoidable).toFixed(3) : "  —  ";
      console.log(
        `第${i + 1}轮   ${(r.publicPct / r.proposals).toFixed(3)}      ${(r.privatePct / r.proposals).toFixed(3)}      ${load}                  ${took}         ${r.proposals}`,
      );
    });
  }
}, 3_600_000);
