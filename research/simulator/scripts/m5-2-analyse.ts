/**
 * Post-run analysis of an M5.2 claim-contest game. Offline, read-only.
 *
 * Reads the two artifacts and answers what the pilot was run to find out: did a
 * real claim contest happen, did the true Percival fight for authority, did any
 * of it move a team or a vote, and did the model actually use the rendered
 * fact ids.
 *
 * Makes no request and constructs no client. Hidden role truth is used ONLY in
 * the section marked private, and never to explain a public number.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/m5-2-analyse.ts -- <gameId>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleType } from "@/lib/types/game";
import { SEATS, type Seat, type Side } from "../core/types";
import { claimContestFrom, renderClaimContest } from "../cognition/claim-contest";
import { CONTEXT_BUDGET } from "../cognition/limits";
import type { PublicRecord, RevealedRoles } from "../cognition/metrics";
import { minorityDissentUptake } from "../cognition/metrics";
import { contestReport, type ContestObservation } from "../cognition/metrics-contest";
import { parseJsonl, type PrivateTraceLine, type PublicReplayLine } from "../run/artifacts";

const say = (...p: unknown[]) => console.log(...p);
const num = (n: number) => n.toLocaleString();
const gameId = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!gameId) {
  say("用法: ... m5-2-analyse.ts -- <gameId>");
  process.exit(2);
}

const OUT = join(process.cwd(), "research", "simulator", "out");
const privateText = readFileSync(join(OUT, "private", `${gameId}.private-trace.jsonl`), "utf8");
const publicText = readFileSync(join(OUT, "public", `${gameId}.public-replay.jsonl`), "utf8");

const priv = (t: string) =>
  (parseJsonl<PrivateTraceLine>(privateText) as unknown as { t: string; data: unknown }[])
    .filter((l) => l.t === t)
    .map((l) => l.data);
const pubEvents = (parseJsonl<PublicReplayLine>(publicText) as unknown as {
  t: string;
  data: unknown;
}[])
  .filter((l) => l.t === "event")
  .map((l) => l.data) as Record<string, unknown>[];

const manifest = priv("private-manifest")[0] as Record<string, unknown>;
const deal = manifest.deal as Record<string, RoleType>;
const roles: RevealedRoles = (() => {
  const bySeat = {} as Record<Seat, RoleType>;
  const sideOf = {} as Record<Seat, Side>;
  for (const seat of SEATS) {
    bySeat[seat] = deal[String(seat)];
    sideOf[seat] = ["morgana", "mordred", "assassin", "oberon"].includes(bySeat[seat])
      ? "evil"
      : "good";
  }
  return { bySeat, sideOf };
})();

const CONTEST = claimContestFrom(pubEvents as never);

type Report = {
  seat: number;
  taskId: string;
  attempt: number;
  premisesVerified: number;
  premisesFromClaims: number;
  premisesOverridden: number;
  unmatchedClosures: number;
  registrySize: number;
  boundsViolations: number;
  estimatedTokens: number;
  overSoftTarget: boolean;
  packSections: Record<string, number>;
  utilisation: Record<string, unknown>;
  social: Record<string, unknown> | null;
  contest: {
    ownClaimStatus: string;
    intendedClaimRole: string | null;
    act: string;
    targetSeats: number[];
    requestedTeam: number[] | null;
    requestedVote: string;
    evidenceResolves: boolean;
    stance: string;
    selectedClaimant: number | null;
    assessments: {
      seat: number;
      level: string;
      publicStatus: string;
      restsOnUnverified: boolean;
    }[];
    rivalSeats: number[];
  } | null;
};
type Attempt = {
  seat: number;
  taskId: string;
  attempt: number;
  outcome: string;
  appliedLegalAction: boolean;
  rejectedBy?: string;
  rejectionReason?: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
  raw: string | null;
};
type Action = { atSequence: number; seat: Seat; action: Record<string, unknown> };

const reports = (priv("cognition-telemetry")[0] ?? []) as Report[];
const attempts = priv("model-call") as Attempt[];
const actions = priv("action") as Action[];

/* ── Rebuild the public record the metrics need ─────────────────────────── */

