/**
 * The private decision protocol — a stable system-prompt layer, plus the
 * bounded structured shape an answer must come back in.
 *
 * WHAT THIS IS NOT. It is not a request for chain-of-thought. Nothing here
 * asks the model to narrate its reasoning, and nothing stores prose that
 * describes reasoning: every field below is either an ID list, an enum, or a
 * short bounded conclusion. The distinction matters practically, not just as a
 * policy — a stored reasoning transcript would grow the next prompt without
 * bound, and the two capacity failures already proved what an unbounded budget
 * costs.
 *
 * WHY A PROTOCOL AT ALL. Experiment 3 showed the table CAN reason well when
 * asked to: "address the dissent" went from 10% to 36% of speeches, and
 * constraint reasoning from 4% to 29%, purely from optional considerations.
 * But it also showed the failure that survives good reasoning — a correct
 * deduction built on an unverifiable premise, repeated with growing confidence
 * because nothing in the loop forced a re-audit. Step 4 exists for exactly
 * that, and it is why the protocol is a numbered sequence rather than more
 * advice: advice is optional by design, and premise auditing should not be.
 *
 * THE PUBLIC MESSAGE IS SEPARATE. Everything in `StructuredConclusion` is
 * private and never reaches the table. What the table hears is the action's
 * own `publicMessage`, unchanged from M0-M4 and still bounded by
 * `limits.speechCharLimit`.
 *
 * STATUS: design + offline scaffolding. `prompts/build.ts` does not import
 * this, and no live run uses it.
 */

import { COGNITION_LIMITS as L, checkChars, checkCount, checkMinCount, type LimitViolation } from "./limits";
import type { Confidence, DerivedConstraint, Hypothesis, SeatDossier } from "./ledger";
import type { Seat } from "../core/types";

/* ── The layer text ─────────────────────────────────────────────────────── */

/**
 * Stable across the whole game and across every seat, so it caches.
 *
 * Deliberately contains NO role, NO seat number and NO game state: a system
 * layer that varied per seat would be a per-seat cache miss on every request,
 * and at ~1.3M input tokens per game the cache is not a detail.
 */
export const DECISION_PROTOCOL_LAYER = [
  "## 私下的思考流程（不要写进公开发言）",
  "",
  "在给出这一步的动作之前，你先在心里按顺序走一遍下面十四步。",
  "**这十四步的过程不要写出来** —— 只把结论按要求的结构填好。",
  "公开发言里只放你真正想在牌桌上说的话。",
  "",
  "1. **补进度**：从你上次处理到的 sequence 开始，把之后发生的事全部读一遍。",
  "2. **更新硬事实**：任务结果、票型、提案、女神令牌流向 —— 这些是裁判记录，不容改写。",
  "3. **把新说法归类为「说法」，不是「事实」**：谁声称了身份、谁公布了验人结果、",
  "   谁自称好人 —— 记下「某号在某个 sequence 说了什么」，记录不等于相信。",
  "4. **审一遍当前桌面共识的前提**：现在大家默认成立的那些结论，各自建立在什么上面？",
  "   其中哪些是裁判记录，哪些只是某个人的话？**一条结论最多和它最弱的前提一样硬。**",
  "5. **更新每个人的档案**：他说过什么、发过什么车、怎么投的、上过哪些车、",
  "   回应过谁、有没有前后矛盾、和谁反复站一起。",
  "6. **同时留住至少两种说得通的世界**：不要过早锁死一种。",
  "   如果 A 是坏人，票型怎么解释；如果 B 是坏人呢。",
  "7. **分清多数意见和少数意见**：现在桌上的主流说法是什么，谁在反对，理由是什么。",
  "8. **正面处理最强的那个异议**：接受它、还是驳倒它，说清楚为什么。",
  "   把多数意见再复述一遍不产生新信息。",
  "9. **想出几个不同的候选动作**，不要只想一个。",
  "10. **比较它们的后果**：各自会给桌面什么信号，会让谁更信你、谁更疑你。",
  "11. **对照你这个身份的长期目标**：这一步是在往那儿走，还是只是应付眼前。",
  "12. **对照你之前的公开承诺**：说过的话要么兑现，要么明说自己改了主意和原因。",
  "13. **选一个动作。**",
  "14. **写下有界的认知更新**：用到了哪些事实、依赖了哪些未经证实的说法、",
  "    质疑了哪些、比较过哪些候选动作、这一步想传达什么信号、身份计划有没有变。",
  "",
  "**「我没有证据」和「我同意」是两回事。** 不确定本身可以是投反对的理由。",
  "**别人的身份声称和验人公布都不是硬信息**，除非裁判记录支持它。",
].join("\n");

