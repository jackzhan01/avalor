/**
 * The event log, rendered as something a language model can read.
 *
 * This is the whole AI feature's ceiling. A model given "9人局，第4轮" produces
 * horoscopes; a model given every car, every vote vector, and every change of
 * heart produces something worth reading. So this file is deliberately verbose
 * where the information is load-bearing, and deliberately explicit where the
 * data model draws a distinction the model would otherwise flatten:
 *
 *   - 没表过态 vs 明确说中立(3) — rendered as different lines, never merged
 *   - 意向车 vs 真发的车 — separate sections, so "说带1/3/5、真带2/4/6" survives
 *   - 女神当众说的 vs 用户实际看到的 — public claim and private truth, apart
 *   - 改口 — the chain is rendered, not just the latest value
 *
 * Pure. No React, no fetch, no Date.now() — same discipline as the selectors,
 * for the same reason: it has to be unit-testable and byte-stable.
 */

import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, RoleType, VoteChoice } from "@/lib/types/game";
import {
  deriveLady,
  deriveOpinions,
  deriveStatements,
  deriveTimeline,
  getAllNotes,
  getAllRoleMarks,
} from "@/lib/selectors";
import { describeComposition, defaultRoleSet, evilCount } from "@/lib/rules/avalon";
import { ROLE_LABELS, markLabel, seatOf } from "@/lib/format/labels";
import {
  deriveRoleInference,
  deriveSideInference,
  isConfidentAbout,
} from "@/lib/inference";

export interface BriefingOptions {
  /**
   * The user's role, their vision, and their guesses.
   *
   * Default true — the private layer is the entire reason the analysis can say
   * anything a bystander couldn't. `false` produces the public-only view, which
   * is what a shared/exported game would look like.
   */
  includePrivate?: boolean;
}

/** 1 = 强踩 … 5 = 强保. Spelled out for the model on first use. */
const RATING_WORD: Record<number, string> = {
  1: "强踩",
  2: "踩",
  3: "中立",
  4: "保",
  5: "强保",
};

function seat(game: GameRecord, playerId: string): string {
  const n = seatOf(game, playerId);
  return n == null ? "?号" : `${n}号`;
}

/** "1·3·5" — seats ascending, the way a team is read out at the table. */
function seats(game: GameRecord, ids: readonly string[]): string {
  const list = ids
    .map((id) => seatOf(game, id))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  return list.length ? list.map((n) => `${n}号`).join("·") : "（无）";
}

function nameHint(game: GameRecord): string {
  const named = game.players
    .filter((p) => p.name)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => `${p.seat}号=${p.name}`);
  return named.length ? `（${named.join("，")}）` : "";
}

/* ── Sections ──────────────────────────────────────────────────────────── */

function renderSetup(game: GameRecord, events: GameEvent[]): string[] {
  const timeline = deriveTimeline(events, game);
  const composition = describeComposition(
    game.playerCount,
    game.roleSet ?? defaultRoleSet(game.playerCount),
  );
  const describe = (lines: { role: RoleType; count: number }[]) =>
    lines
      .map((l) => (l.count > 1 ? `${ROLE_LABELS[l.role]}×${l.count}` : ROLE_LABELS[l.role]))
      .join("、");

  const out = [
    `${game.playerCount} 人局：好人 ${composition.goodTotal} 个，坏人 ${composition.evilTotal} 个。${nameHint(game)}`,
    `场上角色 —— 好人方：${describe(composition.good)}；坏人方：${describe(composition.evil)}`,
    `任务进度：好人拿下 ${timeline.successCount} 轮，坏人拿下 ${timeline.failCount} 轮。`,
  ];

  if (timeline.isComplete) {
    out.push("这局已经结束了。");
  } else {
    const mission = timeline.missions[Math.min(timeline.missionNumber, 5) - 1];
    const phase =
      timeline.phase === "discussion"
        ? "正在讨论、还没发车"
        : timeline.phase === "voting"
          ? "车已经点了，正在投票"
          : "车过了，正在跑任务";
    out.push(
      `现在：第 ${Math.min(timeline.missionNumber, 5)} 轮 · 第 ${timeline.proposalNumber} 车 · ${phase}。`,
      `这一轮要 ${mission.expectedTeamSize} 个人上车${mission.requiredFails === 2 ? "，且需要 2 张坏票才算失败" : ""}。`,
    );
    if (timeline.currentLeaderId) {
      out.push(`当前车主：${seat(game, timeline.currentLeaderId)}。`);
    }
    if (timeline.rejectionStreak > 0) {
      out.push(
        `这一轮已经连续否了 ${timeline.rejectionStreak} 辆车，再否 ${5 - timeline.rejectionStreak} 次坏人直接获胜。`,
      );
    }
  }
  return out;
}

