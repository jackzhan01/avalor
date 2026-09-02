/**
 * Stage 2 — the seat that writes the sentence and knows nothing.
 *
 * THIS FILE IS THE MECHANISM. Everything else in M5.3 — the rules, the
 * classification, the detector — is support. The guarantee is this: the
 * function that builds the public spokesperson's prompt CANNOT REACH the pair,
 * the vision, the roster, the Lady truth, the role, or the ledger, because its
 * input type does not contain them and `assertPublicOnly` refuses at runtime
 * anything that smuggles them in past an `as`.
 *
 * That is a different kind of claim from "the prompt asks it not to". The M5.2
 * pilot asked, in a strategy entry written for exactly this purpose, and seat 8
 * published 「7、9一梅林一莫甘娜」 twice. A model cannot decline to reveal a
 * value it was never given, and it cannot be argued into revealing one either.
 *
 * WHAT THE SPOKESPERSON MAY NOT DO. It writes wording. It does not choose the
 * team, the vote, the mission card, the Lady target, the announced value, the
 * claim, the retraction or the assassination target — stage 1 chose all of
 * those atomically, and the merged answer takes them from stage 1's fields.
 * The spokesperson's schema contains one string and nothing else, so this is
 * not a policy it might drift from; there is no field for it to drift into.
 *
 * WHAT IT DOES RECEIVE, and why each is safe:
 *
 *   the public log            every seat already has it
 *   the referee fact tables   derived from that log by pure functions
 *   the claim contest         likewise
 *   the position view         score, leader, attempt, speaking order — public
 *   a sanitised intent        ids resolved public-only, text fields scrubbed
 *   a persona                 style, and style is public by construction
 *   the seat number           public
 *
 * The seat number is worth a sentence. It is public — everyone can see who is
 * speaking — and the spokesperson needs it to write in the first person. It
 * carries nothing about the deal, and the non-interference tests hold it fixed
 * while swapping everything hidden.
 */

import type { PublicEvent } from "../core/events";
import type { Observation, PositionView } from "../core/observation";
import type { Seat } from "../core/types";
import { ALL_SECRET_CLASSES, SECRET_LABELS, type SecretClass } from "./classification";
import { claimContestFrom, renderClaimContest } from "./claim-contest";
import {
  failedTeamConstraintEntries,
  renderFactTables,
} from "./context-pack";
import { claimsFrom, publicFactsFrom } from "./ledger";
import type { SanitisedIntent } from "./intent";
import type { Fragment } from "../model/json-schema";
import { renderPersona, type PersonaDefinition } from "../prompts/personas";
import { roleName } from "../prompts/transcript";

/* ── The view ───────────────────────────────────────────────────────────── */

/**
 * Everything the spokesperson may know about the game.
 *
 * Three fields, all public. Note what is NOT here: `role`, `side`,
 * `knowledge`, `ladyResults`, `evilRoster`, `evilDiscussion`, `memory`,
 * `request`. Adding any of them would be a compile-time change somebody has to
 * make on purpose, in a file whose header says why not to.
 */
export interface PublicTableView {
  readonly seat: Seat;
  readonly position: PositionView;
  readonly publicLog: readonly PublicEvent[];
}

/** The three public fields of an observation, and only those three. */
export function publicTableViewFor(observation: Observation): PublicTableView {
  return {
    seat: observation.seat,
    position: observation.position,
    publicLog: observation.publicLog,
  };
}

/**
 * Keys that only ever exist on something private. Refused at runtime.
 *
 * The same second lock `buildPlayerPrompt` uses against referee state, aimed at
 * the other leak: an `Observation` cast to a `PublicTableView` type-checks
 * fine, because a view is a structural subset of an observation. Only a
 * runtime check catches that, and the cost of missing it is a whole batch of
 * games whose spokespersons could see the deal.
 */
