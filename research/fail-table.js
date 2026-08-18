/**
 * 生成 soft.ts 用的坏票分布表。
 *
 * 直接估 P(出牌数 f | 车上坏人 k, 本轮需要 need, 比分)，而不是估一个每人概率
 * 再套二项式。因为实测分布明显比二项式更散：k=3 需 1 张时实际 f=0 占 0.284、
 * f=3 占 0.178，二项式给的是 0.185 / 0.079。
 *
 * 坏人不是各自独立抛硬币，而是**正相关**的 —— 同一个局面下他们倾向于做同样的
 * 判断，要么都按住，要么一起出。二项式假设独立，就把这种「同进同退」摊平了。
 * 直接存分布不需要任何关于机制的假设。
 *
 * 两层 Dirichlet 回退：(k,need,比分) → (k,need)，先验强度 15。
 *
 *   node research/fail-table.js
 */

const fs = require("node:fs");

const games = JSON.parse(fs.readFileSync(__dirname + "/data/games.json", "utf8"));
const EVIL = new Set(["MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"]);
const EVIL_COUNTS = { 7: 3, 8: 3, 9: 3, 10: 4 };
const PRIOR = 15;

const byKN = {};
const byKNS = {};
const bump = (bag, key, k, f) => {
  const arr = (bag[key] ??= new Array(k + 1).fill(0));
  arr[f] += 1;
};

for (const g of games) {
  const n = g.players?.length;
  if (!n || !EVIL_COUNTS[n]) continue;
  const evil = new Set((g.outcome?.roles ?? []).filter((r) => EVIL.has(r.role)).map((r) => r.name));
  if (evil.size !== EVIL_COUNTS[n]) continue;

  let s = 0, f = 0;
  for (const m of g.missions ?? []) {
    if (m.state !== "SUCCESS" && m.state !== "FAIL") continue;
    const k = (m.team ?? []).filter((x) => evil.has(x)).length;
    const need = m.failsRequired ?? 1;
    if (k >= 1 && typeof m.numFails === "number" && m.numFails <= k) {
      bump(byKN, `${k}|${need}`, k, m.numFails);
      bump(byKNS, `${k}|${need}|${s}-${f}`, k, m.numFails);
    }
    if (m.state === "SUCCESS") s++; else f++;
  }
}

const normalise = (counts) => {
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => c / total);
};
const smooth = (counts, prior) => {
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c, i) => (c + PRIOR * prior[i]) / (total + PRIOR));
};

/* 顶层先验：把「刚好出够」当成弱先验，剩余质量平摊。这只在某个 (k,need)
   自己都没样本时才生效，实际数据里几乎不会用到。 */
const fallbackPrior = (k, need) => {
  const target = Math.min(k, need);
  return Array.from({ length: k + 1 }, (_, f) => (f === target ? 0.6 : 0.4 / k));
};

const kn = {};
for (const [key, counts] of Object.entries(byKN)) {
  const [k, need] = key.split("|").map(Number);
  kn[key] = smooth(counts, fallbackPrior(k, need));
}

const kns = {};
for (const [key, counts] of Object.entries(byKNS)) {
  const parent = key.split("|").slice(0, 2).join("|");
  kns[key] = smooth(counts, kn[parent]);
}

const fmt = (a) => `[${a.map((x) => x.toFixed(4)).join(", ")}]`;
const total = (key, bag) => bag[key].reduce((a, b) => a + b, 0);

console.log("/** k|need → P(出牌数 f = 0..k)。比分未知时的回退层。 */");
console.log("const FAIL_DIST_BY_TEAM: Record<string, readonly number[]> = {");
for (const key of Object.keys(kn).sort()) {
  console.log(`  "${key}": ${fmt(kn[key])},   // n=${total(key, byKN)}`);
}
console.log("};\n");

console.log("/** k|need|已成功-已失败 → P(出牌数 f = 0..k)。主表。 */");
console.log("const FAIL_DIST: Record<string, readonly number[]> = {");
for (const key of Object.keys(kns).sort()) {
  console.log(`  "${key}": ${fmt(kns[key])},   // n=${total(key, byKNS)}`);
}
console.log("};");
