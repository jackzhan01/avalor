/**
 * Does a vote in round 1 mean the same thing as a vote in round 5?
 *
 * The by-round ablation says early votes make the posterior WORSE. The obvious
 * suspect is that they carry less signal than the pooled parameters assume:
 * on the opening car nobody knows anything, evil has no reason to show its
 * hand, and approving is close to free. If the discriminative power really is
 * ~1.0 early and rises later, then applying one pooled parameter to all of it
 * is feeding noise in as though it were evidence.
 */
const fs = require("node:fs");
const games = JSON.parse(fs.readFileSync(__dirname + "/data/games.json", "utf8"));
const EVIL = new Set(["MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"]);
const EVIL_COUNTS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

const mk = () => ({ hit: 0, n: 0 });
const add = (t, did) => { t.n += 1; if (did) t.hit += 1; };
const rate = (t) => (t.n ? t.hit / t.n : null);

// round -> condition -> side
const byRound = {};
const slot = (r) =>
  (byRound[r] ??= {
    goodOffTainted: mk(), evilOffTainted: mk(),
    goodOffClean: mk(), evilOffClean: mk(),
  });

for (const g of games) {
  const n = g.players?.length;
  if (!n || !EVIL_COUNTS[n]) continue;
  const evilNames = new Set(g.outcome.roles.filter((r) => EVIL.has(r.role)).map((r) => r.name));
  if (evilNames.size !== EVIL_COUNTS[n]) continue;

  (g.missions ?? []).forEach((mission, mi) => {
    const round = mi + 1;
    if (round > 5) return;
    const s = slot(round);
    for (const p of mission.proposals ?? []) {
      if (!p.votes || !p.team) continue;
      const approvers = new Set(p.votes);
      const team = new Set(p.team);
      const tainted = [...team].some((x) => evilNames.has(x));
      for (const player of g.players) {
        if (team.has(player.name)) continue; // aboard carries no side signal
        const yes = approvers.has(player.name);
        const isEvil = evilNames.has(player.name);
        const key = (isEvil ? "evil" : "good") + (tainted ? "OffTainted" : "OffClean");
        add(s[key], yes);
      }
    }
  });
}

console.log("每一轮，从车外投票的判别力（坏人率 ÷ 好人率，1.00 = 毫无信息）\n");
console.log("轮次    车脏时                     车干净时                  样本");
console.log("       好人   坏人   判别力       好人   坏人   判别力");
console.log("─".repeat(72));
for (const round of [1, 2, 3, 4, 5]) {
  const s = byRound[round];
  if (!s) continue;
  const gt = rate(s.goodOffTainted), et = rate(s.evilOffTainted);
  const gc = rate(s.goodOffClean), ec = rate(s.evilOffClean);
  const n = s.goodOffTainted.n + s.evilOffTainted.n + s.goodOffClean.n + s.evilOffClean.n;
  console.log(
    String(round).padStart(4),
    gt.toFixed(3).padStart(7), et.toFixed(3).padStart(7), (et / gt).toFixed(2).padStart(8),
    gc.toFixed(3).padStart(9), ec.toFixed(3).padStart(7), (ec / gc).toFixed(2).padStart(8),
    String(n).padStart(9),
  );
}

console.log("\n判别力离 1.00 越远越有信息量。若第 1 轮两列都接近 1.00，");
console.log("说明开局的票基本是噪音，用统一参数处理会把噪音当证据。");