const PRIVATE_KEYS = [
  "role",
  "side",
  "knowledge",
  "ladyResults",
  "evilRoster",
  "evilDiscussion",
  "memory",
  "deal",
  "bySeat",
  "byRole",
  "ledger",
  "cognition",
  "request",
];

export function assertPublicOnly(value: object, what: string): void {
  for (const key of PRIVATE_KEYS) {
    if (key in value) {
      throw new Error(
        `${what} carries "${key}" — the public spokesperson is built from public state only`,
      );
    }
  }
}

/* ── The prompt ─────────────────────────────────────────────────────────── */

export interface SpokespersonInput {
  readonly view: PublicTableView;
  readonly intent: SanitisedIntent;
  readonly persona: PersonaDefinition;
  /** The task the sentence accompanies. Decides the field name and the framing. */
  readonly taskId: string;
  /** Non-whitespace character budget. */
  readonly speechCharLimit: number;
  /**
   * `prompt-0.6.0`: the fact tables render WITHOUT ids and the brief forbids
   * speaking one.
   *
   * STRUCTURAL, not instructional. Under 0.5.0 the tables printed `[f30]` in
   * front of every line and the legend told the spokesperson it could point at
   * them out loud; it did, in every round of two live games. Removing the ids
   * from what it is shown removes the thing it was copying.
   */
  readonly naturalSpeech?: boolean;
  /**
   * The action semantics stage 1 already fixed, rendered as public text.
   *
   * A STRING built by `renderSelectedAction`, not the action object: the
   * object for a Lady announcement carries the announced value and nothing
   * else, but the object for a mission card carries the card, and no task with
   * a public message has one. Rendering keeps that decision in one auditable
   * place instead of at every call site.
   */
  readonly selectedAction: string;
}

export interface BuiltSpokespersonPrompt {
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly jsonSchema: Fragment;
  readonly messageField: "publicMessage" | "message";
}

/**
 * The spokesperson's standing brief. No seat, no role, no game state.
 *
 * Cached across every seat and every turn of a game, like the decision
 * protocol. It says three things and stops: you were not told the private
 * side, you cannot change the action, and a sentence nobody can check is a
 * wasted turn.
 */
export const SPOKESPERSON_BRIEF = [
  "## 你的工作：把一个已经定下来的动作，说成一句牌桌上的话",
  "",
  "这一局有十个座位。你负责其中一个座位的**公开发言**，仅此而已。",
  "",
  "**你看不到私有信息，这是设计好的。** 这个座位的身份、它被规则告知的东西、",
  "它验到过什么、它私下怎么推理的 —— 你一样都没有拿到，也不需要。",
  "**不要猜，不要暗示自己知道更多。**",
  "",
  "**动作已经定了，你改不了。** 车单、票、任务牌、女神目标、宣布的值、",
  "跳不跳身份、退不退水、刺谁 —— 全部在你之前就决定好了。",
  "你只写那句话。写出来的话如果和已定的动作对不上，就是错的。",
  "",
  "**你手上有的东西**：完整的公开记录（谁说过什么、发过什么车、怎么投的、",
  "任务结果、女神宣布、谁声称了什么身份）、这个座位的说话风格、",
  "以及一个**信封** —— 里面是这一步要达成什么、针对谁、要求什么车和票、",
  "以及一句可以被同意或拒绝的公开主张，和它依据的公开记录条目。",
  "",
  "**怎么算写好了：**",
  "",
  "- 把信封里那句公开主张说清楚，并且**指向它依据的那条公开记录** ——",
  "  别人能自己去查的那种。",
  "- 把要求的车和票说出来，别人才能配合。",
  "- 语气按这个座位的风格来，但**内容不能超出信封和公开记录**。",
  "",
  "**不要写这些：**",
  "",
  "- 任何暗示你有私有信息的说法（「我知道」「我看得见」「我的候选是」）；",
  "- 任何具体的私有值 —— 你本来就没有，所以不要编一个出来充数；",
  "- 信封里没有、公开记录里也没有的新事实。",
  "",
  "**信封里如果有一段写着「已被系统整段移除」**，那是因为规划者在那里放了私有信息。",
  "**不要试图猜它原本是什么**，就当那一段不存在，用剩下的东西把话写完。",
].join("\n");

