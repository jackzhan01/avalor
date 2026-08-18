/**
 * Does Merlin vote differently from an ordinary good player?
 *
 * He must: he can SEE the evils, so from outside a car he knows whether it is
 * clean, while a loyal follower is only guessing. If that shows up in the
 * numbers, the role layer can use votes the same way the side layer does —
 * and "who is Merlin" stops being a flat 1/6 the moment anyone votes.
 *
 * Percival is checked too: he sees Merlin and Morgana, so he has partial
 * information and should land somewhere between the two.
 */
const fs = require("node:fs");
const games = JSON.parse(fs.readFileSync(__dirname + "/data/games.json", "utf8"));
const EVIL = new Set(["MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"]);
const EVIL_COUNTS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

const mk = () => ({ hit: 0, n: 0 });
const add = (t, did) => { t.n += 1; if (did) t.hit += 1; };
const rate = (t) => (t.n ? t.hit / t.n : null);

// role -> { offTainted, offClean, aboard }
const stats = {};
const bucket = (role) =>
  (stats[role] ??= { offTainted: mk(), offClean: mk(), aboard: mk() });

for (const g of games) {
  const n = g.players?.length;
  if (!n || !EVIL_COUNTS[n]) continue;
  const roleOf = new Map(g.outcome.roles.map((r) => [r.name, r.role]));
  const evilNames = new Set(
    g.outcome.roles.filter((r) => EVIL.has(r.role)).map((r) => r.name),
  );
  if (evilNames.size !== EVIL_COUNTS[n]) continue;

  for (const mission of g.missions ?? []) {
    for (const p of mission.proposals ?? []) {
      if (!p.votes || !p.team) continue;
      const approvers = new Set(p.votes);
      const team = new Set(p.team);
      const tainted = [...team].some((x) => evilNames.has(x));

      for (const player of g.players) {
        const role = roleOf.get(player.name);
        if (!role) continue;
        const yes = approvers.has(player.name);
        const b = bucket(role);
        if (team.has(player.name)) add(b.aboard, yes);
        else if (tainted) add(b.offTainted, yes);
        else add(b.offClean, yes);
      }
    }
  }
}

const ORDER = [
  "MERLIN",
  "PERCIVAL",
  "LOYAL FOLLOWER",
  "MORGANA",
  "MORDRED",
  "EVIL MINION",
  "OBERON",
];

console.log("从车外看的上票率 —— 关键是「车脏」和「车干净」拉不拉得开\n");
console.log("角色              车脏时   车干净时    区分度      样本");
console.log("─".repeat(64));
for (const role of ORDER) {
  const b = stats[role];
  if (!b) continue;
  const t = rate(b.offTainted);
  const c = rate(b.offClean);
  const gap = c - t;
  console.log(
    role.padEnd(16),
    (t == null ? "—" : t.toFixed(3)).padStart(7),
    (c == null ? "—" : c.toFixed(3)).padStart(9),
    (gap == null ? "—" : (gap >= 0 ? "+" : "") + gap.toFixed(3)).padStart(10),
    String(b.offTainted.n + b.offClean.n).padStart(9),
  );
}

console.log("\n自己在车上时（应该谁都差不多，纯自利）");
console.log("─".repeat(40));
for (const role of ORDER) {
  const b = stats[role];
  if (!b) continue;
  console.log(
    role.padEnd(16),
    rate(b.aboard).toFixed(3).padStart(7),
    String(b.aboard.n).padStart(9),
  );
}

// The number the role layer would actually use: Merlin vs other good players.
const merlin = stats.MERLIN;
const loyal = stats["LOYAL FOLLOWER"];
console.log("\n梅林 vs 忠臣，从车外看：");
console.log(
  `  车脏时上票   梅林 ${rate(merlin.offTainted).toFixed(3)}  忠臣 ${rate(loyal.offTainted).toFixed(3)}  似然比 ${(rate(merlin.offTainted) / rate(loyal.offTainted)).toFixed(2)}`,
);
console.log(
  `  车净时上票   梅林 ${rate(merlin.offClean).toFixed(3)}  忠臣 ${rate(loyal.offClean).toFixed(3)}  似然比 ${(rate(merlin.offClean) / rate(loyal.offClean)).toFixed(2)}`,
);
