/**
 * 按「信息结构」而不是「牌型」估计行为参数。
 *
 * 每个参数显式声明三件事：哪些局合格、按什么条件分层、哪些角色替换与它无关。
 * 牌型只是元数据，不是分池键 —— 6,002 局摊到 73 种配置上谁都估不出来，
 * 而好人根本看不见坏人牌型，对他而言那些替换等价。
 *
 * 最要紧的一条：区分「真实在车上的坏人数」和「行动者知道的坏人数」。
 * 奥伯伦不认队友、队友也不认他，所以有奥伯伦的局里，一个坏人看到的
 * 「干净车」可能载着奥伯伦。拿真实数去解释他的投票，是在用他没有的信息
 * 解释他的行为。
 *
 *   node research/estimate.js
 */

const fs = require("node:fs");

const games = JSON.parse(fs.readFileSync(__dirname + "/data/games.json", "utf8"));
const EVIL = new Set(["MORGANA", "MORDRED", "OBERON", "EVIL MINION", "ASSASSIN"]);
const EVIL_COUNTS = { 7: 3, 8: 3, 9: 3, 10: 4 };

const mk = () => ({ hit: 0, n: 0 });
const add = (t, did) => { t.n += 1; if (did) t.hit += 1; };
const show = (t) => (t.n ? `${(t.hit / t.n).toFixed(3)}  (n=${t.n})` : "  —");

/** 一局的结构变量。全部从真实身份推出，只用于分层，不喂进推断。 */
function structure(g) {
  const n = g.players?.length;
  if (!n || !EVIL_COUNTS[n]) return null;
  const roles = g.outcome?.roles ?? [];
  const evil = new Map();
  for (const r of roles) if (EVIL.has(r.role)) evil.set(r.name, r.role);
  if (evil.size !== EVIL_COUNTS[n]) return null; // 非标准坏人数，剔除

  const names = roles.map((r) => r.role);
  return {
    n,
    evil,
    hasMerlin: names.includes("MERLIN"),
    hasPercival: names.includes("PERCIVAL"),
    hasMordred: names.includes("MORDRED"),
    hasOberon: names.includes("OBERON"),
  };
}

/**
 * 一个坏人看得见的队友。奥伯伦谁也不认，别人也不认他 —— 所以他自己看到的
 * 队友集合是空的，而别人的队友集合里没有他。
 */
function knownTeammates(s, actor) {
  if (s.evil.get(actor) === "OBERON") return new Set();
  const out = new Set();
  for (const [name, role] of s.evil) {
    if (name !== actor && role !== "OBERON") out.add(name);
  }
  return out;
}

/* ── 参数 1：goodApproves ────────────────────────────────────────────────
   合格：好人结构标准（有梅林 + 派西维尔）。坏人那边换谁都无关 —— 好人
   看不见任何身份，莫德雷德还是奥伯伦对他完全等价。 */
const good = { aboard: mk(), offDirty: mk(), offClean: mk() };

/* ── 参数 2：evilApproves ────────────────────────────────────────────────
   按行动者「知道的」车上队友数分层，并单独拆出奥伯伦本人 —— 他没有协同
   信息，把他和别的坏人混在一起估，等于假设他知道他不知道的事。 */
const evil = {
  aboard: mk(),
  offKnownTeammate: mk(),
  offLooksClean: mk(),
};
const oberonSelf = { aboard: mk(), off: mk() };
/* 同一个格子按「局里有没有奥伯伦」再切一刀，用来检验这个拆分值不值得。 */
const evilByOberon = {
  withOberon: { offLooksClean: mk() },
  noOberon: { offLooksClean: mk() },
};

/* ── 参数 3：evilPlaysFail ───────────────────────────────────────────────
   按车上真实坏人数、第几轮、以及这一轮需要几张坏票分层。牌型无关：
   出不出牌只取决于他在车上、以及他想不想让这轮崩。 */
const fail = {};
const failKey = (evilOnQuest, mission) => `evil=${evilOnQuest} 第${mission}轮`;

for (const g of games) {
  const s = structure(g);
  if (!s) continue;

  const goodEligible = s.hasMerlin && s.hasPercival;

  let missionNo = 0;
  for (const mission of g.missions ?? []) {
    missionNo += 1;

    for (const p of mission.proposals ?? []) {
      if (!p.votes || !p.team) continue;
      const approvers = new Set(p.votes);
      const team = new Set(p.team);
      const actualEvilAboard = [...team].filter((x) => s.evil.has(x)).length;

      for (const player of g.players) {
        const name = player.name;
        const yes = approvers.has(name);
        const aboard = team.has(name);
        const isEvil = s.evil.has(name);

        if (!isEvil) {
          if (!goodEligible) continue;
          if (aboard) add(good.aboard, yes);
          else if (actualEvilAboard > 0) add(good.offDirty, yes);
          else add(good.offClean, yes);
          continue;
        }

        // 坏人：一切以「他知道什么」为准
        const known = knownTeammates(s, name);
        const knownAboard = [...team].filter((x) => known.has(x)).length;
        const isOberon = s.evil.get(name) === "OBERON";

        if (isOberon) {
          add(aboard ? oberonSelf.aboard : oberonSelf.off, yes);
          continue; // 单独统计，不混进下面
        }

        if (aboard) add(evil.aboard, yes);
        else if (knownAboard > 0) add(evil.offKnownTeammate, yes);
        else {
          add(evil.offLooksClean, yes);
          add(
            s.hasOberon
              ? evilByOberon.withOberon.offLooksClean
              : evilByOberon.noOberon.offLooksClean,
            yes,
          );
        }
      }
    }

    const team = mission.team ?? [];
    const evilOnQuest = team.filter((x) => s.evil.has(x)).length;
    if (evilOnQuest >= 1 && typeof mission.numFails === "number") {
      const key = failKey(evilOnQuest, missionNo);
      fail[key] ??= mk();
      for (let i = 0; i < evilOnQuest; i++) {
        add(fail[key], i < mission.numFails);
      }
    }
  }
}

console.log("=== goodApproves —— 合格：有梅林+派西维尔（坏人牌型无关）");
console.log("  自己在车上          ", show(good.aboard));
console.log("  在外面，车上有坏人  ", show(good.offDirty));
console.log("  在外面，车是干净的  ", show(good.offClean));

console.log("\n=== evilApproves —— 按「他知道的」队友分层，奥伯伦单列");
console.log("  自己在车上          ", show(evil.aboard));
console.log("  在外面，有已知队友  ", show(evil.offKnownTeammate));
console.log("  在外面，看着是干净的", show(evil.offLooksClean));
console.log("  ├ 局里有奥伯伦      ", show(evilByOberon.withOberon.offLooksClean));
console.log("  └ 局里没有奥伯伦    ", show(evilByOberon.noOberon.offLooksClean));

console.log("\n=== 奥伯伦本人（无协同信息）");
console.log("  自己在车上          ", show(oberonSelf.aboard));
console.log("  在外面              ", show(oberonSelf.off));

console.log("\n=== evilPlaysFail —— 按车上真实坏人数 × 轮次");
for (const key of Object.keys(fail).sort()) {
  if (fail[key].n >= 100) console.log(`  ${key.padEnd(16)}`, show(fail[key]));
}
