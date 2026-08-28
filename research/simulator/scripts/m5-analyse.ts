/**
 * Post-run analysis of an M5 cognitive game. Offline, read-only.
 *
 * Reads the two artifacts and reports what the pilot was run to find out:
 * how big the prompts got, how much of each bounded field the model actually
 * used, whether constraints rested on unverified premises, and whether the
 * ledger influenced later moves or was merely written and ignored.
 *
 * Makes no request and constructs no client. Prints nothing from the private
 * trace that would expose a hidden role outside the section marked for it.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-analyse.ts -- <gameId>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COGNITION_LIMITS as L, CONTEXT_BUDGET } from "../cognition/limits";
import { parseJsonl, type PrivateTraceLine } from "../run/artifacts";

const say = (...parts: unknown[]) => console.log(...parts);
const gameId = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!gameId) {
  say("用法: ... m5-analyse.ts -- <gameId>");
  process.exit(2);
}

const OUT = join(process.cwd(), "research", "simulator", "out");
const text = readFileSync(join(OUT, "private", `${gameId}.private-trace.jsonl`), "utf8");
const lines = parseJsonl<PrivateTraceLine>(text) as unknown as {
  t: string;
  data: unknown;
}[];
const pick = <T,>(t: string): T[] =>
  lines.filter((l) => l.t === t).map((l) => l.data as T);

type Report = {
  seat: number;
  taskId: string;
  attempt: number;
  premisesOverridden: number;
  boundsViolations: number;
  utilisation: {
    seat: number;
    constraints: number;
    unverifiedConstraints: number;
    hypotheses: number;
    dossierEntries: number;
    commitments: number;
    maxEvidenceChars: number;
    maxConstraintChars: number;
    rolePlanChars: number;
  };
  packSections: Record<string, number>;
  estimatedTokens: number;
  overSoftTarget: boolean;
};

type Attempt = {
  seat: number;
  taskId: string;
  attempt: number;
  capacityAttempt: number;
  outcome: string;
  status: string;
  incompleteReason?: string;
  totalInputChars: number;
  estimatedInputTokens: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  } | null;
  latencyMs: number;
  appliedLegalAction: boolean;
  rejectedBy?: string;
  rejectionReason?: string;
  raw: string | null;
};

const reports = (pick<unknown>("cognition-telemetry")[0] ?? []) as unknown as Report[];
const attempts = pick<Attempt>("model-call");
const manifest = pick<Record<string, unknown>>("private-manifest")[0];

if (reports.length === 0) {
  say("没有认知遥测 —— 这不是一局认知对局，或者一次决策都没完成。");
  process.exit(1);
}

const num = (n: number) => n.toLocaleString();
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/* ── Context size ───────────────────────────────────────────────────────── */

const sizes = reports.map((r) => r.estimatedTokens);
say("## 上下文体量（保守估算 token）");
say("");
say("| 位置 | token |");
say("|---|---|");
say(`| 开局 | ${num(sizes[0])} |`);
say(`| 中位数 | ${num(q(sizes, 0.5))} |`);
say(`| p90 | ${num(q(sizes, 0.9))} |`);
say(`| 最大 | ${num(Math.max(...sizes))} |`);
say(`| 软目标 | ${num(CONTEXT_BUDGET.softTargetTokens)} |`);
say(`| 硬上限 | ${num(CONTEXT_BUDGET.hardCeilingTokens)} |`);
say("");
const crossed = reports.filter((r) => r.overSoftTarget).length;
const peak = Math.max(...sizes);
say(`越过 60K 软目标：**${crossed} 次**`);
say(
  `峰值占软目标 ${((peak / CONTEXT_BUDGET.softTargetTokens) * 100).toFixed(1)}%，` +
    `占 250K 硬上限 ${((peak / CONTEXT_BUDGET.hardCeilingTokens) * 100).toFixed(1)}%`,
);

/* ── Pack sections ──────────────────────────────────────────────────────── */

