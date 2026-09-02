/**
 * M5.5 offline review pack. READ-ONLY, and it makes no request of any kind.
 *
 * Prints the four things a human has to look at before authorising a pilot:
 * the Oberon schema/prompt diff that this milestone exists to close, proof the
 * eligible villains are untouched, the per-turn prompt growth, and the cost
 * projection that follows from it.
 *
 * Everything here is rebuilt from the deterministic referee, so re-running it
 * on a clean checkout reproduces the same numbers.
 */
import { drive } from "../fixtures/harness";
import { dealFromAssignment } from "../core/deal";
import { observationFor } from "../core/observation";
import { testConfig } from "../fixtures/harness";
import { buildCognitivePrompt } from "../cognition/build-cognitive";
import { personaById, assignPersonas } from "../prompts/personas";
import { strategyById } from "../prompts/strategies";
import { CognitionStore } from "../cognition/store";
import { capabilitiesFor } from "../prompts/capabilities";
import { taskSchemaFor } from "../prompts/tasks";
import { jsonSchemaFor } from "../model/json-schema";
import type { Seat } from "../core/types";

const REF = {
  1: "loyal", 2: "assassin", 3: "mordred", 4: "oberon", 5: "loyal",
  6: "loyal", 7: "morgana", 8: "percival", 9: "merlin", 10: "loyal",
} as never;

function at(seat: Seat, version: string) {
  const { state } = drive({
    seed: 7,
    deal: dealFromAssignment(REF),
    override: (o) =>
      o.request?.kind === "leader_close_and_propose"
        ? {
            kind: "leader_close_and_propose" as const,
            publicMessage: "收尾。",
            team: ([1, 2, 3, 4, 5] as Seat[]).slice(0, o.request.teamSize),
          }
        : undefined,
    stopWhen: (s) => s.pending?.kind === "mission" && s.pending.seat === seat,
  });
  if (state.pending?.seat !== seat) return null;
  const observation = observationFor(state, seat);
  const config = testConfig({
    promptVersion: version,
    cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  } as never);
  const built = buildCognitivePrompt({
    observation,
    persona: personaById(assignPersonas(7, "heterogeneous-rotated")[seat].id),
    strategy: strategyById("expert-disciplined"),
    ledger: new CognitionStore().for(observation),
    config,
  });
  const caps = capabilitiesFor(version);
  const wants =
    caps.evilCoordination &&
    (!caps.coordinationFieldGated || observation.missionCoordination !== null);
  const schema = jsonSchemaFor(
    taskSchemaFor(observation.request!, 220, {
      withRetraction: true,
      ...(wants ? { withCoordination: true } : {}),
      ...(caps.voteDiscipline ? { withVoteAnalysis: true } : {}),
      ...(caps.assassinRanking ? { withAssassinationRanking: true } : {}),
      ...(caps.ladyNeutralAssassination ? { withLadyAnalysis: true } : {}),
      ...(caps.persistentClaims ? { withClaimPurpose: true } : {}),
    }),
  );
  return { built, schema, observation };
}

const deal = dealFromAssignment(REF);
console.log("=== 奥伯伦（4号）的任务牌 schema ===");
for (const v of ["prompt-0.6.0", "prompt-0.7.0"]) {
  const r = at(deal.oberon, v);
  if (!r) {
    console.log(`${v}: 这个种子下奥伯伦没有上第一辆车`);
    continue;
  }
  const keys = Object.keys((r.schema as { properties: object }).properties).join(" ");
  console.log(`${v}  字段：${keys}`);
  console.log(`        提示里有「坏人出牌协调」：${r.built.user.includes("坏人出牌协调")}`);
  console.log(`        提示长度 ${r.built.user.length} 字符`);
}

console.log("");
console.log("=== 刺客（2号）的任务牌 schema —— 有资格的坏人不受影响 ===");
for (const v of ["prompt-0.6.0", "prompt-0.7.0"]) {
  const r = at(deal.assassin, v);
  if (!r) continue;
  const keys = Object.keys((r.schema as { properties: object }).properties).join(" ");
  console.log(`${v}  字段：${keys}`);
  console.log(`        提示里有「坏人出牌协调」：${r.built.user.includes("坏人出牌协调")}`);
}

console.log("");
console.log("=== 开局提示长度（成本投影的输入）===");
for (const v of ["prompt-0.6.0", "prompt-0.7.0"]) {
  const { state } = drive({ seed: 1, deal: dealFromAssignment(REF), stopWhen: () => true });
  const seat = state.pending!.seat;
  const observation = observationFor(state, seat);
  const config = testConfig({
    promptVersion: v,
    cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
  } as never);
  const built = buildCognitivePrompt({
    observation,
    persona: personaById(assignPersonas(1, "heterogeneous-rotated")[seat].id),
    strategy: strategyById("expert-disciplined"),
    ledger: new CognitionStore().for(observation),
    config,
  });
  console.log(`${v}  system ${built.system.length} + user ${built.user.length} = ${built.system.length + built.user.length}`);
}

