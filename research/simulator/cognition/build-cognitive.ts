/**
 * The `prompt-0.3.0` layer stack.
 *
 * WHAT MOVED, and why each move is a size decision as much as a quality one:
 *
 *   INTO SYSTEM   the decision protocol. It is one constant for every seat in
 *                 every position, so a game's ~150 requests share one cached
 *                 prefix. A per-seat protocol layer would miss the cache every
 *                 single time, and input is 87% of the uncached spend.
 *
 *   REPLACED      the old layer 5 dumped the whole public log as prose. It is
 *                 now referee-generated fact TABLES plus verbatim recent
 *                 dialogue. Tables are smaller than the prose they replace and
 *                 — the part that matters — mechanically checkable, so
 *                 "nothing was lost" is a property a test can assert rather
 *                 than a claim the author makes.
 *
 *   ADDED         the seat's own bounded ledger, which is what makes the agent
 *                 persistent rather than a stateless policy caller.
 *
 * THE OLD PATH IS UNTOUCHED. `prompts/build.ts` still builds the seven-layer
 * `prompt-0.2.0` stack byte for byte; Experiments 2 and 3 stay reproducible.
 * Nothing here runs unless `cognition.enabled` is true.
 */

import type { SimConfig } from "../config/load";
import type { Observation } from "../core/observation";
import { SEATS } from "../core/types";
import { COMMON_RULES } from "../prompts/common";
import { renderPersona, type PersonaDefinition } from "../prompts/personas";
import { renderRoleLayer } from "../prompts/roles";
import { renderStrategy, type StrategyDefinition } from "../prompts/strategies";
import { renderTask, taskSchemaFor, type TaskSchema } from "../prompts/tasks";
import {
  PROMPT_VERSION_COGNITIVE,
  PROMPT_VERSION_COGNITIVE_V2,
  PROMPT_VERSION_CONTEST,
} from "../prompts/version";
import { jsonSchemaFor, type Fragment } from "../model/json-schema";
import {
  packContext,
  renderOwnPrivateFacts,
  type ArgumentSummary,
  type ContextPack,
} from "./context-pack";
import { activeCommitments, type EpistemicLedger } from "./ledger";
import { limitsFor } from "./limits";
import {
  DECISION_PROTOCOL_LAYER,
  DECISION_PROTOCOL_LAYER_V2,
  DECISION_PROTOCOL_LAYER_V3,
  renderCognition,
} from "./protocol";
import { renderContest } from "./contest";
import { cognitionFragment, COGNITION_FRAGMENT } from "./response";
import { renderSocial } from "./social";

export interface CognitivePromptInput {
  readonly observation: Observation;
  readonly persona: PersonaDefinition;
  readonly strategy: StrategyDefinition;
  readonly ledger: EpistemicLedger;
  readonly config: SimConfig;
  readonly olderArguments?: readonly ArgumentSummary[];
  /** Appended to the user message on a repair attempt. */
  readonly repairNote?: string;
}

export interface CognitiveLayer {
  readonly index: number;
  readonly title: string;
  readonly text: string;
}

export interface BuiltCognitivePrompt {
  readonly promptVersion: string;
  readonly taskId: string;
  readonly schema: TaskSchema;
  /** Action fields plus the cognition block, as one strict schema. */
  readonly jsonSchema: Fragment;
  readonly schemaName: string;
  readonly layers: readonly CognitiveLayer[];
  readonly system: string;
  readonly user: string;
  readonly pack: ContextPack;
}

/** Same guard as the legacy builder: an `as` cast must not smuggle state in. */
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

function assertNoRefereeState(value: object, what: string): void {
  for (const key of REFEREE_ONLY_KEYS) {
    if (key in value) {
      throw new Error(
        `${what} carries "${key}" — that is referee state, and prompts are built from an Observation only`,
      );
    }
  }
}

/**
 * The strict schema the model answers with: the task's own action fields plus
 * one `cognition` object.
 *
 * Built by extending the existing task schema rather than by defining a
 * parallel one. A second definition of "what a legal speech looks like" would
 * drift from the first, and the referee only validates one of them.
 */