say("");
say("## context pack 分节（字符）");
say("");
const keys = Object.keys(reports[0].packSections);
say("| 分节 | 开局 | 中位 | 最大 | 末次 |");
say("|---|---|---|---|---|");
for (const key of keys) {
  const xs = reports.map((r) => r.packSections[key] ?? 0);
  say(
    `| ${key} | ${num(xs[0])} | ${num(q(xs, 0.5))} | ${num(Math.max(...xs))} | ${num(xs[xs.length - 1])} |`,
  );
}

/* ── Field utilisation ──────────────────────────────────────────────────── */

say("");
say("## 认知字段用量（对照上限）");
say("");
const u = reports.map((r) => r.utilisation);
const rows: [string, number[], number][] = [
  ["约束条数", u.map((x) => x.constraints), L.maxDerivedConstraints],
  ["假设条数", u.map((x) => x.hypotheses), L.maxHypotheses],
  ["档案证据条数", u.map((x) => x.dossierEntries), L.evidenceForPerSeat * 10 * 2],
  ["公开承诺条数", u.map((x) => x.commitments), L.maxPublicCommitments],
  ["单条证据字数", u.map((x) => x.maxEvidenceChars), L.evidenceChars],
  ["单条约束字数", u.map((x) => x.maxConstraintChars), L.constraintStatementChars],
  ["身份计划字数", u.map((x) => x.rolePlanChars), L.rolePlanChars],
];
say("| 字段 | 中位 | p90 | 最大 | 上限 | 峰值占比 |");
say("|---|---|---|---|---|---|");
for (const [name, xs, limit] of rows) {
  const max = Math.max(...xs);
  say(
    `| ${name} | ${num(q(xs, 0.5))} | ${num(q(xs, 0.9))} | ${num(max)} | ${num(limit)} | ${((max / limit) * 100).toFixed(0)}% |`,
  );
}

/* ── Bounds violations ──────────────────────────────────────────────────── */

say("");
say("## 越界");
say("");
const violating = reports.filter((r) => r.boundsViolations > 0);
say(`越界的响应：**${violating.length} / ${reports.length}**`);
if (violating.length > 0) {
  const bySeat = new Map<number, number>();
  for (const r of violating) bySeat.set(r.seat, (bySeat.get(r.seat) ?? 0) + 1);
  say("");
  say("按座位：" + [...bySeat].map(([s, n]) => `${s}号 ${n} 次`).join("，"));
  say("");
  say("（字段类型需要看具体响应，遥测只记数量。上限是护栏，越界不截断。）");
}

/* ── Hypotheses over time ───────────────────────────────────────────────── */

say("");
say("## 每座位维护的假设数（随时间）");
say("");
const seats = [...new Set(reports.map((r) => r.seat))].sort((a, b) => a - b);
say("| 座位 | 决策次数 | 假设数（首/中/末） | 始终 ≥2 |");
say("|---|---|---|---|");
for (const seat of seats) {
  const mine = reports.filter((r) => r.seat === seat);
  const hs = mine.map((r) => r.utilisation.hypotheses);
  const always = hs.every((h) => h >= L.minHypotheses);
  say(
    `| ${seat}号 | ${mine.length} | ${hs[0]} / ${q(hs, 0.5)} / ${hs[hs.length - 1]} | ${always ? "✓" : "✗"} |`,
  );
}

/* ── Unverified premises ────────────────────────────────────────────────── */

say("");
say("## 建立在未证实前提上的约束");
say("");
const unverified = u.map((x) => x.unverifiedConstraints);
const totalConstraints = u.map((x) => x.constraints);
say(`峰值：${Math.max(...unverified)} 条（同时期约束总数峰值 ${Math.max(...totalConstraints)}）`);
const withUnverified = reports.filter((r) => r.utilisation.unverifiedConstraints > 0).length;
say(`有未证实约束的响应：${withUnverified} / ${reports.length}`);
say("");
say(`模型引用了裁判事实表里不存在的前提（被系统改判）：` +
  `${reports.reduce((a, r) => a + r.premisesOverridden, 0)} 次`);

/* ── Output side ────────────────────────────────────────────────────────── */

