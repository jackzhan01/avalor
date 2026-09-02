/**
 * A JSONL replay, as something a person can read.
 *
 * READ-ONLY AND OFFLINE. It opens artifacts, writes Markdown, and touches
 * nothing else. The original `.jsonl` files are never modified — this tool has
 * no write path that points at them.
 *
 * TWO MODES, AND THEY NEVER MIX.
 *
 *   `--public` reads the public replay and only the public replay. What it
 *   produces is exactly what a person at the table saw, and it is safe to share
 *   with anyone, including somebody who will later be asked to judge the game.
 *
 *   `--private-research` additionally reads the private trace: roles, private
 *   cognition summaries, and every disclosure the firewall refused. It writes a
 *   SEPARATE FILE with a loud header, and there is no flag that merges the two.
 *
 * The separation is structural rather than careful: `renderPublic` takes the
 * public lines and has no parameter through which private data could arrive.
 *
 * VERBATIM. Every `publicMessage` is reproduced exactly, in full, in order.
 * Nothing is summarised, trimmed or paraphrased — the dialogue IS the artifact,
 * and a renderer that shortened it would be producing a different document that
 * happened to be about the same game.
 *
 *   npx vite-node -c research/simulator/vitest.config.ts \
 *     research/simulator/scripts/render-replay.ts -- <gameId> --public
 *   ... --private-research
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PublicEvent } from "../core/events";
import type { Seat } from "../core/types";
import {
  renderRejectionSummary,
  summariseRejections,
  type CognitionRejection,
} from "../cognition/rejection";
import type { CognitionReport } from "../agents/llm-agent";
import {
  parseJsonl,
  type PrivateTraceLine,
  type PublicReplayLine,
} from "../run/artifacts";
import { roleName } from "../prompts/transcript";

const say = (...parts: unknown[]) => console.log(...parts);

const args = process.argv.slice(2);
const gameId = args.find((a) => !a.startsWith("-"));
const wantPublic = args.includes("--public");
const wantPrivate = args.includes("--private-research");

if (!gameId || (!wantPublic && !wantPrivate)) {
  say("用法：render-replay.ts -- <gameId> [--public] [--private-research]");
  say("");
  say("  --public            公开对局记录，可以给任何人看");
  say("  --private-research  另一份文件，含身份、私有认知摘要、被拦下的泄露");
  say("");
  say("两者永远是两个文件，没有把它们合起来的开关。");
  process.exit(1);
}

const OUT = join(process.cwd(), "research", "simulator", "out");
const publicPath = join(OUT, "public", `${gameId}.public-replay.jsonl`);
const privatePath = join(OUT, "private", `${gameId}.private-trace.jsonl`);
// Two directories, mirroring the two artifact directories. The public document
// does not live under `private/` — a reader deciding what is safe to share
// should be able to answer that from the path.
const publicRenderDir = join(OUT, "rendered");
const privateRenderDir = join(OUT, "private", "rendered");

/* ── Shared vocabulary ──────────────────────────────────────────────────── */

const seatList = (seats: readonly Seat[]) => seats.map((s) => `${s}号`).join("、");

const VOTE_WORD: Readonly<Record<string, string>> = {
  approve: "上",
  reject: "下",
  unknown: "?",
};

/* ── Public ─────────────────────────────────────────────────────────────── */

/**
 * The public document.
 *
 * Takes the public lines and NOTHING ELSE. There is no parameter here through
 * which a role, a seed or a private note could arrive, which is what makes
 * "the public file cannot contain private data" a property of the signature
 * rather than a rule the caller has to remember.
 */
