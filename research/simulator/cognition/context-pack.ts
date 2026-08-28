/**
 * A bounded prompt that never loses a fact.
 *
 * THE PROBLEM, measured rather than assumed. Full-history stateless prompting
 * makes one game's cumulative input ~O(N²): the third paid game carried 90
 * public events into its last request, 18,099 characters, and cumulative input
 * reached 1.32M tokens. Per request that is fine — 14,706 provider-reported
 * tokens against a 250,000 ceiling, a 17× margin. Cumulatively it is the bill.
 * So compaction here is a COST measure, not a feasibility one, and the design
 * says so plainly because the opposite belief would justify much more
 * aggressive trimming than the evidence supports.
 *
 * THE RULE THAT MAKES IT SAFE. Compaction may only ever shorten ARGUMENT.
 * Facts are never summarised, never sampled, never dropped:
 *
 *   mission teams / results / fail counts        never compacted
 *   every proposal and every vote                never compacted
 *   role claims and retractions                  never compacted
 *   Lady holders / targets / announcements       never compacted
 *   current leader, direction, attempt           never compacted
 *   failed-team constraints                      never compacted
 *   the seat's own private hard facts            never compacted
 *   unresolved premise dependencies              never compacted
 *   the seat's own public commitments            never compacted
 *
 * Everything on that list comes from the referee and is rendered as a compact
 * TABLE, which is both smaller than the prose it replaces and lossless.
 * `compactionCompleteness` re-derives the list from a pack and reports what is
 * missing, so "never compacted" is a checked property rather than a promise.
 *
 * NO FREE-FORM SUMMARY IS EVER THE ONLY COPY OF A FACT. Older discussion is
 * summarised, but every fact those arguments referred to is still in the fact
 * tables above them. If a summary is wrong or lossy, the underlying facts are
 * unaffected — which is the difference between a compacted context and a
 * lossy one.
 *
 * COMPACTION COSTS NO EXTRA CALL. The normal action response carries the
 * cognition update (see `protocol.ts`), so the agent's own summaries are
 * produced as a side effect of moves it was going to make anyway. A separate
 * summarisation call would double the request count for a game that already
 * spends 133-192 of them.
 *
 * STATUS: offline scaffolding. Not imported by the live path.
 */

import type { PublicEvent } from "../core/events";
import { deepFreeze } from "../core/freeze";
import type { Observation } from "../core/observation";
import { pessimisticTokenEstimate } from "../model/pricing";
import type { Seat } from "../core/types";
import { claimContestFrom, renderClaimContest } from "./claim-contest";
import type {
  DerivedConstraint,
  EpistemicLedger,
  PublicClaim,
  PublicHardFact,
} from "./ledger";
import {
  CURRENT_STATE_ID,
  FACT_ID_LEGEND,
  PRIVATE_IDS,
  failComparisonId,
  failConstraintId,
  ladyResultId,
} from "./fact-ids";
import { COGNITION_LIMITS as L, CONTEXT_BUDGET, contentChars } from "./limits";

/* ── The pack ───────────────────────────────────────────────────────────── */

/** One older argument, compressed. MODEL-OWNED and bounded. */
export interface ArgumentSummary {
  readonly missionNumber: number;
  readonly attempt: number;
  readonly text: string;
  /** Sequences this summary stands in for. Kept so a reader can go look. */
  readonly coversSequences: readonly number[];
}

export interface ContextPack {
  readonly seat: Seat;
  readonly atSequence: number;

  /* ── Lossless, referee-generated ─────────────────────────────────────── */
  readonly factTables: string;
  readonly ownPrivateFacts: string;
  /**
   * The public claim contest, as a table. Empty before `prompt-0.4.0`.
   *
   * Kept as its own section rather than folded into `factTables` because it is
   * the one part of the pack whose SIZE is driven by how much the table is
   * fighting rather than by how long the game is — a quiet game renders one
   * line here, a three-way Percival contest renders thirty.
   */
  readonly claimContest: string;

  /* ── The agent's own bounded cognition ───────────────────────────────── */
  readonly cognition: string;

  /* ── Verbatim, because recency is where the game is decided ──────────── */
  /** Every event since this seat last acted. Never summarised. */
  readonly sinceMyLastAction: readonly PublicEvent[];
  /** The current proposal cycle's dialogue, verbatim. */
  readonly currentCycle: readonly PublicEvent[];

