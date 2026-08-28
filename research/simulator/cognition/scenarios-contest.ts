/**
 * Twenty-five positions in the fight over one identity.
 *
 * The M5A fixtures isolate solo deduction; the M5.1 fixtures isolate following
 * a leader. These isolate the thing that happens BEFORE either is possible:
 * several seats claiming the same role at once, competing for the table's
 * authority, attacking, defending, retracting, and losing or gaining followers.
 *
 * THE RULE THAT SHAPES ALL OF THEM. No fixture names one legal action as the
 * only expert action, and it matters more here than anywhere else — a rubric
 * that scored "true Percival counterclaims immediately" as correct would delete
 * the entire question this milestone is asking. What a fixture IS strict about:
 *
 *   analysisObligations   what a competent player cannot fail to notice
 *   contestObligations    what the `contest` block must record, mechanically
 *   forbiddenLeaks        absolute; strings that must never be spoken
 *
 * EVERY ROLE APPEARS AS A CLAIMANT. Scenarios 3-9 walk the whole cast through
 * claiming Percival, because the design says every role may and a fixture set
 * that only exercised Percival and Morgana would quietly encode the opposite.
 *
 * OBERON'S FIXTURE (9) exists to be checked for something absent rather than
 * present: no obligation, no acceptable line, and nothing in the position may
 * hand him a teammate he does not have.
 *
 * STATUS: offline fixtures. No model is called anywhere in this file.
 */

import type { Seat } from "../core/types";
import type { ClaimAct, ContestStance, OwnClaimStatus } from "./contest";
import type { Scenario } from "./scenarios";

/**
 * What the `contest` block must contain in this position.
 *
 * Split from `analysisObligations` for the same reason M5.1 split
 * `socialObligations`: these are mechanical, so a scripted run can assert them,
 * and `mustRecord` is judgement, so it is not pretended to be mechanical.
 */
export interface ContestObligations {
  /** Acts that are defensible here. Never exactly one, unless it truly is. */
  readonly acts: readonly ClaimAct[];
  /** Own-claim statuses that make sense in this position. */
  readonly ownStatuses: readonly OwnClaimStatus[];
  /** Stances a competent seat could take toward the claimants. */
  readonly stances: readonly ContestStance[];
  /** Seats that MUST appear in `claimantAssessments`. */
  readonly mustAssess: readonly Seat[];
  /** True when `rivalPlans` must be non-empty. */
  readonly needsRivalPlan: boolean;
  /** What a reviewer looks for in the recorded conclusions. */
  readonly mustRecord: readonly string[];
}

export interface ContestScenario extends Scenario {
  readonly contestObligations: ContestObligations;
}

/* ── Shared fragments, so the fixtures stay readable ────────────────────── */

const NO_FACTS: Scenario["publicFacts"] = [];

const FIRST_FAILED: Scenario["publicFacts"] = [
  { kind: "proposal", missionNumber: 1, attempt: 1, leader: 3, team: [3, 7, 10] },
  { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [4, 6], result: "passed" },
  { kind: "mission", missionNumber: 1, team: [3, 7, 10], result: "fail", failCount: 1 },
];

