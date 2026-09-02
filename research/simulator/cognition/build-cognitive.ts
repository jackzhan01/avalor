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
import { capabilitiesFor } from "../prompts/capabilities";
import { PROMPT_VERSION_COGNITIVE_V2 } from "../prompts/version";
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
  DECISION_PROTOCOL_LAYER_V4,
  renderCognition,
} from "./protocol";
import { renderDisclosureRules } from "./disclosure";
import { renderMissionCoordination } from "../core/evil-coordination";
import { VOTE_ANALYSIS_INSTRUCTION } from "./vote-discipline";
import { ASSASSINATION_INSTRUCTION, LADY_INSTRUCTION } from "./assassination";
import { claimPersistenceInstruction } from "./claim-persistence";
import { INTENT_INSTRUCTION, intentFragment } from "./intent";
import { messageFieldFor, taskHasPublicMessage } from "./firewall";
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
  // A caller that passes no version gets exactly what the completed M5 pilot
  // sent — that default is load-bearing and predates the capability table.
  const caps = capabilitiesFor(promptVersion ?? PROMPT_VERSION_COGNITIVE_V2);
  const disclosure = caps.twoStageSpeech;
  const contest = caps.claimContest;
  const social = caps.social;

  // 0.5.0: the planner does not write the public sentence. The message field is
  // REMOVED from its schema and replaced by the envelope, so "the planner must
  // not write the wording" is a shape the provider enforces rather than an
  // instruction the model may drift from.
  let required = [...base.required];
  const properties: Record<string, Fragment> = { ...base.properties };
  if (disclosure && taskHasPublicMessage(task.id)) {
    const field = messageFieldFor(task.id);
    delete properties[field];
    required = required.filter((r) => r !== field);
    properties.communicationIntent = intentFragment();
    required.push("communicationIntent");
  }

  return {
    type: "object",
    additionalProperties: false,
    required: [...required, "cognition"],
    properties: {
      ...properties,
      // Default keeps the frozen 0.3.0 object, so a caller that does not pass a
      // version gets exactly what the completed pilot sent.
      cognition: social
        ? cognitionFragment(caps.limits, {
            withSocial: true,
            ...(contest ? { withContest: true } : {}),
            ...(caps.stableCommitmentIds ? { withCommitmentIds: true } : {}),
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

  // Capabilities are DECLARED by the version, not re-derived here. The three
  // locals stay for readability; what changed is where their values come from.
  // See `prompts/capabilities.ts` for what re-deriving them cost.
  const caps = capabilitiesFor(config.promptVersion);
  const disclosure = caps.twoStageSpeech;
  const contest = caps.claimContest;
  const social = caps.social;
  const limits = caps.limits;

  // THE OBERON GATE. Under 0.6.0 the coordination FIELD was gated on the
  // version and the coordination SECTION on `observation.missionCoordination`,
  // so Oberon got a required block pointing at a section he did not have. Both
  // now ask the same question, and 0.6.0 keeps its exact bytes because the
  // second half of the condition is itself version-gated.
  const wantsCoordination =
    caps.evilCoordination &&
    (!caps.coordinationFieldGated || observation.missionCoordination !== null);

  const schema = taskSchemaFor(request, config.limits.speechCharLimit, {
    withRetraction: contest,
    ...(wantsCoordination ? { withCoordination: true } : {}),
    ...(caps.voteDiscipline ? { withVoteAnalysis: true } : {}),
    ...(caps.assassinRanking ? { withAssassinationRanking: true } : {}),
    ...(caps.ladyNeutralAssassination ? { withLadyAnalysis: true } : {}),
    ...(caps.persistentClaims ? { withClaimPurpose: true } : {}),
  });

  const cognitionText = renderCognition({
    constraints: ledger.constraints,
    hypotheses: ledger.hypotheses,
    dossiers: ledger.dossiers,
    seats: SEATS,
    rolePlan: ledger.self.rolePlan,
    // 0.5.0 renders the id in front of each promise, because 0.5.0 closes by
    // id. The three frozen stacks render the bare text, byte for byte.
    commitments: activeCommitments(ledger.self.publicCommitments).map((c) =>
      disclosure ? `\`[${c.id}]\` ${c.text}` : c.text,
    ),
    ...(social ? { social: renderSocial(ledger.social) } : {}),
    ...(contest ? { contest: renderContest(ledger.contest) } : {}),
  });

  // 0.5.0 only, and only where there is a sentence to write. The envelope
  // instruction sits BEFORE the cognition instruction because it changes what
  // the answer's action half looks like, and a model that reads "fill in
  // `cognition`" first will have already decided the shape of the answer.
  const wantsIntent = disclosure && taskHasPublicMessage(schema.id);
  const taskText = [
    renderTask(schema),
    "",
    ...(wantsIntent ? [INTENT_INSTRUCTION, ""] : []),
    ...(disclosure
      ? [caps.proseExampleIds ? COMMITMENT_ID_INSTRUCTION_PROSE : COMMITMENT_ID_INSTRUCTION, ""]
      : []),
    ...(caps.voteDiscipline && schema.requestKind === "vote"
      ? [VOTE_ANALYSIS_INSTRUCTION, ""]
      : []),
    ...(caps.assassinRanking && schema.requestKind === "assassinate"
      ? [ASSASSINATION_INSTRUCTION, ""]
      : []),
    ...(caps.ladyNeutralAssassination && schema.requestKind === "assassinate"
      ? [LADY_INSTRUCTION, ""]
      : []),
    ...(caps.persistentClaims && schema.fields.some((f) => f.name === "claimPurpose")
      ? [claimPersistenceInstruction(observation), ""]
      : []),
    // 0.7.0 swaps the id paragraph for prose placeholders. A separate constant
    // rather than an edit, because four completed games need V2/V3 verbatim.
    contest
      ? caps.proseExampleIds
        ? COGNITION_INSTRUCTION_V4
        : COGNITION_INSTRUCTION_V3
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
      text: disclosure
        ? DECISION_PROTOCOL_LAYER_V4
        : contest
          ? DECISION_PROTOCOL_LAYER_V3
          : social
            ? DECISION_PROTOCOL_LAYER_V2
            : DECISION_PROTOCOL_LAYER,
    },
    { index: 3, title: "说话风格", text: renderPersona(persona) },
    {
      index: 4,
      title: "身份与合法信息类型",
      // 0.5.0 appends the role-specific disclosure rule. It is a function of
      // `role` and nothing else, so it stays inside the cacheable system prefix
      // and two seats holding the same role read identical bytes.
      text: disclosure
        ? [renderRoleLayer(observation.role), "", renderDisclosureRules(observation.role)].join("\n")
        : renderRoleLayer(observation.role),
    },
    { index: 5, title: "硬事实与挂车约束", text: pack.factTables },
    ...(contest
      ? [{ index: 5.5, title: "身份声称与派权争夺", text: pack.claimContest }]
      : []),
    {
      index: 6,
      title: "只有你知道的硬信息",
      text: renderOwnPrivateFacts(observation, {
        withIds: social,
        ...(caps.evilRosterRendered ? { withEvilRoster: true } : {}),
      }),
    },
    // The evil coordination convention. Rendered ONLY under a version that
    // declares it AND only when the referee actually granted this seat one —
    // `observationFor` returns null for every good seat, for Oberon, and for an
    // evil seat not riding this mission.
    ...(caps.evilCoordination && observation.missionCoordination
      ? [
          {
            index: 6.5,
            title: "坏人出牌协调",
            text: renderMissionCoordination(observation.missionCoordination),
          },
        ]
      : []),
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
    // The version this stack IS, straight from the capability row. Deriving it
    // back out of the booleans was another place the four stacks could
    // interleave without anybody noticing.
    promptVersion: caps.version,
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
/**
 * The id paragraph, as 0.3.1 through 0.6.0 printed it. FROZEN.
 *
 * Split out of the instruction body rather than edited, because 0.7.0 needs a
 * different one and four completed games need these exact bytes. The two
 * variants are spliced into one shared body below, so the rest of the text
 * cannot drift between them.
 *
 * ⚠ WHAT IS WRONG WITH IT, recorded here rather than fixed here. Every example
 * is written in the notation of a REAL citable row, and `[p.pair]` is not a
 * placeholder at all — it is Percival's actual pair id. A seat that copies it
 * cites a private id it does not hold. The scripted double did exactly that for
 * four milestones and nothing failed, because an unresolvable premise is only
 * silently unverified. `prompt-0.7.0` refuses it, which is how this was found.
 */
const ID_PARAGRAPH_WITH_EXAMPLES: readonly string[] = [
  "**先说 id 怎么填。** 上面事实表和你的私有信息里，每一行开头都有一个方括号 ——",
  "`[f12]`、`[f.fail1]`、`[c33:role]`、`[p.pair]` 这样的。**照抄方括号里面的东西**，",
  "不要自己造。造出来的 id 系统查不到，那条前提就会被算成不硬的。",
];

/**
 * The `prompt-0.7.0` id paragraph. No copyable token, and no private id NAMED.
 *
 * Three rules, and each closes a hole the frozen paragraph left open:
 *
 *   NOTHING HERE PARSES AS AN ID. The placeholders are Chinese prose inside the
 *   brackets, so a model that copies one verbatim produces a string the premise
 *   grammar rejects — a bounded `malformed-reference` repair, never an accepted
 *   premise. A test asserts no token in this text matches the grammar and none
 *   resolves in any seat's registry.
 *
 *   NO PRIVATE ID IS NAMED. The frozen text spells out `p.pair` and `p.self`.
 *   Both are real, both belong to specific roles, and printing them in an
 *   instruction every seat receives tells every seat that those ids exist and
 *   what they are called. 0.7.0 says "the bracket in front of your own private
 *   line" and lets the seat read its own.
 *
 *   IT POINTS AT THE TABLE THAT IS ACTUALLY RENDERED. "Copy exactly one id, from
 *   the table above, into each box" — one box, one id, from THIS turn's table.
 *   That is the same sentence `evidence-refs.ts` enforces.
 */
const ID_PARAGRAPH_PROSE: readonly string[] = [
  "**先说 id 怎么填。** 上面事实表和你的私有信息里，每一行开头都有一个方括号，",
  "里面那一小段就是这一行的 id。**从上面那张表里照抄，一格只放一个。**",
  "",
  "这份说明里**不会给你任何可以直接抄的 id 样例** —— 样例抄进去只会变成查不到的编号。",
  "要引哪一行，就翻上去看那一行开头的方括号里写的是什么。",
  "",
  "**自己造的、猜的、从这段说明里抄的，系统都查得出来**，会被当成格式错误退回来重填。",
  "引不到就留空：空数组是诚实的，一个查不到的 id 会让整条结论被记成没有依据。",
];

const INSTRUCTION_V2_BODY = (idParagraph: readonly string[], proseIds: boolean) => [
  "### 除了动作，还要填一个 `cognition` 对象",
  "",
  "把上面思考流程的**结论**填进去，不要写过程。",
  "",
  ...idParagraph,
  "",
  "- `factsUsed`：你用到的硬事实 id（`f` 开头，包括 `f.now` 和 `f.fail…` 这类算出来的）",
  "- `claimsReliedOn`：你**采信了**的说法 id（`c` 开头）。采信不等于它是真的",
  "- `claimsQuestioned`：你**不接受**的说法 id。同一个 id 不能同时出现在这两个数组里",
  "- `alternativesConsidered`：你比较过的其他候选动作，至少两条",
  "- `selectedActionSummary`：一句话说明你为什么选这个动作",
  "- `intendedPublicSignal`：这一步你想让牌桌接收到什么（私有，牌桌看不到）",
  "- `updatedRolePlan`：身份计划有变就写新的，没变填 null",
  "- `constraints`：你推出来的约束。**每条至少要有一个 `premiseIds`** —— 事实 id 或说法 id 都行。",
  proseIds
    ? "  要引你自己的身份，就抄你私有信息那一节里那一行开头的方括号。系统会自己判断这些前提硬不硬，你不需要（也不能）声明"
    : "  你自己的身份用 `p.self`。系统会自己判断这些前提硬不硬，你不需要（也不能）声明",
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
];

export const COGNITION_INSTRUCTION_V2 = INSTRUCTION_V2_BODY(
  ID_PARAGRAPH_WITH_EXAMPLES,
  false,
).join("\n");

/** The same body, with the 0.7.0 id paragraph. `prompt-0.7.0` only. */
export const COGNITION_INSTRUCTION_V2_PROSE = INSTRUCTION_V2_BODY(
  ID_PARAGRAPH_PROSE,
  true,
).join("\n");

/**
 * The `prompt-0.4.0` instruction: everything 0.3.1 asks for, plus the contest.
 *
 * Built by APPENDING to the 0.3.1 text rather than by restating it. Two copies
 * of "here is how to fill `factsUsed`" would drift, and the drift would be
 * invisible until a game produced two different answers to the same question.
 */
const CONTEST_TAIL: readonly string[] = [
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
];

export const COGNITION_INSTRUCTION_V3 = [COGNITION_INSTRUCTION_V2, ...CONTEST_TAIL].join("\n");

/**
 * `prompt-0.7.0`: the same contest tail on the prose-placeholder body.
 *
 * ONE TAIL, shared. Two copies of the contest instruction would drift, and the
 * drift would only ever show up as two games answering the same question
 * differently — which is the failure mode `capabilities.ts` was written for.
 */
export const COGNITION_INSTRUCTION_V4 = [
  COGNITION_INSTRUCTION_V2_PROSE,
  ...CONTEST_TAIL,
].join("\n");

/**
 * The 0.5.0 override for `closedCommitments`.
 *
 * APPENDED AFTER the 0.4.0 instruction rather than folded into it, and it says
 * so in as many words — the earlier text tells the model to echo the promise
 * 「一字不差」, and a reader who met both without being told which wins would
 * reasonably do the wrong one. Restating the whole instruction to change one
 * paragraph would be two copies that drift.
 *
 * WHY IT CHANGED. Text equality produced three unmatched closures across ten
 * seats in one M5.2 game: the model meant to close a promise, a character
 * drifted, and the ledger silently went on holding the seat to it.
 */
export const COMMITMENT_ID_INSTRUCTION = [
  "### `closedCommitments`：0.5.0 起改用 id（**这一条覆盖上面那段关于原文的说明**）",
  "",
  "你的公开承诺现在每一条前面都有一个方括号 id，像 `[k30.0]`。",
  "要关掉一条承诺，**填它的 id，不要填原文**：",
  "",
  '`{"id": "k30.0", "resolution": "fulfilled"}`',
  "",
  "`resolution` 还是三选一：`fulfilled`（兑现了）/ `obsolete`（局面把它作废了）/",
  "`withdrawn`（你公开反悔了）。**原文不用抄** —— 之前要求一字不差抄回来，",
  "而一个字符的偏差就会让这次关闭静默失败，账本继续拿那条承诺要求你。",
].join("\n");

/**
 * `prompt-0.7.0`: the same rule with no copyable token.
 *
 * The frozen text shows `[k30.0]` twice, including inside a JSON example. A
 * commitment id is a different namespace from a premise id — copying one
 * produces an unmatched closure rather than a false premise — but it is still
 * a string shaped like a real id sitting in an instruction, which is the whole
 * pattern this milestone removes. The placeholder here cannot be mistaken for
 * one, and cannot be parsed as one.
 */
export const COMMITMENT_ID_INSTRUCTION_PROSE = [
  "### `closedCommitments`：0.5.0 起改用 id（**这一条覆盖上面那段关于原文的说明**）",
  "",
  "你的公开承诺现在每一条前面都有一个方括号 id。要关掉一条承诺，",
  "**把那条承诺前面方括号里的东西抄进 `id`，不要填原文**：",
  "",
  '`{"id": "（这里抄那条承诺前面方括号里的东西）", "resolution": "fulfilled"}`',
  "",
  "`resolution` 还是三选一：`fulfilled`（兑现了）/ `obsolete`（局面把它作废了）/",
  "`withdrawn`（你公开反悔了）。**原文不用抄** —— 之前要求一字不差抄回来，",
  "而一个字符的偏差就会让这次关闭静默失败，账本继续拿那条承诺要求你。",
].join("\n");
