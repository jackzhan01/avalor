/**
 * Phase 1 数据审计。产出 research/AUDIT.md 里的每一个数字。
 *
 * 需要先跑 extract.js 生成 research/data/games.json。
 * 用法：node research/audit.js
 */

const games = require("./data/games.json");

const seats = (g) => (g.players || []).length;
const roleNames = (g) => (g.outcome?.roles || []).map((r) => r.role);
const key = (a) => [...a].sort().join(",");

/* 本 App 的官方牌型，映射到语料的角色名。刺客在语料里是标记不是角色，
   所以这里用 EVIL MINION 占位 —— 它就是那个带 assassin 标记的坏人。 */
const APP_SETUP = {
  7: ["MERLIN", "PERCIVAL", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "MORGANA", "OBERON", "EVIL MINION"],
  8: ["MERLIN", "PERCIVAL", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "MORGANA", "EVIL MINION", "EVIL MINION"],
  9: ["MERLIN", "PERCIVAL", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "MORGANA", "MORDRED", "EVIL MINION"],
  10: ["MERLIN", "PERCIVAL", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "LOYAL FOLLOWER", "MORGANA", "MORDRED", "OBERON", "EVIL MINION"],
};

const byCount = {};
for (const g of games) byCount[seats(g)] = (byCount[seats(g)] || 0) + 1;

console.log("=== 人数分布");
for (const n of Object.keys(byCount).sort((a, b) => a - b)) {
  console.log(`${String(n).padStart(3)} 人  ${String(byCount[n]).padStart(6)}  ${((byCount[n] / games.length) * 100).toFixed(1)}%`);
}

const target = games.filter((g) => seats(g) >= 7 && seats(g) <= 10);
console.log(`\n7–10 人合计 ${target.length} / ${games.length}  (${((target.length / games.length) * 100).toFixed(1)}%)`);

/* 字段完整性。numFails 只在 PENDING（没打的任务）上缺，所以按 state 分组
   才看得出那不是数据缺失。 */
const missionByState = {};
let noRoles = 0, noState = 0, noQuestCards = 0, assassinFlag = 0, assassinNamed = 0;
for (const g of target) {
  if (!g.outcome?.roles?.length) noRoles++;
  if (!g.outcome?.state) noState++;
  if (!g.outcome?.votes) noQuestCards++;
  if ((g.outcome?.roles || []).some((r) => r.assassin)) assassinFlag++;
  if (roleNames(g).includes("ASSASSIN")) assassinNamed++;
  for (const m of g.missions || []) {
    const s = m.state ?? "(无)";
    (missionByState[s] ??= { total: 0, noFails: 0 }).total++;
    if (m.numFails == null) missionByState[s].noFails++;
  }
}

console.log("\n=== 字段完整性（7–10 人）");
console.log("缺 outcome.roles        ", noRoles);
console.log("缺 outcome.state        ", noState);
console.log("缺 outcome.votes 任务牌 ", noQuestCards);
for (const [s, v] of Object.entries(missionByState)) {
  console.log(`任务 ${s.padEnd(10)} 共 ${String(v.total).padStart(5)}  缺 numFails ${String(v.noFails).padStart(5)}`);
}
console.log("有 assassin 标记的局    ", assassinFlag);
console.log("把 ASSASSIN 当角色名的局", assassinNamed);

console.log("\n=== 角色配置");
const configs = {};
for (const g of target) {
  const k = `${seats(g)} | ${key(roleNames(g))}`;
  configs[k] = (configs[k] || 0) + 1;
}
const rows = Object.entries(configs).sort((a, b) => b[1] - a[1]);
console.log(`共 ${rows.length} 种配置`);
for (const [k, c] of rows.slice(0, 8)) console.log(String(c).padStart(5), k);

let appMatch = 0;
const appByCount = {};
for (const g of target) {
  const n = seats(g);
  if (key(roleNames(g)) === key(APP_SETUP[n])) {
    appMatch++;
    appByCount[n] = (appByCount[n] || 0) + 1;
  }
}
console.log("\n=== 与本 App 官方牌型一致");
for (const n of [7, 8, 9, 10]) console.log(`${n} 人  ${String(appByCount[n] || 0).padStart(5)}`);
console.log(`合计 ${appMatch}  (${((appMatch / target.length) * 100).toFixed(1)}% of 7–10 人)`);

const outcomes = {};
for (const g of target) outcomes[g.outcome?.state] = (outcomes[g.outcome?.state] || 0) + 1;
console.log("\n=== 胜负基线", outcomes);