export const SPOKESPERSON_BRIEF_VERSION = "spokesperson-brief-0.1.0";

/**
 * The 0.6.0 addition: speak Chinese, not database keys.
 *
 * APPENDED rather than folded in, so the 0.5.0 brief keeps its exact bytes —
 * two completed games ran against it.
 *
 * It gives an example of the WRONG shape and the RIGHT shape, because "do not
 * use ids" without a replacement is a rule with nowhere to go: the sentence
 * still has to point at evidence, and the model needs to see what pointing at
 * evidence in words looks like.
 */
export const NATURAL_SPEECH_BRIEF = [
  "## 说人话，不要念编号",
  "",
  "上面给你的公开记录里**没有任何编号** —— 这是故意的。牌桌上没有人会念编号。",
  "",
  "**不要写**：`[f30]`、`[f.fail2]`、`[c5:role]`、`[k4:claim]`、`p.` 开头的任何东西、",
  "或者 `requestedTeam` 这样的字段名。也不要用方括号引用的写法。",
  "",
  "**要写**：那条记录**说的事情本身**。",
  "",
  "> ❌ 「[f30][f32][f.fail2] 证明这车坏」",
  "> ✅ 「第二轮 7 号发的 1、2、3、4 出了三张失败票」",
  "",
  "第二种写法里，别人不用去查任何东西就能自己核对 —— 这才是给公开理由的意义。",
  "",
  "**编号不是省字数的办法。** 一句话如果只有编号撑着，它其实没有给出理由，",
  "只是给了一个别人打不开的指针。",
].join("\n");

const TASK_FRAMING: Readonly<Record<string, string>> = {
  "opening-direction": "这个座位是开局车主，正在宣布把湖中女神交给哪一边。",
  "speech-opening": "这个座位是这一辆车的车主，正在开场发言，围绕一个意向车说。",
  "speech-regular": "这个座位在这一辆车上只有这一次发言机会。",
  "leader-close-and-propose": "这个座位是车主，正在收尾发言并给出正式车单。",
  "lady-announce": "这个座位拿着湖中女神，正在当众宣布验人结果。",
  "evil-discuss": "这是刺杀环节的坏人密谈，只有四个坏人听得到，好人听不到这一段。",
};

export function buildSpokespersonPrompt(
  input: SpokespersonInput,
): BuiltSpokespersonPrompt {
  const { view, intent, persona } = input;
  assertPublicOnly(view, "public table view");
  assertPublicOnly(intent, "sanitised intent");

  const facts = publicFactsFrom(view.publicLog);
  const claims = claimsFrom(view.publicLog);
  const contest = claimContestFrom(view.publicLog);

  const natural = input.naturalSpeech === true;
  const factTables = [
    renderFactTables(facts, claims, view, {
      // 0.6.0 prints no ids at all. There is then nothing to quote, which is a
      // stronger guarantee than a rule telling it not to.
      ...(natural ? {} : { withIds: true, legend: "public" as const }),
    }),
    "",
    "### 挂掉的车给出的约束（裁判事实推出来的算术，不是谁的意见）",
    ...failedTeamConstraintEntries(facts).map((e) =>
      natural ? `- ${e.text}` : `- \`[${e.id}]\` ${e.text}`,
    ),
  ].join("\n");

  const messageField = input.taskId === "evil-discuss" ? "message" : "publicMessage";
  const channelLine =
    intent.channel === "evil-council"
      ? "**频道：坏人密谈。** 只有另外三个坏人听得到，好人听不到。"
      : "**频道：牌桌公开。** 十个人全都听得到，而且会永久留在公开记录里。";

  const system = [
    SPOKESPERSON_BRIEF,
    ...(natural ? ["", NATURAL_SPEECH_BRIEF] : []),
    "",
    renderPersona(persona),
    "",
    channelLine,
  ].join("\n");

  const user = [
    `## 你是 ${view.seat}号的发言`,
    "",
    TASK_FRAMING[input.taskId] ?? "这个座位正在发言。",
    "",
    factTables,
    "",
    renderClaimContest(contest),
    "",
    renderRecentDialogue(view),
    "",
    renderIntent(intent, input.selectedAction, natural),
    "",
    renderSpokespersonTask(messageField, input.speechCharLimit, intent),
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    system,
    user,
    schemaName: `avalon_say_${input.taskId.replace(/[^a-zA-Z0-9]+/g, "_")}`,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: [messageField],
      properties: {
        [messageField]: { type: "string", minLength: 1 },
      },
    },
    messageField,
  };
}