function renderPublic(lines: readonly PublicReplayLine[]): string {
  const metadata = lines.find((l) => l.t === "public-metadata");
  const events = lines.flatMap((l) => (l.t === "event" ? [l.data] : []));
  const outcome = lines.find((l) => l.t === "outcome");

  const out: string[] = [];
  if (metadata && metadata.t === "public-metadata") {
    const m = metadata.data;
    out.push(
      `# 对局记录 · ${m.gameId}`,
      "",
      "> 这是**公开层**：牌桌上任何人都看得到的东西，逐字保留。",
      "> 不含发牌、种子、任何座位的私有信息，也不含模型的推理记录。",
      "",
      "| | |",
      "|---|---|",
      `| 提示版本 | \`${m.promptVersion}\` |`,
      `| 模拟器 | \`${m.simulatorVersion}\` |`,
      `| 模型 | \`${m.model.id}\`（reasoning \`${m.model.reasoningEffort}\`）|`,
      `| persona 模式 | \`${m.personaMode}\` |`,
      `| 首任队长 | ${m.initialLeader}号 |`,
      `| 行进方向 | ${m.playDirection ?? "未定"} |`,
      `| 女神方向 | ${m.ladySide ?? "未定"} |`,
      "",
    );
  }

  if (outcome && outcome.t === "outcome") {
    const o = outcome.data;
    out.push(
      `**结局：${o.winner === "evil" ? "坏人" : "好人"}胜（${o.reason}）**` +
        (o.assassinTarget !== null ? `　刺杀目标 ${o.assassinTarget}号` : "　未进入刺杀"),
      "",
      "---",
      "",
    );
  }

  out.push(...renderEvents(events));
  return out.join("\n");
}

/**
 * The events, grouped by round and proposal attempt.
 *
 * Grouping is presentation only — every event appears exactly once, in
 * sequence order, and the headings are inserted between them rather than
 * replacing any of them.
 */
function renderEvents(events: readonly PublicEvent[]): string[] {
  const out: string[] = [];
  let round: number | null = null;
  let attempt: number | null = null;

  for (const event of events) {
    if (event.missionNumber !== round || event.attempt !== attempt) {
      round = event.missionNumber;
      attempt = event.attempt;
      out.push("", `## 第 ${round} 轮 · 第 ${attempt} 辆车`, "");
    }
    out.push(renderEvent(event));
  }
  return out;
}

function renderEvent(event: PublicEvent): string {
  const at = `\`seq ${event.sequence}\``;
  switch (event.type) {
    case "game_start":
      return `${at}　对局开始。`;
    case "opening_direction":
      return `${at}　${event.leader}号 把女神交给${event.ladySide === "left" ? "左" : "右"}手边，轮转往${event.playDirection === "left" ? "左" : "右"}。`;
    case "leader_change":
      return `${at}　队长 ${event.from}号 → ${event.to}号`;
    case "speech": {
      const tags: string[] = [];
      if (event.slot === "opening") tags.push("开场");
      if (event.slot === "closing") tags.push("收尾");
      if (event.claim) tags.push(`**跳${roleName(event.claim)}**`);
      if (event.retractClaim === true) tags.push("**退水**");
      if (event.tentativeTeam) tags.push(`意向车 ${seatList(event.tentativeTeam)}`);
      if (event.noTeamYet) tags.push("说组不出车");
      const stances =
        event.stances && event.stances.length > 0
          ? `　_表态：${event.stances
              .map(
                (s) =>
                  `${s.seat}号 ${s.valence > 0 ? "保" : s.valence < 0 ? "踩" : "看不清"}` +
                  `(${s.valence.toFixed(2)}/${s.confidence.toFixed(2)})`,
              )
              .join("，")}_`
          : "";
      const head = `${at}　**${event.speaker}号**${tags.length > 0 ? `　[${tags.join("｜")}]` : ""}`;
      // Verbatim, on its own line, as a quote. Never trimmed.
      return `${head}\n\n> ${event.publicMessage}\n${stances ? `\n${stances}\n` : ""}`;
    }
    case "proposal":
      return `${at}　🚗 **${event.leader}号 发车：${seatList(event.team)}**`;
    case "vote": {
      const detail = Object.entries(event.votes)
        .map(([seat, v]) => `${seat}${VOTE_WORD[v] ?? v}`)
        .join(" ");
      return (
        `${at}　🗳 **${event.result === "passed" ? "车过了" : "车被否"}**` +
        `（${event.approvals} 上）　${detail}`
      );
    }
    case "mission_result":
      return (
        `${at}　${event.result === "success" ? "✅" : "❌"} **第 ${event.missionNumber} 轮` +
        `${event.result === "success" ? "成功" : "失败"}**　上车 ${seatList(event.team)}　` +
        `公开失败票 ${event.failCount}`
      );
    case "lady_assigned":
      return `${at}　🔱 女神令牌给了 ${event.holder}号`;
    case "lady_announced":
      return (
        `${at}　🔱 **${event.holder}号 验了 ${event.target}号，当众宣布「${event.announced === "good" ? "好人" : "坏人"}」**` +
        `（这是他说的，不是裁判说的）\n\n> ${event.publicMessage}\n`
      );
    case "lady_transferred":
      return `${at}　🔱 令牌 ${event.from}号 → ${event.to}号`;
    case "assassination_target":
      return `${at}　🗡 **${event.assassin}号 刺 ${event.target}号**`;
    case "game_end": {
      const reveal = Object.entries(event.reveal)
        .map(([seat, role]) => `${seat}号 ${roleName(role as never)}`)
        .join("　");
      return [
        `${at}　🏁 **对局结束：${event.winner === "evil" ? "坏人" : "好人"}胜（${event.reason}）**`,
        "",
        "**局终亮牌**（规则做的，不是谁说出来的）：",
        "",
        reveal,
      ].join("\n");
    }
  }
}

