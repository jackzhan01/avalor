/**
 * Layer 7 — what is being asked right now, and the exact shape of the answer.
 *
 * Every schema separates four things, and the separation is the point:
 *
 *   PUBLIC MESSAGE   what the table hears. Counted against the 220-character
 *                    budget, and rejected rather than trimmed if it is over.
 *   ACTION           the executable part. A car, a vote, a card, a target.
 *   MEMORY PATCH     compact structured notes, replacing the previous ones.
 *   RATIONALE        one line, for the researcher reading the trace later.
 *
 * A rationale is NOT hidden chain of thought and must not be treated as a
 * place to put one. Nothing here asks the model to show its reasoning; what is
 * asked for is the conclusions it is willing to state, which is the only kind
 * of record that can be audited afterwards.
 *
 * There is one schema per (request kind, speech slot). The two speech slots
 * differ enough to be worth separating: the leader's opening turn is expected
 * to put a tentative car on the table or say why it cannot, an ordinary turn
 * is not.
 */

import type { DecisionRequest } from "../core/types";
import type { Fragment } from "../model/json-schema";
import { assassinationFragment } from "../cognition/assassination";
import { COGNITION_LIMITS_V3 } from "../cognition/limits";

export type SchemaGroup = "public" | "action" | "memory" | "rationale";

export interface SchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly group: SchemaGroup;
  readonly description: string;
  /**
   * A JSON Schema fragment that overrides the one keyed by `name`.
   *
   * Added for M5.5, where two fields differ BY VERSION rather than by name:
   * 0.7.0's `assassination` carries a per-candidate Lady analysis and 0.6.0's
   * does not, and the answer key has to stay `assassination` in both. The
   * alternative — a second entry in `FRAGMENTS` under a versioned name —
   * would put the version back into a lookup key, which is the pattern
   * `prompts/capabilities.ts` exists to remove.
   */
  readonly fragment?: Fragment;
}

export interface TaskSchema {
  /** Stable id, used by snapshots and by the future model client's cache key. */
  readonly id: string;
  readonly requestKind: DecisionRequest["kind"];
  readonly title: string;
  readonly instruction: string;
  /** Non-whitespace character budget for `publicMessage`, or null if none. */
  readonly publicMessageLimit: number | null;
  readonly fields: readonly SchemaField[];
  readonly example: Readonly<Record<string, unknown>>;
}

const MEMORY_FIELD: SchemaField = {
  name: "memoryPatch",
  type: `{ beliefs?: [{seat: 1-10, pEvil: 0-1, note: string}], intentions?: string[], commitments?: string[] }`,
  required: false,
  group: "memory",
  description:
    "你的紧凑私有笔记，会整段替换上一次的。beliefs 是对各座位的怀疑度（软判断，不是硬信息）；intentions 最多三条，写你接下来打算做什么；commitments 写你已经公开承诺、之后要保持一致的东西。别在这里写完整推理。",
};

const RATIONALE_FIELD: SchemaField = {
  name: "rationale",
  type: "string",
  required: false,
  group: "rationale",
  description:
    "一句话，给研究者看的注解，说明你这个动作的主要依据。不是思维链，不要展开推理，也不会有人在游戏里看到它。",
};

/**
 * Options that change the SHAPE of a task, not just its wording.
 *
 * `withRetraction` exists because 退水 is new in `prompt-0.4.0` and the three
 * earlier stacks must keep sending exactly the schema they sent. A field
 * appearing in a strict schema changes `required`, which changes the request,
 * which would make three completed games unbuildable from a checkout.
 */
export interface TaskOptions {
  readonly withRetraction?: boolean;
  /**
   * `prompt-0.6.0`: the mission card carries a bounded coordination record.
   *
   * A separate flag for the same reason `withRetraction` is one — a field
   * appearing in a strict schema changes `required`, which changes the
   * request, which would make four completed games unbuildable.
   */
  readonly withCoordination?: boolean;
  /**
   * `prompt-0.6.0`: the vote carries a bounded six-question analysis.
   *
   * ATTENTION, NOT A QUOTA. It requires the voter to have looked at what the
   * last mission result constrained; it never requires a particular vote.
   */
  readonly withVoteAnalysis?: boolean;
  /** `prompt-0.6.0`: the Assassin ranks candidates before naming one. */
  readonly withAssassinationRanking?: boolean;
  /** `prompt-0.7.0`: the per-candidate Lady analysis inside the ranking. */
  readonly withLadyAnalysis?: boolean;
  /** `prompt-0.7.0`: `claimPurpose` beside `claim` on every speech. */
  readonly withClaimPurpose?: boolean;
}