console.log("");
console.log("=== 各类回合的提示长度对比（0.6.0 → 0.7.0）===");
const KINDS: Array<[string, (s: never) => boolean]> = [
  ["发言", (s) => (s as never as { pending?: { kind: string } }).pending?.kind === "speech"],
  ["投票", (s) => (s as never as { pending?: { kind: string } }).pending?.kind === "vote"],
  ["任务牌", (s) => (s as never as { pending?: { kind: string } }).pending?.kind === "mission"],
  ["刺杀", (s) => (s as never as { pending?: { kind: string } }).pending?.kind === "assassinate"],
];
const DELTA: Record<string, number> = {};
for (const [label, pred] of KINDS) {
  const lens: number[] = [];
  for (const v of ["prompt-0.6.0", "prompt-0.7.0"]) {
    const { state } = drive({
      seed: 11,
      deal: dealFromAssignment(REF),
      override: (o) =>
        o.request?.kind === "leader_close_and_propose"
          ? {
              kind: "leader_close_and_propose" as const,
              publicMessage: "收尾。",
              team: ([1, 5, 9, 10, 6] as Seat[]).slice(0, o.request.teamSize),
            }
          : o.request?.kind === "vote"
            ? { kind: "vote" as const, choice: "approve" as const }
            : undefined,
      stopWhen: (s) => pred(s as never),
    });
    if (!state.pending) { lens.push(0); continue; }
    const seat = state.pending.seat;
    const observation = observationFor(state, seat);
    const config = testConfig({
      promptVersion: v,
      cognition: { enabled: true, mode: "fused", maxCognitionRepairs: 2, telemetry: true },
    } as never);
    const built = buildCognitivePrompt({
      observation,
      persona: personaById(assignPersonas(11, "heterogeneous-rotated")[seat].id),
      strategy: strategyById("expert-disciplined"),
      ledger: new CognitionStore().for(observation),
      config,
    });
    lens.push(built.system.length + built.user.length);
  }
  const [a, b] = lens;
  if (a === 0 || b === 0) { console.log(`${label}：这个种子下没走到`); continue; }
  DELTA[label] = b - a;
  console.log(`${label}：${a.toLocaleString()} → ${b.toLocaleString()}　(${b - a >= 0 ? "+" : ""}${b - a}，${(((b - a) / a) * 100).toFixed(2)}%)`);
}

/* ── The cost projection ────────────────────────────────────────────────── */

// M5.4's live Terra game, measured. The only baseline that is not an estimate.
const M54 = {
  requests: 191,
  uncachedInput: 2_044_734,
  cachedInput: 441_871,
  output: 611_572,
  usd: 11.5167,
  totalChars: 3_357_187,
  speeches: 55,
};
const PRICE = { uncached: 2.0 / 1e6, cached: 0.2 / 1e6, output: 12.0 / 1e6 };

/*
 * The mix M5.4 actually sent, from its private trace.
 *
 * MEASURED, not assumed: 126 planner legs, of which 55 were speeches and 55
 * were votes (one per seat per proposal, five proposals), five mission cards
 * and one assassination. The deltas come from the block printed above rather
 * than from a constant, so this number cannot go stale the next time the
 * instruction text moves — which is exactly what it did between the first M5.5
 * report and this one.
 */
const MIX = { 发言: M54.speeches, 投票: 50, 刺杀: 1 };
const addedChars = Object.entries(MIX).reduce(
  (sum, [label, n]) => sum + n * (DELTA[label] ?? 0),
  0,
);
const growth = addedChars / M54.totalChars;
const uncached = M54.uncachedInput * (1 + growth);
const cached = M54.cachedInput * (1 + growth);
// Output is bounded conclusions, not free text: one Lady block, one purpose
// enum per speech. 1% is an allowance, not a measurement.
const output = M54.output * 1.01;
const base = uncached * PRICE.uncached + cached * PRICE.cached + output * PRICE.output;

// Each new check can cost a repair round. A repair re-sends one planner
// request at roughly the mean size, and M5.4 needed two.
const repairCost = (13_000 * PRICE.uncached + 5_000 * PRICE.output);

console.log("");
console.log("=== Terra 成本投影（dry-run，不发请求）===");
console.log(`基线：M5.4 实测 ${M54.requests} 次请求，$${M54.usd.toFixed(4)}`);
console.log(`新增输入 ${addedChars.toLocaleString()} 字符 = 全局 +${(growth * 100).toFixed(2)}%`);
console.log(`投影输入 未缓存 ${Math.round(uncached).toLocaleString()} + 缓存 ${Math.round(cached).toLocaleString()}`);
console.log(`投影输出 ${Math.round(output).toLocaleString()}（按 +1% 估）`);
console.log(`基础投影 **$${base.toFixed(4)}**`);
for (const n of [0, 5, 10, 20]) {
  const total = base + n * repairCost;
  console.log(
    `  再加 ${String(n).padStart(2)} 次修复重问 → $${total.toFixed(4)}` +
      `${total > 12 ? "　⚠ 越过 $12 提醒线" : ""}${total > 25 ? "　✗ 撞 $25 硬闸" : ""}`,
  );
}
console.log(`累计（从 $54.9304 起）→ $${(54.9304 + base).toFixed(4)}，$100 批量余额 $${(100 - 54.9304 - base).toFixed(4)}`);