  /* ── Compacted, and only ever argument ───────────────────────────────── */
  readonly olderArguments: readonly ArgumentSummary[];

  /* ── The ask ─────────────────────────────────────────────────────────── */
  readonly taskAndSchema: string;

  readonly diagnostics: PackDiagnostics;
}

export interface PackDiagnostics {
  readonly estimatedTokens: number;
  readonly compacted: boolean;
  readonly compactionTrigger: CompactionTrigger | null;
  readonly verbatimEventCount: number;
  readonly summarisedEventCount: number;
  readonly overSoftTarget: boolean;
  readonly overHardCeiling: boolean;
}

/**
 * Why compaction ran. Deterministic, so two identical observations compact
 * identically — the property `deterministicPacking` tests.
 */
export type CompactionTrigger =
  | { readonly kind: "soft_target"; readonly estimatedTokens: number }
  | { readonly kind: "event_count"; readonly events: number }
  | { readonly kind: "cycle_age"; readonly cyclesOlderThan: number };

/** Above this many public events, older cycles compact regardless of size. */
export const COMPACT_ABOVE_EVENTS = 60;
/** Proposal cycles older than this many are candidates for summary. */
export const KEEP_RECENT_CYCLES = 1;

/* ── Lossless fact tables ───────────────────────────────────────────────── */

const seatList = (seats: readonly Seat[]) => seats.join("、");

/**
 * Whether the tables carry citable ids.
 *
 * OFF is `prompt-0.3.0`, byte for byte. The completed pilot's prompts have to
 * stay rebuildable from a checkout, so the repair is a new rendering mode
 * rather than an edit to the old one — the same reason `m5-pilot.json` exists
 * instead of a temporary change to `default.json`.
 */
export interface FactTableOptions {
  readonly withIds?: boolean;
}

/** ``[id]`` as it appears in front of a line. */
const tag = (id: string) => `\`[${id}]\``;

/**
 * The never-compacted core, as tables.
 *
 * Tables rather than sentences because the same information costs perhaps a
 * third as many tokens and reads unambiguously — and because a table is
 * mechanically checkable for completeness, which prose is not.
 *
 * With `withIds`, every referenceable line is prefixed by the canonical id from
 * `fact-ids.ts`. That is the M5.1 repair: the pilot asked for `premiseIds` and
 * then rendered no ids, so the model invented them and every premise it cited
 * came back unverified.
 */