const record: PublicRecord = {
  votes: pubEvents
    .filter((e) => e.type === "vote")
    .map((e) => ({
      missionNumber: Number(e.missionNumber),
      attempt: Number(e.attempt),
      leader: 1 as Seat,
      team: [] as Seat[],
      votes: e.votes as Record<Seat, "approve" | "reject">,
      result: e.result as "passed" | "rejected",
      atSequence: Number(e.sequence),
    })),
  proposals: pubEvents
    .filter((e) => e.type === "proposal")
    .map((e) => ({
      missionNumber: Number(e.missionNumber),
      attempt: Number(e.attempt),
      leader: Number(e.leader) as Seat,
      team: e.team as Seat[],
      atSequence: Number(e.sequence),
    })),
  missions: pubEvents
    .filter((e) => e.type === "mission_result")
    .map((e) => ({
      missionNumber: Number(e.missionNumber),
      result: e.result as "success" | "fail",
      atSequence: Number(e.sequence),
    })),
  speeches: pubEvents
    .filter((e) => e.type === "speech")
    .map((e) => ({
      speaker: Number(e.speaker) as Seat,
      publicMessage: String(e.publicMessage),
      atSequence: Number(e.sequence),
    })),
};
// Votes carry no roster; the preceding proposal does. Carried across so the
// vote-alignment metric sees the same team the table saw.
for (const [i, vote] of record.votes.entries()) {
  const proposal = [...record.proposals].filter((p) => p.atSequence < vote.atSequence).pop();
  if (proposal) {
    (record.votes as unknown as Record<string, unknown>[])[i].leader = proposal.leader;
    (record.votes as unknown as Record<string, unknown>[])[i].team = proposal.team;
  }
}

/**
 * One contest record per decision, stamped with the sequence it was made at.
 *
 * The telemetry does not carry a sequence, so it is recovered by pairing the
 * reports with the actions in order — both are appended once per decision, so
 * index i of one is index i of the other. Asserted below rather than assumed.
 */
const observations: ContestObservation[] = reports
  .map((r, i) => ({ r, a: actions[i] }))
  .filter(({ r, a }) => r.contest && a && a.seat === r.seat)
  .map(({ r, a }) => ({
    seat: r.seat as Seat,
    taskId: r.taskId,
    atSequence: a.atSequence,
    ownClaimStatus: r.contest!.ownClaimStatus,
    act: r.contest!.act,
    targetSeats: r.contest!.targetSeats as Seat[],
    requestedTeam: (r.contest!.requestedTeam as Seat[] | null) ?? null,
    requestedVote: r.contest!.requestedVote,
    stance: r.contest!.stance,
    selectedClaimant: (r.contest!.selectedClaimant as Seat | null) ?? null,
    assessments: r.contest!.assessments.map((x) => ({ ...x, seat: x.seat as Seat })),
    rivalSeats: r.contest!.rivalSeats as Seat[],
  }));

say(`# M5.2 实盘对局分析 —— ${gameId}`);
say("");
say(
  `报告 ${reports.length} 条 / 动作 ${actions.length} 个 / 请求 ${attempts.length} 次；` +
    `配对成功 ${observations.length} 条`,
);
if (observations.length !== reports.length) {
  say(`⚠ 有 ${reports.length - observations.length} 条报告没能和动作配上，下面的时序指标要打折扣看`);
}

/* ── A. Public course of the game ───────────────────────────────────────── */

say("");
say("## 公开进程");
say("");
say("| 轮 | 结果 | 公开失败票 | 上车 |");
say("|---|---|---|---|");
for (const m of record.missions) {
  const team = pubEvents.find(
    (e) => e.type === "mission_result" && Number(e.missionNumber) === m.missionNumber,
  )!.team as Seat[];
  say(`| ${m.missionNumber} | ${m.result === "fail" ? "失败" : "成功"} | ${pubEvents.find((e) => e.type === "mission_result" && Number(e.missionNumber) === m.missionNumber)!.failCount} | ${team.join("、")} |`);
}
say("");
say("| 提案 | 队长 | 车 | 结果 | 反对 |");
say("|---|---|---|---|---|");
for (const p of record.proposals) {
  const v = record.votes.find((x) => x.atSequence > p.atSequence);
  const rejecters = v ? SEATS.filter((s) => v.votes[s] === "reject") : [];
  say(
    `| R${p.missionNumber}#${p.attempt} | ${p.leader} | ${p.team.join("、")} | ` +
      `${v ? (v.result === "passed" ? "过" : "否") : "—"} | ${rejecters.join("、") || "无"} |`,
  );
}

/* ── B. The claim contest, publicly ─────────────────────────────────────── */

say("");
say("## 派权争夺（公开侧）");
say("");
say("```markdown");
say(renderClaimContest(CONTEST));
say("```");

const cr = contestReport(observations, CONTEST, record, roles);