/** Bumped when the protocol text changes in a way that could move behaviour. */
export const PROTOCOL_VERSION = "cognition-protocol-0.1.0";

/**
 * The 0.3.1 protocol: the fourteen steps, plus the bridge to a public move.
 *
 * WHY A SECOND CONSTANT rather than an edit. The fourteen steps above are what
 * the completed pilot's ~150 requests carried; a byte here changes that game's
 * system prefix and un-reproduces it. So the old layer stays and the new one
 * quotes it.
 *
 * WHAT THE BRIDGE IS FOR. The pilot got better private reasoning and a quieter
 * table: explicit engagement with somebody else's argument fell from 48% of
 * speeches to 21%, no role was ever claimed, and good never formed a coalition
 * for evil to have to break. Ten correct private analyses that never meet do
 * not beat four coordinated players.
 *
 * WHAT IT IS NOT. It does not say to speak every suspicion. Merlin and evil
 * need concealment, and step 20 says so in as many words: pick the one public
 * conclusion that is worth other people being able to act on, not the ledger.
 */
export const PUBLIC_BRIDGE_LAYER = [
  "",
  "## 从私下判断到牌桌上的动作",
  "",
  "想清楚之后、给出动作之前，再走六步。**这六步的过程同样不要写出来。**",
  "",
  "15. **现在谁在带节奏？** 谁的说法正在被别人当参照 —— 可能是跳了身份的人，",
  "    也可能只是分析讲得最站得住的那个。可以同时有两个人在争这个位置，也可以没有。",
  "16. **他到底要大家接受哪一句话？** 写成一句可以被同意或拒绝的话，",
  "    不是「他很可疑」这种感觉。",
  "17. **支持这句话的最强公开证据是什么？** 必须是牌桌上人人看得到的东西。",
  "18. **反对它的最强理由是什么？** 说不出来就是还没处理它。",
  "19. **你要跟、有条件地跟、驳、还是自己走？** 四个都合法。",
  "20. **你要在公开场合说什么或做什么，别人才能和你配合？**",
  "",
  "跟的时候：**点名是谁**、说清你接的是他哪一条论证或哪辆车、给出你这一票或你的用车倾向。",
  "只说「我同意」等于没说 —— 别人无法据此和你对齐。",
  "",
  "驳的时候：**指出你不接受的是哪一条前提**，尽量给出更安全的车、另一种世界、",
  "或者一个具体的信息目标。",
  "",
  "带节奏的时候：给一个**可执行的请求** —— 用哪辆车或避开哪辆、大家该怎么投、",
  "接下来最该分清的是哪一组比较、什么证据出现你就会改口。",
  "",
  "**不是每一条怀疑都要说出口。** 梅林要藏，坏人要掩护 —— 选那一条值得让别人接住的结论，",
  "不要把整个推理记录倒到桌上。",
].join("\n");

/** The full 0.3.1 system layer: fourteen private steps, then the bridge. */
export const DECISION_PROTOCOL_LAYER_V2 = [DECISION_PROTOCOL_LAYER, PUBLIC_BRIDGE_LAYER].join("\n");

export const PROTOCOL_VERSION_V2 = "cognition-protocol-0.2.0";

/**
 * The claim contest — 派权争夺 — as a stable system layer.
 *
 * WHY IT IS SEPARATE FROM THE BRIDGE. The bridge (15–20) asks "who is leading
 * and how do I coordinate". That question presumes leadership has settled. Early
 * high-level play often looks nothing like that: two or three seats stand on
 * Percival at once, each with a story, each attacking the others. Asking a seat
 * in that position "who is the focal player" is asking it to answer a question
 * the table has not answered yet.
 *
 * THE CENTRAL RULE, and the reason this milestone exists: a rival claiming your
 * identity is not a parallel opinion. Steps 24 and 25 make that a thing the
 * agent has to decide rather than a thing it can drift past — and they keep
 * "reduce their credibility" and "call them evil" as two different moves.
 *
 * WHAT IS DELIBERATELY NOT HERE. Any suggestion that a claim is evidence of a
 * role, in either direction — the word "派西维尔" appears as an identity people
 * CLAIM, never as one anybody has. Every seat may claim it; the layer carries
 * no seat number, no role and no game state, so it caches once for the whole
 * game across all ten seats.
 */