say("");
say("## 输出侧");
say("");
const withUsage = attempts.filter((a) => a.usage !== null);
const outs = withUsage.map((a) => a.usage!.outputTokens);
const reasoning = withUsage.map((a) => a.usage!.reasoningTokens);
const cap = Number(manifest?.maxOutputTokens ?? 0);
say("| | token |");
say("|---|---|");
say(`| 输出中位 | ${num(q(outs, 0.5))} |`);
say(`| 输出 p90 | ${num(q(outs, 0.9))} |`);
say(`| 输出最大 | ${num(Math.max(...outs))} |`);
say(`| 其中推理最大 | ${num(Math.max(...reasoning))} |`);
say(`| 上限 | ${num(cap)} |`);
say(`| 峰值余量 | ${num(cap - Math.max(...outs))} |`);
say("");
const exhausted = attempts.filter((a) => a.outcome === "output_limit");
say(`撞到输出上限：**${exhausted.length} 次**`);
say(
  `推理占输出比例：中位 ${(
    (q(withUsage.map((a) => a.usage!.reasoningTokens / Math.max(1, a.usage!.outputTokens)), 0.5)) * 100
  ).toFixed(0)}%`,
);

/* ── Attempt breakdown ──────────────────────────────────────────────────── */

say("");
say("## 请求分类");
say("");
const byOutcome = new Map<string, number>();
for (const a of attempts) byOutcome.set(a.outcome, (byOutcome.get(a.outcome) ?? 0) + 1);
say("| 结果 | 次数 |");
say("|---|---|");
for (const [k, v] of byOutcome) say(`| ${k} | ${v} |`);
say("");
say(`容量重试（capacityAttempt>1）：${attempts.filter((a) => a.capacityAttempt > 1).length}`);
// `attempt > 1` counts EVERY re-ask, and the runner re-asks for three
// different reasons. Reporting them as one number sent me looking at the
// wrong half once already, so they are split here.
const reasked = attempts.filter((a) => a.attempt > 1);
const malformed = attempts.filter((a) => a.outcome === "invalid").length;
const refused = attempts.filter((a) => a.outcome === "valid" && !a.appliedLegalAction);
const by = (kind: string) => refused.filter((a) => a.rejectedBy === kind).length;
const unlabelled = refused.filter((a) => !a.rejectedBy).length;
say(`重问（attempt>1）合计：${reasked.length}`);
say(`  动作格式错（outcome=invalid）：${malformed}`);
say(`  答案被打回但动作解析没问题：${refused.length}`);
say(`    裁判判非法：${by("referee")}`);
say(`    cognition 块不合法：${by("cognition")}`);
say(`    其他（动作层面）：${by("action-format")}`);
if (unlabelled > 0) {
  // The M5 pilot's five. Reported as referee rejections in that game's write-up
  // and later shown by replay to be cognition blocks, every one. Guessing here
  // is what produced the wrong number, so this line refuses to guess.
  say(`    未记录原因：${unlabelled}（M5.1 之前的产物没有 rejectedBy —— ` +
    `要判定原因请跑 scripts/why-reasked.ts）`);
}

/* ── Latency ────────────────────────────────────────────────────────────── */

say("");
say("## 延迟");
say("");
const lat = attempts.map((a) => a.latencyMs).filter((x) => x > 0);
say(`中位 ${(q(lat, 0.5) / 1000).toFixed(1)}s，p90 ${(q(lat, 0.9) / 1000).toFixed(1)}s，` +
  `最大 ${(Math.max(...lat) / 1000).toFixed(1)}s，合计 ${(lat.reduce((a, b) => a + b, 0) / 60000).toFixed(1)} 分钟`);

/* ── Max request ────────────────────────────────────────────────────────── */

say("");
say("## 单次请求最大体量");
say("");
const maxChars = Math.max(...attempts.map((a) => a.totalInputChars));
const maxReal = Math.max(...withUsage.map((a) => a.usage!.inputTokens));
const maxEst = Math.max(...attempts.map((a) => a.estimatedInputTokens));
say(`字符 ${num(maxChars)}　估算 ${num(maxEst)} token　provider 实报 ${num(maxReal)} token`);
say(`估算/实报 = ${(maxEst / Math.max(1, maxReal)).toFixed(2)}×`);
say(`距 250,000 硬闸还有 ${((1 - maxReal / 250000) * 100).toFixed(1)}%`);
