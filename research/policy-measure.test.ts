import { it } from "vitest";
import { deriveSideInference } from "@/lib/inference";
import type { RoleType } from "@/lib/types/game";
import { corpusSplit } from "./splits";

/**
 * Approve rates as a POLICY, not as a likelihood.
 *
 * A likelihood may condition on the hypothesis; a policy that generates a
 * simulated player's action may not condition on anything that player cannot
 * see. So a loyal is keyed on the PUBLIC read — the frozen posterior's
 * expected number of evils on the team, which any seat at the table could work
 * out — rather than on the true composition.
 *
 * Fitted on train only.
 */
it("measures approve rates against the public read", () => {
  const train = corpusSplit("train", { limit: 400 });
  type Cell = { h: number; n: number };
  const mk = (): Cell => ({ h: 0, n: 0 });
  const rate = (c: Cell) => (c.n ? +(c.h / c.n).toFixed(3) : null);

  // Bucketed by expected evils on the team under the public posterior.
  const BUCKETS = [0.4, 0.8, 1.2, 1.6];
  const label = (q: number) => {
    for (let i = 0; i < BUCKETS.length; i++) if (q < BUCKETS[i]) return i;
    return BUCKETS.length;
  };

  const byRoleBucket = new Map<string, Cell[]>();
  const cell = (key: string, b: number) => {
    let arr = byRoleBucket.get(key);
    if (!arr) byRoleBucket.set(key, (arr = BUCKETS.map(mk).concat([mk()])));
    return arr[b];
  };

  let scanned = 0;
  for (const { game, events, truth } of train) {
    // Walk the log, scoring each vote against the posterior BEFORE it.
    const prefix: typeof events = [];
    for (const event of events) {
      if (event.type === "vote") {
        const proposal = events.find(
          (e) => e.type === "proposal" && e.id === event.proposalId,
        );
        if (proposal && proposal.type === "proposal") {
          const side = deriveSideInference(prefix as never, game);
          const team = new Set(proposal.teamPlayerIds);
          let q = 0;
          for (const seat of team) q += side.evilProbability.get(seat) ?? 0;
          const b = label(q);
          scanned += 1;
          for (const [seat, choice] of Object.entries(event.votes)) {
            if (choice !== "approve" && choice !== "reject") continue;
            if (team.has(seat)) continue; // aboard is its own decision
            const role = truth.byPlayer.get(seat);
            if (!role) continue;
            const key: string =
              role === "merlin" ? "merlin" :
              role === "percival" ? "percival" :
              role === "oberon" ? "oberon" :
              role === "loyal" ? "loyal" : "evil";
            const c = cell(key, b);
            c.n += 1;
            if (choice === "approve") c.h += 1;
          }
        }
      }
      prefix.push(event as never);
    }
  }

  console.log("");
  console.log(`训练集 ${train.length} 局，${scanned} 次投票`);
  console.log("");
  console.log("公开读数（车上期望坏人数）   <0.4    <0.8    <1.2    <1.6    >=1.6");
  for (const key of ["loyal", "merlin", "percival", "evil", "oberon"]) {
    const arr = byRoleBucket.get(key);
    if (!arr) continue;
    const name =
      key === "loyal" ? "忠臣" : key === "merlin" ? "梅林" :
      key === "percival" ? "派西维尔" : key === "evil" ? "坏人(非奥)" : "奥伯伦";
    console.log(
      name.padEnd(12) +
        arr.map((c) => (rate(c) === null ? "   —" : String(rate(c)).padStart(7))).join(" ") +
        "   n=" + arr.reduce((a, c) => a + c.n, 0),
    );
  }
}, 3_600_000);