function renderViewer(game: GameRecord, events: GameEvent[]): string[] {
  const me = game.viewerPlayerId;
  const out: string[] = [];

  out.push(
    me ? `我坐 ${seat(game, me)}。` : "我的座位没有记录（默认按 1 号看待）。",
  );

  if (game.viewerRole) {
    out.push(`我这局的身份是：${ROLE_LABELS[game.viewerRole]}。`);
  } else {
    out.push("我没有填自己的身份，所以下面的视野信息可能不完整。");
  }

  // Vision (`known`) and reads (`guess`) are different kinds of fact and the
  // model must not average them: one is what the game told the user, the other
  // is what the user decided. Rendered as separate lists with explicit labels.
  const known: string[] = [];
  const guessed: string[] = [];
  for (const [targetId, state] of getAllRoleMarks(events)) {
    const line = `${seat(game, targetId)} 是 ${markLabel(state.mark)}`;
    (state.certainty === "known" ? known : guessed).push(line);
  }

  out.push(
    known.length
      ? `我的视野（游戏发牌时告诉我的，百分之百是真的，别人不知道我知道）：${known.join("；")}。`
      : "我没有视野信息，或者还没记下来。",
  );
  if (guessed.length) {
    out.push(
      `我自己之前的推测（只是我的判断，可能是错的，请独立复核）：${guessed.join("；")}。`,
    );
  }

  const evils = evilCount(game.playerCount);
  if (game.viewerRole === "merlin") {
    out.push(
      `提醒：我是梅林，全场 ${evils} 个坏人${known.length < evils ? `，我只看到 ${known.length} 个（莫德雷德在我视野之外）` : ""}。`,
    );
  }
  return out;
}

function renderMissions(game: GameRecord, events: GameEvent[]): string[] {
  const timeline = deriveTimeline(events, game);
  return timeline.missions.map((m) => {
    if (m.result) {
      const fails =
        m.failCount == null ? "坏票数没数清" : `${m.failCount} 张坏票`;
      return `第 ${m.missionNumber} 轮：${m.result === "success" ? "成功" : "失败"}（${fails}）· 上车的是 ${seats(game, m.teamPlayerIds ?? [])}`;
    }
    if (m.status === "in_progress") {
      return `第 ${m.missionNumber} 轮：正在进行 · 要 ${m.expectedTeamSize} 个人`;
    }
    return `第 ${m.missionNumber} 轮：还没打 · 要 ${m.expectedTeamSize} 个人`;
  });
}

function renderVote(
  game: GameRecord,
  votes: Record<string, VoteChoice>,
): string {
  const buckets: Record<VoteChoice, string[]> = {
    approve: [],
    reject: [],
    unknown: [],
  };
  const unrecorded: string[] = [];
  for (const player of game.players) {
    const choice = votes[player.id];
    if (choice) buckets[choice].push(player.id);
    else unrecorded.push(player.id);
  }

  const parts = [
    `上票 ${seats(game, buckets.approve)}`,
    `下票 ${seats(game, buckets.reject)}`,
  ];
  if (buckets.unknown.length) {
    parts.push(`没看清 ${seats(game, buckets.unknown)}`);
  }
  if (unrecorded.length) {
    // Never recorded ≠ recorded as unknown. Say so, or the model will read a
    // gap in the notes as a meaningful abstention.
    parts.push(`没记下来 ${seats(game, unrecorded)}`);
  }
  return parts.join("，");
}

function renderProposals(game: GameRecord, events: GameEvent[]): string[] {
  const timeline = deriveTimeline(events, game);
  const out: string[] = [];

  for (const id of timeline.proposalOrder) {
    const p = timeline.proposalsById.get(id);
    if (!p) continue;

    const head = `第 ${p.missionNumber} 轮第 ${p.proposalNumber} 车：${seat(game, p.event.leaderId)} 带 ${seats(game, p.event.teamPlayerIds)}`;
    const tail =
      p.status === "draft"
        ? " → 没投票就换车了"
        : p.status === "voting"
          ? " → 还没投票"
          : p.vote?.finalResult === "rejected"
            ? " → 被否了"
            : p.mission
              ? ` → 车过了，任务${p.mission.result === "success" ? "成功" : "失败"}`
              : " → 车过了";

    out.push(head + tail);
    if (p.vote) out.push(`    票型：${renderVote(game, p.vote.votes)}`);
  }

  return out.length ? out : ["（还没有人发过车）"];
}