export function renderFactTables(
  facts: readonly PublicHardFact[],
  claims: readonly PublicClaim[],
  observation: Observation,
  options: FactTableOptions = {},
): string {
  const ids = options.withIds === true;
  const p = observation.position;
  const lines: string[] = ["## 硬事实（裁判记录，不可改写）"];
  if (ids) lines.push("", FACT_ID_LEGEND);

  lines.push(
    "",
    ids ? `### 当前局面 ${tag(CURRENT_STATE_ID)}` : "### 当前局面",
    `第 ${p.missionNumber} 轮，第 ${p.attempt} 次点车，连否 ${p.rejectionStreak} 次`,
    `队长 ${p.leader}号，行进方向 ${p.playDirection ?? "未定"}`,
    `比分 好人 ${p.successes} : 坏人 ${p.fails}`,
    `本轮上车 ${p.teamSizeThisMission} 人，需要 ${p.failsRequiredThisMission} 张失败票才挂`,
  );

  const missions = facts.filter((f) => f.kind === "mission_result");
  lines.push("", "### 任务结果");
  if (missions.length === 0) lines.push("（还没有任务结算）");
  for (const m of missions) {
    if (m.kind !== "mission_result") continue;
    lines.push(
      `- ${ids ? `${tag(m.id)} ` : ""}第 ${m.missionNumber} 轮 ${m.result === "success" ? "成功" : "失败"}　` +
        `上车 ${seatList(m.team)}号　公开失败票 ${m.failCount}`,
    );
  }

  lines.push("", "### 提案与投票");
  const proposals = facts.filter((f) => f.kind === "proposal");
  const votes = facts.filter((f) => f.kind === "vote");
  if (proposals.length === 0) lines.push("（还没有提案）");
  for (const proposal of proposals) {
    if (proposal.kind !== "proposal") continue;
    const vote = votes.find(
      (v) =>
        v.kind === "vote" &&
        v.missionNumber === proposal.missionNumber &&
        v.attempt === proposal.attempt,
    );
    lines.push(
      `- ${ids ? `${tag(proposal.id)} ` : ""}R${proposal.missionNumber}#${proposal.attempt} ${proposal.leader}号发车 ${seatList(proposal.team)}号`,
    );
    if (vote && vote.kind === "vote") {
      const rejecters = Object.entries(vote.votes)
        .filter(([, v]) => v === "reject")
        .map(([s]) => s);
      lines.push(
        `    ${ids ? `${tag(vote.id)} ` : ""}${vote.result === "passed" ? "车过了" : "车被否"}　` +
          `反对：${rejecters.length > 0 ? `${rejecters.join("、")}号` : "无"}`,
      );
    }
  }

  lines.push("", "### 湖中女神");
  const ladyFacts = facts.filter(
    (f) => f.kind === "lady_announcement" || f.kind === "lady_transfer",
  );
  if (ladyFacts.length === 0) lines.push("（还没有验人）");
  for (const f of ladyFacts) {
    if (f.kind === "lady_announcement") {
      // Two ids on one line, because it is two different things: the referee
      // recorded that an announcement happened, and a player asserted its
      // content. Citing the first as if it settled the second is the exact
      // collapse Experiment 3 lost a game to.
      const claim = claims.find((c) => c.kind === "lady_claim" && c.provenance.kind === "table-claim" && c.seat === f.holder && c.target === f.target);
      const marks = ids ? `${tag(f.id)}${claim ? `／宣称 ${tag(claim.id)}` : ""} ` : "";
      lines.push(`- ${marks}${f.holder}号 验了 ${f.target}号，**公开宣称**「${f.announced}」（这是他说的，不是裁判说的）`);
    } else if (f.kind === "lady_transfer") {
      lines.push(`- ${ids ? `${tag(f.id)} ` : ""}令牌 ${f.from}号 → ${f.to}号`);
    }
  }
  lines.push(`当前令牌在 ${p.ladyHolder ?? "无人"}号手上，已经验过 ${p.ladyChecksDone} 次`);

  lines.push("", "## 公开说法（有人这么说过，不等于真的）");
  const roleClaims = claims.filter((c) => c.kind === "role_claim");
  if (roleClaims.length === 0) lines.push("（还没有人跳身份）");
  for (const c of roleClaims) {
    if (c.kind !== "role_claim") continue;
    lines.push(
      `- ${ids ? `${tag(c.id)} ` : ""}${c.seat}号 在 seq ${c.sinceSequence} 声称自己是 ${c.claimed}` +
        (c.retractedAtSequence !== null ? `（seq ${c.retractedAtSequence} 改口了）` : ""),
    );
  }

  return lines.join("\n");
}

/**
 * Constraints a failed mission imposes, generated by the referee's own facts.
 *
 * Generated rather than left to the model on purpose. This is the reasoning
 * step Experiment 3 got right and Experiment 2 mostly did not, and it is pure
 * arithmetic over public facts — so there is no reason to spend reasoning
 * tokens rediscovering it each turn, and no reason to risk getting it wrong.
 */
export function failedTeamConstraints(facts: readonly PublicHardFact[]): string[] {
  return failedTeamConstraintEntries(facts).map((e) => e.text);
}