export function fusedSchemaFor(task: TaskSchema, promptVersion?: string): Fragment {
  const base = jsonSchemaFor(task) as {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, Fragment>;
  };
  const contest = promptVersion === PROMPT_VERSION_CONTEST;
  const social = contest || promptVersion === PROMPT_VERSION_COGNITIVE_V2;
  return {
    type: "object",
    additionalProperties: false,
    required: [...base.required, "cognition"],
    properties: {
      ...base.properties,
      // Default keeps the frozen 0.3.0 object, so a caller that does not pass a
      // version gets exactly what the completed pilot sent.
      cognition: social
        ? cognitionFragment(limitsFor(promptVersion ?? PROMPT_VERSION_COGNITIVE_V2), {
            withSocial: true,
            ...(contest ? { withContest: true } : {}),
          })
        : COGNITION_FRAGMENT,
    },
  };
}

export function fusedSchemaNameFor(task: TaskSchema): string {
  return `avalon_cog_${task.id.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

export function buildCognitivePrompt(input: CognitivePromptInput): BuiltCognitivePrompt {
  const { observation, persona, strategy, ledger, config } = input;
  assertNoRefereeState(observation, "observation");

  const request = observation.request;
  if (!request) {
    throw new Error(
      `seat ${observation.seat} has no pending request — there is nothing to ask it`,
    );
  }
  if (ledger.seat !== observation.seat) {
    // A seat reading another seat's ledger would be the worst leak this system
    // could produce, so it is checked at the one place both are in scope.
    throw new Error(
      `ledger belongs to ${ledger.seat}号 but the prompt is for ${observation.seat}号`,
    );
  }

  // One flag decides the whole stack: which limit table, which schema, whether
  // ids are rendered, whether the social block is asked for. Keeping it a
  // single derived boolean is what stops the two versions from interleaving.
  const contest = config.promptVersion === PROMPT_VERSION_CONTEST;
  // 0.4.0 is a superset: it renders ids and the social block too. One derived
  // pair of booleans rather than a chain of version comparisons scattered
  // through the builder — that is what stops the three stacks interleaving.
  const social = contest || config.promptVersion === PROMPT_VERSION_COGNITIVE_V2;
  const limits = limitsFor(config.promptVersion);

  const schema = taskSchemaFor(request, config.limits.speechCharLimit, {
    withRetraction: contest,
  });

  const cognitionText = renderCognition({
    constraints: ledger.constraints,
    hypotheses: ledger.hypotheses,
    dossiers: ledger.dossiers,
    seats: SEATS,
    rolePlan: ledger.self.rolePlan,
    commitments: activeCommitments(ledger.self.publicCommitments).map((c) => c.text),
    ...(social ? { social: renderSocial(ledger.social) } : {}),
    ...(contest ? { contest: renderContest(ledger.contest) } : {}),
  });

  const taskText = [
    renderTask(schema),
    "",
    contest
      ? COGNITION_INSTRUCTION_V3
      : social
        ? COGNITION_INSTRUCTION_V2
        : COGNITION_INSTRUCTION,
  ].join("\n");

  const pack = packContext({
    observation,
    ledger,
    cognitionText,
    taskAndSchema: taskText,
    olderArguments: input.olderArguments ?? [],
    withIds: social,
    withClaimContest: contest,
  });

  const layers: CognitiveLayer[] = [
    { index: 1, title: "共同规则", text: COMMON_RULES },
    {
      index: 2,
      title: "思考流程",
      text: contest
        ? DECISION_PROTOCOL_LAYER_V3
        : social
          ? DECISION_PROTOCOL_LAYER_V2
          : DECISION_PROTOCOL_LAYER,
    },
    { index: 3, title: "说话风格", text: renderPersona(persona) },
    { index: 4, title: "身份与合法信息类型", text: renderRoleLayer(observation.role) },
    { index: 5, title: "硬事实与挂车约束", text: pack.factTables },
    ...(contest
      ? [{ index: 5.5, title: "身份声称与派权争夺", text: pack.claimContest }]
      : []),
    {
      index: 6,
      title: "只有你知道的硬信息",
      text: renderOwnPrivateFacts(observation, { withIds: social }),
    },
    { index: 7, title: "你自己的推理记录", text: cognitionText },
    { index: 8, title: "策略档", text: renderStrategy(strategy, observation) },
    { index: 9, title: "最近的发言与本次任务", text: renderRecent(pack) },
    { index: 10, title: "输出格式", text: taskText },
  ];

  // 1-4 are stable for the whole game: rules, protocol, persona, role. That is
  // the cacheable prefix, and it is why the protocol carries no seat number.
  const system = layers
    .filter((l) => l.index <= 4)
    .map((l) => l.text)
    .join("\n\n");
  const userParts = layers
    .filter((l) => l.index >= 5)
    .map((l) => l.text)
    .filter((t) => t.length > 0);
  const user = input.repairNote
    ? `${userParts.join("\n\n")}\n\n${input.repairNote}`
    : userParts.join("\n\n");

  return {
    promptVersion: contest
      ? PROMPT_VERSION_CONTEST
      : social
        ? PROMPT_VERSION_COGNITIVE_V2
        : PROMPT_VERSION_COGNITIVE,
    taskId: schema.id,
    schema,
    jsonSchema: fusedSchemaFor(schema, config.promptVersion),
    schemaName: fusedSchemaNameFor(schema),
    layers,
    system,
    user,
    pack,
  };
}

function renderRecent(pack: ContextPack): string {
  const parts: string[] = [];
  if (pack.olderArguments.length > 0) {
    parts.push("## 更早的讨论（已压缩；上面的硬事实是完整的）");
    for (const a of pack.olderArguments) {
      parts.push(`- R${a.missionNumber}#${a.attempt}：${a.text}`);
    }
    parts.push("");
  }
  if (pack.currentCycle.length > 0) {
    parts.push("## 这一次点车的全部发言（原文）");
    for (const e of pack.currentCycle) {
      parts.push(e.type === "speech" ? `${e.speaker}号：${e.publicMessage}` : `[${e.type}]`);
    }
  }
  return parts.join("\n");
}