/* ── The pieces ─────────────────────────────────────────────────────────── */

function renderRecentDialogue(view: PublicTableView): string {
  const p = view.position;
  const cycle = view.publicLog.filter(
    (e) => e.missionNumber === p.missionNumber && e.attempt === p.attempt,
  );
  if (cycle.length === 0) return "";
  const lines = ["## 这一次点车的全部发言（原文）"];
  for (const e of cycle) {
    lines.push(e.type === "speech" ? `${e.speaker}号：${e.publicMessage}` : `[${e.type}]`);
  }
  return lines.join("\n");
}

const ACT_WORDS: Readonly<Record<string, string>> = {
  "claim-percival": "公开声称自己是派西维尔",
  "counterclaim-percival": "对跳派西维尔",
  "defend-own-claim": "为自己已有的声称辩护",
  "attack-rival-claim": "打对手的声称",
  "endorse-claimant": "支持某个声称者",
  "challenge-claimant": "质疑某个声称者",
  "retract-claim": "退水，公开收回自己之前的声称",
  "compare-claimants": "把几个声称者放在一起比较",
  "stay-hidden": "这一步不谈身份",
};

const VOTE_WORDS: Readonly<Record<string, string>> = {
  approve: "上票",
  reject: "下票",
  none: "不提要求",
};

function renderIntent(
  intent: SanitisedIntent,
  selectedAction: string,
  natural: boolean,
): string {
  const lines = ["## 信封（这一步要达成的事，已经定好了）", ""];
  lines.push(`- **这一步的目的**：${intent.publicGoal || "（未写）"}`);
  lines.push(
    `- **针对谁**：${intent.targetSeats.length > 0 ? intent.targetSeats.map((s) => `${s}号`).join("、") : "全桌"}`,
  );
  lines.push(
    `- **公开身份动作**：${ACT_WORDS[intent.selectedClaimAction] ?? intent.selectedClaimAction}`,
  );
  lines.push(
    `- **要求的车**：${intent.requestedTeam ? intent.requestedTeam.map((s) => `${s}号`).join("、") : "不提车"}`,
  );
  lines.push(`- **要求怎么投**：${VOTE_WORDS[intent.requestedVote] ?? intent.requestedVote}`);
  lines.push(`- **希望牌桌接下来做什么**：${intent.desiredTableEffect || "（未写）"}`);
  lines.push("");
  lines.push("**你要说清楚的那一句公开主张：**", "", `> ${intent.publicProposition}`);

  lines.push(
    "",
    natural
      ? "**它依据的公开记录**（只有这些；**用你自己的话说出来，不要念任何编号**）："
      : "**它可以引用的公开记录条目**（只有这些，别的都不要引）：",
  );
  if (intent.publicBasis.length === 0) {
    lines.push("- （没有给，那就只靠上面的公开记录和这一次的发言本身说）");
  } else {
    for (const b of intent.publicBasis) {
      // 0.6.0 shows the LABEL only. The id is what the private audit keeps; the
      // spokesperson has no use for it and every use of it is a defect.
      lines.push(natural ? `- ${b.label}` : `- \`[${b.id}]\` ${b.label}`);
    }
  }

  if (selectedAction.length > 0) {
    lines.push("", "**已经定下来的动作（你不能改，只能把话和它对齐）：**", selectedAction);
  }

  if (intent.factsThatMustRemainPrivate.length > 0) {
    lines.push(
      "",
      "**这一局里存在下面这几类私有信息。你一样都没有拿到，也不要试图推：**",
      ...intent.factsThatMustRemainPrivate.map((c) => `- ${SECRET_LABELS[c]}`),
      "",
      "写出来的话里**不能出现任何这几类东西的具体值**。你本来就没有，所以最容易犯的错是**编一个** ——",
      "编出来的假私有信息一样会让牌桌以为这个座位有视野，代价和真的泄露一样。",
    );
  }
  return lines.join("\n");
}