/** The same arithmetic, each line carrying the id a premise may cite it by. */
export function failedTeamConstraintEntries(
  facts: readonly PublicHardFact[],
): { readonly id: string; readonly text: string }[] {
  const failures = facts.filter(
    (f): f is Extract<PublicHardFact, { kind: "mission_result" }> =>
      f.kind === "mission_result" && f.result === "fail",
  );
  const lines: { id: string; text: string }[] = [];
  for (const f of failures) {
    lines.push({
      id: failConstraintId(f.missionNumber),
      text:
        `第 ${f.missionNumber} 轮 ${seatList(f.team)}号 里**至少有 ${f.failCount} 个坏人**` +
        `（这只说明至少，没说明是谁，也没洗清车上其他人）`,
    });
  }
  // Pairwise intersections and differences: the comparison the playbook asks
  // for, computed once here so every seat starts from the same arithmetic.
  for (let i = 0; i < failures.length; i += 1) {
    for (let j = i + 1; j < failures.length; j += 1) {
      const a = failures[i];
      const b = failures[j];
      const both = a.team.filter((s) => b.team.includes(s));
      const onlyA = a.team.filter((s) => !b.team.includes(s));
      const onlyB = b.team.filter((s) => !a.team.includes(s));
      lines.push({
        id: failComparisonId(a.missionNumber, b.missionNumber),
        text:
          `第 ${a.missionNumber} 轮与第 ${b.missionNumber} 轮：` +
          `交集 ${both.length > 0 ? `${seatList(both)}号` : "空"}，` +
          `只在前者 ${onlyA.length > 0 ? `${seatList(onlyA)}号` : "空"}，` +
          `只在后者 ${onlyB.length > 0 ? `${seatList(onlyB)}号` : "空"}`,
      });
    }
  }
  return lines;
}

/**
 * The seat's own private hard facts. Never compacted, never shared.
 *
 * With `withIds`, each line carries a `p…` id. Those ids are minted ONLY into
 * the registry of the seat entitled to the fact, so an unauthorised seat that
 * writes `p.pair` — having, say, read one in somebody's published trace — gets
 * `unknown` from its own registry and the premise stays unverified. The gate is
 * the registry, not the rendering; this just makes the ids quotable.
 */
export function renderOwnPrivateFacts(
  observation: Observation,
  options: FactTableOptions = {},
): string {
  const ids = options.withIds === true;
  const lines = ["## 只有你知道的硬信息"];
  lines.push(
    `${ids ? `${tag(PRIVATE_IDS.self)} ` : ""}你是 ${observation.seat}号，身份 ${observation.role}。`,
  );

  const k = observation.knowledge;
  switch (k.kind) {
    case "none":
      lines.push("规则没有给你任何关于别人身份的信息。");
      break;
    case "sees_evil":
      lines.push(
        `${ids ? `${tag(PRIVATE_IDS.seesEvil)} ` : ""}你看得见的坏人是 ${seatList(k.seats)}号 —— 但**莫德雷德你看不见**。`,
      );
      break;
    case "knows_teammates":
      lines.push(
        `${ids ? `${tag(PRIVATE_IDS.teammates)} ` : ""}你的同伴是 ${seatList(k.seats)}号 —— 奥伯伦不在其中，你也不知道他是谁。`,
      );
      break;
    case "merlin_or_morgana":
      lines.push(
        `${ids ? `${tag(PRIVATE_IDS.percivalPair)} ` : ""}${seatList(k.pair)}号 这两个人里，一个是梅林，一个是莫甘娜，你分不出哪个是哪个。`,
      );
      break;
  }

  if (observation.ladyResults.length > 0) {
    lines.push("", "你自己验到的（永久有效，谁也改不了）：");
    for (const r of observation.ladyResults) {
      lines.push(
        `- ${ids ? `${tag(ladyResultId(r.missionNumber))} ` : ""}第 ${r.missionNumber} 轮后，你验 ${r.target}号，真实是 ${r.trueSide}`,
      );
    }
  }
  // Gated on the seat's OWN side rather than on the array being non-empty.
  // `observationFor` already guarantees a good seat receives none — this is the
  // second lock: a malformed observation carrying somebody else's discussion
  // still renders nothing, so the pack cannot become a leak path on its own.
  if (observation.side === "evil" && observation.evilDiscussion.length > 0) {
    lines.push("", "坏人密谈：");
    for (const line of observation.evilDiscussion) {
      lines.push(`- ${line.speaker}号：${line.message}`);
    }
  }
  return lines.join("\n");
}

/* ── Slicing the log ────────────────────────────────────────────────────── */

/** Events belonging to the current mission and attempt. */
export function currentCycleEvents(
  log: readonly PublicEvent[],
  missionNumber: number,
  attempt: number,
): PublicEvent[] {
  return log.filter((e) => e.missionNumber === missionNumber && e.attempt === attempt);
}

/** Everything after the seat's last action. Verbatim, always. */
export function eventsSince(
  log: readonly PublicEvent[],
  lastProcessedSequence: number,
): PublicEvent[] {
  return log.filter((e) => e.sequence > lastProcessedSequence);
}

