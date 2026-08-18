/**
 * The full cross-tab: does "aboard the car" explain approving better than
 * "which side you are on"? The pooled numbers suggested it does, which would
 * mean the model is attributing ordinary self-interest to evil.
 */
const fs = require("node:fs");
const games = JSON.parse(fs.readFileSync(__dirname + "/games.json", "utf8"));
const EVIL = new Set(["MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"]);
const EVIL_COUNTS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

const mk = () => ({ hit: 0, n: 0 });
const add = (t, did) => { t.n += 1; if (did) t.hit += 1; };
const rate = (t) => (t.n ? t.hit / t.n : null);

const cell = {
  goodAboard: mk(),
  goodOffWithEvilAboard: mk(),
  goodOffCleanCar: mk(),
  evilAboard: mk(),
  evilOffTeammateAboard: mk(),
  evilOffCleanCar: mk(),
};
// Fail card, split by how many evils shared the quest.
const failByCompany = { 1: mk(), 2: mk(), 3: mk() };

for (const g of games) {
  const n = g.players?.length;
  if (!n || !EVIL_COUNTS[n]) continue;
  const evilNames = new Set(g.outcome.roles.filter((r) => EVIL.has(r.role)).map((r) => r.name));
  if (evilNames.size !== EVIL_COUNTS[n]) continue;

  for (const mission of g.missions ?? []) {
    for (const p of mission.proposals ?? []) {
      if (!p.votes || !p.team) continue;
      const approvers = new Set(p.votes);
      const team = new Set(p.team);
      const evilAboard = [...team].filter((x) => evilNames.has(x)).length;

      for (const player of g.players) {
        const name = player.name;
        const yes = approvers.has(name);
        const aboard = team.has(name);
        const isEvil = evilNames.has(name);
        if (isEvil) {
          if (aboard) add(cell.evilAboard, yes);
          else if (evilAboard > 0) add(cell.evilOffTeammateAboard, yes);
          else add(cell.evilOffCleanCar, yes);
        } else {
          if (aboard) add(cell.goodAboard, yes);
          else if (evilAboard > 0) add(cell.goodOffWithEvilAboard, yes);
          else add(cell.goodOffCleanCar, yes);
        }
      }
    }

    // Fail cards for this mission, keyed by how many evils were on it.
    const team = mission.team ?? [];
    const evilOnQuest = team.filter((x) => evilNames.has(x)).length;
    if (evilOnQuest >= 1 && evilOnQuest <= 3 && typeof mission.numFails === "number") {
      for (let i = 0; i < evilOnQuest; i++) {
        // Attribute per-evil: numFails of evilOnQuest played the card.
        add(failByCompany[evilOnQuest], i < mission.numFails);
      }
    }
  }
}

const show = (label, t, note = "") =>
  console.log(
    label.padEnd(28),
    (rate(t) == null ? "—" : rate(t).toFixed(3)).padStart(7),
    String(t.n).padStart(10),
    note,
  );

console.log("上票率                          比率      样本");
console.log("─".repeat(60));
console.log("【自己在车上】");
show("  好人", cell.goodAboard);
show("  坏人", cell.evilAboard);
console.log("【自己不在车上，车上有坏人】");
show("  好人", cell.goodOffWithEvilAboard);
show("  坏人（有队友在车上）", cell.evilOffTeammateAboard);
console.log("【自己不在车上，车上全好人】");
show("  好人", cell.goodOffCleanCar);
show("  坏人", cell.evilOffCleanCar);

const lr = (a, b) => (rate(a) / rate(b)).toFixed(2);
console.log("\n判别力（坏人率 ÷ 好人率，1.00 = 毫无信息）");
console.log("  自己在车上          ", lr(cell.evilAboard, cell.goodAboard));
console.log("  在外面，车上有坏人  ", lr(cell.evilOffTeammateAboard, cell.goodOffWithEvilAboard));
console.log("  在外面，车干净      ", lr(cell.evilOffCleanCar, cell.goodOffCleanCar));

console.log("\n坏人上车时出坏票的概率，按车上有几个坏人分:");
for (const [k, t] of Object.entries(failByCompany)) {
  show(`  车上 ${k} 个坏人`, t);
}