function speechFields(
  withTeam: boolean,
  withRetraction = false,
  withClaimPurpose = false,
): SchemaField[] {
  const fields: SchemaField[] = [
    {
      name: "publicMessage",
      type: "string",
      required: true,
      group: "public",
      description: "你要说出口的话。全桌都听得到。最多 220 个非空白字符，超了会被打回。",
    },
    {
      name: "stances",
      type: "[{seat: 1-10, valence: -1..1, confidence: 0..1}]",
      required: false,
      group: "public",
      description:
        "你对其他座位的公开表态。valence -1 是强踩，+1 是强保，0 是明确说看不清。不要给自己表态。",
    },
    {
      name: "claim",
      type: '"merlin" | "percival" | "loyal" | "morgana" | "mordred" | "assassin" | "oberon" | null',
      required: false,
      group: "public",
      description:
        "公开声称自己是某个身份，或者 null 表示不声称。声称是可选的，桌上没有任何规则要求你声称或不声称。" +
        (withClaimPurpose
          ? "**已经成立的声称不需要再报一次** —— 想引用它，在话里说就行，claim 留空。"
          : ""),
    },
  ];
  if (withClaimPurpose) {
    fields.push({
      name: "claimPurpose",
      type: '"first-claim" | "answering-challenge" | "resolving-ambiguity" | "re-entering" | null',
      required: false,
      group: "public",
      description:
        "只有 claim 不为 null 时才要填：这一次报身份是为了什么。" +
        "`first-claim` 第一次报；`answering-challenge` 有人跳了同一个身份或者当面质疑你；" +
        "`resolving-ambiguity` 牌桌在当你没报过；`re-entering` 你退过水，现在重新报。" +
        "**会拿公开记录核对** —— 对不上会被打回。",
    });
    fields.push({
      name: "ambiguityEventIds",
      type: "number[] | null",
      required: false,
      group: "public",
      description:
        "只有 `claimPurpose` 是 `resolving-ambiguity` 时才要填：" +
        "**哪一件公开的事**让你这个已经成立的声称重新变得不清楚 —— 填它的 seq。" +
        "必须是你上次报身份之后发生的，而且得是别人跳身份 / 退水 / 踩你 / 新的任务结果 / 女神宣布这几类之一。" +
        "**这是私有字段，牌桌看不到。** 一件都指不出来，就说明没有歧义可澄清。",
    });
  }
  if (withRetraction) {
    fields.push({
      name: "retractClaim",
      type: "boolean | null",
      required: false,
      group: "public",
      description:
        "退水：公开收回你之前成立的身份声称。**和 claim: null 不是一回事** —— " +
        "claim 填 null 只是这次发言不谈身份，你之前声称的仍然成立；填 true 才是当众撤回。" +
        "只有你现在有成立的声称时才能填 true，而且不能和新的 claim 同时给。" +
        "撤回不会删掉记录：你原来声称过什么、什么时候、当时推过什么车，全都留在公开日志里。",
    });
  }
  if (withTeam) {
    fields.push(
      {
        name: "tentativeTeam",
        type: "number[] | null",
        required: false,
        group: "public",
        description:
          "意向车：你现在倾向于带哪些座位。**这不是正式车单**，之后可以改。不给就填 null。",
      },
      {
        name: "noTeamYet",
        type: "boolean",
        required: false,
        group: "public",
        description:
          "你现在组不出合适的车。填 true 时 tentativeTeam 必须是 null，两者不能同时给。",
      },
    );
  }
  return fields;
}

function build(
  id: string,
  requestKind: DecisionRequest["kind"],
  title: string,
  instruction: string,
  publicMessageLimit: number | null,
  fields: readonly SchemaField[],
  example: Readonly<Record<string, unknown>>,
): TaskSchema {
  return {
    id,
    requestKind,
    title,
    instruction,
    publicMessageLimit,
    fields: [...fields, MEMORY_FIELD, RATIONALE_FIELD],
    example,
  };
}