/**
 * How to fill the `cognition` block. Deliberately short.
 *
 * The protocol layer already says WHAT to think about; this says only where to
 * put the conclusions. Saying it twice would be two copies that drift, and the
 * one in the cached system layer would win by repetition.
 */
export const COGNITION_INSTRUCTION = [
  "### 除了动作，还要填一个 `cognition` 对象",
  "",
  "把上面思考流程的**结论**填进去，不要写过程：",
  "",
  "- `factsUsed`：你用到的硬事实 id（就是上面事实表里 `f` 开头的那些）",
  "- `claimsReliedOn`：你**采信了**的说法 id（`c` 开头）。采信不等于它是真的",
  "- `claimsQuestioned`：你**不接受**的说法 id。同一个 id 不能同时出现在这两个数组里",
  "- `alternativesConsidered`：你比较过的其他候选动作，至少两条",
  "- `selectedActionSummary`：一句话说明你为什么选这个动作",
  "- `intendedPublicSignal`：这一步你想让牌桌接收到什么（私有，牌桌看不到）",
  "- `updatedRolePlan`：身份计划有变就写新的，没变填 null",
  "- `constraints`：你推出来的约束。**每条都要列出 `premiseIds`** —— 用到的事实 id 或说法 id。",
  "  系统会自己判断这些前提硬不硬，你不需要（也不能）声明",
  "- `hypotheses`：**至少两种**同时说得通的坏人配置",
  "- `seatReads`：你对各座位的判断，用 strong-good / lean-good / unresolved / lean-evil / strong-evil",
  "- `coverStory` / `claimPlan` / `nextTurnPlan`：你自己的计划，全部私有",
  "- `newCommitments`：这一步你新做出的公开承诺（之后要保持一致的话）",
  "",
  "**公开发言里只放你真正想在牌桌上说的话，认知内容一个字都不要写进去。**",
].join("\n");