/* ── Private ────────────────────────────────────────────────────────────── */

const PRIVATE_WARNING = [
  "> # ⚠ containsPrivateInformation: true",
  ">",
  "> **这份文件是答案。** 它包含每个座位的真实身份、他们私下的推理摘要、",
  "> 以及被防泄露闸拦下的内容。",
  ">",
  "> 读过它的人再去评价这一局，就不是盲评了。",
  "> **公开版在另一个文件里，两者永远不合并。**",
].join("\n");

function renderPrivate(lines: readonly PrivateTraceLine[]): string {
  const manifestLine = lines.find((l) => l.t === "private-manifest");
  const reports = lines.flatMap((l) =>
    l.t === "cognition-telemetry" ? [...l.data] : [],
  ) as CognitionReport[];
  const actions = lines.flatMap((l) => (l.t === "action" ? [l.data] : []));

  const out: string[] = [PRIVATE_WARNING, "", `# 私有研究记录 · ${gameId}`, ""];

  if (manifestLine && manifestLine.t === "private-manifest") {
    const m = manifestLine.data;
    out.push(
      "## 发牌",
      "",
      "| 座位 | 身份 | persona | 策略档 |",
      "|---|---|---|---|",
      ...m.seats.map(
        (s) => `| ${s.seat}号 | **${roleName(s.role)}** | ${s.persona ?? "—"} | ${s.strategy ?? "—"} |`,
      ),
      "",
      `策略档指纹 \`${m.strategyFingerprint.slice(0, 16)}…\`　输出上限 ${m.maxOutputTokens}`,
      "",
    );
  }

  /* ── The firewall, which is what M5.3 added ───────────────────────────── */
  const withFirewall = reports.filter((r) => r.disclosure !== null);
  out.push("## 防泄露闸", "");
  if (withFirewall.length === 0) {
    out.push(
      "（这一局没有走两阶段 —— 它是 `prompt-0.5.0` 之前的提示栈跑的，那时候公开发言",
      "和私有推理还在同一次请求里产出。）",
      "",
    );
  } else {
    const redactions = withFirewall.filter((r) => (r.disclosure?.redactedFields.length ?? 0) > 0);
    const rejections = withFirewall.filter(
      (r) => (r.disclosure?.messageRejections.length ?? 0) > 0,
    );
    out.push(
      `- 走过闸的说话回合：**${withFirewall.length}**`,
      `- 规划者被整段抹掉字段的回合：**${redactions.length}**`,
      `- 成句之后被拦下的回合：**${rejections.length}**`,
      `- 被剔除的公开依据 id：**${withFirewall.reduce((n, r) => n + (r.disclosure?.rejectedBasisIds ?? 0), 0)}**`,
      "",
    );
    if (redactions.length > 0) {
      out.push("### 规划者试图带过去的东西", "", "| 座位 | 任务 | 字段 | 类别 |", "|---|---|---|---|");
      for (const r of redactions) {
        for (const field of r.disclosure?.redactedFields ?? []) {
          out.push(
            `| ${r.seat}号 | \`${r.taskId}\` | \`${field}\` | ${(r.disclosure?.plannerLeakClasses ?? []).join("、")} |`,
          );
        }
      }
      out.push("");
    }
    if (rejections.length > 0) {
      out.push("### 成句之后被拦下的", "", "| 座位 | 任务 | 第几次 | 命中的规则 |", "|---|---|---|---|");
      for (const r of rejections) {
        for (const rejection of r.disclosure?.messageRejections ?? []) {
          out.push(
            `| ${r.seat}号 | \`${r.taskId}\` | ${rejection.attempt} | ${rejection.rules.join("、")} |`,
          );
        }
      }
      out.push("", "**被拦下的句子本身不在这里，也不在轨迹里。** 记的是类别和规则 ——",
        "一个存着泄露原文的研究文件，会把闸刚刚阻止的事情重新做一遍。", "");
    }
  }

  /* ── Refused cognition attempts ───────────────────────────────────────── */
  const rejections = lines.flatMap((l) =>
    l.t === "cognition-rejection" ? [l.data] : [],
  ) as CognitionRejection[];
  out.push("## 被拒的认知尝试", "");
  if (rejections.length === 0) {
    out.push("这一局没有任何认知块被打回。", "");
  } else {
    out.push("```", renderRejectionSummary(summariseRejections(rejections)), "```", "");
    out.push(
      "| 座位 | 任务 | 第几次 | 类别 | 代码 | 还会重问 |",
      "|---|---|---|---|---|---|",
      ...rejections.map(
        (r) =>
          `| ${r.seat}号 | ${r.taskId} | ${r.attempt} | ${r.categories.join("、")} | ` +
          `${r.codes.join(" ")} | ${r.willRetry ? "是" : "**否，到此为止**"} |`,
      ),
      "",
      "**被拒的那一份认知块本身不在这里，也不在轨迹里。** 记的是类别和代码 —— " +
        "一个存着被拒原文的研究文件，等于把检查刚刚拦下的东西又收了进来。",
      "",
    );
  }

  /* ── Per-seat cognition summaries ─────────────────────────────────────── */
  out.push("## 各座位的私有推理摘要", "");
  const bySeat = new Map<Seat, CognitionReport[]>();
  for (const report of reports) {
    const list = bySeat.get(report.seat) ?? [];
    list.push(report);
    bySeat.set(report.seat, list);
  }
  for (const [seat, list] of [...bySeat.entries()].sort((a, b) => a[0] - b[0])) {
    const last = list[list.length - 1];
    out.push(
      `### ${seat}号`,
      "",
      `- 决策 ${list.length} 次　引用解析成硬事实 ${list.reduce((n, r) => n + r.premisesVerified, 0)}、` +
        `说法 ${list.reduce((n, r) => n + r.premisesFromClaims, 0)}、` +
        `查无此 id ${list.reduce((n, r) => n + r.premisesOverridden, 0)}`,
      last.contest
        ? `- 最后一步的派权状态：\`${last.contest.ownClaimStatus}\`　动作 \`${last.contest.act}\`　` +
          `站位 \`${last.contest.stance}\``
        : "- （这一局没有派权记录）",
      last.social
        ? `- 最后一步的站位：\`${last.social.stance ?? "—"}\`　焦点 ${last.social.focalSeat ?? "—"}号`
        : "",
      "",
    );
  }

  out.push(
    "## 逐步动作",
    "",
    "| seq | 座位 | 动作 |",
    "|---|---|---|",
    ...actions.map((a) => `| ${a.atSequence} | ${a.seat}号 | \`${a.action.kind}\` |`),
    "",
  );

  return out.filter((line) => line !== "").join("\n");
}