export const CLAIM_CONTEST_LAYER = [
  "",
  "## 派权争夺",
  "",
  "**任何身份都可以声称任何身份。** 桌上同时有两三个人自称派西维尔是常见局面，不是异常。",
  "多一个人声称，本身不说明谁真谁假 —— 裁判只记录了「谁在什么时候说了什么」。",
  "",
  "轮到你说话之前，再走六步。**过程同样不要写出来。**",
  "",
  "21. **现在有几个人站在同一个身份上？** 谁先说的、谁是跟着对跳的、谁退过水。",
  "22. **把他们放在一起比，不要一个一个单独看。** 可比的东西是公开的：",
  "    声称的时机与发言位、有没有回应更早的声称、说的候选对前后一致吗、",
  "    发过什么车、怎么投的、任务结果打没打脸、说会发生的事发生了吗、",
  "    被质疑时答不答、给的建议能不能执行、跟他的人是在复述证据还是只在造声势。",
  "23. **你自己要不要进这个场？** 跳、对跳、继续藏、先看一轮再进，都合法。",
  "    但要说出**这一手**换到什么、代价是什么 —— 不是一般道理，是这个局面下的。",
  "24. **如果你已经在场上：竞争者在抢的是你的权威，不是在发表平行意见。**",
  "    你要决定怎么削弱他的可信度，或者说清为什么现在先不动手、",
  "    你在拉谁、什么事件会让你动手、以及在他拿下一辆关键车之前你怎么把话语权拿回来。",
  "25. **打他的声称，不等于断定他是坏人。** 指出时机不对、故事对不上、",
  "    票和话不一致 —— 这些都是在打声称。直接说他是坏人是另一个动作，代价也不同。",
  "26. **想一个能把两个人分开的公开检验。** 一辆车、一次投票、一个具体的问题，",
  "    结果出来之后大家能看出谁说对了。",
  "",
  "**退水也是一个动作。** 它不删除任何东西：你原来声称过什么、推过什么车、",
  "踩过谁，全都留在公开记录里。别人会去看你退水前后的差别，而退水既可能是",
  "有计划的掩护，也可能是撑不住了 —— 这两种都真实发生过。",
  "",
  "**不要重复说「我是派西维尔」而不处理场上的争夺。** 如果你说自己才是可信的那个，",
  "公开发言里应该有：给自己的正面理由、和至少一个竞争者的对比、",
  "一个能执行的车或票的请求、以及一个之后能检验的条件。",
  "",
  "**不在场上的人也要比较着看。** 支持某个人的时候，说清是支持谁的哪一句话、",
  "它落到哪一票或哪一辆车上、以及什么证据会让你换边。",
  "谁都不支持也可以 —— 那就自己给出一个比较办法或一套车，不要只是沉默。",
].join("\n");

/** The full 0.4.0 system layer: fourteen steps, the bridge, then the contest. */
export const DECISION_PROTOCOL_LAYER_V3 = [
  DECISION_PROTOCOL_LAYER,
  PUBLIC_BRIDGE_LAYER,
  CLAIM_CONTEST_LAYER,
].join("\n");

export const PROTOCOL_VERSION_V3 = "cognition-protocol-0.3.0";

/* ── The structured conclusion ──────────────────────────────────────────── */

/**
 * What comes back alongside the action. All bounded, all conclusions.
 *
 * Note the asymmetry between `factsUsed` and `claimsReliedOn`: both are ID
 * lists, but they are separate fields rather than one list with a flag,
 * because a model filling one array is free to be vague about which entries
 * are which. Two arrays force the classification at write time.
 */
export interface StructuredConclusion {
  /** IDs of `PublicHardFact`s this decision used. */
  readonly factsUsed: readonly string[];
  /** IDs of `PublicClaim`s this decision took at face value, if any. */
  readonly claimsReliedOn: readonly string[];
  /** IDs of `PublicClaim`s this decision explicitly does not accept. */
  readonly claimsQuestioned: readonly string[];
  /** Short labels of the other actions weighed. At least two. */
  readonly alternativesConsidered: readonly string[];
  readonly selectedActionSummary: string;
  /** What this move is meant to tell the table. Private; the message is public. */
  readonly intendedPublicSignal: string;
  /** Null when the plan is unchanged this turn. */
  readonly updatedRolePlan: string | null;
}