export function taskSchemaFor(
  request: DecisionRequest,
  speechCharLimit: number,
  options: TaskOptions = {},
): TaskSchema {
  switch (request.kind) {
    case "choose_opening_direction":
      return build(
        "opening-direction",
        request.kind,
        "开局：选方向",
        [
          "你是开局车主。你要决定把湖中女神交给自己**左手边**还是**右手边**的人。",
          "记住两者是相反的：交给左手边 → 发言与车主往右轮转；交给右手边 → 往左轮转。",
          "方向定下之后整局不变，全桌都会知道。",
          "同时说一句公开的话，解释或者不解释都行。",
        ].join("\n"),
        speechCharLimit,
        [
          {
            name: "ladySide",
            type: '"left" | "right"',
            required: true,
            group: "action",
            description: "把湖中女神交给你左手边还是右手边的人。",
          },
          {
            name: "publicMessage",
            type: "string",
            required: true,
            group: "public",
            description: "你在做这个决定时说的话。最多 220 个非空白字符。",
          },
        ],
        {
          ladySide: "left",
          publicMessage: "女神给我左手边，顺序往右走。",
          memoryPatch: { intentions: ["先看第一辆车谁抢着上"] },
          rationale: "想让令牌落在发言靠后的位置",
        },
      );

    case "speech": {
      const opening = request.slot === "opening";
      return build(
        opening ? "speech-opening" : "speech-regular",
        request.kind,
        opening ? "你的开场发言（你是车主）" : "你的发言",
        opening
          ? [
              "轮到你开场。你是这一辆车的车主。",
              "**围绕一个意向车来说** —— 你现在倾向于带谁、为什么。",
              "如果你确实组不出合适的车，也可以直说（把 noTeamYet 填 true，tentativeTeam 填 null）。",
              "这只是意向。等其他九个人说完，你还会有一次收尾发言，那时候才给正式车单。",
            ].join("\n")
          : [
              "轮到你发言。你在这一辆车上只有这一次机会说话。",
              "可以给判断、给表态、追问别人、也可以说自己看不清。",
              "你也可以顺手给一个意向车，表示你希望车主带谁 —— 但决定权不在你。",
            ].join("\n"),
        speechCharLimit,
        speechFields(true, options.withRetraction === true, options.withClaimPurpose === true),
        opening
          ? {
              publicMessage: "我先带 1、4、7，理由是他们前面都没被质疑过。",
              tentativeTeam: [1, 4, 7],
              noTeamYet: false,
              stances: [{ seat: 6, valence: -0.3, confidence: 0.4 }],
              claim: null,
              memoryPatch: { intentions: ["听完九个人再决定要不要换人"] },
              rationale: "开局没有信息，先给一辆最难挑毛病的车",
            }
          : {
              publicMessage: "我不太想让 6 号上这辆车，他刚才对 4 号的解释绕开了投票。",
              tentativeTeam: null,
              noTeamYet: false,
              stances: [{ seat: 6, valence: -0.5, confidence: 0.5 }],
              claim: null,
              memoryPatch: { beliefs: [{ seat: 6, pEvil: 0.6, note: "回避了自己的票" }] },
              rationale: "他的说法和票对不上",
            },
      );
    }

    case "leader_close_and_propose":
      return build(
        "leader-close-and-propose",
        request.kind,
        "收尾发言 + 正式车单",
        [
          "九个人都说完了，轮到你收尾。**这一次回答同时包含两件事**：",
          "1. 你的收尾发言（另有独立的 220 字额度，和你的开场不共用）；",
          `2. **正式车单**，必须正好 ${request.teamSize} 个人，座位互不重复。`,
          "正式车单可以和你开场说的意向车不一样 —— 改了就在发言里说清楚，因为两者都留在公开记录里。",
          "车单一旦提交，全桌立刻投票。",
        ].join("\n"),
        speechCharLimit,
        [
          {
            name: "publicMessage",
            type: "string",
            required: true,
            group: "public",
            description: "你的收尾发言。最多 220 个非空白字符，和开场额度分开计算。",
          },
          {
            name: "team",
            type: "number[]",
            required: true,
            group: "action",
            description: `正式车单。正好 ${request.teamSize} 个不重复的座位（1 到 10）。`,
          },
        ],
        {
          publicMessage: "听完之后我把 6 号换下来，改带 1、4、9。",
          team: [1, 4, 9],
          memoryPatch: { commitments: ["我说过换掉 6 号是因为他回避投票"] },
          rationale: "6 号在解释里绕开了自己的票",
        },
      );

    case "vote":
      return build(
        "vote",
        request.kind,
        "投票",
        [
          "对桌上这辆车投票。十个人同时投，**同时揭晓** —— 你现在看不到任何人的票。",
          "过车要严格多数：至少 6 票上才算过，5 上 5 下算否。",
          "注意连否的代价：同一轮连否 5 次，坏人直接获胜。",
          "这一步没有公开发言。",
        ].join("\n"),
        null,
        [
          {
            name: "choice",
            type: '"approve" | "reject"',
            required: true,
            group: "action",
            description: "上票还是下票。",
          },
          ...(options.withVoteAnalysis === true
            ? [
                {
                  name: "voteAnalysis",
                  type:
                    "{ newConstraint, constraintFit, implicatedRiders, leaderExplanation, " +
                    "informationFromApproving, rejectionStreak, hammerRisk, choice, reason, evidenceIds }",
                  required: true,
                  group: "action" as const,
                  description:
                    "投票前的六问，填**结论**不填过程。`choice` 必须和上面的 choice 一致。" +
                    "**这六问不是要你投反对** —— 每一个的合理答案里都包含「所以我上票」。" +
                    "要求的只有一件事：这六件事你看过了。",
                },
              ]
            : []),
        ],
        {
          choice: "reject",
          memoryPatch: { intentions: ["如果这辆车过了，重点看 4 号出不出坏票"] },
          rationale: "车上有上一轮崩车的人",
        },
      );

    case "mission":
      return build(
        "mission-card",
        request.kind,
        "出任务牌",
        [
          "你在车上。出一张任务牌。",
          "**只有坏人会被问到这一步** —— 好人没有选择，裁判直接替他们出成功。",
          "结算后公开的只有：上车名单、成功或失败、坏票张数。**谁出的哪张牌永远不公开。**",
          "这一步没有公开发言。",
        ].join("\n"),
        null,
        [
          {
            name: "card",
            type: '"success" | "fail"',
            required: true,
            group: "action",
            description: "成功或失败。出成功也是一个正当的选择。",
          },
          ...(options.withCoordination === true
            ? [
                {
                  name: "coordination",
                  type:
                    "{ designated: boolean, failsRequired: number, card: \"success\"|\"fail\", " +
                    'intent: "sabotage"|"conceal", evidenceIds: string[] }',
                  required: true,
                  group: "action" as const,
                  description:
                    "按房规约定填的**有界结论**，不要写推理过程。" +
                    "`designated` 抄第四节里给你的指定状态；`failsRequired` 抄这一轮需要几张失败票；" +
                    "`card` 和上面的 card 必须一致；" +
                    "`intent` 是 sabotage（推进破坏）还是 conceal（这一轮藏自己）；" +
                    "`evidenceIds` 填你据以判断的**公开**事实 id（可以为空）。" +
                    "**不是指定出牌人就必须出 success** —— 多加一张失败票会把你们这一队的人数报出去。",
                },
              ]
            : []),
        ],
        {
          card: "success",
          memoryPatch: { intentions: ["这轮先干净过去，第 4 轮再动手"] },
          rationale: "现在崩会把怀疑集中到这四个人身上",
        },
      );

    case "lady_select":
      return build(
        "lady-select",
        request.kind,
        "湖中女神：选一个人验",
        [
          "湖中女神在你手上。选一个人验。",
          `你现在可以验的是：${request.eligible.join("、")}号。`,
          "自己不能验，拿过令牌的人也不能验。",
          "裁判会**私下**告诉你他的真实阵营（只有好人 / 坏人，没有具体身份）。",
          "然后你必须当众宣布一个结果 —— 那一步是下一次回答，你可以说真话也可以说假话。",
          "**令牌接下来会交给被你验的人**，所以验谁也决定了下一次验人权在谁手上。",
          "这一步没有公开发言。",
        ].join("\n"),
        null,
        [
          {
            name: "target",
            type: "number",
            required: true,
            group: "action",
            description: `要验的座位，必须在 ${request.eligible.join("、")} 里面。`,
          },
        ],
        {
          target: request.eligible[0] ?? 1,
          memoryPatch: { intentions: ["按结果决定下一轮保谁"] },
          rationale: "他两轮都在车上但没被质疑过",
        },
      );

    case "lady_announce":
      return build(
        "lady-announce",
        request.kind,
        "湖中女神：当众宣布",
        [
          "裁判已经私下告诉你真实答案了（写在第四节里）。",
          "现在你必须**当众宣布**好人或坏人。",
          "**你可以说谎。** 别人只看得到你说了什么，看不到裁判给你的答案。",
          "你私下拿到的那条硬信息不会因为你说了什么而改变。",
        ].join("\n"),
        speechCharLimit,
        [
          {
            name: "announced",
            type: '"good" | "evil"',
            required: true,
            group: "action",
            description: "你当众宣布的结果。可以和裁判告诉你的不一样。",
          },
          {
            name: "publicMessage",
            type: "string",
            required: true,
            group: "public",
            description: "你宣布时说的话。最多 220 个非空白字符。",
          },
        ],
        {
          announced: "good",
          publicMessage: "我验了 8 号，是好人，下一轮我保他。",
          memoryPatch: { commitments: ["我公开说过 8 号是好人"] },
          rationale: "照实说，先建立可信度",
        },
      );

    case "evil_discuss":
      return build(
        "evil-discuss",
        request.kind,
        "坏人密谈（只有你们四个听得到）",
        [
          "好人已经拿到三轮成功，进入刺杀环节。",
          "四个坏人现在互相知道了确切身份（写在第四节里），**包括奥伯伦**。",
          "按座位顺序，每人说一句。好人听不到这一段。",
          "目标只有一个：帮刺客判断谁是梅林。",
          "长度限制和公开发言一样：最多 220 个非空白字符。",
        ].join("\n"),
        speechCharLimit,
        [
          {
            name: "message",
            type: "string",
            required: true,
            group: "public",
            description: "说给另外三个坏人听的一句话。最多 220 个非空白字符。",
          },
        ],
        {
          message: "我押 2 号。第 3 轮那辆脏车他是唯一下票的好人。",
          memoryPatch: { beliefs: [{ seat: 2, pEvil: 0.1, note: "投得像能看见" }] },
          rationale: "他的票型和有视野的人一致",
        },
      );

    case "assassinate":
      return build(
        "assassinate",
        request.kind,
        "刺杀：指认梅林",
        [
          "由你做最终决定。指认一个座位。",
          "**刺中梅林，坏人赢；没刺中，好人赢。** 没有第二次机会。",
          "你不能指认自己。第四节里已经给了你坏人这边的确切身份，剩下六个座位里有一个是梅林。",
          "这一步没有公开发言。",
        ].join("\n"),
        null,
        [
          {
            name: "target",
            type: "number",
            required: true,
            group: "action",
            description: "你认为是梅林的座位。",
          },
          ...(options.withAssassinationRanking === true
            ? [
                {
                  name: "assassination",
                  type:
                    "{ candidates: [{seat, signals, evidence, counterEvidence, evidenceIds, " +
                    (options.withLadyAnalysis === true ? "lady, " : "") +
                    "confidence}], target, why, whatWouldChangeIt }",
                  required: true,
                  group: "action" as const,
                  fragment: assassinationFragment(
                    COGNITION_LIMITS_V3,
                    options.withLadyAnalysis === true ? { withLadyAnalysis: true } : {},
                  ),
                  description:
                    "指认之前的有界候选排序：至少两个候选，每个都要有正面和反面。" +
                    "`target` 必须和上面的 target 一致，而且必须是候选之一。" +
                    (options.withLadyAnalysis === true
                      ? "**宣布过验人结果的候选必须填 `lady`。**"
                      : "") +
                    "**没有「刺最准的那个」这条规则** —— 最会组织的人同样可能是派西维尔或做掩护的忠臣。",
                },
              ]
            : []),
        ],
        {
          target: 2,
          rationale: "他在第 3、4 轮的票都提前避开了脏车",
        },
      );
  }
}

/** Layer 7 as it reaches the model. */
export function renderTask(schema: TaskSchema): string {
  const lines = [`## 七、现在要你做的事：${schema.title}`, "", schema.instruction, ""];

  const groups: { group: SchemaGroup; label: string }[] = [
    { group: "public", label: "公开发言（全桌听得到）" },
    { group: "action", label: "执行动作（真的会改变游戏状态）" },
    { group: "memory", label: "私有记忆（只有你以后看得到）" },
    { group: "rationale", label: "理由（给研究者看的注解，不是思维链）" },
  ];

  lines.push("### 输出字段");
  for (const { group, label } of groups) {
    const fields = schema.fields.filter((f) => f.group === group);
    if (fields.length === 0) continue;
    lines.push("", `**${label}**`);
    for (const field of fields) {
      lines.push(
        `- \`${field.name}\`（${field.type}）${field.required ? "**必填**" : "可选"}：${field.description}`,
      );
    }
  }

  lines.push(
    "",
    "### 只输出这样一个 JSON 对象",
    "",
    JSON.stringify(schema.example, null, 2),
    "",
    "不要加 markdown 代码块，不要在 JSON 前后写任何别的字。",
  );

  return lines.join("\n");
}
