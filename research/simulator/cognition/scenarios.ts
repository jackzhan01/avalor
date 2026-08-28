/**
 * Thirteen deterministic positions, each isolating one thing an expert does.
 *
 * These are EVALUATION FIXTURES, not tests of a policy. Each names the analysis
 * a competent player owes the position and the families of action that are
 * defensible from it — families, plural, deliberately:
 *
 *   NO FIXTURE NAMES ONE LEGAL ACTION AS THE ONLY EXPERT ACTION. Percival
 *   claiming early and Percival staying hidden are both real lines that real
 *   players defend. A rubric that scored one of them as correct would not be
 *   measuring skill, it would be measuring conformity to whoever wrote the
 *   rubric — and it would quietly delete the choice the whole Percival
 *   experiment is about.
 *
 * What a fixture CAN be strict about is the ANALYSIS: a Percival who does not
 * notice that both his candidates are on the proposed team has missed a fact
 * about his own hand, whatever he then decides to do about it. Those are the
 * `analysisObligations`, and they are checkable.
 *
 * `forbiddenLeaks` is the third column and is absolute: strings that must not
 * appear in a public message from this seat in this position, because they
 * would be information the seat cannot have or must not give away for free.
 *
 * STATUS: offline scaffolding. No model is called anywhere in this file.
 */

import type { RoleType } from "@/lib/types/game";
import type { Seat, Side } from "../core/types";
import type { Confidence } from "./ledger";

/** A public fact, in the compact shape a fixture declares. */
export type FixtureFact =
  | {
      readonly kind: "mission";
      readonly missionNumber: number;
      readonly team: readonly Seat[];
      readonly result: "success" | "fail";
      readonly failCount: number;
    }
  | {
      readonly kind: "proposal";
      readonly missionNumber: number;
      readonly attempt: number;
      readonly leader: Seat;
      readonly team: readonly Seat[];
    }
  | {
      readonly kind: "vote";
      readonly missionNumber: number;
      readonly attempt: number;
      readonly rejecters: readonly Seat[];
      readonly result: "passed" | "rejected";
    }
  | {
      readonly kind: "lady";
      readonly holder: Seat;
      readonly target: Seat;
      readonly announced: Side;
    };

export interface FixtureClaim {
  readonly seat: Seat;
  readonly kind: "role" | "alignment" | "assertion";
  readonly text: string;
  readonly atSequence: number;
}

/** What the tested seat privately holds. Mirrors `PrivateKnowledge`. */
export interface FixturePrivate {
  readonly seat: Seat;
  readonly role: RoleType;
  readonly side: Side;
  readonly knowledge:
    | { readonly kind: "none" }
    | { readonly kind: "sees_evil"; readonly seats: readonly Seat[] }
    | { readonly kind: "knows_teammates"; readonly seats: readonly Seat[] }
    | { readonly kind: "merlin_or_morgana"; readonly pair: readonly [Seat, Seat] };
  readonly ladyResults?: readonly {
    readonly target: Seat;
    readonly trueSide: Side;
    readonly missionNumber: number;
  }[];
}

/**
 * A family of defensible lines, not a single move.
 *
 * `mustJustify` is what makes a family strict without making it narrow: any
 * line in the family is acceptable, but taking it without addressing the named
 * point is not.
 */