say("");
say("### 声称时间线");
say("");
if (cr.timeline.events.length === 0) say("（全局没有任何身份声称）");
for (const e of cr.timeline.events) {
  say(
    `- seq ${e.sequence}　${e.seat}号　${e.kind === "claim" ? "声称" : "退水"} ${e.claimed}` +
      (e.counter ? "（对跳）" : ""),
  );
}

/* ── C. The four impact metrics, separately ─────────────────────────────── */

say("");
say("## 派权到底改变了什么");
say("");
const im = cr.impact;
say("| 指标 | 值 |");
say("|---|---|");
say(`| **changedProposal** | ${im.changedProposal} |`);
say(`| **changedVote** | ${im.changedVote} |`);
say(`| **changedEither** | ${im.changedEither} |`);
say(`| **changedBoth** | ${im.changedBoth} |`);
say(`| 提案总数 | ${im.proposals} |`);
say(`| 其中队长当时在跟某个声称者 | ${im.proposalsUnderAClaimant} |`);
say(`| 其中真的照着他要的车发了 | ${im.proposalsFollowingTheAsk} |`);
say(`| 投票总数 | ${im.votes} |`);
say(`| 可比较的跟随者票 | ${im.voteFollowingsCompared} |`);
say(`| 按明确请求投的（强证据） | ${im.votesMatchingAnExplicitAsk} |`);
say(`| 只是和声称者投得一样（弱证据） | ${im.votesMatchingTheClaimant} |`);

say("");
say("## 其余争夺指标");
say("");
say(`- 声称 ${cr.timeline.total} 次（其中派西维尔 ${cr.timeline.percivalClaims} 次），对跳 ${cr.timeline.counterclaims} 次，退水 ${cr.timeline.retractions} 次`);
say(`- 对跳延迟：${cr.latency.pairs} 对，平均 ${cr.latency.meanSequences.toFixed(1)} 个 sequence，最快 ${cr.latency.fastest ?? "—"}`);
say(`- 同时在场的声称者：${cr.activeByTurn.map((p) => `seq${p.sequence}→${p.active}`).join("，") || "—"}`);
say(`- 攻击边 ${cr.attacks.length} 条${cr.attacks.map((a) => `　${a.from}→${a.to}（${a.attacks} 次，其中声称者之间 ${a.betweenClaimants}）`).join("")}`);
say(`- 被攻击后的应答率：${cr.defence.answered}/${cr.defence.attacksReceived}（${(cr.defence.rate * 100).toFixed(0)}%）`);
say(`- 声称者动作里带可执行请求的：${cr.actionable.withTeamOrVote}/${cr.actionable.claimantDecisions}（${(cr.actionable.rate * 100).toFixed(0)}%）`);
say(`- 跟随者换边 ${cr.switches.length} 次${cr.switches.map((s) => `　${s.seat}号 ${s.from}→${s.to}@seq${s.atSequence}`).join("")}`);
say("");
say("### 各声称者的联盟");
if (cr.coalitions.length === 0) say("（没有人聚拢到任何跟随者）");
for (const c of cr.coalitions) {
  say(
    `- ${c.claimant}号：支持 ${c.supporters.join("、") || "无"}；有条件支持 ${c.conditionalSupporters.join("、") || "无"}；反对 ${c.opponents.join("、") || "无"}（规模 ${c.size}）`,
  );
}
say("");
say("### 票与车的对齐");
for (const v of cr.voteAlignment) {
  say(`- 跟 ${v.claimant}号 的人：${v.agreed}/${v.compared} 次投得一样（${(v.rate * 100).toFixed(0)}%）`);
}
say(`- 队长发的车与所跟声称者要的车：比较 ${cr.teamOverlap.compared} 次，平均 Jaccard ${cr.teamOverlap.meanJaccard.toFixed(2)}`);
say("");
say("### 退水结果");
if (cr.retractions.length === 0) say("（没有人退水）");
for (const r of cr.retractions) {
  say(
    `- ${r.seat}号 seq ${r.atSequence}：投票前 ${r.beforeVote}，挂车后 ${r.afterFailedMission}，` +
      `退水前支持者 ${r.backersBefore} → 之后 ${r.backersAfter}`,
  );
}
say("");
const dissent = minorityDissentUptake(
  observations.map((o) => ({
    seat: o.seat,
    taskId: o.taskId,
    atSequence: o.atSequence,
    focalCandidates: [],
    stance:
      o.stance === "support"
        ? ("follow" as const)
        : o.stance === "conditional-support"
          ? ("conditional-follow" as const)
          : o.stance === "oppose"
            ? ("challenge" as const)
            : ("independent" as const),
    focalSeat: o.selectedClaimant,
    proposition: "",
    publicAction: "",
    coordinateWith: [],
    proposedTeam: o.requestedTeam,
    votingBloc: "undecided" as const,
  })),
  record,
);
say(`少数派异议被接住：${dissent.takenUp}/${dissent.dissents}（${(dissent.rate * 100).toFixed(0)}%）`);