/* ── Run ────────────────────────────────────────────────────────────────── */

if (wantPublic) {
  if (!existsSync(publicPath)) {
    say(`找不到公开回放：${publicPath}`);
    process.exit(1);
  }
  const lines = parseJsonl<PublicReplayLine>(readFileSync(publicPath, "utf8"));
  mkdirSync(publicRenderDir, { recursive: true });
  const target = join(publicRenderDir, `${gameId}.public.md`);
  writeFileSync(target, `${renderPublic(lines)}\n`, "utf8");
  const speeches = lines.filter((l) => l.t === "event" && l.data.type === "speech").length;
  say(`公开版：${target}`);
  say(`  ${lines.length} 行 → ${speeches} 段发言，全部逐字保留`);
}

if (wantPrivate) {
  if (!existsSync(privatePath)) {
    say(`找不到私有轨迹：${privatePath}`);
    process.exit(1);
  }
  const lines = parseJsonl<PrivateTraceLine>(readFileSync(privatePath, "utf8"));
  mkdirSync(privateRenderDir, { recursive: true });
  const target = join(privateRenderDir, `${gameId}.private-research.md`);
  writeFileSync(target, `${renderPrivate(lines)}\n`, "utf8");
  say(`私有版：${target}`);
  say("  ⚠ 含身份与私有推理摘要。不要和公开版一起分发。");
}
