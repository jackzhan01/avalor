/**
 * Layer 5, and the assembly of all seven.
 *
 * STATELESS BY CONSTRUCTION. Every prompt is rebuilt from the current
 * observation and nothing else — no conversation object, no message history,
 * no accumulated snapshots. The public history appears exactly once per
 * request, and `build.test.ts` asserts it by counting sequence markers.
 *
 * BE PRECISE ABOUT WHAT THAT COSTS. Rebuilding keeps each request
 * self-contained and bounded by the CURRENT history, which is what keeps any
 * single request comfortably under the 250,000-token ceiling. It does not make
 * a game cheaper: request k carries about k events, so per-request input is
 * linear in the turn count and CUMULATIVE input over a game is roughly
 * quadratic. A stateful thread would accumulate the same history and cost the
 * same; the difference is auditability and resumability, not tokens.
 *
 * What a stateful thread would additionally do is carry every earlier
 * observation SNAPSHOT alongside the history, which is a second growth term on
 * top of this one. Avoiding that is the actual saving.
 *
 * WHAT THIS FUNCTION MAY BE GIVEN. An `Observation`, a persona, a strategy.
 * Not a `GameState`, not a `Deal`. The type says so and `assertNoRefereeState`
 * says so again at runtime, because the type would not survive one `as`.
 *
 * LAYER ORDER is 1..7 across the two messages: the system message carries the
 * three layers that never change during a game (rules, persona, role), the
 * user message carries the four that do (concrete knowledge, position and
 * public state, strategy, task). Strategy is static and would cache better in
 * the system message; keeping the declared order intact is worth more than
 * that, and it is a small block.
 */

import type { Observation } from "../core/observation";
import { checkInputTokens, type InputLimitVerdict } from "../core/input-limit";
import type { SimConfig } from "../config/load";
import { COMMON_RULES } from "./common";
import { renderPersona, type PersonaDefinition } from "./personas";
import { renderPrivateKnowledgeLayer, renderRoleLayer } from "./roles";
import { renderStrategy, type StrategyDefinition } from "./strategies";
import { renderTask, taskSchemaFor, type TaskSchema } from "./tasks";
import { renderTranscript, roleName } from "./transcript";
import { PROMPT_VERSION } from "./version";

/* ── Layer 5 ───────────────────────────────────────────────────────────── */

const PHASE_WORDS: Readonly<Record<string, string>> = {
  setup: "开局前",
  reveal: "发牌",
  opening_direction: "选方向",
  discussion: "发言",
  vote: "投票",
  mission: "任务",
  lady_select: "湖中女神验人",
  lady_announce: "湖中女神宣布",
  assassination_reveal: "坏人互认",
  assassination_discuss: "坏人密谈",
  assassination_strike: "刺杀",
  terminal: "已结束",
};

const TRACK_WORDS: Readonly<Record<string, string>> = {
  success: "成功",
  fail: "失败",
  pending: "未打",
};

/**
 * Where this seat sits in the game right now.
 *
 * Everything here is CURRENT STATE, derived and scalar. It deliberately does
 * not re-list past events — the transcript below it is the one and only place
 * the public history is serialised, and re-summarising it would both waste the
 * token budget and make "appears exactly once" untestable.
 */
export function renderPositionLayer(observation: Observation): string {
  const p = observation.position;
  const direction =
    p.playDirection === null
      ? "还没定"
      : p.playDirection === "left"
        ? "往左（座位号 +1）"
        : "往右（座位号 −1）";

  const lines = [
    "## 五、你现在的位置与场上局面",
    "",
    "**位置**",
    `- 你是 ${observation.seat}号。左手边是 ${p.leftNeighbor}号，右手边是 ${p.rightNeighbor}号。`,
    `- 轮转方向：${direction}`,
    `- 当前车主：${p.leader}号${p.leader === observation.seat ? "（就是你）" : ""}`,
    `- 离你当车主还有 ${p.seatsUntilILead} 轮${p.seatsUntilILead === 0 ? "（现在就是你）" : ""}`,
    `- 当前阶段：${PHASE_WORDS[p.phase] ?? p.phase}`,
  ];

  if (p.speakingOrder.length > 0) {
    const order = p.speakingOrder
      .map((turn, i) => {
        const mark = i < p.speechIndex ? "✓" : i === p.speechIndex ? "→" : "·";
        const tag =
          turn.slot === "opening" ? "开场" : turn.slot === "closing" ? "收尾+发车" : "";
        return `${mark}${turn.seat}号${tag ? `(${tag})` : ""}`;
      })
      .join(" ");
    lines.push(
      "",
      "**这一辆车的发言顺序**（✓ 已说，→ 正在说，· 还没说）",
      order,
      `已经说过的：${p.alreadySpoken.length > 0 ? p.alreadySpoken.map((s) => `${s}号`).join("、") : "还没有人"}`,
    );
  }

  lines.push(
    "",
    "**任务进度**",
    `- 五轮结果：${p.missionTrack.map((slot, i) => `第${i + 1}轮 ${TRACK_WORDS[slot] ?? slot}`).join("，")}`,
    `- 目前 ${p.successes} 成 ${p.fails} 败`,
    `- 现在是第 ${p.missionNumber} 轮的第 ${p.attempt} 辆车，已经连否 ${p.rejectionStreak} 次`,
    `- 这一轮要 ${p.teamSizeThisMission} 个人上车，需要 ${p.failsRequiredThisMission} 张坏票才算失败`,
  );

  if (p.rejectionStreak >= 3) {
    lines.push(
      `- ⚠ 再否 ${5 - p.rejectionStreak} 次，这一轮就直接判坏人获胜。`,
    );
  }

  if (p.proposedTeam) {
    lines.push("", `**桌上这辆车**：${p.proposedTeam.map((s) => `${s}号`).join("、")}`);
  }

  if (p.tentativeTeams.length > 0) {
    lines.push(
      "",
      "**这一辆车上大家给过的意向车**（只是意向，不是正式车单）",
      ...p.tentativeTeams.map((t) =>
        t.noTeamYet
          ? `- ${t.seat}号：说现在组不出车`
          : `- ${t.seat}号：${(t.team ?? []).map((s) => `${s}号`).join("、")}`,
      ),
    );
  }

  lines.push(
    "",
    "**湖中女神**",
    p.ladyHolder === null
      ? "- 还没有交出去。"
      : `- 现在在 ${p.ladyHolder}号 手上，已经验过 ${p.ladyChecksDone} 次（最多三次，第 2、3、4 轮之后各一次）。`,
  );
  if (p.ladyHeldBy.length > 0) {
    lines.push(
      `- 拿过令牌的人：${p.ladyHeldBy.map((s) => `${s}号`).join("、")}。这些人都不能再被验。`,
    );
  }

  if (p.standingClaims.length > 0) {
    lines.push(
      "",
      "**公开声称过身份的人**（只是声称，没有任何人验证过）",
      ...p.standingClaims.map(
        (c) => `- ${c.seat}号 自称是${roleName(c.claimed)}（第 ${c.sinceSequence} 手起）`,
      ),
    );
  }

  lines.push("", renderTranscript(observation.publicLog));
  return lines.join("\n");
}