function renderOpinions(game: GameRecord, events: GameEvent[]): string[] {
  const { current, history } = deriveOpinions(events);
  const out: string[] = [];
  const silent: string[] = [];

  for (const player of [...game.players].sort((a, b) => a.seat - b.seat)) {
    const row = current.get(player.id);
    if (!row || row.size === 0) {
      silent.push(player.id);
      continue;
    }

    const cells = [...row.entries()]
      .sort(([a], [b]) => (seatOf(game, a) ?? 0) - (seatOf(game, b) ?? 0))
      .map(([targetId, cell]) => {
        const base = `${seat(game, targetId)}=${cell.rating}(${RATING_WORD[cell.rating]})`;
        if (cell.revisionCount <= 1) return base;
        // A change of heart is often the single most informative thing in the
        // log, so the whole chain goes in, not just where it landed.
        const chain = (history.get(`${player.id}|${targetId}`) ?? [])
          .map((e) => e.rating)
          .join("→");
        return `${base}[改过口：${chain}]`;
      });

    out.push(`${seat(game, player.id)} 说：${cells.join("，")}`);
  }

  if (silent.length) {
    out.push(
      `以下人从头到尾没对任何人公开表过态（注意：这是「没说过」，不是「说了中立」）：${seats(game, silent)}`,
    );
  }
  return out;
}

function renderStatements(game: GameRecord, events: GameEvent[]): string[] {
  const { intendedTeams, roleClaims } = deriveStatements(events);
  const out: string[] = [];

  for (const [playerId, chain] of intendedTeams) {
    for (const e of chain) {
      out.push(
        `第 ${e.missionNumber} 轮：${seat(game, playerId)} 嘴上说会带 ${seats(game, e.teamPlayerIds)}（这只是他说的，不是他真发的车）`,
      );
    }
  }

  for (const [playerId, chain] of roleClaims) {
    for (const e of chain) {
      out.push(
        `第 ${e.missionNumber} 轮：${seat(game, playerId)} ${e.claimed ? "跳派（自称派西维尔）" : "收回了跳派"}`,
      );
    }
  }

  return out.sort();
}

function renderLady(game: GameRecord, events: GameEvent[]): string[] {
  const lady = deriveLady(events, game);
  if (!lady.enabled) return [];

  const out: string[] = [];
  if (lady.holderId) {
    out.push(`女神牌现在在 ${seat(game, lady.holderId)} 手上。`);
  }
  for (const check of lady.checks) {
    const said =
      check.announced === "good"
        ? "当众说他是好人"
        : check.announced === "evil"
          ? "当众说他是坏人"
          : "没说结果（或者我没听清）";
    out.push(
      `第 ${check.missionNumber} 轮：${seat(game, check.holderId)} 验了 ${seat(game, check.targetId)}，${said}。注意：验人的人说的话不一定是真的。`,
    );
  }
  if (lady.due) out.push("现在还欠一次验人没验。");
  return out;
}

function renderNotes(game: GameRecord, events: GameEvent[]): string[] {
  return getAllNotes(events).map((note) =>
    note.playerId
      ? `第 ${note.missionNumber} 轮 · 关于 ${seat(game, note.playerId)}：${note.text}`
      : `第 ${note.missionNumber} 轮 · 全桌：${note.text}`,
  );
}

/**
 * What pure logic has already settled, handed to the model as fact.
 *
 * This is the highest-leverage section in the briefing. Without it the model
 * reasons from scratch over 84 possible worlds and invents things; with it,
 * whole branches are closed off before it starts — and closed off by
 * arithmetic it cannot argue with. CSP4SDG reports the same effect: a
 * constraint solver supplied as an auxiliary tool measurably improves an LLM.
 *
 * The wording matters as much as the content. Everything here is labelled as
 * DERIVED AND CERTAIN, with an explicit instruction not to contradict it,
 * because the failure mode being prevented is the model politely agreeing with
 * the section and then reasoning as though it had never read it.
 */