/**
 * The full private response shape for a fused call: cognition plus action.
 *
 * The action itself is deliberately typed as `unknown` here — it is whatever
 * `taskSchemaFor` already demands, and re-declaring it in this module would
 * create a second definition of a legal move that could drift from the first.
 */
export interface CognitiveResponse {
  readonly conclusion: StructuredConclusion;
  readonly cognitionUpdate: BoundedCognitionUpdate;
  readonly action: unknown;
}

/**
 * The model-writable slice, in the flat shape a JSON schema can express.
 *
 * Deliberately flatter than `CognitionUpdate`: strict structured output does
 * not love deep optional nesting, and a shape the provider rejects at 3am is
 * worse than one that needs a small adapter.
 */
export interface BoundedCognitionUpdate {
  readonly constraints: readonly {
    readonly id: string;
    readonly statement: string;
    readonly premiseIds: readonly string[];
    /** Parallel to `premiseIds`. Checked, not trusted — see `adaptUpdate`. */
    readonly premiseVerified: readonly boolean[];
    readonly premiseLabels: readonly string[];
  }[];
  readonly hypotheses: readonly {
    readonly id: string;
    readonly label: string;
    readonly evilSeats: readonly number[];
    readonly rationale: string;
    readonly standing: Confidence;
  }[];
  readonly seatReads: readonly {
    readonly seat: number;
    readonly standing: Confidence;
    readonly evidenceFor: readonly string[];
    readonly evidenceAgainst: readonly string[];
    readonly contradictions: readonly string[];
    readonly lastChangeReason: string;
  }[];
  readonly selfUpdate: {
    readonly rolePlan: string;
    readonly intendedSignal: string;
    readonly coverStory: string;
    readonly claimPlan: string;
    readonly nextTurnPlan: string;
    readonly newCommitments: readonly string[];
  };
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/**
 * Check a conclusion against its bounds and its own internal consistency.
 *
 * The consistency check that matters: a claim cannot be both relied on and
 * questioned. A model that lists an id in both arrays has not classified it,
 * it has hedged, and hedging is exactly what step 4 is meant to prevent.
 */
export function validateConclusion(c: StructuredConclusion): LimitViolation[] {
  const bad: LimitViolation[] = [];
  bad.push(...checkCount("factsUsed", c.factsUsed, L.maxFactsUsed));
  bad.push(...checkCount("claimsReliedOn", c.claimsReliedOn, L.maxClaimsReliedOn));
  bad.push(...checkCount("claimsQuestioned", c.claimsQuestioned, L.maxClaimsQuestioned));
  bad.push(
    ...checkCount("alternativesConsidered", c.alternativesConsidered, L.maxAlternativesConsidered),
  );
  bad.push(
    ...checkMinCount(
      "alternativesConsidered",
      c.alternativesConsidered,
      L.minAlternativesConsidered,
    ),
  );
  for (const [i, a] of c.alternativesConsidered.entries()) {
    bad.push(...checkChars(`alternativesConsidered[${i}]`, a, L.alternativeChars));
  }
  bad.push(
    ...checkChars("selectedActionSummary", c.selectedActionSummary, L.selectedActionSummaryChars),
  );
  bad.push(...checkChars("intendedPublicSignal", c.intendedPublicSignal, L.intendedSignalChars));
  if (c.updatedRolePlan !== null) {
    bad.push(...checkChars("updatedRolePlan", c.updatedRolePlan, L.rolePlanChars));
  }
  return bad;
}

export interface ConsistencyProblem {
  readonly code: string;
  readonly detail: string;
}

/** Cross-field checks that a size limit cannot express. */
export function conclusionConsistency(c: StructuredConclusion): ConsistencyProblem[] {
  const problems: ConsistencyProblem[] = [];
  const both = c.claimsReliedOn.filter((id) => c.claimsQuestioned.includes(id));
  for (const id of both) {
    problems.push({
      code: "claim_both_ways",
      detail: `${id} 同时出现在「依赖」和「质疑」里 —— 这是没分类，不是谨慎`,
    });
  }
  if (new Set(c.factsUsed).size !== c.factsUsed.length) {
    problems.push({ code: "duplicate_facts", detail: "factsUsed 里有重复 id" });
  }
  return problems;
}

/**
 * Turn a model's flat update into ledger objects, re-deriving what it may not assert.
 *
 * `premiseVerified` arrives from the model and is NOT trusted: the caller
 * passes a resolver built from the referee's own fact table, and a premise the
 * resolver does not recognise as a fact is unverified whatever the model said.
 * Without this, a model could mark its own assumption "verified" and the
 * `restsOnUnverified` flag — the entire point of the ledger — would be
 * self-certified.
 */
export function resolvePremises(
  update: BoundedCognitionUpdate,
  isVerifiedFactId: (id: string) => boolean,
): { readonly overridden: number; readonly constraints: readonly DerivedConstraint[] } {
  let overridden = 0;
  const constraints = update.constraints.map((c) => {
    const premises = c.premiseIds.map((id, i) => {
      const truth = isVerifiedFactId(id);
      if (truth !== (c.premiseVerified[i] ?? false)) overridden += 1;
      return { id, verified: truth, label: c.premiseLabels[i] ?? id };
    });
    return {
      id: c.id,
      statement: c.statement,
      premises,
      restsOnUnverified: premises.some((p) => !p.verified),
      provenance: { kind: "inference" as const, premises },
      atSequence: 0,
    };
  });
  return { overridden, constraints };
}

/* ── Rendering the ledger back into a prompt ────────────────────────────── */

/** Human-readable standing, for the prompt. */
const STANDING_LABEL: Readonly<Record<Confidence, string>> = {
  "strong-good": "基本确定好人",
  "lean-good": "偏好人",
  unresolved: "看不清",
  "lean-evil": "偏坏人",
  "strong-evil": "基本确定坏人",
};

export function renderStanding(c: Confidence): string {
  return STANDING_LABEL[c];
}

/**
 * The cognition layer as the model reads it back.
 *
 * Constraints resting on unverified premises are marked INLINE rather than in
 * a footnote, because a caveat that is separated from its claim is a caveat
 * that gets skipped.
 */
export function renderCognition(input: {
  readonly constraints: readonly DerivedConstraint[];
  readonly hypotheses: readonly Hypothesis[];
  readonly dossiers: Readonly<Record<Seat, SeatDossier>>;
  readonly seats: readonly Seat[];
  readonly rolePlan: string;
  readonly commitments: readonly string[];
  /** Rendered social model, appended verbatim. Empty on the 0.3.0 stack. */
  readonly social?: string;
  /** Rendered claim-contest model. Empty before `prompt-0.4.0`. */
  readonly contest?: string;
}): string {
  const lines: string[] = ["## 你自己的推理记录（只有你看得到）"];

  if (input.constraints.length > 0) {
    lines.push("", "### 你已经推出来的约束");
    for (const c of input.constraints) {
      const mark = c.restsOnUnverified ? "【前提未证实】" : "【前提都是裁判记录】";
      const premises = c.premises.map((p) => `${p.label}${p.verified ? "" : "(未证实)"}`).join("、");
      lines.push(`- ${mark} ${c.statement}　依据：${premises}`);
    }
  }

  if (input.hypotheses.length > 0) {
    lines.push("", "### 你同时留着的几种可能");
    for (const h of input.hypotheses) {
      lines.push(
        `- ${h.label}（坏人可能是 ${h.evilSeats.join("、")}号）：${h.rationale}　—— ${renderStanding(h.standing)}`,
      );
    }
  }

  const seen = input.seats
    .map((s) => input.dossiers[s])
    .filter((d) => d && (d.evidenceFor.length > 0 || d.evidenceAgainst.length > 0));
  if (seen.length > 0) {
    lines.push("", "### 你对每个人的记录");
    for (const d of seen) {
      const good = d.evidenceFor.map((e) => e.text).join("；");
      const bad = d.evidenceAgainst.map((e) => e.text).join("；");
      lines.push(
        `- ${d.seat}号 ${renderStanding(d.standing)}` +
          (good ? `　正面：${good}` : "") +
          (bad ? `　反面：${bad}` : "") +
          (d.lastChangeReason ? `　最近改变：${d.lastChangeReason}` : ""),
      );
    }
  }

  if (input.rolePlan) lines.push("", "### 你的身份计划", input.rolePlan);
  if (input.commitments.length > 0) {
    lines.push("", "### 你公开承诺过的话（要么兑现，要么明说改了）");
    for (const c of input.commitments) lines.push(`- ${c}`);
  }
  if (input.social) lines.push("", input.social);
  if (input.contest) lines.push("", input.contest);

  return lines.join("\n");
}
