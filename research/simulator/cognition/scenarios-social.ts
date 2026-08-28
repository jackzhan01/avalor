/**
 * Twelve positions where the game is decided by coordination, not deduction.
 *
 * The M5A fixtures in `scenarios.ts` isolate what one seat can work out on its
 * own. These isolate what a seat does about OTHER PEOPLE — who is leading, whether
 * to follow, and what has to be said out loud for anyone else to be able to act
 * on it. That is the half the completed pilot never exercised: zero claims, no
 * coalition, explicit engagement down from 48% of speeches to 21%, and evil
 * winning 3:0 without ever having to break a good plan, because there was never
 * one to break.
 *
 * THE SAME RULE AS THE M5A FIXTURES APPLIES, and it matters more here.
 * NO FIXTURE NAMES ONE LEGAL ACTION AS THE ONLY EXPERT ACTION. Following a
 * credible claimant and refusing to follow anybody are both real lines. What a
 * fixture is strict about is the ANALYSIS — and, new here, the SOCIAL RECORD:
 * `socialObligations` names what the seat's `social` block must contain, which
 * is checkable without grading the move.
 *
 * `forbiddenLeaks` is absolute, as before.
 *
 * STATUS: offline fixtures. No model is called anywhere in this file.
 */

import type { Seat } from "../core/types";
import type { AlignmentStance } from "./social";
import type { Scenario } from "./scenarios";

/**
 * What the social block must record in this position.
 *
 * `stances` lists the alignments a competent seat could defensibly take — more
 * than one wherever the position genuinely allows it. `mustName` is the seat
 * whose leadership the block has to be about, and `mustRecord` is prose a human
 * reviewer checks. The point of splitting them: the first two are mechanical,
 * so a scripted run can assert them; the third is judgement, so it is not
 * pretended to be mechanical.
 */
export interface SocialObligations {
  /** Alignments that are defensible here. Never exactly one, unless it is. */
  readonly stances: readonly AlignmentStance[];
  /** Seats the social model must have an opinion about. */
  readonly mustName: readonly Seat[];
  /** What a reviewer looks for in the recorded conclusions. */
  readonly mustRecord: readonly string[];
}

export interface SocialScenario extends Scenario {
  readonly socialObligations: SocialObligations;
}