/* ── Compaction ─────────────────────────────────────────────────────────── */

/**
 * Should this pack compact, and why?
 *
 * Deterministic and total: given the same observation and the same estimate,
 * the answer is always the same trigger. No randomness, no clock, no model.
 */
export function compactionTrigger(
  estimatedTokens: number,
  publicEventCount: number,
  cyclesOld: number,
): CompactionTrigger | null {
  if (estimatedTokens > CONTEXT_BUDGET.softTargetTokens) {
    return { kind: "soft_target", estimatedTokens };
  }
  if (publicEventCount > COMPACT_ABOVE_EVENTS) {
    return { kind: "event_count", events: publicEventCount };
  }
  if (cyclesOld > KEEP_RECENT_CYCLES) {
    return { kind: "cycle_age", cyclesOlderThan: KEEP_RECENT_CYCLES };
  }
  return null;
}

/**
 * Which events may be replaced by a summary.
 *
 * ONLY speeches, and only ones outside the recent window. Everything else in
 * the log is a fact and is already in the tables — dropping the verbatim
 * speech that surrounded a vote loses the argument, never the vote.
 */
export function compactableEvents(
  log: readonly PublicEvent[],
  keepFromSequence: number,
): PublicEvent[] {
  return log.filter((e) => e.type === "speech" && e.sequence < keepFromSequence);
}

/* ── Packing ────────────────────────────────────────────────────────────── */

export interface PackInput {
  readonly observation: Observation;
  readonly ledger: EpistemicLedger;
  readonly cognitionText: string;
  readonly taskAndSchema: string;
  readonly olderArguments: readonly ArgumentSummary[];
  /** `prompt-0.3.1` renders citable ids. Absent means the frozen 0.3.0 bytes. */
  readonly withIds?: boolean;
  /** `prompt-0.4.0` renders the public claim contest. */
  readonly withClaimContest?: boolean;
}

/**
 * Build the pack. Pure, deterministic, and makes no request of any kind.
 */
export function packContext(input: PackInput): ContextPack {
  const { observation, ledger } = input;
  const withIds = input.withIds === true;
  const p = observation.position;
  const log = observation.publicLog;

  const factTables = [
    renderFactTables(ledger.publicFacts, ledger.claims, observation, { withIds }),
    "",
    "### 挂掉的车给出的约束（裁判事实推出来的算术，不是谁的意见）",
    ...failedTeamConstraintEntries(ledger.publicFacts).map((e) =>
      withIds ? `- ${tag(e.id)} ${e.text}` : `- ${e.text}`,
    ),
  ].join("\n");

  const ownPrivateFacts = renderOwnPrivateFacts(observation, { withIds });
  // Derived from the log, not carried: the contest is referee-owned and must
  // always be exactly what the referee's own events say right now.
  const claimContest =
    input.withClaimContest === true ? renderClaimContest(claimContestFrom(log)) : "";
  const currentCycle = currentCycleEvents(log, p.missionNumber, p.attempt);
  const sinceMyLastAction = eventsSince(log, ledger.self.lastProcessedSequence);

  const keepFrom = currentCycle.length > 0 ? currentCycle[0].sequence : 0;
  const compactable = compactableEvents(log, keepFrom);

  const verbatimSet = new Set<number>([
    ...currentCycle.map((e) => e.sequence),
    ...sinceMyLastAction.map((e) => e.sequence),
  ]);

  const bodyForEstimate = [
    factTables,
    ownPrivateFacts,
    claimContest,
    input.cognitionText,
    ...sinceMyLastAction.map(describe),
    ...currentCycle.map(describe),
    ...input.olderArguments.map((a) => a.text),
    input.taskAndSchema,
  ].join("\n");

  const estimatedTokens = pessimisticTokenEstimate(bodyForEstimate);
  const trigger = compactionTrigger(estimatedTokens, log.length, p.missionNumber - 1);

  return deepFreeze({
    seat: observation.seat,
    atSequence: log.length,
    factTables,
    ownPrivateFacts,
    claimContest,
    cognition: input.cognitionText,
    sinceMyLastAction,
    currentCycle,
    olderArguments: [...input.olderArguments].slice(0, L.maxArgumentSummaries),
    taskAndSchema: input.taskAndSchema,
    diagnostics: {
      estimatedTokens,
      compacted: trigger !== null && compactable.length > 0,
      compactionTrigger: trigger,
      verbatimEventCount: verbatimSet.size,
      summarisedEventCount: compactable.filter((e) => !verbatimSet.has(e.sequence)).length,
      overSoftTarget: estimatedTokens > CONTEXT_BUDGET.softTargetTokens,
      overHardCeiling: estimatedTokens > CONTEXT_BUDGET.hardCeilingTokens,
    },
  });
}