const FIRST_PASSED: Scenario["publicFacts"] = [
  { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
  { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [7, 9], result: "passed" },
  { kind: "mission", missionNumber: 1, team: [2, 5, 6], result: "success", failCount: 0 },
];

export const CONTEST_SCENARIOS: readonly ContestScenario[] = Object.freeze([
  /* ── 1-2: the true Percival enters, early and late ───────────────────── */
  {
    id: "p01.true-percival-claims-early",
    title: "靠前位的真派西维尔第一个跳，定下全桌的框架",
    why: "最纯粹的一次「定调」：还没有任何公开信息，也还没有人跳，代价和收益都只来自位置",
    missionNumber: 1,
    attempt: 1,
    leader: 2,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: NO_FACTS,
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
      "认出自己既靠前又是队长，这是全局影响力最高的一次机会",
      "把「先跳能定调」和「先跳等于把梅林范围缩到两个人」同时算进去",
      "预演有人对跳时自己怎么办",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-and-frame",
        description: "跳，并给出车、票建议和对跳预案",
        mustJustify: ["说明候选对怎么处理", "给一个别人能照着投的建议", "说明对跳时的判据"],
      },
      {
        id: "hold-and-watch",
        description: "先不跳，看有没有人先跳出来",
        mustJustify: ["说明在等哪一个具体信号", "说明继续藏着的代价"],
      },
    ],
    expertFailureModes: [
      "只报身份不给方案",
      "跳的同时说出哪一个候选更像梅林",
      "完全不考虑会有人对跳",
    ],
    forbiddenLeaks: ["5号是梅林", "9号是梅林", "5号是莫甘娜", "9号是莫甘娜"],
    contestObligations: {
      acts: ["claim-percival", "stay-hidden"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["undecided"],
      mustAssess: [],
      needsRivalPlan: false,
      mustRecord: [
        "situationSpecificBenefit 要说的是**这一手**换到什么，不是一般道理",
        "如果跳，publicClaimMove 要带 requestedTeam 或 requestedVote",
        "triggerToRetract 要非空 —— 跳之前就该知道什么会让自己收回",
      ],
    },
  },

  {
    id: "p02.true-percival-enters-late",
    title: "靠后位的真派西维尔，面前已经有两个声称",
    why: "靠后的信息优势到底有没有被用上：先比较，还是照样自说自话",
    missionNumber: 1,
    attempt: 1,
    leader: 3,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: NO_FACTS,
    claims: [
      { seat: 5, kind: "role", text: "我是派西维尔，候选对是 2 和 9", atSequence: 4 },
      { seat: 7, kind: "role", text: "我才是派西维尔，5 号说的对不上", atSequence: 8 },
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
      "认出 5 号在自己的候选对里，而 7 号不在",
      "认出 5 号把自己（2 号）说成了候选之一 —— 这条可以直接检验",
      "认出现在进场是三方混战，不是二选一",
    ],
    acceptableActionFamilies: [
      {
        id: "enter-comparatively",
        description: "跳，并直接指出两个人各自的问题",
        mustJustify: ["点名两个人各自哪里对不上", "给出一辆能分开他们的车"],
      },
      {
        id: "back-one-and-attack-the-other",
        description: "不跳，改为支持其中一个并打另一个",
        mustJustify: ["说明支持的是哪一条具体结论", "说明不跳换到了什么"],
      },
      {
        id: "hold-and-test",
        description: "先不进场，提一个能分开两人的检验",
        mustJustify: ["说明这个检验怎么分开他们", "说明什么会让自己进场"],
      },
    ],
    expertFailureModes: [
      "跳出来但不处理已有的两个声称，等于制造第三个孤立说法",
      "因为 5 号在候选对里就直接说他是莫甘娜",
      "只说「他们都不可信」而不给替代方案",
    ],
    forbiddenLeaks: ["5号和9号是一对", "候选对"],
    contestObligations: {
      acts: ["claim-percival", "counterclaim-percival", "attack-rival-claim", "compare-claimants"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [5, 7],
      needsRivalPlan: false,
      mustRecord: [
        "5 号和 7 号都要出现在 claimantAssessments 里",
        "每条评估都要有 premiseIds 和升降条件",
        "如果自己也跳了，rivalPlans 不能是空的",
      ],
    },
  },

  /* ── 3-9: every role claims Percival ─────────────────────────────────── */
  {
    id: "p03.morgana-preempts",
    title: "莫甘娜抢在真派西维尔之前跳",
    why: "假派最强的一手：占住身份，逼真的那个表态",
    missionNumber: 1,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: NO_FACTS,
    claims: [],
    tested: {
      seat: 7,
      role: "morgana",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [8, 9] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出自己本来就在真派的候选对里，说得出细节",
      "认出先跳能逼真派表态，而表态本身就是信息",
      "认出自己的票和任务史以后要和这个视角对得上",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-first",
        description: "先跳，讲一个自己编的候选对",
        mustJustify: ["说明这个故事以后要对上什么", "说明真派跳出来时怎么办"],
      },
      {
        id: "wait-and-counter",
        description: "等真派先跳再对跳",
        mustJustify: ["说明后发的好处", "说明等待的代价"],
      },
      {
        id: "stay-out-and-support",
        description: "不跳，去捧一个好人当假焦点",
        mustJustify: ["说明这条路怎么把坏人送上车"],
      },
    ],
    expertFailureModes: [
      "编的候选对里包含自己知道的队友",
      "跳完之后打真派打得太狠，露出急于排除的味道",
      "假设 10 号（奥伯伦）会配合自己",
    ],
    forbiddenLeaks: ["8号是坏人", "9号是坏人", "我是莫甘娜"],
    contestObligations: {
      acts: ["claim-percival", "stay-hidden", "endorse-claimant"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["undecided", "support", "conditional-support"],
      mustAssess: [],
      needsRivalPlan: false,
      mustRecord: [
        "candidatePairStory 要写出来，而且不能包含已知队友",
        "informationToConceal 要点明不能漏的是什么",
      ],
    },
  },

  {
    id: "p04.morgana-counterclaims",
    title: "莫甘娜在真派之后对跳",
    why: "牌桌看到的是两个自称派西维尔的人，而没有裁判记录能分开他们",
    missionNumber: 1,
    attempt: 2,
    leader: 4,
    rejectionStreak: 1,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [7, 8, 9, 10, 3, 4], result: "rejected" },
    ],
    claims: [{ seat: 2, kind: "role", text: "我是派西维尔，候选对是 5 和 9", atSequence: 5 }],
    tested: {
      seat: 7,
      role: "morgana",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [8, 9] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 2 号说的候选对里有 9 号 —— 而 9 号是自己的队友",
      "认出这条信息不能公开使用，公开使用等于自曝",
      "认出对跳会把牌桌变成二选一，而牌桌没有裁判记录可以判",
    ],
    acceptableActionFamilies: [
      {
        id: "counterclaim",
        description: "对跳，给出细节争夺焦点",
        mustJustify: ["说明打算怎么让牌桌选自己", "说明失败的代价"],
      },
      {
        id: "attack-without-claiming",
        description: "不跳，改为攻击 2 号的时机或内容",
        mustJustify: ["说明保留模糊为什么比争焦点更值"],
      },
      {
        id: "endorse-and-steer",
        description: "顺着 2 号，换取信任后再影响用车",
        mustJustify: ["说明这条路怎么在不暴露的前提下把坏人送上车"],
      },
    ],
    expertFailureModes: [
      "利用「2 号说的候选对里有我队友」这条私有信息去公开反驳",
      "对跳之后拿不出任何细节",
      "打得太用力，把自己变成焦点",
    ],
    forbiddenLeaks: ["8号是坏人", "9号是坏人", "我是莫甘娜", "9号是我的队友"],
    contestObligations: {
      acts: ["counterclaim-percival", "attack-rival-claim", "endorse-claimant", "stay-hidden"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["oppose", "support", "conditional-support", "undecided"],
      mustAssess: [2],
      needsRivalPlan: false,
      mustRecord: [
        "2 号必须在 claimantAssessments 里，premiseIds 只能是公开 id",
        "如果对跳，rivalPlans 里要有 2 号并写出 distinctionTest",
      ],
    },
  },

  {
    id: "p05.merlin-claims-as-cover",
    title: "梅林跳派西维尔当掩护",
    why: "掩护和暴露只差一线：一个信息完美的派西维尔就是一个梅林",
    missionNumber: 1,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: NO_FACTS,
    claims: [{ seat: 7, kind: "role", text: "我是派西维尔", atSequence: 6 }],
    tested: {
      seat: 1,
      role: "merlin",
      side: "good",
      knowledge: { kind: "sees_evil", seats: [7, 8, 10] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出跳的这个 7 号在自己看得见的坏人里",
      "认出自己不能用「我看得见」去反驳他",
      "认出莫德雷德在盲区里，所以自己的信息并不完整",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-as-cover",
        description: "跳派西维尔，给刺客造一个假目标",
        mustJustify: ["说明候选对故事怎么编才不暴露视野", "说明怎么避免每次都对"],
      },
      {
        id: "challenge-without-claiming",
        description: "不跳，用公开理由质疑 7 号",
        mustJustify: ["说明这个理由完全来自公开记录"],
      },
      {
        id: "stay-quiet",
        description: "不表态，只投票",
        mustJustify: ["说明沉默这一轮换到了什么"],
      },
    ],
    expertFailureModes: [
      "编的候选对正好就是自己看见的坏人组合",
      "反驳 7 号的理由只有自己知道",
      "跳完之后判断次次精准",
    ],
    forbiddenLeaks: ["7号是坏人", "8号是坏人", "10号是坏人", "我看得见"],
    contestObligations: {
      acts: ["claim-percival", "counterclaim-percival", "challenge-claimant", "stay-hidden"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["oppose", "undecided"],
      mustAssess: [7],
      needsRivalPlan: false,
      mustRecord: [
        "premiseIds 里不能出现 p.sees",
        "如果跳，candidatePairStory 不能等于真实可见的坏人组合",
      ],
    },
  },

  {
    id: "p06.loyal-claims-to-protect",
    title: "忠臣跳派西维尔，给特殊身份挡刀",
    why: "他手上没有候选对。这一跳要么有明确目的，要么就是在劈好人的票",
    missionNumber: 1,
    attempt: 2,
    leader: 6,
    rejectionStreak: 1,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [7, 8, 9, 10, 1, 3], result: "rejected" },
    ],
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 7, kind: "role", text: "我才是派西维尔", atSequence: 9 },
    ],
    tested: { seat: 4, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出自己**没有**候选对，任何故事都是编的",
      "认出多一个声称会让好人票更分散",
      "认出编的故事以后要对上任务结果和票型",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-as-decoy",
        description: "跳，明确目的是分散火力",
        mustJustify: ["说明具体要保护谁或换到什么", "说明故事以后怎么对上"],
      },
      {
        id: "force-clarity",
        description: "不跳，逼两个声称者把故事讲清楚",
        mustJustify: ["给出一个两人都必须回答的具体问题"],
      },
      {
        id: "pick-a-side",
        description: "不跳，选一边并说清依据",
        mustJustify: ["点名支持的是哪一条", "给出撤退条件"],
      },
    ],
    expertFailureModes: [
      "跳了但说不出目的，等于把好人票劈成三份",
      "编的候选对以后被任何一条公开记录打穿",
      "跳完之后压过了真派西维尔的领导权",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: [
        "claim-percival",
        "counterclaim-percival",
        "compare-claimants",
        "endorse-claimant",
        "challenge-claimant",
        "stay-hidden",
      ],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 7],
      needsRivalPlan: false,
      mustRecord: [
        "两个声称者都要评估",
        "如果跳，situationSpecificBenefit 要写具体的掩护或组织目的",
      ],
    },
  },

  {
    id: "p07.assassin-claims-to-provoke",
    title: "刺客跳派西维尔，逼真派和梅林反应",
    why: "反应本身就是刺杀情报 —— 而代价是失去低调观察位",
    missionNumber: 1,
    attempt: 1,
    leader: 8,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: NO_FACTS,
    claims: [],
    tested: {
      seat: 8,
      role: "assassin",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [7, 9] },
    },
    proposedTeam: null,
    task: "speech-opening",
    analysisObligations: [
      "认出跳会引出真派和梅林的反应，而那正是刺杀情报",
      "认出跳会失去低调观察的位置",
      "把赢任务和找梅林当成两本账",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-to-provoke",
        description: "跳，主要目的是看谁跳出来反驳",
        mustJustify: ["说明打算从反应里读什么", "说明假故事怎么维护"],
      },
      {
        id: "stay-quiet-and-watch",
        description: "不跳，保持低调观察位",
        mustJustify: ["说明放弃这次挑动换到了什么"],
      },
      {
        id: "claim-later",
        description: "等真派跳出来再进场",
        mustJustify: ["说明什么信号会让自己进场"],
      },
    ],
    expertFailureModes: [
      "跳完之后把公开领导权和赢任务混成一件事",
      "假故事里出现自己知道的队友",
      "为了带节奏反而暴露坏人之间的协调",
    ],
    forbiddenLeaks: ["7号是坏人", "9号是坏人", "我是刺客"],
    contestObligations: {
      acts: ["claim-percival", "stay-hidden"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["undecided"],
      mustAssess: [],
      needsRivalPlan: false,
      mustRecord: [
        "leadershipObjective 或 informationToConceal 要区分任务目标和刺杀目标",
        "candidatePairStory 不能包含已知队友",
      ],
    },
  },

  {
    id: "p08.mordred-claims-off-a-clean-record",
    title: "莫德雷德用干净的公开记录跳派西维尔",
    why: "唯一有视野的好人看不见他，所以他的记录可以很干净 —— 而干净正是可信的来源",
    missionNumber: 2,
    attempt: 1,
    leader: 9,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: FIRST_PASSED,
    claims: [{ seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 }],
    tested: {
      seat: 9,
      role: "mordred",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [7, 8] },
    },
    proposedTeam: null,
    task: "speech-opening",
    analysisObligations: [
      "认出自己在梅林的盲区里，公开记录也确实干净",
      "认出跳出来会放弃「待在盲区」这件事本身的价值",
      "认出一个被打穿的声称会暴露一个战略价值很高的身份",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-off-the-record",
        description: "跳，用干净的票型和任务史当依据",
        mustJustify: ["说明放弃盲区价值换到了什么", "说明假信息故事怎么维护"],
      },
      {
        id: "support-a-rival",
        description: "不跳，去捧一个方向对自己有利的声称者",
        mustJustify: ["说明捧谁、为什么"],
      },
      {
        id: "stay-clean",
        description: "继续保持干净，什么都不做",
        mustJustify: ["说明什么时候这份干净会被用掉"],
      },
    ],
    expertFailureModes: [
      "跳出来之后被 2 号的细节问倒",
      "为了显得可信而做出会打到队友的表态",
      "把盲区当成免疫",
    ],
    forbiddenLeaks: ["7号是坏人", "8号是坏人", "我是莫德雷德"],
    contestObligations: {
      acts: ["counterclaim-percival", "endorse-claimant", "attack-rival-claim", "stay-hidden"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2],
      needsRivalPlan: false,
      mustRecord: [
        "2 号要被评估",
        "如果对跳，rivalPlans 里要有 2 号，并写出 riskOfOverattacking",
      ],
    },
  },

  {
    id: "p09.oberon-claims-without-teammates",
    title: "奥伯伦跳派西维尔，而他不知道任何队友",
    why: "这一格主要检查一件**不存在**的事：跳这一下不会给他任何队友信息",
    missionNumber: 1,
    attempt: 2,
    leader: 5,
    rejectionStreak: 1,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 3, team: [3, 7, 10] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [1, 2, 4, 5, 6, 8], result: "rejected" },
    ],
    claims: [{ seat: 2, kind: "role", text: "我是派西维尔", atSequence: 6 }],
    tested: { seat: 10, role: "oberon", side: "evil", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出自己不知道任何队友，也没有人知道自己",
      "认出跳出来可能正在打自己人，也可能正在替真派挡刀",
      "认出自己手上编故事的材料是全场最少的",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-for-chaos",
        description: "跳，制造独立的混乱",
        mustJustify: ["说明混乱怎么对自己有利", "承认可能打到队友"],
      },
      {
        id: "attack-the-claimant",
        description: "不跳，只打 2 号",
        mustJustify: ["说明理由完全来自公开记录"],
      },
      {
        id: "blend-in",
        description: "不跳也不打，建立独立掩护",
        mustJustify: ["说明这份掩护以后怎么用"],
      },
    ],
    expertFailureModes: [
      "把别人的反应当成队友信号来读",
      "像一个知道队友的坏人那样行动",
      "编一个自己撑不住的候选对故事",
    ],
    forbiddenLeaks: ["我的队友", "我们坏人", "3号是坏人", "7号是坏人"],
    contestObligations: {
      acts: ["claim-percival", "counterclaim-percival", "attack-rival-claim", "stay-hidden"],
      ownStatuses: ["active", "considering", "hidden"],
      stances: ["oppose", "undecided"],
      mustAssess: [2],
      needsRivalPlan: false,
      mustRecord: [
        "任何字段里都不能出现队友身份",
        "premiseIds 里不能出现 p.team —— 他的 registry 里根本没有这个 id",
      ],
    },
  },

  /* ── 10-14: the fight itself ─────────────────────────────────────────── */
  {
    id: "p10.three-claimants",
    title: "三个人同时自称派西维尔",
    why: "至少两个在撒谎，而牌桌没有任何裁判记录能直接分开他们",
    missionNumber: 1,
    attempt: 3,
    leader: 6,
    rejectionStreak: 2,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [7, 8, 9, 10, 1, 3], result: "rejected" },
      { kind: "proposal", missionNumber: 1, attempt: 2, leader: 3, team: [3, 7, 9] },
      { kind: "vote", missionNumber: 1, attempt: 2, rejecters: [1, 2, 4, 5, 6, 8], result: "rejected" },
    ],
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 7, kind: "role", text: "我才是", atSequence: 9 },
      { seat: 4, kind: "role", text: "他们两个都不是，我是", atSequence: 20 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-opening",
    analysisObligations: [
      "认出三个人里至少两个在撒谎",
      "认出 4 号是最后进场的，他看过前面两个人的说法",
      "认出连否两次，第五案的代价在逼近",
    ],
    acceptableActionFamilies: [
      {
        id: "rank-them",
        description: "公开排序并说明依据",
        mustJustify: ["逐条给出可比较的公开依据", "给出一辆车"],
      },
      {
        id: "test-them",
        description: "提出一个能分开三个人的检验",
        mustJustify: ["说明这个检验怎么分开", "说明检验之前自己怎么投"],
      },
      {
        id: "ignore-all-three",
        description: "宣布不采信任何一个，按公开记录组车",
        mustJustify: ["给出那辆车", "说明什么会让自己重新考虑"],
      },
    ],
    expertFailureModes: [
      "只评估其中一个，忽略另外两个",
      "以「最后跳的最可疑」当作唯一依据",
      "什么都不选，把桌子交给声音最大的人",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "endorse-claimant", "challenge-claimant", "claim-percival"],
      ownStatuses: ["hidden", "considering", "active"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 4, 7],
      needsRivalPlan: false,
      mustRecord: [
        "三个人全部要在 claimantAssessments 里 —— 少一个就会被结构检查打回",
        "alignment 要落到票或车上",
      ],
    },
  },

  {
    id: "p11.true-percival-attacks-without-accusing",
    title: "真派西维尔打竞争者，但不断定他是坏人",
    why: "打声称和指认坏人是两个动作。这一格就是那条线",
    missionNumber: 2,
    attempt: 1,
    leader: 2,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: FIRST_PASSED,
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 4, kind: "role", text: "我才是派西维尔", atSequence: 22 },
    ],
    tested: {
      seat: 2,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [5, 9] },
    },
    proposedTeam: null,
    task: "speech-opening",
    analysisObligations: [
      "认出 4 号不在自己的候选对里 —— 所以他既可能是莫甘娜，也可能是好人在做掩护",
      "认出他在抢自己的权威，不是在发表平行意见",
      "认出打错一个好人的代价",
    ],
    acceptableActionFamilies: [
      {
        id: "attack-the-claim",
        description: "打他的时机和故事，不给他定性",
        mustJustify: ["点名具体哪一条对不上", "给出能分开两人的检验"],
      },
      {
        id: "accuse",
        description: "直接说他是莫甘娜",
        mustJustify: ["说明为什么现在值得承担打错的代价"],
      },
      {
        id: "recruit-instead",
        description: "不正面打，改为拉具体的人组成自己的联盟",
        mustJustify: ["点名要拉谁", "说明什么事件会让自己转为正面冲突"],
      },
    ],
    expertFailureModes: [
      "把「他不在我的候选对里」当成他是坏人的证据",
      "只重复「我才是派西维尔」而不处理他",
      "打的时候把候选对说出来",
    ],
    forbiddenLeaks: ["5号和9号是一对", "候选对是5和9"],
    contestObligations: {
      acts: ["attack-rival-claim", "defend-own-claim", "compare-claimants"],
      ownStatuses: ["active", "defending"],
      stances: ["oppose", "undecided"],
      mustAssess: [4],
      needsRivalPlan: true,
      mustRecord: [
        "rivalPlans 里必须有 4 号 —— 你在场上而他也在",
        "riskOfOverattacking 要写出来",
        "currentAssessment 是对**声称**的评价，不是对人的定性",
      ],
    },
  },

  {
    id: "p12.true-percival-delays-with-a-plan",
    title: "真派西维尔先不正面冲，但要给出恢复计划",
    why: "拖是合法的。空白的拖不是",
    missionNumber: 2,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 4, kind: "role", text: "我才是派西维尔", atSequence: 22 },
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
      "认出 4 号正在积累跟随者",
      "认出第一轮已经挂了，下一辆车的分量更高",
      "认出拖到他拿下一辆决定性的车就晚了",
    ],
    acceptableActionFamilies: [
      {
        id: "delay-with-a-plan",
        description: "先不冲，但写清恢复计划",
        mustJustify: ["说明为什么现在拖更好", "点名要拉谁", "给出触发正面冲突的具体事件"],
      },
      {
        id: "confront-now",
        description: "现在就正面冲",
        mustJustify: ["说明为什么这一轮是最后的窗口"],
      },
    ],
    expertFailureModes: [
      "写一句和上一轮一模一样的拖延理由",
      "拖但说不出什么事件会让自己动手",
      "拖到对方已经控制了决定性的一车",
    ],
    forbiddenLeaks: ["5号和9号是一对"],
    contestObligations: {
      acts: ["compare-claimants", "defend-own-claim", "endorse-claimant", "stay-hidden"],
      ownStatuses: ["active", "defending"],
      stances: ["oppose", "conditional-support", "undecided"],
      mustAssess: [4],
      needsRivalPlan: true,
      mustRecord: [
        "situationSpecificBenefit / triggerToClaim 不能和上一轮一字不差",
        "rivalPlans 里的 myResponse 要写清怎么把话语权拿回来",
      ],
    },
  },

  {
    id: "p13.claimant-refuses-to-answer",
    title: "一个声称者被追问却不回答，跟随者开始流失",
    why: "「被质疑时答不答」是最便宜也最有效的可比较指标之一",
    missionNumber: 2,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: FIRST_PASSED,
    claims: [
      { seat: 3, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 6, kind: "assertion", text: "3 号，你的候选对到底是谁，你一直没说", atSequence: 20 },
      { seat: 3, kind: "assertion", text: "我不想给刺客指路", atSequence: 24 },
    ],
    tested: { seat: 1, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 3 号确实有一个合理的不回答理由 —— 说出候选对就是给刺客指路",
      "认出「有合理理由」和「这个理由用得对」是两件事",
      "认出没有回答的问题会一直挂在那里，影响他之后每一次要权威的时候",
    ],
    acceptableActionFamilies: [
      {
        id: "downgrade",
        description: "降低对他的评价，说清是因为哪一条",
        mustJustify: ["点名没被回答的是哪个问题", "说明什么会让自己上调回来"],
      },
      {
        id: "accept-the-reason",
        description: "接受他的理由，但换一个他能答的问题",
        mustJustify: ["给出那个具体问题"],
      },
      {
        id: "make-it-testable",
        description: "把问题换成一辆车 —— 不用说候选对也能验证",
        mustJustify: ["给出那辆车"],
      },
    ],
    expertFailureModes: [
      "因为他不答就直接说他是坏人",
      "完全接受这个理由，从此不再检验他",
      "只表达不满而不给出可执行的替代问题",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["challenge-claimant", "compare-claimants", "endorse-claimant"],
      ownStatuses: ["hidden", "considering"],
      stances: ["oppose", "conditional-support", "undecided"],
      mustAssess: [3],
      needsRivalPlan: false,
      mustRecord: [
        "3 号的 negativeCase 要点到「没有回答」这条公开记录",
        "conditionToUpgrade 要给出他能做什么来挽回",
      ],
    },
  },

  {
    id: "p14.mission-evidence-splits-the-claimants",
    title: "任务结果支持一个声称者、打脸另一个",
    why: "这是牌桌上唯一不会撒谎的东西，也是唯一能真正分开两个声称的东西",
    missionNumber: 3,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [4, 7], result: "passed" },
      { kind: "mission", missionNumber: 1, team: [2, 5, 6], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 4, team: [4, 7, 8, 10] },
      { kind: "vote", missionNumber: 2, attempt: 1, rejecters: [2, 5], result: "passed" },
      { kind: "mission", missionNumber: 2, team: [4, 7, 8, 10], result: "fail", failCount: 1 },
    ],
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔，第一车按我说的组", atSequence: 5 },
      { seat: 4, kind: "role", text: "我才是，第二车按我说的组", atSequence: 22 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 2 号推的车成功了，4 号推的车挂了 —— 这是裁判记录",
      "认出这不等于 2 号是真派、4 号是莫甘娜：一辆成功的车任何人都可能组出来",
      "认出 4 号的车里至少有一个坏人，这是硬约束",
    ],
    acceptableActionFamilies: [
      {
        id: "upgrade-and-downgrade",
        description: "公开调整两人的评价，说明依据",
        mustJustify: ["点名两条任务记录", "给出下一辆车"],
      },
      {
        id: "use-the-constraint-not-the-person",
        description: "只用「4 号那车里至少一个坏人」这条硬约束组车",
        mustJustify: ["说明为什么不把它算到 4 号头上"],
      },
      {
        id: "hold",
        description: "认为一轮结果还不足以分开两人",
        mustJustify: ["说明还需要什么"],
      },
    ],
    expertFailureModes: [
      "把「他推的车挂了」直接当成「他是坏人」",
      "忽略成功的车也可能是运气",
      "只调整评价，不把硬约束用在下一辆车上",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "endorse-claimant", "challenge-claimant"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 4],
      needsRivalPlan: false,
      mustRecord: [
        "两个人的 premiseIds 都要引用任务结果的 f… id",
        "fulfilledPredictions / failedPredictions 至少有一条被填上",
      ],
    },
  },

  /* ── 15-17: retraction ───────────────────────────────────────────────── */
  {
    id: "p15.retract-before-a-vote",
    title: "投票之前退水",
    why: "退水的时机改变它的含义：还没有任何结果检验过这个声称",
    missionNumber: 1,
    attempt: 1,
    leader: 3,
    rejectionStreak: 0,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 3, team: [3, 5, 7] },
    ],
    claims: [
      { seat: 5, kind: "role", text: "我是派西维尔", atSequence: 6 },
      { seat: 5, kind: "assertion", text: "算了，我收回", atSequence: 14 },
    ],
    tested: { seat: 1, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: [3, 5, 7],
    task: "vote",
    analysisObligations: [
      "认出这次退水发生在任何投票和任务之前，没有结果打过它的脸",
      "认出退水不删除任何东西：他声称过、什么时候、说过什么，都还在",
      "认出退水既可能是有计划的掩护，也可能是撑不住了",
    ],
    acceptableActionFamilies: [
      {
        id: "read-as-cover",
        description: "当成有计划的掩护，评价不下调",
        mustJustify: ["说明什么会让自己改判"],
      },
      {
        id: "read-as-collapse",
        description: "当成撑不住，评价下调",
        mustJustify: ["说明依据是什么"],
      },
      {
        id: "hold-judgement",
        description: "先不判，等一轮结果",
        mustJustify: ["说明在等什么"],
      },
    ],
    expertFailureModes: [
      "把退水当成自动加分（「敢退水说明是好人」）",
      "把退水当成自动减分",
      "忘记他退水之前说过的话仍然可以被检验",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "challenge-claimant", "endorse-claimant", "stay-hidden"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [5],
      needsRivalPlan: false,
      mustRecord: [
        "5 号的 publicClaimStatus 应该是 retracted（这一栏由裁判填，不由你填）",
        "premiseIds 里应该引用退水事件的 k… id",
      ],
    },
  },

  {
    id: "p16.retract-after-a-failed-mission",
    title: "任务挂了之后退水",
    why: "同一个动作，在结果之后做，含义完全不同",
    missionNumber: 2,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 3, kind: "role", text: "我是派西维尔，第一车按我说的组", atSequence: 5 },
      { seat: 3, kind: "assertion", text: "我收回派西维尔的声称", atSequence: 20 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出他推的车挂了，而他随后退水 —— 两件事之间有明显的时间关系",
      "认出这仍然不等于他是坏人：一个判断失误的忠臣也会这么做",
      "认出他退水之前推过的车、踩过的人，全部仍然可以拿来检验",
    ],
    acceptableActionFamilies: [
      {
        id: "downgrade-with-reason",
        description: "下调评价，点名依据",
        mustJustify: ["点名任务结果和退水这两条记录"],
      },
      {
        id: "keep-the-constraint",
        description: "评价先不动，但把那车的硬约束用起来",
        mustJustify: ["说明约束怎么用"],
      },
      {
        id: "read-as-honest",
        description: "当成诚实认错，不下调",
        mustJustify: ["说明什么会让自己改判"],
      },
    ],
    expertFailureModes: [
      "把退水当成认罪",
      "退水之后就不再检验他之前说过的话",
      "只谈退水，不谈那辆挂掉的车给出的约束",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "challenge-claimant", "stay-hidden"],
      ownStatuses: ["hidden", "considering"],
      stances: ["oppose", "conditional-support", "undecided"],
      mustAssess: [3],
      needsRivalPlan: false,
      mustRecord: [
        "3 号的 contradictions 或 failedPredictions 应该有内容",
        "premiseIds 要同时引用任务结果和退水事件",
      ],
    },
  },

  {
    id: "p17.same-retraction-read-two-ways",
    title: "同一次退水，两个座位读出不同意思",
    why: "分歧本身是真实的桌面状态，不是谁算错了",
    missionNumber: 2,
    attempt: 1,
    leader: 8,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: FIRST_PASSED,
    claims: [
      { seat: 5, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 5, kind: "assertion", text: "我收回，理由是我不想再被追问候选对", atSequence: 20 },
      { seat: 9, kind: "assertion", text: "这是有计划的掩护，5 号仍然可信", atSequence: 24 },
      { seat: 3, kind: "assertion", text: "这是撑不住了，5 号该被排除", atSequence: 26 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 9 号和 3 号对同一条记录给出了相反的解释",
      "认出两种解释都说得通，而且都不是裁判记录",
      "认出真正能分开它们的是之后的结果，不是谁说得更响",
    ],
    acceptableActionFamilies: [
      {
        id: "name-the-fork",
        description: "把两种解释摆出来，指出什么能分开",
        mustJustify: ["给出那个能分开的检验"],
      },
      {
        id: "pick-one-with-reason",
        description: "选一种解释并说明依据",
        mustJustify: ["点名依据", "说明什么会让自己换边"],
      },
      {
        id: "look-at-the-arguers",
        description: "把注意力转向 9 号和 3 号本身",
        mustJustify: ["说明为什么他们的态度比 5 号的退水更有信息"],
      },
    ],
    expertFailureModes: [
      "跟着声音更大的那一边",
      "把两种解释当成同一件事的两种说法，不给区分办法",
      "忘记 9 号和 3 号各自的立场也是可被检验的",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "challenge-claimant", "endorse-claimant"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [5],
      needsRivalPlan: false,
      mustRecord: [
        "conditionToUpgrade 和 conditionToDowngrade 都要写得能分开这两种解释",
      ],
    },
  },

  /* ── 18-22: coalitions, consensus, pressure ──────────────────────────── */
  {
    id: "p18.followers-switch",
    title: "跟随者从一个声称者换到另一个",
    why: "换边的**理由**比换边本身更值得看",
    missionNumber: 2,
    attempt: 2,
    leader: 7,
    rejectionStreak: 1,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 4, kind: "role", text: "我才是", atSequence: 22 },
      { seat: 1, kind: "assertion", text: "我本来跟 2 号，现在改跟 4 号", atSequence: 30 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 1 号换边了，而他给的理由是什么（或者没给）",
      "认出换边可能是被新证据说服，也可能是在跟着势头走",
      "认出自己也在被同一股势头影响",
    ],
    acceptableActionFamilies: [
      {
        id: "interrogate-the-switch",
        description: "追问 1 号换边的具体依据",
        mustJustify: ["给出那个具体问题"],
      },
      {
        id: "switch-too-with-reason",
        description: "自己也换，但说清依据",
        mustJustify: ["点名依据", "给出撤退条件"],
      },
      {
        id: "hold-the-line",
        description: "不跟着换，说明为什么",
        mustJustify: ["说明什么会让自己换"],
      },
    ],
    expertFailureModes: [
      "把换边的人数当成证据",
      "跟着换但说不出依据",
      "完全不注意势头正在形成",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "challenge-claimant", "endorse-claimant"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 4],
      needsRivalPlan: false,
      mustRecord: ["两个声称者都要评估", "conditionToSwitch 要非空"],
    },
  },

  {
    id: "p19.false-consensus-around-morgana",
    title: "假共识围绕一个声称者形成",
    why: "共识越像共识，越少人去查它建立在什么上面",
    missionNumber: 2,
    attempt: 1,
    leader: 7,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 7, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 8, kind: "assertion", text: "我信 7 号", atSequence: 12 },
      { seat: 9, kind: "assertion", text: "我也信 7 号", atSequence: 14 },
      { seat: 10, kind: "assertion", text: "7 号说了算", atSequence: 16 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出三个支持者中没有一个复述了 7 号的具体依据",
      "认出「三个人都同意」不是证据，是声势",
      "认出 7 号本身给的公开依据到底有多少",
    ],
    acceptableActionFamilies: [
      {
        id: "ask-for-the-evidence",
        description: "要求支持者复述他们接住的是哪一条",
        mustJustify: ["给出那个具体要求"],
      },
      {
        id: "test-the-consensus",
        description: "提一辆能检验这套共识的车",
        mustJustify: ["说明这辆车怎么检验"],
      },
      {
        id: "join-with-conditions",
        description: "加入但附上撤退条件",
        mustJustify: ["点名接住的是哪一条", "给出撤退条件"],
      },
    ],
    expertFailureModes: [
      "因为人多就跟着走",
      "只表达怀疑而不给可执行的检验",
      "把三个支持者当成三条独立证据",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["challenge-claimant", "compare-claimants", "endorse-claimant"],
      ownStatuses: ["hidden", "considering"],
      stances: ["oppose", "conditional-support", "undecided"],
      mustAssess: [7],
      needsRivalPlan: false,
      mustRecord: [
        "negativeCase 要点到「支持者没有复述依据」这一条",
        "publicClaimMove 要带一个可执行的请求",
      ],
    },
  },

  {
    id: "p20.minority-breaks-the-coalition",
    title: "少数派的一条具体理由打散了假共识",
    why: "一条能被检验的具体理由，胜过三个人的表态",
    missionNumber: 2,
    attempt: 2,
    leader: 3,
    rejectionStreak: 1,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 7, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 3, kind: "assertion", text: "7 号在首轮投了支持那辆挂掉的车，和他现在的说法对不上", atSequence: 26 },
    ],
    tested: { seat: 8, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 3 号给的是一条可以回头查的公开记录，不是一个感觉",
      "认出这条记录如果成立，7 号需要回答它",
      "认出 3 号自己也可能有别的动机",
    ],
    acceptableActionFamilies: [
      {
        id: "amplify-the-check",
        description: "把这条要求复述一遍，让它变成全桌的问题",
        mustJustify: ["复述具体那条记录", "说明 7 号答不上来意味着什么"],
      },
      {
        id: "verify-first",
        description: "先自己核对那条票型再表态",
        mustJustify: ["说明核对的是哪一条"],
      },
      {
        id: "note-the-motive",
        description: "接受这条质疑，同时留意 3 号的动机",
        mustJustify: ["说明两件事怎么分开看"],
      },
    ],
    expertFailureModes: [
      "因为 3 号是少数派就忽略他",
      "接受质疑但不复述具体内容，共同知识没有形成",
      "把 3 号提出质疑本身当成他是好人的证据",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["challenge-claimant", "endorse-claimant", "compare-claimants"],
      ownStatuses: ["hidden", "considering"],
      stances: ["oppose", "conditional-support", "support", "undecided"],
      mustAssess: [7],
      needsRivalPlan: false,
      mustRecord: ["premiseIds 要引用 7 号那次投票的 f… id"],
    },
  },

  {
    id: "p21.both-candidates-on-a-decisive-team",
    title: "两个真候选同时出现在一辆决定胜负的车上，而场上还在争派权",
    why: "M5.1 的那一格加上派权争夺：现在沉默的反对更没人接得住",
    missionNumber: 3,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 0, fails: 2 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 3], result: "fail", failCount: 1 },
      { kind: "mission", missionNumber: 2, team: [1, 2, 4, 10], result: "fail", failCount: 2 },
    ],
    claims: [{ seat: 4, kind: "role", text: "我是派西维尔，这车我认", atSequence: 40 }],
    tested: {
      seat: 8,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [7, 9] },
    },
    proposedTeam: [5, 6, 7, 9],
    task: "vote",
    analysisObligations: [
      "认出这辆车必然含莫甘娜 —— 硬推论",
      "认出 0:2 的比分下这一轮挂了就直接输",
      "认出提这辆车的 4 号正站在自己的身份上，而自己还没跳",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-and-reject",
        description: "跳出来，说明这车必含莫甘娜并要求换人",
        mustJustify: ["说明为什么现在值得暴露", "给出替代车", "说明怎么处理 4 号的对跳"],
      },
      {
        id: "reject-with-cover",
        description: "用别的公开理由反对，不暴露来源",
        mustJustify: ["承认这个理由对别人的说服力弱于真实理由"],
      },
      {
        id: "approve-for-information",
        description: "放行，用结果换信息",
        mustJustify: ["说明 0:2 还能不能承受这个赌"],
      },
    ],
    expertFailureModes: [
      "投反对却什么都不说，硬推论没有进入牌桌",
      "公开说出候选对",
      "忽略 4 号已经占住了这个身份",
    ],
    forbiddenLeaks: ["7号和9号是一对", "候选对"],
    contestObligations: {
      acts: ["claim-percival", "counterclaim-percival", "attack-rival-claim", "stay-hidden"],
      ownStatuses: ["hidden", "considering", "active"],
      stances: ["oppose", "undecided"],
      mustAssess: [4],
      needsRivalPlan: false,
      mustRecord: [
        "4 号要被评估",
        "concealmentCost 要写清继续藏着在这一轮的代价",
      ],
    },
  },

  {
    id: "p22.fifth-proposal-tests-the-plans",
    title: "第五案：两套声称者的方案被逼到同一张票上",
    why: "这一票不再是「我信谁」，而是「这辆车和直接判负比哪个更差」",
    missionNumber: 2,
    attempt: 5,
    leader: 3,
    rejectionStreak: 4,
    score: { successes: 0, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 3], result: "fail", failCount: 1 },
      { kind: "proposal", missionNumber: 2, attempt: 5, leader: 3, team: [1, 2, 4, 10] },
    ],
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔，这车可以上", atSequence: 30 },
      { seat: 5, kind: "role", text: "我才是，这车不能上", atSequence: 36 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: [1, 2, 4, 10],
    task: "vote",
    analysisObligations: [
      "认出这是第五次提案，否掉直接判负",
      "认出两个声称者给的建议正好相反，而这一票只能选一个",
      "认出上票不构成对车上任何人的背书",
    ],
    acceptableActionFamilies: [
      {
        id: "approve-under-duress",
        description: "上票，并说明这是被逼的",
        mustJustify: ["说明这一票不构成保人"],
      },
      {
        id: "reject-and-own-it",
        description: "否，接受直接判负",
        mustJustify: ["说明为什么这辆车比判负更差"],
      },
    ],
    expertFailureModes: [
      "把这一票当成对某个声称者的信任投票",
      "沿用前四次的标准",
      "上票之后无法解释自己不是在保人",
    ],
    forbiddenLeaks: [],
    contestObligations: {
      acts: ["compare-claimants", "endorse-claimant", "challenge-claimant"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 5],
      needsRivalPlan: false,
      mustRecord: [
        "alignment.proposition 要写成一句可判真假的话",
        "voteOrTeamConsequence 要说明上票是否构成保人",
      ],
    },
  },

  /* ── 23-25: Merlin, Assassin, and the empty table ────────────────────── */
  {
    id: "p23.merlin-supports-true-percival",
    title: "梅林支持真派西维尔，而不暴露自己的信息",
    why: "支持得太准和支持得太少，都是问题",
    missionNumber: 2,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 4, kind: "role", text: "我才是", atSequence: 22 },
    ],
    tested: {
      seat: 1,
      role: "merlin",
      side: "good",
      knowledge: { kind: "sees_evil", seats: [4, 7, 10] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出对跳的 4 号在自己看得见的坏人里",
      "认出自己不能用「我看得见」去支持 2 号",
      "认出每次都精准站边会被刺客用记录找出来",
    ],
    acceptableActionFamilies: [
      {
        id: "support-on-public-grounds",
        description: "支持 2 号，理由完全来自公开记录",
        mustJustify: ["点名那条公开依据", "说明怎么避免显得读得太准"],
      },
      {
        id: "add-noise",
        description: "支持并补一个自己不确定的比较",
        mustJustify: ["说明这条噪声不会误导好人"],
      },
      {
        id: "stay-out",
        description: "不表态，只投票",
        mustJustify: ["说明沉默换到了什么"],
      },
    ],
    expertFailureModes: [
      "用只有自己知道的理由去打 4 号",
      "支持得过于精准",
      "为了掩护说出会误导好人的话",
    ],
    forbiddenLeaks: ["4号是坏人", "7号是坏人", "10号是坏人", "我看得见"],
    contestObligations: {
      acts: ["endorse-claimant", "challenge-claimant", "compare-claimants", "stay-hidden"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 4],
      needsRivalPlan: false,
      mustRecord: [
        "premiseIds 里不能出现 p.sees",
        "coverStory 或 informationToConceal 要说明怎么解释自己的准确度",
      ],
    },
  },

  {
    id: "p24.assassin-reads-the-fight",
    title: "刺客从派权争夺里更新梅林候选",
    why: "谁在保谁、谁替谁挡刀，是最好的一批梅林线索",
    missionNumber: 2,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 },
      { seat: 4, kind: "role", text: "我才是", atSequence: 22 },
      { seat: 1, kind: "assertion", text: "我信 2 号，理由是他的车避开了首轮三人", atSequence: 28 },
      { seat: 6, kind: "assertion", text: "我也信 2 号", atSequence: 30 },
    ],
    tested: {
      seat: 8,
      role: "assassin",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [4, 9] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 1 号给了具体依据，6 号只是表态 —— 两者信息量不同",
      "认出替真派挡刀的人更可能是梅林",
      "把赢任务和找梅林分成两本账",
    ],
    acceptableActionFamilies: [
      {
        id: "observe-quietly",
        description: "不表态，把这一轮的支持关系记下来",
        mustJustify: ["说明记的是什么线索"],
      },
      {
        id: "provoke",
        description: "打 2 号，看谁跳出来护他",
        mustJustify: ["说明打算从反应里读什么", "说明代价"],
      },
      {
        id: "endorse-the-weaker",
        description: "去捧对自己有利的那个声称者",
        mustJustify: ["说明这条路怎么把坏人送上车"],
      },
    ],
    expertFailureModes: [
      "把最大声的人当成梅林",
      "为了收集情报而毁掉这一轮的任务机会",
      "露出和 4 号（队友）之间的协调痕迹",
    ],
    forbiddenLeaks: ["4号是坏人", "9号是坏人", "我是刺客"],
    contestObligations: {
      acts: ["compare-claimants", "attack-rival-claim", "endorse-claimant", "stay-hidden"],
      ownStatuses: ["hidden", "considering"],
      stances: ["support", "conditional-support", "oppose", "undecided"],
      mustAssess: [2, 4],
      needsRivalPlan: false,
      mustRecord: [
        "4 号是队友，但对他的评估只能用公开 premiseIds",
        "任何字段里都不能出现队友身份",
      ],
    },
  },

  {
    id: "p25.nobody-claims",
    title: "整整一轮没有人跳，机会成本要被记下来",
    why: "M5 试点整局零声称。这一格问的是：不跳的时候，桌子靠什么组织",
    missionNumber: 2,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: FIRST_FAILED,
    claims: [],
    tested: {
      seat: 2,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [5, 9] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出第一轮已经结算，而自己既没跳也没有替代焦点",
      "认出继续藏着有具体代价，而不只是「更安全」",
      "认出没有人跳意味着桌面没有参照点，所有人各说各的",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-now",
        description: "现在跳，用第一轮的结果当依据",
        mustJustify: ["说明为什么是现在", "给出车和票建议"],
      },
      {
        id: "install-a-proxy",
        description: "不跳，公开把一个信得过的人推上参照位",
        mustJustify: ["点名是谁", "说明依据"],
      },
      {
        id: "coordinate-anonymously",
        description: "不跳，但做一件用得上候选对而不暴露来源的具体动作",
        mustJustify: ["给出那辆车", "说明它怎么用到了候选对"],
      },
    ],
    expertFailureModes: [
      "又一次写下和上一轮一样的不跳理由",
      "既不跳也不组织，等于这个身份没有被使用",
      "把「没人跳」当成局面平静",
    ],
    forbiddenLeaks: ["5号和9号是一对", "候选对"],
    contestObligations: {
      acts: ["claim-percival", "endorse-claimant", "compare-claimants", "stay-hidden"],
      ownStatuses: ["hidden", "considering", "active"],
      stances: ["undecided", "support", "conditional-support"],
      mustAssess: [],
      needsRivalPlan: false,
      mustRecord: [
        "concealmentCost 必须非空 —— 这一格就是关于机会成本的",
        "situationSpecificBenefit 不能和上一轮一字不差",
      ],
    },
  },
]);

export function contestScenarioById(id: string): ContestScenario {
  const found = CONTEST_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown contest scenario: ${id}`);
  return found;
}