export const SOCIAL_SCENARIOS: readonly SocialScenario[] = Object.freeze([
  /* ── 1-4: Percival, and who ends up leading ────────────────────────────── */
  {
    id: "x01.percival-claims-with-a-plan",
    title: "真派西维尔第一轮跳，并给出可执行的车与票",
    why:
      "M5 试点里派西维尔十七次决策一次都没跳，也没有替代方案。这一格问的是：" +
      "跳的时候到底该带上什么，才算真的换到了组织权",
    missionNumber: 1,
    attempt: 1,
    leader: 2,
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
    task: "leader-close-and-propose",
    analysisObligations: [
      "认出自己既是首任队长又能定调，这是全局影响力最高的一次机会",
      "把「跳能立刻给好人一个锚点」和「跳等于把梅林范围缩到两人」同时算进去",
      "想清楚有人对跳派西维尔时自己怎么办",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-and-lead",
        description: "跳派西维尔，同时给出首车、投票建议和对跳预案",
        mustJustify: [
          "说明这一车为什么这么组（候选对怎么处理）",
          "给出一个别人能照着投的具体建议",
          "说明有人对跳时的判据",
        ],
      },
      {
        id: "lead-without-claiming",
        description: "不跳，但用队长权组织好人",
        mustJustify: ["说明不跳换到了什么", "给出一个不依赖身份的可执行请求"],
      },
    ],
    expertFailureModes: [
      "只报一句「我是派西维尔」，没有车、没有票建议、没有对跳预案",
      "跳完之后把候选对里更像梅林的那个也说出来",
      "组了一辆车却不说为什么是这几个人，别人无法接住",
    ],
    forbiddenLeaks: ["5号是梅林", "9号是梅林", "5号是莫甘娜", "9号是莫甘娜"],
    socialObligations: {
      stances: ["independent", "challenge"],
      mustName: [],
      mustRecord: [
        "alignment.publicAction 要是一个别人能配合的具体动作，不是一句表态",
        "coalitionPlan 要有 proposedTeam 或明确的 votingBloc",
        "strongestDissent 要预演对跳",
      ],
    },
  },

  {
    id: "x02.percival-hides-but-props-up-a-proxy",
    title: "派西维尔不跳，改为在桌上立一个代理焦点",
    why:
      "不跳是合法的，但 M5 试点证明了不跳且不组织等于这个身份没被使用。" +
      "这一格检验的是第二条路存不存在",
    missionNumber: 1,
    attempt: 2,
    leader: 6,
    rejectionStreak: 1,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 3, team: [3, 7, 10] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [2, 4, 6, 8, 9, 1], result: "rejected" },
    ],
    claims: [
      { seat: 6, kind: "assertion", text: "3号那辆车没解释为什么带 10 号，我按这个否", atSequence: 8 },
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
      "认出 6 号的反对理由是具体的、可以被公开检验的",
      "认识到把 6 号推上焦点位可以在不暴露候选对的前提下组织好人",
      "说明这一轮的局面为什么支持不跳 —— 而不是重复上一轮的理由",
    ],
    acceptableActionFamilies: [
      {
        id: "endorse-a-proxy",
        description: "公开支持 6 号的标准，让他成为参照点",
        mustJustify: ["点名接住的是他哪一条", "说明自己为什么不直接站出来"],
      },
      {
        id: "claim-now-instead",
        description: "改主意，这一轮就跳",
        mustJustify: ["说明是什么让门槛过了"],
      },
      {
        id: "coordinate-without-a-proxy",
        description: "自己给出一个用得上候选对但不暴露来源的具体车",
        mustJustify: ["说明这辆车的公开理由站得住"],
      },
    ],
    expertFailureModes: [
      "又一次写下和上一轮一字不差的不跳理由",
      "支持 6 号却不说支持的是哪一条，等于没产生共同知识",
      "为了立代理焦点而暴露候选对",
    ],
    forbiddenLeaks: ["5号是梅林", "9号是梅林", "候选对"],
    socialObligations: {
      stances: ["follow", "conditional-follow", "independent"],
      mustName: [6],
      mustRecord: [
        "6 号要出现在 focalCandidates 里，带 basisIds",
        "conditionToReconsider 要说明什么会让他失去这个位置",
        "如果是 conditional-follow，proposition 要是 6 号那条标准本身",
      ],
    },
  },

  {
    id: "x03.percival-pair-on-one-team",
    title: "两个候选被放进同一辆关键车",
    why:
      "派西维尔手上唯一的硬推论。M5 试点里 8 号确实认出了它并投了反对 —— " +
      "但没有人知道他为什么反对，所以这条信息没有进入牌桌",
    missionNumber: 3,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 0, fails: 2 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [8, 1, 3], result: "fail", failCount: 1 },
      { kind: "mission", missionNumber: 2, team: [1, 2, 4, 10], result: "fail", failCount: 2 },
    ],
    claims: [],
    tested: {
      seat: 8,
      role: "percival",
      side: "good",
      knowledge: { kind: "merlin_or_morgana", pair: [7, 9] },
    },
    proposedTeam: [5, 6, 7, 9],
    task: "vote",
    analysisObligations: [
      "认出这辆车必然含莫甘娜 —— 这是硬推论，不是猜测",
      "认出比分 0:2，这一轮挂了就直接输",
      "重新评估跳不跳：沉默的反对救不了这一轮，也没人会接住",
    ],
    acceptableActionFamilies: [
      {
        id: "claim-and-reject",
        description: "跳派西维尔并说明这辆车必含莫甘娜，要求换人",
        mustJustify: ["说明为什么现在值得暴露", "给出替代车"],
      },
      {
        id: "reject-with-cover",
        description: "用别的公开理由反对，不暴露来源",
        mustJustify: ["承认这个理由对别人的说服力弱于真实理由"],
      },
      {
        id: "approve-for-information",
        description: "放行，用结果换信息",
        mustJustify: ["说明 0:2 的比分下还能不能承受这个赌"],
      },
    ],
    expertFailureModes: [
      "投了反对却完全不说理由，硬推论没有进入牌桌",
      "公开说出「7、9 是一对」，直接把候选对交给刺客",
      "把这一票当成普通一票，忽略这是定胜负的一轮",
    ],
    forbiddenLeaks: ["7号和9号是一对", "候选对"],
    socialObligations: {
      stances: ["challenge", "independent"],
      mustName: [4],
      mustRecord: [
        "alignment.proposition 要是「5、6、7、9 这辆车可以上」这一句本身",
        "publicAction 要说明公开怎么表达，哪怕选择不暴露来源",
      ],
    },
  },

  {
    id: "x04.morgana-counterclaims",
    title: "莫甘娜对跳派西维尔",
    why: "假焦点是坏人最强的社会手段。牌桌看到的是两个自称派西维尔的人，没有裁判记录可以分开他们",
    missionNumber: 1,
    attempt: 2,
    leader: 4,
    rejectionStreak: 1,
    score: { successes: 0, fails: 0 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [7, 8, 9, 10, 3, 4], result: "rejected" },
    ],
    claims: [{ seat: 2, kind: "role", text: "我是派西维尔", atSequence: 5 }],
    tested: {
      seat: 7,
      role: "morgana",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [8, 9] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 2 号跳了之后，自己作为「候选之一」的模糊性开始贬值",
      "认出对跳会把牌桌变成二选一，而牌桌没有裁判记录可以判",
      "认出自己知道队友是 8、9，但奥伯伦不在其中",
    ],
    acceptableActionFamilies: [
      {
        id: "counterclaim",
        description: "对跳派西维尔，给出细节争夺焦点位",
        mustJustify: ["说明对跳之后打算怎么让牌桌选自己", "说明失败的代价"],
      },
      {
        id: "undermine-without-claiming",
        description: "不跳，改为攻击 2 号声称的时机或内容",
        mustJustify: ["说明为什么保留模糊比争焦点更值"],
      },
      {
        id: "endorse-and-steer",
        description: "顺着 2 号，换取信任后再影响用车",
        mustJustify: ["说明这条路怎么在不暴露的前提下把坏人送上车"],
      },
    ],
    expertFailureModes: [
      "对跳之后拿不出任何细节，立刻被比下去",
      "攻击得太用力，反而把自己变成焦点",
      "假设 10 号（奥伯伦）会配合",
    ],
    forbiddenLeaks: ["8号是坏人", "9号是坏人", "我是莫甘娜"],
    socialObligations: {
      stances: ["challenge", "follow", "independent"],
      mustName: [2],
      mustRecord: [
        "2 号必须出现在 focalCandidates 里，claimedRole 记成 percival",
        "reasonsToChallenge 要写得出一条牌桌能听懂的",
        "coalitionPlan.messageObjective 要说明这次发言要达成什么",
      ],
    },
  },

  /* ── 5-8: following, and un-following ──────────────────────────────────── */
  {
    id: "x05.loyal-conditionally-follows",
    title: "忠臣有条件地跟一个站得住的声称者",
    why:
      "M5 试点里十个座位各自分析、互不接住。这一格问的是：跟一个人的时候，" +
      "公开要说到什么程度，别人才能一起用",
    missionNumber: 2,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [2, 5, 6], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 2, team: [2, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [7, 9], result: "passed" },
    ],
    claims: [{ seat: 2, kind: "role", text: "我是派西维尔，第一车避开我的两个候选", atSequence: 5 }],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 2 号说过的话被结果兑现了 —— 他组的车成功了",
      "认出「兑现过一次」不等于身份为真，莫甘娜也可以组一辆成功的车",
      "认出 7、9 是当时唯二的反对者，这是可比较的公开记录",
    ],
    acceptableActionFamilies: [
      {
        id: "follow-out-loud",
        description: "公开跟 2 号，复述接住的是哪一条，并给出票",
        mustJustify: ["点名 2 号", "复述具体结论而不是「我同意」", "给出撤退条件"],
      },
      {
        id: "follow-quietly",
        description: "按 2 号的方向投，但不公开背书",
        mustJustify: ["说明为什么不值得公开"],
      },
      {
        id: "test-instead",
        description: "提出一个能检验 2 号的具体安排",
        mustJustify: ["说明这个检验能分开哪两种世界"],
      },
    ],
    expertFailureModes: [
      "只说「我同意 2 号」，不复述任何具体结论",
      "因为他跳了派西维尔就当成硬信息",
      "跟了但说不出什么会让自己收回信任",
    ],
    forbiddenLeaks: [],
    socialObligations: {
      stances: ["follow", "conditional-follow", "challenge"],
      mustName: [2],
      mustRecord: [
        "conditionToReconsider 必须非空",
        "如果是 follow / conditional-follow，publicAction 要包含具体的票或车",
        "claimedRole 记 percival，但 basisIds 只能是公开记录",
      ],
    },
  },

  {
    id: "x06.loyal-rejects-a-contradicted-claimant",
    title: "声称者的公开记录和他的声称对不上",
    why: "跟一个人容易，撤下来难。这一格给的是明确的矛盾，检验撤不撤",
    missionNumber: 3,
    attempt: 1,
    leader: 6,
    rejectionStreak: 0,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [2, 5, 6], result: "success", failCount: 0 },
      { kind: "mission", missionNumber: 2, team: [2, 3, 7, 8], result: "fail", failCount: 1 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 2, team: [2, 3, 7, 8] },
      { kind: "vote", missionNumber: 2, attempt: 1, rejecters: [4, 9], result: "passed" },
    ],
    claims: [
      { seat: 2, kind: "role", text: "我是派西维尔，我组的车避开了我的候选", atSequence: 5 },
      { seat: 2, kind: "assertion", text: "第二车我保证干净", atSequence: 20 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 2 号自己组的第二辆车挂了，而他公开保证过它干净",
      "认出这条矛盾是裁判记录支持的，不是别人的说法",
      "认出 2 号仍然可能是真派西维尔且判断失误 —— 矛盾降低分量，不等于定性",
    ],
    acceptableActionFamilies: [
      {
        id: "withdraw-trust",
        description: "公开收回信任，说清是哪一条让自己改的",
        mustJustify: ["点名具体矛盾", "说明现在改跟谁或改成独立判断"],
      },
      {
        id: "downgrade-not-drop",
        description: "降低而不是取消对 2 号的权重",
        mustJustify: ["说明什么会让他重新站住"],
      },
      {
        id: "keep-following",
        description: "仍然跟，但要求他解释",
        mustJustify: ["说明为什么这条矛盾不足以推翻他"],
      },
    ],
    expertFailureModes: [
      "继续跟着走，完全不提那条矛盾",
      "把矛盾当成「他是坏人」的证明",
      "撤了信任却不说撤到哪里去，桌面失去焦点",
    ],
    forbiddenLeaks: [],
    socialObligations: {
      stances: ["challenge", "independent", "conditional-follow"],
      mustName: [2],
      mustRecord: [
        "reasonsToChallenge 必须点到第二车挂掉这条裁判记录",
        "credibility 至少降到 contested",
      ],
    },
  },

  {
    id: "x07.minority-dissenter-becomes-focal",
    title: "少数派事前反对，车挂了",
    why: "事前反对是证据不是证明。这一格检验的是能不能同时用它、又不迷信它",
    missionNumber: 2,
    attempt: 1,
    leader: 4,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: [
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 3, team: [3, 7, 10] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [4, 6], result: "passed" },
      { kind: "mission", missionNumber: 1, team: [3, 7, 10], result: "fail", failCount: 1 },
    ],
    claims: [
      { seat: 4, kind: "assertion", text: "3、7、10 没有一条选人理由，我否", atSequence: 9 },
    ],
    tested: { seat: 1, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 4 号和 6 号是唯二的事前反对者，而那辆车确实挂了",
      "认出 4 号当时给的理由是具体的、可以回头检验的",
      "认出坏人也会反对一辆注定要挂的车来买信誉",
    ],
    acceptableActionFamilies: [
      {
        id: "promote-the-dissenter",
        description: "公开抬高 4 号的分量，建议由他组下一辆车",
        mustJustify: ["点明是哪一条理由现在被兑现了", "说明这不是身份证明"],
      },
      {
        id: "use-but-discount",
        description: "采用他的标准，但不把权重给到人身上",
        mustJustify: ["说明标准和人为什么要分开"],
      },
      {
        id: "test-the-dissenter",
        description: "让 4 号组车，用结果检验",
        mustJustify: ["说明这个检验能分开哪两种世界"],
      },
    ],
    expertFailureModes: [
      "把「他反对过」直接当成他是好人",
      "完全不提这条公开记录，等于浪费了唯一一次可回头检验的表态",
      "抬高 4 号却不给任何可执行的下一步",
    ],
    forbiddenLeaks: [],
    socialObligations: {
      stances: ["follow", "conditional-follow", "independent"],
      mustName: [4],
      mustRecord: [
        "basisIds 要指向第一轮的投票记录和任务结果",
        "reasonsToChallenge 要写下「反对过不等于好人」",
      ],
    },
  },

  {
    id: "x08.trusted-leader-loses-a-team",
    title: "一直被跟的人推的车挂了",
    why: "焦点是位置不是身份。这一格问的是这张椅子换不换得掉",
    missionNumber: 3,
    attempt: 1,
    leader: 9,
    rejectionStreak: 0,
    score: { successes: 1, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [1, 5, 6], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 5, team: [5, 6, 7, 8] },
      { kind: "vote", missionNumber: 2, attempt: 1, rejecters: [3], result: "passed" },
      { kind: "mission", missionNumber: 2, team: [5, 6, 7, 8], result: "fail", failCount: 1 },
    ],
    claims: [
      { seat: 5, kind: "assertion", text: "第二车按第一车的成功位扩展，最稳", atSequence: 18 },
      { seat: 3, kind: "assertion", text: "扩展成功位等于假设第一车全干净，我否", atSequence: 20 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 5 号的方法被结果否掉了，而 3 号事前就指出了它的漏洞",
      "认出自己在两辆车上都在，这既是信息也是嫌疑",
      "认出焦点可以易主，而且现在有具体理由易主",
    ],
    acceptableActionFamilies: [
      {
        id: "hand-over",
        description: "公开把参照点移到 3 号，说明依据",
        mustJustify: ["点名 3 号当时的具体理由", "给出下一辆车的方向"],
      },
      {
        id: "keep-but-fix",
        description: "保留 5 号，但要求他换掉出问题的那条标准",
        mustJustify: ["说明哪一条标准要换"],
      },
      {
        id: "no-focal",
        description: "主张这一轮不设焦点，逐位比较",
        mustJustify: ["说明僵住的代价，尤其是第五案"],
      },
    ],
    expertFailureModes: [
      "继续跟 5 号，只因为之前一直跟着他",
      "把 3 号捧上去却不说他当时的理由是什么",
      "忘记自己在两辆车上，别人一定会算这一条",
    ],
    forbiddenLeaks: [],
    socialObligations: {
      stances: ["challenge", "conditional-follow", "independent"],
      mustName: [5, 3],
      mustRecord: [
        "focalCandidates 里要同时有 5 和 3",
        "5 号的 credibility 要降下来，且给出裁判记录依据",
      ],
    },
  },

  /* ── 9-12: two coalitions, the hammer, Merlin, and evil consensus ─────── */
  {
    id: "x09.two-coalitions",
    title: "两套说法各推一辆车",
    why: "好人分成两半僵住，坏人什么都不用做就赢第五案",
    missionNumber: 2,
    attempt: 2,
    leader: 7,
    rejectionStreak: 1,
    score: { successes: 1, fails: 0 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [1, 2, 3], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 2, attempt: 1, leader: 4, team: [1, 2, 3, 4] },
      { kind: "vote", missionNumber: 2, attempt: 1, rejecters: [5, 6, 8, 9, 10], result: "rejected" },
    ],
    claims: [
      { seat: 4, kind: "assertion", text: "成功车原班人马加我，最稳", atSequence: 14 },
      { seat: 6, kind: "assertion", text: "原班人马只验证了三个人，第四个位置必须换新人", atSequence: 16 },
    ],
    tested: { seat: 10, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出两套说法真正分歧的那一条前提：成功车是否洗清了车上三人",
      "认出连否已经开始，第五案的代价在逼近",
      "认出自己这一票是唯一的影响力（这一轮轮不到自己发车）",
    ],
    acceptableActionFamilies: [
      {
        id: "pick-a-side-with-a-reason",
        description: "选一边，说清是因为哪一条前提",
        mustJustify: ["点名两套说法分歧的那一条", "给出票"],
      },
      {
        id: "propose-a-bridge",
        description: "给出一辆同时满足两套标准的车",
        mustJustify: ["说明它为什么两边都能接受"],
      },
      {
        id: "name-the-test",
        description: "指出什么结果能把两套说法分开",
        mustJustify: ["说明在分开之前自己怎么投"],
      },
    ],
    expertFailureModes: [
      "各打五十大板，两边都不选，把僵局延长",
      "选边却说不出理由，别人无法接住",
      "忽略第五案的逼近",
    ],
    forbiddenLeaks: [],
    socialObligations: {
      stances: ["follow", "conditional-follow", "challenge", "independent"],
      mustName: [4, 6],
      mustRecord: [
        "focalCandidates 要同时包含 4 和 6",
        "alignment.proposition 要是那条分歧前提本身，不是「我支持某人」",
      ],
    },
  },

  {
    id: "x10.hammer-changes-following",
    title: "第五案：跟或不跟的代价完全变了",
    why:
      "M5 试点第 2 轮走到第五案，9:1 强制通过，直接送出第二个失败分。" +
      "这一票的性质和前四票不同，而前四票的习惯会一路带过来",
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
      { seat: 5, kind: "assertion", text: "这车带 1 号，1 号在首轮失败车上，我还是否", atSequence: 40 },
    ],
    tested: { seat: 6, role: "loyal", side: "good", knowledge: { kind: "none" } },
    proposedTeam: [1, 2, 4, 10],
    task: "vote",
    analysisObligations: [
      "认出这是第五次提案，否掉直接判负，不是换个队长",
      "认出 5 号的标准在前四次是合理的，在这一次代价完全不同",
      "认出「这辆车可能有坏人」和「否掉就直接输」要放在一起比",
    ],
    acceptableActionFamilies: [
      {
        id: "approve-under-duress",
        description: "上票，并公开说明这是被逼的不是背书",
        mustJustify: ["说明这一票不构成对车上任何人的保人"],
      },
      {
        id: "reject-and-own-it",
        description: "仍然否，接受直接判负的后果",
        mustJustify: ["说明为什么这辆车比直接判负更差"],
      },
    ],
    expertFailureModes: [
      "沿用前四次的标准，没有意识到这一票的性质变了",
      "上票之后被当成对车上四人的背书，事后无法解释",
      "否掉却拿不出「这车必挂」的具体理由",
    ],
    forbiddenLeaks: [],
    socialObligations: {
      stances: ["challenge", "independent", "conditional-follow"],
      mustName: [5],
      mustRecord: [
        "alignment.proposition 要写成「1、2、4、10 这辆车比直接判负更差」这样可判真假的一句",
        "publicAction 要说明上票是否构成保人",
      ],
    },
  },

  {
    id: "x11.merlin-backs-a-leader",
    title: "梅林支持一个方向对的焦点，而不自己变成焦点",
    why: "梅林的问题不是知道什么，是怎么让别人知道而自己不被刺",
    missionNumber: 2,
    attempt: 1,
    leader: 5,
    rejectionStreak: 0,
    score: { successes: 0, fails: 1 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [3, 7, 10], result: "fail", failCount: 1 },
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 3, team: [3, 7, 10] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [1, 4], result: "passed" },
    ],
    claims: [
      { seat: 4, kind: "assertion", text: "下一车避开首轮全部三人，先把干净位找出来", atSequence: 12 },
    ],
    tested: {
      seat: 1,
      role: "merlin",
      side: "good",
      knowledge: { kind: "sees_evil", seats: [7, 8, 10] },
    },
    proposedTeam: null,
    task: "speech-regular",
    analysisObligations: [
      "认出 4 号的方向和自己看到的坏人一致，但他给的理由是公开记录，不是视野",
      "认出莫德雷德在自己看不见的位置上，所以「避开首轮三人」并不足够",
      "认出自己每次都站对边会被刺客用投票记录找出来",
    ],
    acceptableActionFamilies: [
      {
        id: "back-the-leader",
        description: "支持 4 号，把结论的来源留在公开记录上",
        mustJustify: ["说明支持的是哪一条公开理由", "说明怎么避免显得读得太准"],
      },
      {
        id: "add-one-degree",
        description: "支持并补一个自己不确定的比较，制造噪声",
        mustJustify: ["说明补的这一条不会误导好人"],
      },
      {
        id: "stay-quiet",
        description: "不表态，只投票",
        mustJustify: ["说明沉默这一轮换到了什么"],
      },
    ],
    expertFailureModes: [
      "自己抛出一个比 4 号更准的新结论，直接暴露视野",
      "为了掩护而说出会误导好人的话",
      "忘记莫德雷德，把「避开首轮三人」当成安全",
    ],
    forbiddenLeaks: ["7号是坏人", "8号是坏人", "10号是坏人", "我看得见"],
    socialObligations: {
      stances: ["follow", "conditional-follow", "independent"],
      mustName: [4],
      mustRecord: [
        "basisIds 只能是公开记录 —— 不能出现 p.sees",
        "coverStory 要说明怎么解释自己的准确度",
      ],
    },
  },

  {
    id: "x12.evil-manufactures-consensus",
    title: "坏人把一辆对自己有利的车做成「桌面共识」",
    why: "假共识是坏人最便宜的手段，也是最容易被回头清算的",
    missionNumber: 2,
    attempt: 1,
    leader: 8,
    rejectionStreak: 0,
    score: { successes: 1, fails: 0 },
    publicFacts: [
      { kind: "mission", missionNumber: 1, team: [1, 5, 6], result: "success", failCount: 0 },
      { kind: "proposal", missionNumber: 1, attempt: 1, leader: 1, team: [1, 5, 6] },
      { kind: "vote", missionNumber: 1, attempt: 1, rejecters: [8, 9], result: "passed" },
    ],
    claims: [
      { seat: 2, kind: "assertion", text: "第二车我建议 1、5、6 加 8，成功位扩展", atSequence: 15 },
    ],
    tested: {
      seat: 8,
      role: "assassin",
      side: "evil",
      knowledge: { kind: "knows_teammates", seats: [7, 9] },
    },
    proposedTeam: null,
    task: "leader-close-and-propose",
    analysisObligations: [
      "认出 2 号的建议正好把自己送上车，而且它是别人提的",
      "认出自己第一轮投了反对而那辆车成功了，这条记录对自己不利",
      "认出把共识推得越用力，车挂之后回头清算越容易找到自己",
    ],
    acceptableActionFamilies: [
      {
        id: "ride-the-consensus",
        description: "顺着 2 号的建议发车，让它看起来是桌面共识",
        mustJustify: ["说明车挂之后打算怎么解释自己在车上"],
      },
      {
        id: "add-a-teammate",
        description: "在共识车上再塞一个队友",
        mustJustify: ["说明多一个坏人换到了什么，以及双踩的信息代价"],
      },
      {
        id: "decline-and-cover",
        description: "不上这辆车，先修复第一轮反对留下的记录",
        mustJustify: ["说明放弃这次机会换到了什么"],
      },
    ],
    expertFailureModes: [
      "推得太用力，自己变成这辆车唯一的来源",
      "把两个队友都塞进去，一挂就是一条免费的硬约束",
      "忘记自己第一轮投过反对，组车理由和票型对不上",
    ],
    forbiddenLeaks: ["7号是坏人", "9号是坏人", "我是刺客"],
    socialObligations: {
      stances: ["follow", "conditional-follow", "independent"],
      mustName: [2],
      mustRecord: [
        "2 号要出现在 focalCandidates 里 —— 捧他是一个动作，要被记下来",
        "coalitionPlan.strongestDissent 要预演「为什么是你在推这辆车」",
      ],
    },
  },
]);

export function socialScenarioById(id: string): SocialScenario {
  const found = SOCIAL_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown social scenario: ${id}`);
  return found;
}