/**
 * The `prompt-0.3.1` instruction: the same fields, with real ids, plus social.
 *
 * The one line this file got wrong last time said the ids were "the ones
 * starting with `f` in the fact table above", and the fact table printed none.
 * It now points at the bracket that is actually there, and shows one.
 */
export const COGNITION_INSTRUCTION_V2 = [
  "### 除了动作，还要填一个 `cognition` 对象",
  "",
  "把上面思考流程的**结论**填进去，不要写过程。",
  "",
  "**先说 id 怎么填。** 上面事实表和你的私有信息里，每一行开头都有一个方括号 ——",
  "`[f12]`、`[f.fail1]`、`[c33:role]`、`[p.pair]` 这样的。**照抄方括号里面的东西**，",
  "不要自己造。造出来的 id 系统查不到，那条前提就会被算成不硬的。",
  "",
  "- `factsUsed`：你用到的硬事实 id（`f` 开头，包括 `f.now` 和 `f.fail…` 这类算出来的）",
  "- `claimsReliedOn`：你**采信了**的说法 id（`c` 开头）。采信不等于它是真的",
  "- `claimsQuestioned`：你**不接受**的说法 id。同一个 id 不能同时出现在这两个数组里",
  "- `alternativesConsidered`：你比较过的其他候选动作，至少两条",
  "- `selectedActionSummary`：一句话说明你为什么选这个动作",
  "- `intendedPublicSignal`：这一步你想让牌桌接收到什么（私有，牌桌看不到）",
  "- `updatedRolePlan`：身份计划有变就写新的，没变填 null",
  "- `constraints`：你推出来的约束。**每条至少要有一个 `premiseIds`** —— 事实 id 或说法 id 都行。",
  "  你自己的身份用 `p.self`。系统会自己判断这些前提硬不硬，你不需要（也不能）声明",
  "- `hypotheses`：**至少两种**同时说得通的坏人配置，每一种都要有真正的 label 和 rationale",
  "- `seatReads`：你对各座位的判断，用 strong-good / lean-good / unresolved / lean-evil / strong-evil",
  "- `coverStory` / `claimPlan` / `nextTurnPlan`：你自己的计划，全部私有",
  "- `newCommitments`：这一步你新做出的公开承诺（之后要保持一致的话）",
  "- `closedCommitments`：已经兑现（fulfilled）、被局面作废（obsolete）、",
  "  或者你公开反悔了（withdrawn）的旧承诺，`text` 要和原文一字不差。没有就给空数组",
  "",
  "### `social`：你对牌桌的读",
  "",
  "- `focalCandidates`：现在谁在带节奏，最多三个。每一个都要有 `basisIds`（他凭哪条公开记录）、",
  "  `directive`（他要牌桌做什么）、`conditionToReconsider`（什么会让你改变对他的看法），",
  "  以及跟他的理由和驳他的理由 —— 两边都空说明他其实不是焦点",
  "- `alignment`：你这一步的站位。`stance` 是 follow / conditional-follow / challenge / independent。",
  "  除了 independent 都必须点名 `focalSeat`。`proposition` 要写成**一句可以被同意或拒绝的话**，",
  "  `publicAction` 写你打算在公开场合做什么，别人要能据此和你配合",
  "- `coalitionPlan`：你想拉谁、想推哪辆车、票往哪边、这次发言要达成什么，",
  "  以及 `strongestDissent` —— 反对你这个计划的最强理由是什么",
  "",
  "**跳身份、藏身份、跟人、驳人，全部是你自己的选择。** 上面这些字段只是要求你把选择记下来。",
  "",
  "**公开发言里只放你真正想在牌桌上说的话，认知内容一个字都不要写进去。**",
].join("\n");