/* ── Assembly ──────────────────────────────────────────────────────────── */

export interface PromptLayer {
  readonly index: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly title: string;
  readonly text: string;
}

export interface BuiltPrompt {
  readonly promptVersion: string;
  readonly taskId: string;
  readonly schema: TaskSchema;
  readonly layers: readonly PromptLayer[];
  /** Layers 1-3: the same bytes for this seat all game. */
  readonly system: string;
  /** Layers 4-7: everything that moves. */
  readonly user: string;
  /** system + user, for snapshots, hashing and token counting. */
  readonly fullText: string;
}

export interface BuildPromptInput {
  readonly observation: Observation;
  readonly persona: PersonaDefinition;
  readonly strategy: StrategyDefinition;
  /** Defaults to the shipped 220. Pass a config's value to keep them in step. */
  readonly speechCharLimit?: number;
}

/** Keys that only ever exist on the referee's own state, never an observation. */
const REFEREE_ONLY_KEYS = [
  "deal",
  "bySeat",
  "byRole",
  "pendingVotes",
  "missionCards",
  "privateLog",
  "ladyPending",
  "evilSeats",
  "goodSeats",
];

/**
 * Refuse anything that smells like referee state.
 *
 * The signature already says `Observation`, but one `as` defeats that and the
 * cost of being wrong here is an entire batch of games where the models could
 * see the deal — a failure that produces beautiful results and no warning.
 */
function assertNoRefereeState(value: object, what: string): void {
  for (const key of REFEREE_ONLY_KEYS) {
    if (key in value) {
      throw new Error(
        `${what} carries "${key}" — that is referee state, and prompts are built from an Observation only`,
      );
    }
  }
}

export function buildPlayerPrompt(input: BuildPromptInput): BuiltPrompt {
  const { observation, persona, strategy } = input;
  assertNoRefereeState(observation, "observation");

  const request = observation.request;
  if (!request) {
    throw new Error(
      `seat ${observation.seat} has no pending request — there is nothing to ask it`,
    );
  }

  const schema = taskSchemaFor(request, input.speechCharLimit ?? 220);

  const layers: PromptLayer[] = [
    { index: 1, title: "共同规则", text: COMMON_RULES },
    { index: 2, title: "说话风格", text: renderPersona(persona) },
    { index: 3, title: "身份与合法信息类型", text: renderRoleLayer(observation.role) },
    { index: 4, title: "你实际看到的东西", text: renderPrivateKnowledgeLayer(observation) },
    { index: 5, title: "位置与公开局面", text: renderPositionLayer(observation) },
    { index: 6, title: "策略档", text: renderStrategy(strategy, observation) },
    { index: 7, title: "本次任务与输出格式", text: renderTask(schema) },
  ];

  const system = layers
    .filter((l) => l.index <= 3)
    .map((l) => l.text)
    .join("\n\n");
  const user = layers
    .filter((l) => l.index >= 4)
    .map((l) => l.text)
    .join("\n\n");

  return {
    promptVersion: PROMPT_VERSION,
    taskId: schema.id,
    schema,
    layers,
    system,
    user,
    fullText: `${system}\n\n${user}`,
  };
}

/**
 * The 250,000-token gate, wired to a caller-supplied count.
 *
 * No tokeniser is bundled and none is guessed. When the model client lands and
 * the supported counting mechanism for the configured model has actually been
 * checked, the count comes from there and this signature does not change.
 */
export function guardPromptInput(
  tokens: number,
  config?: Pick<SimConfig, "limits">,
): InputLimitVerdict {
  return checkInputTokens(tokens, config?.limits.maxStandardInputTokens);
}