function renderInference(game: GameRecord, events: GameEvent[]): string[] {
  const side = deriveSideInference(events, game);
  if (side.contradictory) {
    return [
      "我记的东西自相矛盾 —— 没有任何一种身份分配能同时满足全部记录。",
      "可能有一处记错了（票型、坏票数、或者我的视野）。分析时请指出最可能记错的是哪一条。",
    ];
  }

  const out: string[] = [
    `把规则套在我记下的事实上做排除法：${game.playerCount} 人局共 ${side.total} 种坏人组合，现在只剩 ${side.surviving.length} 种。`,
  ];

  for (const elimination of side.eliminations) {
    out.push(`  · 排除 ${elimination.eliminated} 种 —— ${elimination.reason}`);
  }

  if (side.provenEvil.length) {
    out.push(`**确定是坏人**：${seats(game, side.provenEvil)}（这是推出来的，不是猜的）`);
  }
  if (side.provenGood.length) {
    out.push(`**确定是好人**：${seats(game, side.provenGood)}（这是推出来的，不是猜的）`);
  }

  // Only worth listing when the space is small enough to actually read; past
  // a dozen it is noise that crowds out the rest of the briefing.
  if (side.surviving.length > 1 && side.surviving.length <= 12) {
    const worlds = side.surviving
      .map((h) => seats(game, h.evil))
      .join("　/　");
    out.push(`剩下的可能组合，全部列在这里：${worlds}`);
  }

  const ranked = [...side.evilProbability.entries()]
    .filter(([id]) => !side.provenEvil.includes(id) && !side.provenGood.includes(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id, p]) => `${seat(game, id)} ${Math.round(p * 100)}%`);
  if (ranked.length) {
    out.push(`其余座位是坏人的概率（已按票型和坏票数加权）：${ranked.join("，")}`);
  }

  // Role marginals, but only where they have actually converged — a flat
  // distribution dressed up as a finding is exactly what this app refuses to
  // do elsewhere.
  const roles = deriveRoleInference(events, game);
  const roleLines: string[] = [];
  for (const [role, row] of roles.byRole) {
    if (role === "loyal" || role === "minion") continue;
    if (!isConfidentAbout(roles, role)) continue;
    const top = [...row.entries()]
      .filter(([, p]) => p > 0.01)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, p]) => `${seat(game, id)} ${Math.round(p * 100)}%`);
    if (top.length) roleLines.push(`${ROLE_LABELS[role]}：${top.join("，")}`);
  }
  if (roleLines.length) {
    out.push(`身份也已经收窄到可以说的程度 —— ${roleLines.join("；")}`);
  }

  out.push(
    "以上全部由规则推演得出，**是确定的**。你的分析必须与它一致：不要把「确定是好人」的人说成坏人，也不要提出已经被排除掉的组合。你的价值在于解释那些还没被排除的可能里哪个更像真的，以及从发言和态度里读出排除法读不到的东西。",
  );
  return out;
}

/* ── Assembly ──────────────────────────────────────────────────────────── */

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `## ${title}\n${lines.join("\n")}`;
}

/**
 * The complete briefing, as plain Chinese text.
 *
 * Text rather than JSON on purpose: the model reads this far better, and it is
 * also directly showable to the user — "这是发出去的内容" is a claim the app
 * should be able to back up with the actual bytes.
 */
export function buildBriefing(
  game: GameRecord,
  events: GameEvent[],
  options: BriefingOptions = {},
): string {
  const includePrivate = options.includePrivate ?? true;

  const blocks = [
    section("牌局", renderSetup(game, events)),
    includePrivate ? section("我自己（私密信息，别人不知道）", renderViewer(game, events)) : "",
    // Placed straight after the private layer, before the raw log: the model
    // should know what is already settled before it starts reading events.
    includePrivate
      ? section("排除法已经确定的（纯逻辑推演，不是推测）", renderInference(game, events))
      : "",
    section("五轮任务", renderMissions(game, events)),
    section("每一辆车和票型", renderProposals(game, events)),
    section("公开保踩（1 强踩 / 2 踩 / 3 中立 / 4 保 / 5 强保）", renderOpinions(game, events)),
    section("意向车与跳派", renderStatements(game, events)),
    section("湖中女神", renderLady(game, events)),
    section("我记的零散备注", renderNotes(game, events)),
  ];

  return blocks.filter(Boolean).join("\n\n");
}