/* ── D. Private research section ────────────────────────────────────────── */

say("");
say("## 【私有研究】读了发牌的部分");
say("");
say("| 座位 | 身份 | 阵营 |");
say("|---|---|---|");
for (const seat of SEATS) {
  say(`| ${seat} | ${roles.bySeat[seat]} | ${roles.sideOf[seat]} |`);
}
say("");
say(`声称派西维尔的身份分布：${JSON.stringify(cr.roles)}`);
if (cr.capture) {
  say(
    `跟错人：真派 ${cr.capture.truePercival}，莫甘娜 ${cr.capture.morgana}，` +
      `其他坏人 ${cr.capture.otherEvil}，其他好人 ${cr.capture.otherGood}` +
      `　→ 莫甘娜俘获率 ${(cr.capture.morganaCaptureRate * 100).toFixed(0)}%，` +
      `任意坏人俘获率 ${(cr.capture.anyEvilCaptureRate * 100).toFixed(0)}%`,
  );
}
if (cr.loyalSplit) {
  const s = cr.loyalSplit;
  say(
    `忠臣（${s.loyalSeats} 个）最后站位：真派 ${s.withTruePercival}，莫甘娜 ${s.withMorgana}，` +
      `其他声称者 ${s.withOtherClaimant}，谁都不站 ${s.withNobody}`,
  );
}
if (cr.truePercival) {
  const p = cr.truePercival;
  say(
    `真派西维尔：跳了 ${p.claimed}${p.claimedAtSequence !== null ? `（seq ${p.claimedAtSequence}）` : ""}，` +
      `拉到 ${p.backers} 个跟随者，主动打了 ${p.attacksMade} 个人，被打 ${p.attacksReceived} 次，` +
      `**明确处理了 ${p.rivalsAddressed} 个竞争者**`,
  );
}

/* ── E. Fact ids and cognition ──────────────────────────────────────────── */

const sum = (k: keyof Report) => reports.reduce((a, r) => a + Number(r[k] ?? 0), 0);
say("");
say("## 事实 ID 与认知");
say("");
say("| | |");
say("|---|---|");
say(`| 解析成硬事实的前提 | **${num(sum("premisesVerified"))}** |`);
say(`| 解析成说法的前提 | ${num(sum("premisesFromClaims"))} |`);
say(`| 查无此 id（编造 / 越权 / 过期） | **${num(sum("premisesOverridden"))}** |`);
const totalPremises = sum("premisesVerified") + sum("premisesFromClaims") + sum("premisesOverridden");
say(`| 合计引用 | ${num(totalPremises)} |`);
say(
  `| 硬事实占比 | ${totalPremises ? ((sum("premisesVerified") / totalPremises) * 100).toFixed(1) : "0"}% |`,
);
say(`| 可引用 id（开局 / 最大） | ${reports[0]?.registrySize ?? 0} / ${Math.max(...reports.map((r) => r.registrySize))} |`);
say(`| 字段越界 | ${sum("boundsViolations")} 次 |`);
say(`| 未匹配的承诺关闭 | ${sum("unmatchedClosures")} 次 |`);
const unverifiedConstraints = reports.filter(
  (r) => Number(r.utilisation.unverifiedConstraints ?? 0) > 0,
).length;
say(`| 带未证实约束的响应 | ${unverifiedConstraints} / ${reports.length} |`);
const unverifiedClaimReads = reports.reduce(
  (a, r) => a + Number(r.utilisation.unverifiedClaimReads ?? 0),
  0,
);
say(`| 建立在未证实前提上的声称评估 | ${unverifiedClaimReads} |`);

say("");
say("### 认知块的动作分布");
say("");
const acts = new Map<string, number>();
const statuses = new Map<string, number>();
const stances = new Map<string, number>();
for (const o of observations) {
  acts.set(o.act, (acts.get(o.act) ?? 0) + 1);
  statuses.set(o.ownClaimStatus, (statuses.get(o.ownClaimStatus) ?? 0) + 1);
  stances.set(o.stance, (stances.get(o.stance) ?? 0) + 1);
}
say(`- act：${[...acts].map(([k, v]) => `${k} ${v}`).join("，")}`);
say(`- 自己的声称状态：${[...statuses].map(([k, v]) => `${k} ${v}`).join("，")}`);
say(`- 对声称者的站位：${[...stances].map(([k, v]) => `${k} ${v}`).join("，")}`);