function renderSpokespersonTask(
  messageField: string,
  limit: number,
  intent: SanitisedIntent,
): string {
  return [
    "## 输出格式",
    "",
    `只输出一个 JSON 对象，里面只有 \`${messageField}\` 一个字段：`,
    "",
    `{ "${messageField}": "……" }`,
    "",
    `最多 ${limit} 个非空白字符，超了会被打回。`,
    "不要加 markdown 代码块，不要在 JSON 前后写任何别的字。",
    "",
    intent.channel === "evil-council"
      ? "这一句是说给另外三个坏人听的。"
      : "这一句全桌都会听到，并且会被后面每一轮反复引用 —— 说得能被核对，比说得响要紧。",
  ].join("\n");
}

/**
 * The already-chosen action, as public text for stage 2 to align with.
 *
 * Reads only fields the table will see the moment the action is applied. The
 * Lady case is the one to be careful about: the ANNOUNCED value is public the
 * instant it is announced, so the spokesperson must know it to write a
 * coherent sentence — but the referee's true answer never appears here, and
 * `PublicTableView` has no field that could carry it.
 */
export function renderSelectedAction(
  taskId: string,
  action: Readonly<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  const team = action.team;
  if (Array.isArray(team)) parts.push(`- 正式车单：${team.map((s) => `${s}号`).join("、")}`);
  const tentative = action.tentativeTeam;
  if (Array.isArray(tentative)) {
    parts.push(`- 意向车：${tentative.map((s) => `${s}号`).join("、")}`);
  }
  if (action.noTeamYet === true) parts.push("- 明确表示现在组不出车");
  if (typeof action.claim === "string") {
    parts.push(`- 公开声称自己是${roleName(action.claim as never)}`);
  }
  if (action.retractClaim === true) parts.push("- 退水：公开收回之前的身份声称");
  if (typeof action.ladySide === "string") {
    parts.push(`- 湖中女神交给${action.ladySide === "left" ? "左手边" : "右手边"}`);
  }
  if (taskId === "lady-announce" && typeof action.announced === "string") {
    parts.push(`- **当众宣布的结果：${action.announced === "good" ? "好人" : "坏人"}**`);
  }
  const stances = action.stances;
  if (Array.isArray(stances) && stances.length > 0) {
    const rendered = stances
      .map((s) => {
        const entry = s as { seat?: number; valence?: number };
        const v = typeof entry.valence === "number" ? entry.valence : 0;
        return `${entry.seat}号 ${v > 0 ? "保" : v < 0 ? "踩" : "看不清"}`;
      })
      .join("、");
    parts.push(`- 公开表态：${rendered}`);
  }
  return parts.join("\n");
}

/** For the audit and the review package: what stage 2 is never given. */
export const WITHHELD_FROM_SPOKESPERSON: readonly SecretClass[] = ALL_SECRET_CLASSES;