/**
 * The `prompt-0.4.0` instruction: everything 0.3.1 asks for, plus the contest.
 *
 * Built by APPENDING to the 0.3.1 text rather than by restating it. Two copies
 * of "here is how to fill `factsUsed`" would drift, and the drift would be
 * invisible until a game produced two different answers to the same question.
 */
export const COGNITION_INSTRUCTION_V3 = [
  COGNITION_INSTRUCTION_V2,
  "",
  "### `contest`：派权争夺",
  "",
  "**任何身份都可以声称任何身份**，包括派西维尔。桌上同时有几个人自称同一个身份是常见局面。",
  "",
  "- `ownClaimStrategy`：你自己在这个场上的位置。",
  "  `currentStatus` 是 hidden / considering / active / defending / retracting / retracted。",
  "  `situationSpecificBenefit` 和 `situationSpecificRisk` 要写**这一手在这个局面下**",
  "  换到什么、代价是什么 —— 不是「跳了能组织好人」这种一般道理。",
  "  `triggerToClaim` 和 `triggerToRetract` 是具体条件。`candidatePairStory` 是你打算",
  "  在公开场合讲的候选对说法（你完全可以编一个，也可以留空）。",
  "  `consistencyObligations` 是你已经说过、之后必须对得上的话。",
  "- `claimantAssessments`：**把所有声称者放在一起比**，一个都不能漏 ——",
  "  桌上正站在派西维尔上的人必须全部在这个数组里。每一条要有 `premiseIds`，",
  "  填的是事实表和声称表里的 `[f…]` / `[c…]` / `[k…]`。",
  "  `currentAssessment` 是 leading / plausible / contested / weak / broken ——",
  "  这是在评价**那个声称站不站得住**，不是在断定那个人是好是坏。",
  "  `conditionToUpgrade` / `conditionToDowngrade` 必填。",
  "- `rivalPlans`：**只有你自己也在声称的时候才填**。桌上还有别的声称者而你在场上，",
  "  这里就不能是空的 —— 竞争者在抢你的权威，不是在发表平行意见。",
  "  每条都要写满：`whyTheirClaimCompetesWithMine`（他为什么和你冲突）、",
  "  `attackCase`（你要打的点）、`expectedDefense`（他大概怎么答）、",
  "  `myResponse`（你怎么回）、`riskOfOverattacking`（打过头的风险）、",
  "  `distinctionTest`（一个能把你们俩分开的公开检验）。",
  "- `alignment`：你在声称者之间的站位。`stance` 是 support / conditional-support /",
  "  oppose / undecided；除了 undecided 都必须点名 `selectedClaimant`。",
  "  `proposition` 要写成一句可以被同意或拒绝的话，`voteOrTeamConsequence` 要落到票或车上。",
  "- `publicClaimMove`：你这一步真正要做的公开动作。`act` 从固定列表里选：",
  "  claim-percival / counterclaim-percival / defend-own-claim / attack-rival-claim /",
  "  endorse-claimant / challenge-claimant / retract-claim / compare-claimants / stay-hidden。",
  "  `attack-rival-claim`、`endorse-claimant`、`challenge-claimant` 必须点名 `targetSeats`，",
  "  而且对方得是真的声称过的人。`defend-own-claim` 和 `retract-claim` 需要你自己有成立的声称。",
  "  `requestedTeam` 的人数要符合这一轮的车。`evidenceIds` 同样填真实 id。",
  "  `informationToConceal` 写这一步绝对不能漏出去的东西（私有，牌桌看不到）。",
  "",
  "**动作字段和 `contest` 要对得上。** 这一步真的要跳，就在动作的 `claim` 里填 `percival`；",
  "真的要退水，就把 `retractClaim` 填 true（**和 claim 填 null 不是一回事** ——",
  "claim 填 null 只是这次不谈身份，你之前的声称仍然成立）。",
  "只在 `contest` 里写「我跳了」而动作里不跳，牌桌什么都看不到。",
  "",
  "**打一个人的声称，不等于说他是坏人。** 时机不对、故事对不上、票和话不一致，",
  "都是在打声称；直接指认是另一个动作，代价也不一样。",
].join("\n");