/* ── F. Requests, size, cost ────────────────────────────────────────────── */

say("");
say("## 请求、体量、延迟");
say("");
const reasked = attempts.filter((a) => a.attempt > 1);
const refused = attempts.filter((a) => a.outcome === "valid" && !a.appliedLegalAction);
say(`- 请求 ${attempts.length} 次，重问 ${reasked.length} 次`);
say(`- 动作格式错 ${attempts.filter((a) => a.outcome === "invalid").length} 次`);
say(`- 答案被打回 ${refused.length} 次：裁判 ${refused.filter((a) => a.rejectedBy === "referee").length}，cognition ${refused.filter((a) => a.rejectedBy === "cognition").length}，动作层面 ${refused.filter((a) => a.rejectedBy === "action-format").length}，未记录 ${refused.filter((a) => !a.rejectedBy).length}`);
for (const a of refused) {
  say(`    - ${a.seat}号 · ${a.taskId} · ${a.rejectedBy ?? "?"}：${a.rejectionReason ?? "(无)"}`);
}
say(`- provider 失败 ${attempts.filter((a) => a.outcome === "provider_error").length} 次`);

const sizes = reports.map((r) => r.estimatedTokens).sort((a, b) => a - b);
const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
say("");
say("| 上下文（估算 token） | |");
say("|---|---|");
say(`| 开局 | ${num(reports[0].estimatedTokens)} |`);
say(`| 中位 | ${num(q(0.5))} |`);
say(`| p90 | ${num(q(0.9))} |`);
say(`| 最大 | ${num(sizes[sizes.length - 1])} |`);
say(`| 软目标 | ${num(CONTEXT_BUDGET.softTargetTokens)} |`);
say(`| 越过软目标 | ${reports.filter((r) => r.overSoftTarget).length} 次 |`);

say("");
say("| pack 分节（字符） | 开局 | 中位 | 最大 | 末次 |");
say("|---|---|---|---|---|");
for (const key of ["factTables", "claimContest", "ownPrivateFacts", "cognition", "currentCycle", "total"]) {
  const xs = reports.map((r) => r.packSections[key] ?? 0);
  const sorted = [...xs].sort((a, b) => a - b);
  say(
    `| ${key} | ${num(xs[0])} | ${num(sorted[Math.floor(sorted.length / 2)])} | ${num(Math.max(...xs))} | ${num(xs[xs.length - 1])} |`,
  );
}

const withUsage = attempts.filter((a) => a.usage !== null);
const outs = withUsage.map((a) => a.usage!.outputTokens).sort((a, b) => a - b);
const lat = attempts.map((a) => a.latencyMs).filter((x) => x > 0).sort((a, b) => a - b);
say("");
say(`输出 token：中位 ${num(outs[Math.floor(outs.length / 2)])}，p90 ${num(outs[Math.floor(outs.length * 0.9)])}，最大 ${num(outs[outs.length - 1])}，上限 12,000`);
say(
  `延迟：中位 ${(lat[Math.floor(lat.length / 2)] / 1000).toFixed(1)}s，p90 ${(lat[Math.floor(lat.length * 0.9)] / 1000).toFixed(1)}s，最大 ${(lat[lat.length - 1] / 1000).toFixed(1)}s，合计 ${(lat.reduce((a, b) => a + b, 0) / 60000).toFixed(1)} 分钟`,
);

/* ── G. Per-seat contest behaviour ──────────────────────────────────────── */

say("");
say("## 【私有研究】每个座位在派权上的行为");
say("");
say("| 座位 | 身份 | 决策数 | 最终自身状态 | act 分布 | 最终站位 |");
say("|---|---|---|---|---|---|");
for (const seat of SEATS) {
  const mine = observations.filter((o) => o.seat === seat);
  if (mine.length === 0) {
    say(`| ${seat} | ${roles.bySeat[seat]} | 0 | — | — | — |`);
    continue;
  }
  const last = mine[mine.length - 1];
  const byAct = new Map<string, number>();
  for (const o of mine) byAct.set(o.act, (byAct.get(o.act) ?? 0) + 1);
  say(
    `| ${seat} | ${roles.bySeat[seat]} | ${mine.length} | ${last.ownClaimStatus} | ` +
      `${[...byAct].map(([k, v]) => `${k}×${v}`).join(" ")} | ` +
      `${last.stance}${last.selectedClaimant !== null ? ` ${last.selectedClaimant}号` : ""} |`,
  );
}