export interface ActionFamily {
  readonly id: string;
  readonly description: string;
  readonly mustJustify: readonly string[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** Why this position is worth a fixture at all. */
  readonly why: string;
  readonly missionNumber: number;
  readonly attempt: number;
  readonly leader: Seat;
  readonly rejectionStreak: number;
  readonly score: { readonly successes: number; readonly fails: number };
  readonly publicFacts: readonly FixtureFact[];
  readonly claims: readonly FixtureClaim[];
  readonly tested: FixturePrivate;
  readonly proposedTeam: readonly Seat[] | null;
  readonly task: string;
  /** Checkable. A competent answer must show it noticed each of these. */
  readonly analysisObligations: readonly string[];
  /** Two or more. Any is acceptable; the justification is what is graded. */
  readonly acceptableActionFamilies: readonly ActionFamily[];
  /** Ways strong players lose this position. */
  readonly expertFailureModes: readonly string[];
  /** Substrings that must never appear in this seat's public message. */
  readonly forbiddenLeaks: readonly string[];
  /** Where a competent read should land, when the position determines one. */
  readonly expectedStandings?: Readonly<Partial<Record<Seat, Confidence>>>;
}

/* ── The fixtures ───────────────────────────────────────────────────────── */

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    id: "s01.percival-early-position",
    title: "第一轮靠前发言的派西维尔",
    why: "跳与不跳的取舍最纯粹的一次：还没有任何公开信息，代价和收益都只来自位置",
    missionNumber: 1,
    attempt: 1,
    leader: 8,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: [],
    claims: [],
    tested: {
      seat: 2,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [5, 9] },
    },
    proposedTeam: null,
    task: "speech-opening",
    analysisObligations: [
      "认出 5 和 9 是一对候选，其中恰有一个是莫甘娜",
      "认识到现在还没有任何公开信息可以区分这两个人",
      "把「早跳能给好人一个锚点」和「早跳等于替刺客把梅林范围缩到两人」同时算进去",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-early",
        description: "第一轮就跳派西维尔，公开组织好人",
        mustJustify: ["说明用什么换取了什么", "说明打算怎么保护候选对里的真梅林"],
      },
      {
        id: "hold-and-organise",
        description: "不跳，但用发言把好人组织起来",
        mustJustify: ["给出不跳的替代组织方案，而不是单纯沉默"],
      },
      {
        id: "delay-one-round",
        description: "等第一轮结果出来再定",
        mustJustify: ["说明在等哪一个具体信号"],
      },
    ],
    expertFailureModes: [
      "跳了却没有后续计划，把身份卖了却没换到组织权",
      "全程不跳也不组织，等于这个身份没有被使用",
      "无意中透露两个候选里更像梅林的是哪一个",
    ],
    forbiddenLeaks: ["5号是梅林", "9号是梅林", "5号是莫甘娜", "9号是莫甘娜"],
  },

  {
    id: "s02.percival-late-position",
    title: "上游已有声称之后的靠后派西维尔",
    why: "位置带来的信息优势是否真的被使用",
    missionNumber: 1,
    attempt: 1,
    leader: 3,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: [],
    claims: [
      { seat: 5, kind: "role", text: "我是梅林", atSequence: 4 },
      { seat: 9, kind: "assertion", text: "5号跳梅林太早，不可信", atSequence: 6 },
    ],
    tested: {
      seat: 2,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [5, 9] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出跳梅林的 5 号正在自己的候选对里",
      "认出质疑他的 9 号也在自己的候选对里",
      "认识到这个组合本身就是信息：一个候选跳梅林、另一个候选压他",
      "把「5 跳梅林是真梅林」和「5 是莫甘娜在钓」两种解释同时留着",
    ],
    acceptableActionFamilies: [
      {
        id: "counterclaim",
        description: "对跳，逼全桌在两个候选之间二选一",
        mustJustify: ["说明为什么现在摊牌比继续观察更值"],
      },
      {
        id: "support-with-conditions",
        description: "有条件地支持其中一个，留好退路",
        mustJustify: ["说明支持所依据的具体行为，而不是身份声称本身"],
      },
      {
        id: "stay-hidden-and-probe",
        description: "不表态，用问题逼两个候选给出可对照的说法",
        mustJustify: ["给出具体要问什么、以及不同回答会怎么改变判断"],
      },
    ],
    expertFailureModes: [
      "直接相信跳梅林的那个，等于把选择权交给莫甘娜",
      "同时打压两个候选，把真梅林也一起埋掉",
    ],
    forbiddenLeaks: ["5号和9号里有一个是莫甘娜", "我看到的两个人是5和9"],
  },

  {
    id: "s03.percival-pair-on-one-team",
    title: "两个候选被放进同一辆车",
    why: "派西维尔手上唯一的硬推论：这车必含莫甘娜",
    missionNumber: 2,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [4, 2, 7], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 4, team: [4, 5, 9, 1] },
    ],
    claims: [],
    tested: {
      seat: 2,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [5, 9] },
    },
    proposedTeam: [4, 5, 9, 1],
    task: "vote",
    analysisObligations: [
      "认出 5 和 9 同时在车上",
      "由候选对推出这辆车里一定有莫甘娜 —— 这是硬推论，不是猜测",
      "权衡反对的力度与暴露程度：反对越明确，越等于自报派西维尔并点出候选对",
    ],
    acceptableActionFamilies: [
      {
        id: "reject-loudly",
        description: "明确反对并说出理由，接受暴露",
        mustJustify: ["说明为什么这一轮值得用身份换掉这辆车"],
      },
      {
        id: "reject-quietly",
        description: "反对，但用不暴露候选对的理由包装",
        mustJustify: ["给出一个站得住的公开理由，而不是空反对"],
      },
      {
        id: "approve-with-plan",
        description: "放行，用这一轮的结果换信息",
        mustJustify: ["说明打算怎么从失败票数反推，以及愿意付的代价"],
      },
    ],
    expertFailureModes: [
      "没注意到两个候选同车，白白放过唯一的硬推论",
      "反对时把话说到「这两个人里有一个是莫甘娜」，等于免费送出候选对",
    ],
    forbiddenLeaks: ["5号和9号里有一个是莫甘娜", "这两个人里必有莫甘娜"],
    expectedStandings: { 5: "unresolved", 9: "unresolved" },
  },

  {
    id: "s04.merlin-lady-unresolved-mordred",
    title: "梅林拿着女神，莫德雷德还没找到",
    why: "三局里两次把女神验在持牌人已知的好人身上，是最一致的浪费",
    missionNumber: 2,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "success", failCount: 0 },
      { kind: "mission", missionNumber: 2, team: [2, 3, 5, 6], result: "fail", failCount: 1 },
    ],
    claims: [],
    tested: {
      seat: 9,
      role: "merlin",
      side: "good",
      knowledge: { kind: "sees_evil", seats: [2, 4, 7] },
    },
    proposedTeam: null,
    task: "lady-select",
    analysisObligations: [
      "分清「看得见的坏人 2、4、7」和「看不见的莫德雷德」是两个不同的集合",
      "认识到验 2、4、7 换不到任何新信息",
      "把还没定性的座位列出来作为莫德雷德的候选",
      "把令牌会转给被验者这一点算进选择",
    ],
    acceptableActionFamilies: [
      {
        id: "hunt-mordred",
        description: "验一个未定性的座位，找莫德雷德",
        mustJustify: ["说明为什么选这个候选而不是别的未定性座位"],
      },
      {
        id: "signal-or-transfer",
        description: "验一个已知好人，为了公开可信度或把令牌送到想给的人手上",
        mustJustify: ["说明放弃搜索换到的是什么，且那个东西这一轮确实更值"],
      },
    ],
    expertFailureModes: [
      "验已知好人却说不出换到了什么，等于这次机会没用",
      "验完之后的公开宣称让人看出他早就知道答案",
    ],
    forbiddenLeaks: ["我看得见坏人", "2号、4号、7号是坏人", "我是梅林"],
  },

  {
    id: "s05.two-failures-overlapping-teams",
    title: "两轮挂车，队伍部分重叠",
    why: "交集与差集的分层推理，是好人唯一不依赖任何人说法的工具",
    missionNumber: 3,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 0, fails: 2 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [1, 3, 8], result: "fail", failCount: 1 },
      { kind: "mission", missionNumber: 2, team: [3, 8, 5, 6], result: "fail", failCount: 1 },
    ],
    claims: [],
    tested: { seat: 10, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "第一轮 1、3、8 里至少一坏",
      "第二轮 3、8、5、6 里至少一坏",
      "交集是 3、8；只在前者是 1；只在后者是 5、6",
      "认识到交集里的人同时满足两个约束，但两个约束也可能由不同的人分别满足",
      "不把 1、5、6 当作已被洗清",
    ],
    acceptableActionFamilies: [
      {
        id: "press-intersection",
        description: "把压力集中在交集 3、8 上",
        mustJustify: ["说明为什么单一坏人解释比两个坏人分别踩更可信"],
      },
      {
        id: "split-test",
        description: "提一辆能把交集和差集分开检验的车",
        mustJustify: ["说明这辆车的结果会怎样区分两种解释"],
      },
      {
        id: "keep-both-worlds",
        description: "明确保留两种配置，先不下结论",
        mustJustify: ["说明还需要什么信息才能分开"],
      },
    ],
    expertFailureModes: [
      "把 3、8 直接定罪，忽略两坏分别在两车的可能",
      "把 1、5、6 当成已洗清",
      "只说「挂过车的都可疑」，不做分层",
    ],
    forbiddenLeaks: [],
  },

  {
    id: "s06.persuasive-conclusion-on-unverified-claim",
    title: "很有说服力的结论，前提却没人验证得了",
    why: "实验 3 真正输掉的地方：正确的推理建立在不可验证的前提上",
    missionNumber: 3,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 0, fails: 2 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "fail", failCount: 1 },
      { kind: "mission", missionNumber: 2, team: [2, 3, 5, 6], result: "fail", failCount: 2 },
      { kind: "lady", holder: 9, target: 6, announced: "good" },
    ],
    claims: [
      { seat: 6, kind: "role", text: "我是忠臣，二车我只能出成", atSequence: 40 },
      {
        seat: 6,
        kind: "assertion",
        text: "所以2、3、5恰有两坏，首车8、1、4恰一坏，余下7、9、10恰一坏",
        atSequence: 41,
      },
    ],
    tested: { seat: 10, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出这套推理的两个前提：6 号自称忠臣、9 号的验人公布为真",
      "认出这两个前提都是**说法**，不是裁判记录",
      "认出算术在前提成立时是对的 —— 问题不在推理，在地基",
      "同时保留「6 号说的是真的」和「6 号在切自己出去」两个世界",
    ],
    acceptableActionFamilies: [
      {
        id: "attack-premises",
        description: "接受算术，但要求前提被独立检验",
        mustJustify: ["点明具体是哪一条前提未证实，以及怎样才能验证"],
      },
      {
        id: "conditional-accept",
        description: "有条件地按这套切分行动，同时标明它可能整个垮掉",
        mustJustify: ["说明如果前提假，代价是什么、怎么回退"],
      },
    ],
    expertFailureModes: [
      "被算术的严密说服，把结论当成硬信息往下传",
      "因为前提不硬就把整套推理丢掉，连带丢掉正确的约束部分",
    ],
    forbiddenLeaks: [],
  },

  {
    id: "s07.minority-dissent-proved-right",
    title: "少数派的反对后来被证明是对的",
    why: "第二局梅林三次正确反对被 8:2 淹掉；这是好人最贵的一次系统性失灵",
    missionNumber: 3,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [4, 1, 8], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 7, team: [7, 5, 6, 9] },
      { kind: "vote", missionNumber: 2, attempt: 1, rejecters: [4, 9], result: "passed" },
      { kind: "mission", missionNumber: 2, team: [7, 5, 6, 9], result: "fail", failCount: 1 },
    ],
    claims: [],
    tested: { seat: 1, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 4 号和 9 号在车挂之前就反对过",
      "把「事前反对」和「事后说早就觉得不对」区分开 —— 前者有公开记录",
      "同时认识到这不是证明：坏人也可能反对一辆注定要挂的车来买信誉",
      "回看两人当时给的理由，而不只是他们的票",
    ],
    acceptableActionFamilies: [
      {
        id: "elevate-dissenters",
        description: "把两名反对者的判断当作值得跟进的线索",
        mustJustify: ["说明是他们的哪一条理由值得跟，而不是「他们反对过」"],
      },
      {
        id: "test-dissenters",
        description: "提一辆能检验反对者本身的车",
        mustJustify: ["说明这辆车会怎样区分「看得准」和「买信誉」"],
      },
    ],
    expertFailureModes: [
      "把事前反对直接当成好人证明",
      "完全不回头看反对者的理由，让正确判断第二次被淹掉",
    ],
    forbiddenLeaks: [],
  },

  {
    id: "s08.reject-without-replacement",
    title: "说不出更好的车，但这辆车不能上",
    why: "「拿不出替代方案」被当成必须上票的理由，是三局里反复出现的错误",
    missionNumber: 3,
    attempt: 2,
    leader: 5,
    rejectionStreak: 1,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [4, 2, 8], result: "success", failCount: 0 },
      { kind: "mission", missionNumber: 2, team: [2, 3, 5, 6], result: "fail", failCount: 1 },
      { kind: "proposal", missionNumber: 3, attempt: 2, leader: 5, team: [1, 5, 7, 10] },
    ],
    claims: [
      { seat: 5, kind: "assertion", text: "拿不出更好的车就该上", atSequence: 60 },
    ],
    tested: { seat: 10, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: [1, 5, 7, 10],
    task: "vote",
    analysisObligations: [
      "认出「没有替代方案」并不构成这辆车安全的理由",
      "把当前连否次数和「这是不是最后一次提案」分开算",
      "认识到挂过车之后应当提高上票门槛，而不是沿用之前的标准",
    ],
    acceptableActionFamilies: [
      {
        id: "reject-without-alternative",
        description: "直接反对，并说明没有替代不等于同意",
        mustJustify: ["说明这辆车具体哪里说不清楚"],
      },
      {
        id: "reject-with-partial",
        description: "反对，并给出一个不完整但方向明确的替代",
        mustJustify: ["说明替代方案解决了原车的哪个问题"],
      },
      {
        id: "approve-on-streak",
        description: "因为连否风险而放行",
        mustJustify: ["说明连否代价为什么此刻高于上错车的代价"],
      },
    ],
    expertFailureModes: [
      "把「我没有证据」直接当成「我同意」",
      "只因为连否压力就放行，却不说明代价对比",
    ],
    forbiddenLeaks: [],
  },

  {
    id: "s09.two-evil-on-one-team",
    title: "两个已知坏人在同一辆车上",
    why: "实验 3 的第二轮双踩，把「至少两坏」免费告诉了全桌",
    missionNumber: 2,
    attempt: 1,
    leader: 7,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 7, team: [2, 3, 5, 6] },
    ],
    claims: [],
    tested: {
      seat: 2,
      role: "assassin",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [3, 7] },
    },
    proposedTeam: [2, 3, 5, 6],
    task: "mission-card",
    analysisObligations: [
      "认出队友 3 号也在车上",
      "认识到一张失败票已经足够挂掉这一轮",
      "认识到第二张失败票不增加分数，只公开「这车至少两坏」",
      "把当前比分算进去：现在挂这一轮是否已经决定胜负",
    ],
    acceptableActionFamilies: [
      {
        id: "coordinate-single-fail",
        description: "只出一张失败票（自己踩或让队友踩）",
        mustJustify: ["说明怎么在没有沟通渠道时降低双踩风险"],
      },
      {
        id: "play-success-for-cover",
        description: "自己出成功，保住掩护",
        mustJustify: ["说明这一轮放过的代价，以及掩护要用在哪里"],
      },
      {
        id: "double-fail-deliberately",
        description: "接受双踩，因为掩护已经不重要",
        mustJustify: ["说明为什么此刻信息隐藏不再有价值"],
      },
    ],
    expertFailureModes: [
      "不假思索一起踩，白送人数信息",
      "两人都想着保掩护，结果一张都没踩",
    ],
    forbiddenLeaks: ["3号是我的同伴", "我们有两个人在车上", "我是刺客"],
  },

  {
    id: "s10.assassin-tracking-quiet-merlin",
    title: "刺客追踪一个安静但反复说对的人",
    why: "梅林最容易留下的指纹不是发言，是投票模式",
    missionNumber: 4,
    attempt: 1,
    leader: 3,
    rejectionStreak: 0,
    score: { successes: 2, fails: 1 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 8, team: [8, 1, 4] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [9], result: "passed" },
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "fail", failCount: 1 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 7, team: [7, 5, 6, 9] },
      { kind: "vote", missionNumber: 2, attempt: 1, rejecters: [9], result: "passed" },
      { kind: "mission", missionNumber: 2, team: [7, 5, 6, 9], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 3, attempt: 1, leader: 6, team: [1, 6, 9, 10] },
      { kind: "vote", missionNumber: 3, attempt: 1, rejecters: [9, 2], result: "passed" },
      { kind: "mission", missionNumber: 3, team: [1, 6, 9, 10], result: "success", failCount: 0 },
    ],
    claims: [],
    tested: {
      seat: 2,
      role: "assassin",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [3, 7] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "注意到 9 号在唯一挂掉的那一轮之前投了反对",
      "注意到 9 号从不靠喊身份取得地位",
      "把「反复说对」和「声音最大」区分开",
      "同时保留 9 号只是谨慎的忠臣这一解释",
    ],
    acceptableActionFamilies: [
      {
        id: "probe-quietly",
        description: "在不惊动对方的前提下继续观察并排序候选",
        mustJustify: ["说明还要看什么才能把 9 号和谨慎忠臣区分开"],
      },
      {
        id: "pressure-to-reveal",
        description: "公开施压逼 9 号表态，用他的反应换信息",
        mustJustify: ["说明施压暴露自己关注点的代价"],
      },
    ],
    expertFailureModes: [
      "只盯发言最多的人，漏掉安静但票票踩点的人",
      "过早公开锁定候选，让对方开始伪装",
    ],
    forbiddenLeaks: ["我是刺客", "3号和7号是我的同伴", "我在找梅林"],
    expectedStandings: { 9: "lean-good" },
  },

  {
    id: "s11.oberon-without-teammates",
    title: "奥伯伦评估一辆车，不知道谁是同伴",
    why: "唯一一个必须在没有队友信息下行动的坏人身份",
    missionNumber: 2,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 6, team: [1, 6, 7, 9] },
    ],
    claims: [],
    tested: { seat: 4, role: "oberon", side: "evil", knowledge: { kind: "none" } },
    proposedTeam: [1, 6, 7, 9],
    task: "vote",
    analysisObligations: [
      "认识到自己不知道车上有没有同伴",
      "认识到否掉这辆车可能否掉一辆本来会挂的车",
      "认识到公开怀疑某个人时，那个人可能是同伴",
      "不能假设别的坏人会配合自己 —— 他们也不知道自己是谁",
    ],
    acceptableActionFamilies: [
      {
        id: "approve-to-preserve-chance",
        description: "放行，保留车上有同伴的可能",
        mustJustify: ["说明放行的公开理由站得住"],
      },
      {
        id: "reject-with-cover",
        description: "反对，为自己建立独立的好人形象",
        mustJustify: ["说明这个形象要用在哪里，以及误伤同伴的风险"],
      },
    ],
    expertFailureModes: [
      "像一个知道队友的坏人那样行动，暴露出协调痕迹",
      "为了洗白而精准打击，结果打到同伴",
    ],
    forbiddenLeaks: ["我是坏人", "我不知道我的同伴是谁", "我是奥伯伦"],
  },

  {
    id: "s12.fifth-proposal-danger",
    title: "第五次提案，否掉就直接输",
    why: "同一张反对票在这里和在普通提案上代价完全不同",
    missionNumber: 3,
    attempt: 5,
    leader: 2,
    rejectionStreak: 4,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "success", failCount: 0 },
      { kind: "mission", missionNumber: 2, team: [2, 3, 5, 6], result: "fail", failCount: 1 },
      { kind: "proposal", missionNumber: 3, attempt: 5, leader: 2, team: [2, 3, 5, 8] },
    ],
    claims: [],
    tested: { seat: 10, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: [2, 3, 5, 8],
    task: "vote",
    analysisObligations: [
      "认出这是第五次提案，否掉即判负",
      "认出车上 2、3、5 三人都在挂掉的第二轮车里",
      "把「否掉立刻输」和「上车可能输」这两种代价直接对比，而不是只算其一",
    ],
    acceptableActionFamilies: [
      {
        id: "approve-under-hammer",
        description: "上票，因为否掉是立刻输",
        mustJustify: ["说明上车之后打算怎么从结果里取信息"],
      },
      {
        id: "reject-anyway",
        description: "仍然反对，认为这辆车必挂",
        mustJustify: ["说明为什么确定到愿意直接认输"],
      },
    ],
    expertFailureModes: [
      "机械沿用「说不清就否」，忘了这一次否车即判负",
      "只因为是第五次就无条件上票，不做任何记录",
    ],
    forbiddenLeaks: [],
  },

  {
    id: "s13.long-history-needs-compaction",
    title: "历史很长，必须压缩才装得下",
    why: "验证压缩不丢硬事实 —— 这是有界上下文唯一必须为真的性质",
    missionNumber: 4,
    attempt: 3,
    leader: 7,
    rejectionStreak: 2,
    score: { successes: 2, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 4], result: "success", failCount: 0 },
      { kind: "mission", missionNumber: 2, team: [2, 3, 5, 6], result: "fail", failCount: 2 },
      { kind: "mission", missionNumber: 3, team: [1, 2, 9, 10], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 4, attempt: 1, leader: 4, team: [4, 5, 6, 7, 8] },
      { kind: "vote", missionNumber: 4, attempt: 1, rejecters: [1, 2, 3, 5, 6, 8, 9, 10], result: "rejected" },
      { kind: "proposal", missionNumber: 4, attempt: 2, leader: 5, team: [1, 5, 7, 8, 10] },
      { kind: "vote", missionNumber: 4, attempt: 2, rejecters: [2, 3, 6, 9], result: "rejected" },
      { kind: "proposal", missionNumber: 4, attempt: 3, leader: 7, team: [2, 3, 7, 9, 10] },
      { kind: "lady", holder: 9, target: 6, announced: "good" },
      { kind: "lady", holder: 6, target: 8, announced: "good" },
    ],
    claims: [
      { seat: 6, kind: "role", text: "我是忠臣", atSequence: 70 },
      { seat: 5, kind: "role", text: "我是忠臣", atSequence: 74 },
    ],
    tested: { seat: 10, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: [2, 3, 7, 9, 10],
    task: "vote",
    analysisObligations: [
      "三轮任务的队伍、结果与失败票数全部仍然可读",
      "四轮里每一次提案与投票仍然可读",
      "两次女神公布与两次身份声称仍然可读",
      "挂车约束仍然可读",
    ],
    acceptableActionFamilies: [
      {
        id: "any-justified-vote",
        description: "赞成或反对都可以",
        mustJustify: ["引用至少一条压缩之后仍然存在的硬事实"],
      },
    ],
    expertFailureModes: ["因为历史被压缩而引用了错误或不存在的事实"],
    forbiddenLeaks: [],
  },
]);

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown scenario: ${id}`);
  return found;
}