function describe(event: PublicEvent): string {
  if (event.type === "speech") return `${event.speaker}号：${event.publicMessage}`;
  return `[${event.type}]`;
}

/** The pack as one string, in the order the model reads it. */
export function renderPack(pack: ContextPack): string {
  const parts = [pack.factTables, "", pack.ownPrivateFacts, ""];
  if (pack.claimContest) parts.push(pack.claimContest, "");
  if (pack.cognition) parts.push(pack.cognition, "");
  if (pack.olderArguments.length > 0) {
    parts.push("## 更早的讨论（已压缩；上面的硬事实是完整的）");
    for (const a of pack.olderArguments) {
      parts.push(`- R${a.missionNumber}#${a.attempt}：${a.text}`);
    }
    parts.push("");
  }
  if (pack.currentCycle.length > 0) {
    parts.push("## 这一次点车的全部发言（原文）");
    for (const e of pack.currentCycle) parts.push(describe(e));
    parts.push("");
  }
  parts.push(pack.taskAndSchema);
  return parts.join("\n");
}

/* ── Completeness ───────────────────────────────────────────────────────── */

export interface CompletenessReport {
  readonly missing: readonly string[];
  readonly complete: boolean;
}

/**
 * Re-derive the never-compact list from the rendered pack and report gaps.
 *
 * The point is that this reads the RENDERED text, not the structures that
 * produced it. A packer that built the tables correctly and then forgot to
 * include them would pass a structural check and fail this one.
 */
export function compactionCompleteness(
  pack: ContextPack,
  ledger: EpistemicLedger,
  observation: Observation,
): CompletenessReport {
  const text = renderPack(pack);
  const missing: string[] = [];

  for (const f of ledger.publicFacts) {
    switch (f.kind) {
      case "mission_result":
        if (!text.includes(`第 ${f.missionNumber} 轮`)) missing.push(`任务 ${f.missionNumber}`);
        if (!f.team.every((s) => text.includes(`${s}`))) missing.push(`任务 ${f.missionNumber} 队伍`);
        break;
      case "proposal":
        if (!text.includes(`R${f.missionNumber}#${f.attempt}`)) {
          missing.push(`提案 R${f.missionNumber}#${f.attempt}`);
        }
        break;
      case "lady_announcement":
        if (!text.includes(`${f.holder}号 验了 ${f.target}号`)) {
          missing.push(`女神公布 ${f.holder}->${f.target}`);
        }
        break;
      default:
        break;
    }
  }

  for (const c of ledger.claims) {
    if (c.kind === "role_claim" && !text.includes(`${c.seat}号 在 seq ${c.sinceSequence}`)) {
      missing.push(`身份声称 ${c.seat}号`);
    }
  }

  // The seat's own private facts, and the premise dependencies it must carry.
  if (!text.includes(`你是 ${observation.seat}号`)) missing.push("自己的身份");
  for (const r of observation.ladyResults) {
    if (!text.includes(`你验 ${r.target}号`)) missing.push(`自己的验人结果 ${r.target}`);
  }
  for (const constraint of ledger.constraints) {
    if (constraint.restsOnUnverified && !text.includes(constraint.statement)) {
      missing.push(`未证实前提的约束 ${constraint.id}`);
    }
  }
  for (const commitment of ledger.self.publicCommitments) {
    if (commitment.withdrawnAtSequence === null && !text.includes(commitment.text)) {
      missing.push(`公开承诺「${commitment.text.slice(0, 12)}…」`);
    }
  }

  return { missing, complete: missing.length === 0 };
}

/** Characters in the rendered pack, whitespace excluded. */
export function packSize(pack: ContextPack): number {
  return contentChars(renderPack(pack));
}
