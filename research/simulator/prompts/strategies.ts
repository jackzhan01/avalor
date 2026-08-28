/**
 * Layer 6 — strategy profiles. Three, and only three.
 *
 *   `baseline`         no tactical advice at all. The control arm.
 *   `community-meta`   optional high-level considerations drawn from what
 *                      experienced Avalon players discuss. DRAFT.
 *   `custom`           the experimenter's own text, treated as configuration.
 *
 * AN EARLIER CATALOG WAS REMOVED. It carried four data-informed profiles whose
 * rendered text quoted this repository's own corpus measurements — discrimination
 * ratios, per-round improvements, hammer pass rates. That was rejected, and
 * correctly: a prompt that tells a model "the measured rate is 0.768" is not
 * giving it a consideration, it is handing it a conclusion derived from data
 * the experiment is supposed to be independent of. Any result from a table
 * primed that way would be measuring the priming.
 *
 * So the hard rule, enforced by `strategies.test.ts`:
 *
 *   NO RENDERED STRATEGY TEXT MAY CONTAIN a corpus reference, a win rate, a
 *   likelihood ratio, an empirical percentage, or a claim that some tactic is
 *   statistically optimal.
 *
 * `provenance` exists for the humans reading `research/community-meta-sources.md`
 * and is deliberately NOT rendered.
 *
 * Two more rules, unchanged from before and equally load-bearing:
 *
 *   NOTHING HERE IS A RULE. Every entry is a CONDITION plus something to
 *   CONSIDER. In particular «派西维尔第一轮必须跳» is not encoded and must not
 *   be: claiming, counter-claiming, delaying, retracting and staying hidden are
 *   all choices, and a profile that removes the choice removes the thing being
 *   studied.
 *
 *   CONDITIONS READ REAL FIELDS. Every heuristic declares which `Observation`
 *   fields its condition depends on, and a test resolves each declared path
 *   against a real observation.
 */

import { createHash } from "node:crypto";
import type { RoleType } from "@/lib/types/game";
import type { Side } from "../core/types";
import type { Observation } from "../core/observation";

/**
 * Who a consideration is rendered to.
 *
 * Role-specific advice reaching every seat is prompt clutter at best; at worst
 * it teaches ten seats what one seat's job is, which is not what a strategy
 * profile is for. So each heuristic declares its audience.
 *
 * THE FILTER MAY READ ONLY THE SEAT'S OWN `role` AND `side`. Both are already
 * in that seat's `Observation` — the seat knows what it is — so the rendered
 * text is a function of (own role, own side, strategy id) and nothing else.
 * That is what makes it non-leaking: no fact about any OTHER seat can change
 * a single character of what this seat reads, which `strategies.leak.test.ts`
 * asserts by swapping facts this seat is not entitled to and comparing bytes.
 *
 * Referee state is not reachable from here by construction: the applicability
 * function takes an `Observation` and there is nothing else in scope.
 */
export type StrategyScope =
  /** General play — teams, votes, speech order. Rendered to every seat. */
  | { readonly kind: "all" }
  /** Only to seats holding one of these roles. */
  | { readonly kind: "roles"; readonly roles: readonly RoleType[] }
  /** Only to one side. A seat always knows its own side. */
  | { readonly kind: "side"; readonly side: Side };

/** Dotted paths into an `Observation`. Validated against a real one by a test. */
export type ObservationField =
  | "seat"
  | "role"
  | "side"
  | "knowledge"
  | "ladyResults"
  | "publicLog"
  | "memory"
  | "position.phase"
  | "position.leader"
  | "position.playDirection"
  | "position.speakingOrder"
  | "position.alreadySpoken"
  | "position.seatsUntilILead"
  | "position.missionNumber"
  | "position.attempt"
  | "position.rejectionStreak"
  | "position.successes"
  | "position.fails"
  | "position.missionTrack"
  | "position.teamSizeThisMission"
  | "position.failsRequiredThisMission"
  | "position.tentativeTeams"
  | "position.proposedTeam"
  | "position.ladyHolder"
  | "position.ladyHeldBy"
  | "position.ladyChecksDone"
  | "position.standingClaims";

export interface Heuristic {
  readonly id: string;
  /** Who reads this. Defaults to every seat when absent. */
  readonly scope?: StrategyScope;
  /** Which observation fields the condition depends on. Checked by a test. */
  readonly reads: readonly ObservationField[];
  /** The condition, phrased against those fields. */
  readonly when: string;
  /** What to CONSIDER. Never an instruction. */
  readonly consider: string;
  /** True when experienced players genuinely disagree about this. */
  readonly disputed: boolean;
  /**
   * Something the position REQUIRES the agent to notice, not to do.
   *
   * The distinction is load-bearing. Percival may respond however he likes to
   * both candidates riding one team; he may not fail to see it. So an
   * obligation constrains the ANALYSIS and leaves the ACTION free — which is
   * the only way to be strict without deleting the choice being studied.
   *
   * Absent (and therefore false) on every `community-meta` entry, so that
   * profile's fingerprint is unchanged.
   */
  readonly obligation?: boolean;
  /**
   * Where this came from, for a human reviewer.
   *
   * NOT RENDERED. It points at `research/community-meta-sources.md`, which is
   * where the links, access dates and confidence levels live. Rendering it
   * would put source citations — and the temptation to put numbers beside
   * them — back into the prompt.
   */
  readonly provenance?: string;
}

export type StrategyId =
  | "baseline"
  | "community-meta"
  | "expert-cognitive"
  | "expert-social"
  | "expert-claim-contest"
  | "custom";

/** The selectable catalog. `custom` is built per run, so it is not in here. */
export type CatalogStrategyId = Exclude<StrategyId, "custom">;

export interface StrategyDefinition {
  readonly id: StrategyId;
  readonly name: string;
  readonly status: "complete" | "draft";
  readonly summary: string;
  readonly heuristics: readonly Heuristic[];
  /** Only for `custom`. Recorded verbatim in the private manifest. */
  readonly customText?: string;
}

const BASELINE: StrategyDefinition = {
  id: "baseline",
  name: "基线",
  status: "complete",
  summary:
    "不给任何打法建议。你已经知道规则、你的身份和你的胜利条件，剩下的自己判断。这是对照组：别的策略档加了什么，都要和这一档比才知道有没有用。",
  heuristics: [],
};

/**
 * High-level considerations, all optional, all conditional.
 *
 * Sourced from what experienced players discuss rather than from any
 * measurement — see `research/community-meta-sources.md`, which also records
 * that several primary threads could not be retrieved and marks the survey
 * incomplete. That is why this profile is a DRAFT.
 */
const COMMUNITY_META: StrategyDefinition = {
  id: "community-meta",
  name: "社区高阶考量",
  status: "draft",
  summary:
    "一些老玩家常谈的高阶考量，按身份和发言位置组织。**全部是可选的条件性做法，没有一条是规则**，标了「有争议」的更是连老玩家之间都没谈拢。你完全可以不照做。",
  heuristics: [
    /* ── Percival: the convention this profile was asked to carry ──────── */
    {
      id: "cm.percival-early-position",
      scope: { kind: "roles", roles: ["percival"] },
      reads: [
        "role",
        "position.speakingOrder",
        "position.alreadySpoken",
        "position.missionNumber",
      ],
      when: "你是派西维尔，而且这一轮你发言很靠前（前面几乎没人说过话），现在还是第一轮",
      consider:
        "早早公开自己的身份，给好人一个立刻能用的公开锚点，也压缩莫甘娜前两轮的操作空间。代价是把梅林的候选范围从六个好人缩到两个人，等于替刺客做了一次筛选",
      disputed: true,
      provenance: "community-meta-sources.md：知乎与 BGG 都以「是否可行」在讨论，无共识",
    },
    {
      id: "cm.percival-late-position",
      scope: { kind: "roles", roles: ["percival"] },
      reads: [
        "role",
        "position.alreadySpoken",
        "position.standingClaims",
        "position.speakingOrder",
      ],
      when: "你是派西维尔，而且这一轮你发言很靠后，上游已经有人说过话、甚至已经有人声称了身份",
      consider:
        "先听完再决定。靠后的位置多出来的是信息：谁已经跳了、谁在替谁说话，都能改变你要不要跳、要不要对跳",
      disputed: true,
      provenance: "community-meta-sources.md：同上",
    },
    {
      id: "cm.claim-is-always-a-choice",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "position.missionNumber", "knowledge"],
      when: "你在考虑要不要公开声称一个身份",
      consider:
        "跳、不跳、拖一轮再跳、对跳别人、跳完再反跳、一直藏着 —— 全部是合法选项，没有哪一条是义务",
      disputed: false,
    },
    {
      id: "cm.counterclaim",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "knowledge", "role"],
      when: "有人声称了一个只可能有一个人的身份，而你有理由认为他不是",
      consider:
        "对跳会把矛盾摆到台面上，逼全桌二选一。它也可能正是对面想要的：你一站出来，两个候选就都暴露了",
      disputed: true,
      provenance: "community-meta-sources.md：坏人对跳划不划算，没找到共识",
    },

    /* ── Merlin ────────────────────────────────────────────────────────── */
    {
      id: "cm.merlin-usefulness-costs-safety",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "position.missionNumber"],
      when: "你是梅林，正在想要不要把话说得更明白一点",
      consider:
        "说得越有用，越容易被认出来。这是这个身份本身的取舍，不是你哪里做错了 —— 你要在「让好人走对」和「活过刺杀」之间自己定位置",
      disputed: false,
      provenance: "community-meta-sources.md：avalon-game.com wiki，多处一致",
    },
    {
      id: "cm.merlin-support-rather-than-lead",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "publicLog", "position.alreadySpoken"],
      when: "你是梅林，而且已经有别人说到点子上了",
      consider:
        "顺着他说，而不是自己一直抛新观点。一个总是第一个说对的人很好认",
      disputed: true,
      provenance: "community-meta-sources.md：有人主张前期干脆少说，分歧在「多主动」",
    },

    /* ── The evil side, role-aware ─────────────────────────────────────── */
    {
      id: "cm.mordred-clean-position",
      scope: { kind: "roles", roles: ["mordred"] },
      reads: ["role", "publicLog", "position.missionTrack"],
      when: "你是莫德雷德",
      consider:
        "唯一有视野的好人认不出你，所以你可以站在比队友干净得多的位置上说话。但这个优势只活在你的票和你发的车还站得住的时候",
      disputed: false,
    },
    {
      id: "cm.oberon-blind-risk",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "position.proposedTeam", "position.teamSizeThisMission"],
      when: "你是奥伯伦，正在发车或者要投票",
      consider:
        "你不知道谁是同伴，所以你做的每一件事都可能砸到自己人。把这一点算进去，别把一辆本来会崩的车投掉",
      disputed: false,
    },
    {
      id: "cm.evil-blend-early",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "position.missionNumber", "publicLog"],
      when: "你是坏人，还在前期",
      consider:
        "前期信息少，谁都说不清楚，这时候最容易混过去；等到后面每个人的历史都被翻出来对照，改口的成本会高得多",
      disputed: true,
    },

    /* ── Position and turn order ───────────────────────────────────────── */
    {
      id: "cm.speaking-position",
      scope: { kind: "all" },
      reads: ["position.speakingOrder", "position.alreadySpoken", "seat"],
      when: "轮到你说话，而你在这一轮的顺序里位置靠前或者靠后",
      consider:
        "靠前的人定调，说什么会被后面所有人拿来当参照；靠后的人信息多，但说什么都容易被当成「跟着风向走」。位置不同，同一句话的分量不一样",
      disputed: true,
    },
    {
      id: "cm.distance-to-leading",
      scope: { kind: "all" },
      reads: ["position.seatsUntilILead", "position.rejectionStreak", "position.attempt"],
      when: "你在算这一轮还轮不轮得到你发车",
      consider:
        "轮不到的话，你现在这一票就是你这一轮全部的影响力，可以据此决定要不要把它花在表态上",
      disputed: false,
    },
    {
      id: "cm.votes-versus-words",
      scope: { kind: "all" },
      reads: ["publicLog", "position.standingClaims"],
      when: "有人的说法和他之前的投票对不上",
      consider:
        "很多人认为票比话更能说明问题，因为投票有代价而说话没有。也有人提醒老练的对手正是用票在买信誉 —— 两边都听听",
      disputed: true,
      provenance: "community-meta-sources.md：常见说法，同时也被质疑",
    },

    /* ── 1. What a failed mission does and does not prove ──────────────── */
    {
      id: "cm.failed-team-is-a-constraint-not-a-verdict",
      scope: { kind: "all" },
      reads: ["position.missionTrack", "position.fails", "publicLog"],
      when: "有一轮车挂了，你在想车上那几个人怎么办",
      consider:
        "把它当成一个约束条件而不是一份判决：这辆车上**至少有一个**坏人，仅此而已。车上其他人既没有被证明是坏人，也没有被洗清 —— 直接把整车打成坏人，和直接放过整车，是同一种错误的两个方向",
      disputed: false,
    },
    {
      id: "cm.compare-failed-teams",
      scope: { kind: "all" },
      reads: ["position.missionTrack", "position.fails", "publicLog"],
      when: "已经挂了不止一轮，两辆挂掉的车成员不完全一样",
      consider:
        "把两辆车的**交集**和**差集**分开看。交集里的人同时满足两个约束，差集里的人只满足一个。这比「上过挂车的都可疑」能分出更细的层次",
      disputed: false,
    },
    {
      id: "cm.keep-multiple-hypotheses",
      scope: { kind: "all" },
      reads: ["memory", "position.missionTrack", "publicLog"],
      when: "你在心里给某个人下结论",
      consider:
        "同时留着几套说得通的解释，而不是过早锁死一个。「如果 A 是坏人，那这些票怎么解释」和「如果 B 是坏人呢」两条线并行推，往往比死磕一条更快收敛",
      disputed: false,
    },

    /* ── 2. Voting after a failure ─────────────────────────────────────── */
    {
      id: "cm.reject-without-a-perfect-alternative",
      scope: { kind: "all" },
      reads: ["position.proposedTeam", "position.rejectionStreak", "position.fails"],
      when: "你觉得这辆车有风险，但一时想不出一套完美的替代阵容",
      consider:
        "想不出更好的车，本身并不是上这辆车的理由。给替代方案能让你的反对更有说服力，但它不是投反对票的前提条件",
      disputed: false,
    },
    {
      id: "cm.rejection-streak-and-the-hammer",
      scope: { kind: "all" },
      reads: ["position.rejectionStreak", "position.attempt", "position.missionNumber"],
      when: "这一轮已经否过几次车了，你在算还能不能再否",
      consider:
        "把「连否几次」和「这是不是最后一次提案」当成两件独立的事来算。普通提案否掉只是换个队长，最后一次提案的性质完全不同 —— 这两种局面下同一张反对票的代价差得很远",
      disputed: false,
    },
    {
      id: "cm.raise-the-bar-after-failures",
      scope: { kind: "all" },
      reads: ["position.fails", "position.successes", "position.proposedTeam"],
      when: "已经挂了不止一轮，现在又来了一辆你说不清楚的车",
      consider:
        "在这种局面下要求更强的理由再上票，而不是沿用前面几轮的标准。前面挂过说明之前的判断标准放行了坏人，同一套标准再用一次没有理由指望不同结果",
      disputed: false,
    },

    /* ── 3. Minority dissent ───────────────────────────────────────────── */
    {
      id: "cm.correct-dissent-deserves-a-look",
      scope: { kind: "all" },
      reads: ["publicLog", "position.missionTrack"],
      when: "有人在某辆车挂之前就投了反对票",
      consider:
        "值得回头看看他当时给的理由。在结果出来之前反对，和事后说「我早就觉得不对」是两回事 —— 前者是能查证的公开记录",
      disputed: false,
    },
    {
      id: "cm.correct-dissent-is-evidence-not-proof",
      scope: { kind: "all" },
      reads: ["publicLog", "position.standingClaims"],
      when: "有人反对过一辆后来挂掉的车，你在考虑要不要因此信他",
      consider:
        "这是证据，不是证明。坏人同样可以去反对一辆注定要挂的车来给自己买信誉 —— 尤其是当他知道车上有同伴、这车怎么都会挂的时候",
      disputed: true,
    },
    {
      id: "cm.address-the-dissent-explicitly",
      scope: { kind: "all" },
      reads: ["publicLog", "position.alreadySpoken", "position.speakingOrder"],
      when: "轮到你说话，前面已经有人提出了和多数意见不同的看法",
      consider:
        "正面回应那个具体论点 —— 说清楚你为什么接受或者不接受它 —— 而不是把当前多数派的说法再复述一遍。重复多数意见不产生新信息，也让少数派的判断没有机会被检验",
      disputed: false,
    },

    /* ── 4. The Percival candidate pair ────────────────────────────────── */
    {
      id: "cm.percival-pair-on-one-team",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "position.proposedTeam"],
      when: "你是派西维尔，而你看到的那两个候选人被放进了同一辆车",
      consider:
        "这辆车里一定有莫甘娜 —— 两个候选人里必有一个是。可以考虑强烈反对，同时掂量一下：反对得越明确，越等于告诉全桌你是派西维尔、以及那两个人是谁",
      disputed: false,
    },
    {
      id: "cm.percival-pair-split",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "position.proposedTeam", "publicLog"],
      when: "你是派西维尔，两个候选人一个在车上、一个不在",
      consider:
        "这一轮的结果会给你信息：车挂了，车上那个的嫌疑上升；车过了，也不能反过来洗清他。攒够几轮再动，比第一轮就表态可能更值",
      disputed: true,
    },

    /* ── 5. Merlin and the Lady ────────────────────────────────────────── */
    {
      id: "cm.merlin-lady-hunts-mordred",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "ladyResults", "position.ladyHolder"],
      when: "你是梅林，而且湖中女神在你手上",
      consider:
        "你看得见的坏人已经在你脑子里了，看不见的那个才是问题。验一个你还没定性的人，有机会把藏着的莫德雷德翻出来 —— 这是女神能给你、而你的身份给不了你的东西",
      disputed: false,
    },
    {
      id: "cm.merlin-lady-check-a-known-good",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "position.ladyHolder", "position.ladyChecksDone"],
      when: "你是梅林，拿着女神，正考虑验一个你已经知道是好人的人",
      consider:
        "这一验换不到新信息，但仍可能有别的价值：一次能兑现的公开宣称、或者把令牌送到你想让他拿的人手上。代价是放弃了这一次找莫德雷德的机会 —— 信息、可信度、令牌去向，三者自己权衡",
      disputed: true,
    },

    /* ── 6. The evil mission card ──────────────────────────────────────── */
    {
      id: "cm.fail-scores-but-narrows",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "position.proposedTeam", "position.missionTrack"],
      when: "你是坏人，人在车上，要出任务牌",
      consider:
        "踩下去能拿分，但也把公开怀疑收窄到这几个人身上；出成功能保住掩护，代价是这一轮白上。哪个更值取决于现在的比分和你后面还想不想被信任",
      disputed: true,
    },
    {
      id: "cm.multiple-evil-on-one-team",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "knowledge", "position.proposedTeam"],
      when: "你是坏人，而且你知道车上还有别的坏人",
      consider:
        "两张失败票和一张的效果一样是挂车，但公开信息完全不同 —— 全桌会立刻知道这车里至少有两个坏人。多出来的那张牌买不到额外的分，只卖掉了信息",
      disputed: false,
    },
    {
      id: "cm.last-mission-cover-stops-mattering",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "position.fails", "position.successes"],
      when: "你是坏人，再挂一轮就直接赢了",
      consider:
        "掩护是为了以后还能用，而如果没有以后，它就不值钱了。这时候藏身份的理由比前几轮弱得多",
      disputed: false,
    },
    {
      id: "cm.oberon-cards-without-teammates",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "position.proposedTeam", "position.failsRequiredThisMission"],
      when: "你是奥伯伦，人在车上要出牌",
      consider:
        "你不知道车上还有没有同伴，所以你既可能补上关键的一张，也可能和同伴一起踩出两张、白白暴露人数。没有队友信息这件事本身就要算进你的决定里",
      disputed: false,
    },

    /* ── 7. What each evil role is actually holding ────────────────────── */
    {
      id: "cm.morgana-ambiguity-and-its-cost",
      scope: { kind: "roles", roles: ["morgana"] },
      reads: ["role", "position.standingClaims", "publicLog"],
      when: "你是莫甘娜",
      consider:
        "派西维尔看到的是两个人，你是其中之一 —— 这份模糊是你的资源。但它是有时限的：一旦你的言行和另一个候选拉开差距，你就从「两个候选之一」变成了「那个明显假的」",
      disputed: false,
    },
    {
      id: "cm.assassin-tracks-the-consistently-right",
      scope: { kind: "roles", roles: ["assassin"] },
      reads: ["role", "publicLog", "position.missionTrack"],
      when: "你是刺客，在物色最后那一刀",
      consider:
        "留意谁反复给出后来被验证是对的判断，而且没有靠喊身份来取得地位。声音最大的人不一定是看得最清楚的人，而你要找的是后者",
      disputed: false,
    },
    {
      id: "cm.oberon-may-hit-his-own",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "publicLog", "position.proposedTeam"],
      when: "你是奥伯伦，正在公开怀疑某个人",
      consider:
        "那个人可能是你的同伴，而你没有办法知道。你打得越准，越有可能打到自己人 —— 把这个不确定性算进去，别把话说死",
      disputed: false,
    },

    /* ── 8. Building a coalition on the good side ──────────────────────── */
    {
      id: "cm.isolated-signal-needs-uptake",
      scope: { kind: "side", side: "good" },
      reads: ["publicLog", "position.speakingOrder", "position.alreadySpoken"],
      when: "你是好人，看对了一件事并且说了出来",
      consider:
        "一个没有人接的正确判断，在结果上和没说过差不多。你的判断要变成票才有用，而变成票需要后面的人接住它 —— 说的时候就可以想想怎么让人接得住",
      disputed: false,
    },
    {
      id: "cm.name-what-changed-your-mind",
      scope: { kind: "all" },
      reads: ["publicLog", "position.alreadySpoken"],
      when: "轮到你说话，前面已经有几个人表过态",
      consider:
        "点名说清楚是谁的哪一句改变了、或者没能改变你的判断。这既让你的推理可以被检验，也让全桌看得出哪些论点真的在流动、哪些只是在被复述",
      disputed: false,
    },
    {
      id: "cm.no-proof-is-not-approval",
      scope: { kind: "all" },
      reads: ["position.proposedTeam", "position.fails", "memory"],
      when: "你要投票，但你并没有指向任何人的确凿理由",
      consider:
        "把「我没有证据」和「我同意这辆车」分开。拿不出证据不等于这车安全 —— 不确定本身可以是投反对的理由，尤其在已经挂过车之后",
      disputed: false,
    },

    /* ── The Lady ──────────────────────────────────────────────────────── */
    {
      id: "cm.lady-target-passes-token",
      scope: { kind: "all" },
      reads: ["position.ladyHolder", "position.ladyHeldBy", "position.ladyChecksDone"],
      when: "你拿着湖中女神，正在挑验谁",
      consider:
        "验谁不只关系到你得到什么，也决定了令牌接下来落在谁手上 —— 被验的人会拿到它",
      disputed: false,
    },
    {
      id: "cm.lady-announcement-is-a-move",
      scope: { kind: "all" },
      reads: ["ladyResults", "position.ladyHolder", "publicLog"],
      when: "你验完了，要当众宣布",
      consider:
        "宣布本身是一步棋，不是汇报。说真话能建立可信度，说假话能保护别的东西，两条都合法 —— 但你之后的每句话都要和这次宣布对得上",
      disputed: false,
    },
  ],
};

/**
 * `expert-cognitive` — the M5 arm. Role, position, claim, mission and phase.
 *
 * THE DIVISION OF LABOUR WITH THE PROTOCOL LAYER, which is the whole reason
 * this profile looks different from `community-meta`:
 *
 *   `cognition/protocol.ts`   GENERAL reasoning discipline. Audit your
 *                             premises. Keep two worlds. Answer the strongest
 *                             dissent. Compare alternatives. Same fourteen
 *                             steps for every seat in every position, so it is
 *                             one cacheable constant.
 *
 *   HERE                      SITUATED expert judgement. What Percival does
 *                             when both candidates ride one team. What Merlin
 *                             owes when the Lady is in hand. When a second
 *                             fail card buys nothing.
 *
 * NOTHING IS SAID IN BOTH PLACES. `expert-cognitive.test.ts` asserts that —
 * duplicated instruction is not emphasis, it is two copies that will drift,
 * and the one in the cached layer would win by repetition.
 *
 * WHAT IS DIFFERENT FROM `community-meta`, beyond content: a few entries are
 * `obligation: true`. Those are not tactics — they are things a competent
 * player has NOTICED, and the cognition update has a field for each. Percival
 * may do whatever he likes about both candidates riding one team; he may not
 * fail to see it. Every obligation leaves the ACTION free.
 *
 * `baseline` and `community-meta` above are untouched and must stay that way:
 * they are the two arms Experiments 2 and 3 ran, their fingerprints are
 * recorded in shipped artifacts, and a byte here would invalidate both.
 */
const EXPERT_COGNITIVE: StrategyDefinition = {
  id: "expert-cognitive",
  name: "专家认知",
  status: "draft",
  summary:
    "按身份、发言位置、任务阶段组织的高阶考量。**打法全部可选** —— 标了「必须看到」的不是要你怎么做，" +
    "而是这个局面下一个称职的玩家不可能没注意到的事，你可以看到之后选择不管它。" +
    "通用的推理纪律不在这里，在思考流程那一层，两边不重复。",
  heuristics: [
    /* ── 派西维尔 ─────────────────────────────────────────────────────── */
    {
      id: "ec.percival-pair-standing",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "publicLog", "memory"],
      when: "你是派西维尔",
      consider:
        "把那两个候选当成一个持续维护的整体来看，而不是两个孤立的人。每一轮问自己：这一轮发生的事让哪一个更像梅林、哪一个更像莫甘娜，是哪个具体行为改变了它",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.percival-pair-same-team",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "position.proposedTeam"],
      when: "你的两个候选被放进同一辆车",
      consider:
        "这辆车里必然有莫甘娜 —— 这是你手上唯一的硬推论，不是猜测。**怎么处理完全由你决定**：强烈反对、用别的理由包装着反对、或者放行用结果换信息，都是专家线。要权衡的是反对得越明确、越等于自报身份并点出候选对",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.percival-early-claim-default",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "position.speakingOrder", "position.alreadySpoken", "position.missionNumber"],
      when: "你是派西维尔，第一轮，而且你发言位置靠前",
      consider:
        "**优先考虑直接跳派西维尔**。靠前的位置意味着你的声明会成为全桌的参照点，好人因此立刻有一个可用的锚，莫甘娜前两轮的操作空间也被压缩。这是一个强默认，不是照做不可的动作 —— 代价是把梅林的候选范围从六个好人缩到两个，等于替刺客做了一次筛选",
      disputed: true,
    },
    {
      id: "ec.percival-not-claiming-needs-a-plan",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "position.standingClaims", "position.missionNumber", "memory"],
      when: "你是派西维尔，而你决定这一轮不跳",
      consider:
        "不跳是合法的，但它需要一个替代方案而不是一个空白：你打算怎么在不公开身份的情况下组织好人、怎么继续用候选对、以及**什么条件出现你就会跳**。全程既不跳也没有替代计划，等于这个身份没有被使用",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.percival-do-not-rank-the-pair-publicly",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "publicLog"],
      when: "你要公开谈论那两个候选中的任何一个",
      consider:
        "不要在没有明确回报的情况下透露你觉得哪一个更像梅林。那等于直接给刺客指路。如果确实要用这个信息换东西，先想清楚换到的是什么",
      disputed: false,
    },

    /* ── 梅林 ─────────────────────────────────────────────────────────── */
    {
      id: "ec.merlin-two-sets",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "publicLog"],
      when: "你是梅林",
      consider:
        "「我看得见的坏人」和「我看不见的莫德雷德」是两个不同的集合。看得见的那几个已经在你脑子里了，真正的问题是剩下那个 —— 把还没定性的座位当成莫德雷德候选单独记着，随公开信息收窄",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.merlin-lady-searches",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "ladyResults", "position.ladyHolder"],
      when: "你是梅林，湖中女神在你手上",
      consider:
        "通常应该验一个还没定性的莫德雷德候选。验一个你已经知道是好人的、或者你本来就看得见的坏人，是允许的 —— 但那一验换不到新信息，所以要能说出它换到了什么：一次能兑现的公开宣称、或者把令牌送到你想让他拿的人手上",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.merlin-no-perfect-record",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "publicLog", "position.missionTrack"],
      when: "你是梅林，正在决定这一票怎么投",
      consider:
        "一个每次都投对、而且只有他每次都投对的人，刺客用投票记录就能找到。你需要一套传信计划和一套刺杀掩护 —— 有时顺着别人已经说对的话说，比自己再抛一个正确的新观点更安全",
      disputed: true,
    },

    /* ── 忠臣 ─────────────────────────────────────────────────────────── */
    {
      id: "ec.loyal-claims-stay-claims",
      scope: { kind: "side", side: "good" },
      reads: ["position.standingClaims", "publicLog"],
      when: "有人跳了身份、公布了验人结果，或者自称好人",
      consider:
        "记下「谁在什么时候说了什么」，然后继续把它当说法用。没有裁判记录支持的声称永远不会变成硬信息，哪怕说的人后来一直没被推翻",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.loyal-what-would-separate",
      scope: { kind: "side", side: "good" },
      reads: ["memory", "position.missionTrack", "publicLog"],
      when: "你同时留着两种以上说得通的坏人配置",
      consider:
        "明确说出**什么证据能把它们分开** —— 哪一辆车的结果、谁的哪一次表态。说不出区分条件的多种可能，和没有想过是一样的",
      disputed: false,
    },
    {
      id: "ec.loyal-weigh-the-minority",
      scope: { kind: "side", side: "good" },
      reads: ["publicLog", "position.alreadySpoken"],
      when: "桌上出现了和多数意见不同的具体理由",
      consider:
        "明确评估它，而不是绕过去。同时记住事前反对是证据不是证明 —— 坏人也可以反对一辆注定要挂的车来买信誉",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.loyal-reject-with-a-purpose",
      scope: { kind: "side", side: "good" },
      reads: ["position.proposedTeam", "position.fails", "position.rejectionStreak"],
      when: "你要投反对票",
      consider:
        "最好同时给出一套更安全的替代阵容、或者一个具体的信息目标（这一否想换到什么）。**拿不出替代方案本身不是上票的理由** —— 但拿得出会让你的反对真正能被别人接住",
      disputed: false,
    },

    /* ── 刺客 ─────────────────────────────────────────────────────────── */
    {
      id: "ec.assassin-ranked-list",
      scope: { kind: "roles", roles: ["assassin"] },
      reads: ["role", "publicLog", "position.missionTrack", "memory"],
      when: "你是刺客",
      consider:
        "从头到尾维护一个**有排序**的梅林候选名单。每次调整排序都要能指出是哪一条新的公开证据、或者哪一处解释变了 —— 说不出依据的排序变化，到最后一刀时也用不上",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.assassin-what-to-track",
      scope: { kind: "roles", roles: ["assassin"] },
      reads: ["role", "publicLog"],
      when: "你在观察谁可能是梅林",
      consider:
        "留意反复投对的票、说不出来源却读得很准的车、被别人保护的人、以及刻意的低调。声音最大的人不一定是看得最清楚的那个",
      disputed: false,
    },
    {
      id: "ec.assassin-two-jobs",
      scope: { kind: "roles", roles: ["assassin"] },
      reads: ["role", "position.successes", "position.fails"],
      when: "你是刺客，在权衡这一轮怎么打",
      consider:
        "赢任务和准备刺杀是两件事，有时会冲突：一个能立刻挂车的动作，可能同时毁掉你观察某个候选的机会。三挂已定的时候，全部注意力可以转到刺杀上",
      disputed: false,
    },

    /* ── 莫德雷德 / 莫甘娜 ─────────────────────────────────────────────── */
    {
      id: "ec.mordred-blind-spot-not-immunity",
      scope: { kind: "roles", roles: ["mordred"] },
      reads: ["role", "publicLog", "position.missionTrack"],
      when: "你是莫德雷德",
      consider:
        "唯一有视野的好人看不见你，所以你可以站在比队友干净得多的位置上。但盲区不是免疫 —— 你的票和你发过的车会以完全普通的方式暴露你",
      disputed: false,
    },
    {
      id: "ec.mordred-protect-or-separate",
      scope: { kind: "roles", roles: ["mordred"] },
      reads: ["role", "publicLog", "position.proposedTeam"],
      when: "你是莫德雷德，而你的队友正在被怀疑",
      consider:
        "保还是切。保错了一起沉，切早了失去队友 —— 而且你们之间没有沟通渠道，他不会知道你在做什么",
      disputed: true,
    },
    {
      id: "ec.morgana-ambiguity-has-a-clock",
      scope: { kind: "roles", roles: ["morgana"] },
      reads: ["role", "position.standingClaims", "publicLog"],
      when: "你是莫甘娜",
      consider:
        "派西维尔看到的是两个人，你是其中之一。这份模糊是你的资源，但它有时限 —— 一旦你的言行和另一个候选拉开差距，你就从「两个候选之一」变成「那个明显假的」",
      disputed: false,
    },

    /* ── 奥伯伦 ───────────────────────────────────────────────────────── */
    {
      id: "ec.oberon-no-coordination",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "position.proposedTeam", "publicLog"],
      when: "你是奥伯伦",
      consider:
        "你不知道队友是谁，**他们也不知道你是谁**。所以不要假设任何人会配合你，也不要像一个知道队友的坏人那样行动 —— 那种协调痕迹会把整个坏人组一起暴露",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.oberon-friendly-fire",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "publicLog", "position.proposedTeam"],
      when: "你是奥伯伦，正在公开怀疑某人或者要否掉一辆车",
      consider:
        "那个人可能是同伴，那辆车可能本来会挂。你打得越准，越有可能打到自己人。建立一套独立的掩护，而不是靠猜队友",
      disputed: false,
    },

    /* ── 坏人共通：任务牌 ─────────────────────────────────────────────── */
    {
      id: "ec.evil-compare-fail-and-success",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "position.proposedTeam", "position.successes", "position.fails"],
      when: "你是坏人，人在车上要出任务牌",
      consider:
        "**每一次都把踩和不踩摆出来比一遍**。踩能拿分但会把公开怀疑收窄到这几个人身上；出成功保住掩护但这一轮白上。哪个更值取决于当前比分、你现在的怀疑度、以及车上有几个你知道的坏人",
      disputed: false,
      obligation: true,
    },
    {
      id: "ec.evil-double-fail-leaks",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "knowledge", "position.proposedTeam"],
      when: "你是坏人，而且你知道车上还有别的坏人",
      consider:
        "两张失败票和一张一样是挂车，但公开信息完全不同：全桌会立刻知道这车里至少有两个坏人，而那条约束会成为他们之后所有推理的地基。多出来的那张牌买不到额外的分，只卖掉了信息。**这不是说只能踩一张** —— 没有沟通渠道，协调本身就有风险",
      disputed: true,
      obligation: true,
    },
    {
      id: "ec.evil-cover-expires",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "position.fails", "position.successes"],
      when: "你是坏人，再挂一轮就直接赢了",
      consider:
        "掩护是为了以后还能用，没有以后它就不值钱了。这时候藏身份的理由比前几轮弱得多",
      disputed: false,
    },

    /* ── 声称与位置（全员） ───────────────────────────────────────────── */
    {
      id: "ec.claiming-loyal-is-cheap",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "publicLog"],
      when: "有人自称忠臣，或者你在考虑自称忠臣",
      consider:
        "这是合法动作，但它**本身几乎不携带信息** —— 六个好人里有四个是忠臣，而任何人都能说这句话。它尤其不能用来自证：拿「我是忠臣所以我在车上只能出成」去切分约束，等于把一句免费的话当成硬前提",
      disputed: false,
    },
    {
      id: "ec.claim-is-a-choice",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "position.missionNumber", "knowledge"],
      when: "你在考虑要不要公开声称一个身份",
      consider:
        "跳、不跳、拖一轮再跳、对跳、跳完再反跳、一直藏着 —— 全是合法选项。区别不在于哪个正确，而在于你能不能说出这一个换到了什么",
      disputed: false,
    },
    {
      id: "ec.speaking-position",
      scope: { kind: "all" },
      reads: ["position.speakingOrder", "position.alreadySpoken", "position.seatsUntilILead"],
      when: "轮到你说话",
      consider:
        "靠前的人定调，说什么会被后面所有人当参照；靠后的人信息多，但说什么都容易被当成跟风。如果这一轮轮不到你发车，那你这一票就是你全部的影响力",
      disputed: false,
    },

    /* ── 任务阶段（全员） ─────────────────────────────────────────────── */
    {
      id: "ec.raise-the-bar-after-a-failure",
      scope: { kind: "all" },
      reads: ["position.fails", "position.successes", "position.proposedTeam"],
      when: "已经挂过车，现在又来了一辆说不清楚的车",
      consider:
        "提高上票门槛，而不是沿用之前的标准。挂过说明之前的标准放行了坏人，同一套标准再用一次没有理由指望不同结果",
      disputed: false,
    },
    {
      id: "ec.fifth-proposal-is-different",
      scope: { kind: "all" },
      reads: ["position.attempt", "position.rejectionStreak", "position.missionNumber"],
      when: "这一轮已经连否了好几次",
      consider:
        "把「连否了几次」和「这是不是最后一次提案」当成两件事算。前面几次否掉只是换个队长；最后一次否掉直接判负，同一张反对票的代价完全不同",
      disputed: false,
    },
    {
      id: "ec.decider-round",
      scope: { kind: "all" },
      reads: ["position.successes", "position.fails"],
      when: "比分是 2:2，这一轮定胜负",
      consider:
        "这一轮之后没有下一轮：好人这一票的门槛应该是全局最高的，坏人的掩护则贬到最低",
      disputed: false,
    },
  ],
};

/**
 * `expert-social` — everything `expert-cognitive` says, plus the table.
 *
 * WHY A NEW PROFILE AND NOT AN EDIT. `expert-cognitive`'s fingerprint is
 * recorded in a completed paid game's manifest. Adding one heuristic to it
 * would change that digest, and the artifact would then describe a profile that
 * no longer exists. So this one INHERITS the whole catalog by spreading it and
 * appends — `strategies.test.ts` asserts the inherited entries are the same
 * objects, so the two cannot quietly drift.
 *
 * WHAT THE PILOT SHOWED, and what each block below answers:
 *
 *   NOBODY LED.      Zero role claims in the whole game. Percival held the
 *                    candidate pair for seventeen decisions, wrote nearly the
 *                    same claim trigger each time, and used it once — to reject,
 *                    silently. Good never had a shared plan, so evil never had
 *                    to break one.
 *   NOBODY FOLLOWED. Explicit engagement with somebody else's argument fell
 *                    from 48% of speeches to 21%. Ten private analyses that
 *                    never meet lose to four coordinated players.
 *
 * WHAT IS DELIBERATELY NOT HERE. No entry says to trust a Percival claim
 * because it is a Percival claim, and none says a loyal seat must follow
 * anyone. Manufactured consensus is exactly what evil wants; the counter is a
 * table that can drop a leader, which is why `es.loyal-withdraw-trust` and
 * `es.evil-manufacture-consensus` sit in the same catalog.
 */
const EXPERT_SOCIAL: StrategyDefinition = {
  id: "expert-social",
  name: "专家认知 + 桌面协调",
  status: "draft",
  summary:
    "在专家认知的基础上，加上牌桌层面的东西：谁在带节奏、要不要跟、怎么让别人能跟你。" +
    "**打法全部可选** —— 标了「必须看到」的仍然只约束你看见什么，不约束你怎么做。" +
    "通用的推理纪律和「从私下判断到牌桌上的动作」那六步不在这里，在思考流程那一层。",
  heuristics: [
    ...EXPERT_COGNITIVE.heuristics,

    /* ── 派西维尔：从「持有信息」到「组织好人」 ─────────────────────── */
    {
      id: "es.percival-claim-buys-leadership",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "position.speakingOrder", "position.missionNumber", "position.leader"],
      when: "你是派西维尔，而且你在第一轮拿到了靠前发言位、首任队长、或者别的高影响力位置",
      consider:
        "**强烈倾向直接跳，而且跳的时候要带上可执行的东西**：你打算怎么处理那两个候选、第一辆车用谁或避开谁、大家该怎么投、以及有人对跳你会怎么办。只报一句「我是派西维尔」而不给方案，等于把身份卖了却什么都没买到。这仍然是强默认而不是规则 —— 不跳也合法，但见下一条",
      disputed: true,
    },
    {
      id: "es.percival-hiding-must-still-organise",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "position.missionNumber", "position.standingClaims", "memory"],
      when: "你是派西维尔，第一轮的任务已经结算，而你还没跳",
      consider:
        "到这时候要么跳、要么在桌上立一个你信得过的人当替代焦点、要么做一件用得上候选对但不暴露来源的具体协调动作（比如推一辆把两个候选分开的车）。三样一样都没有，这个身份就没被用过",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.percival-not-claiming-needs-a-fresh-reason",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "publicLog", "position.standingClaims", "memory"],
      when: "你是派西维尔，你决定这一轮仍然不跳",
      consider:
        "说出**这一轮的局面**带来的不跳理由，而不是重复上一轮写过的那句。局面变了理由就该变；一字不差地照抄上一轮的触发条件，说明这个决定其实没有被重新做过",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.percival-pair-same-team-crosses-a-line",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "position.proposedTeam", "position.missionNumber"],
      when: "你的两个候选被放进同一辆车，而且这辆车关系到胜负",
      consider:
        "除了那条硬推论本身，还要重新问一次跳不跳：现在你手上有一个别人给不出的具体结论，而沉默地投反对既救不了这一轮、也不会有人接住。要权衡的是这一车的分量和暴露的代价",
      disputed: true,
      obligation: true,
    },

    /* ── 忠臣：跟人，但随时能撤 ───────────────────────────────────────── */
    {
      id: "es.loyal-find-the-focal",
      scope: { kind: "side", side: "good" },
      reads: ["publicLog", "position.standingClaims", "position.alreadySpoken"],
      when: "桌上有人正在被当作参照 —— 跳了身份的、或者分析被反复引用的",
      consider:
        "明确判断他值不值得跟，依据是论证质量、前后一致性、任务史、票型、以及他之前说会发生的事有没有真的发生。**跳了派西维尔本身不是理由** —— 莫甘娜也会跳",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.loyal-follow-out-loud",
      scope: { kind: "side", side: "good" },
      reads: ["publicLog", "position.proposedTeam"],
      when: "你决定跟某个人的判断",
      consider:
        "在公开发言里**点名是谁、复述你接住的是他哪一条具体结论、并给出你这一票**。只说「我同意 X 号」不产生共同知识 —— 把那条结论再说一遍，它才会变成全桌能一起用的东西",
      disputed: false,
    },
    {
      id: "es.loyal-keep-an-exit",
      scope: { kind: "side", side: "good" },
      reads: ["memory", "position.missionTrack", "publicLog"],
      when: "你正在跟着某个人走",
      consider:
        "同时留一个撤退条件：什么结果、什么矛盾、什么没兑现的话会让你收回信任。说不出撤退条件的跟随不是判断，是把票交出去了",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.loyal-withdraw-trust",
      scope: { kind: "side", side: "good" },
      reads: ["publicLog", "position.missionTrack", "position.standingClaims"],
      when: "你之前跟的那个人身上出现了前后矛盾、他推的车挂了、他没兑现说过的话、或者他开始给出没有依据的确定结论",
      consider:
        "公开降低或收回信任，并说清是哪一条让你改的。坏人最想要的就是一个不会被撤换的焦点 —— 一张换不掉的椅子比坐在上面的人危险",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.loyal-two-leaders",
      scope: { kind: "side", side: "good" },
      reads: ["publicLog", "position.standingClaims", "position.tentativeTeams"],
      when: "桌上同时有两个人在争带节奏的位置，各自推不同的车",
      consider:
        "不要各打五十大板。找出两套说法真正分歧的那一条前提，说出**什么结果能把它们分开**，然后选一个方向 —— 好人分成两半僵住，坏人不需要做任何事就赢了第五案",
      disputed: false,
    },

    /* ── 梅林：支持焦点，但不要变成焦点 ───────────────────────────────── */
    {
      id: "es.merlin-back-a-leader",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "publicLog", "position.standingClaims"],
      when: "你是梅林，桌上有人正在带节奏而且方向大致对",
      consider:
        "支持他往往比自己再抛一个正确的新观点安全 —— 他的结论会变成全桌的，而刺客看到的是他在推理。要小心的是支持得太准：每次都恰好站对边，本身就是一条投票记录",
      disputed: true,
    },
    {
      id: "es.merlin-do-not-become-the-focal",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "publicLog", "position.speakingOrder"],
      when: "你是梅林，而桌子开始把你当参照",
      consider:
        "这是刺客最想看到的位置。可以把结论的来源推给公开记录、把功劳让给先说的人、或者主动引入一个你并不确定的比较 —— 但不要因此开始说错话，一个突然变蠢的焦点同样显眼",
      disputed: true,
    },

    /* ── 坏人：假焦点、拆联盟 ─────────────────────────────────────────── */
    {
      id: "es.morgana-claim-percival",
      scope: { kind: "roles", roles: ["morgana"] },
      reads: ["role", "position.standingClaims", "position.missionNumber"],
      when: "你是莫甘娜，而且还没有人跳派西维尔，或者已经有人跳了",
      consider:
        "跳派西维尔（或者对跳）是这个身份的核心手段之一：你在一个真候选对里，说得出细节。代价是从此你和真派西维尔只能活一个，而且真的那个知道你在撒谎。没人跳的时候先跳往往更强",
      disputed: true,
    },
    {
      id: "es.evil-endorse-a-false-leader",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "publicLog", "position.standingClaims"],
      when: "桌上有人正在成为焦点",
      consider:
        "捧一个方向对你有利的好人，往往比自己站出来带节奏便宜得多 —— 你不用承担被检验的风险，而他推的车里可以有你。要留意的是他随时可能推对",
      disputed: false,
    },
    {
      id: "es.evil-split-the-coalition",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "publicLog", "position.tentativeTeams", "position.rejectionStreak"],
      when: "好人正在围绕某个人形成一致的车",
      consider:
        "拆开它通常比正面反对有效：给出一个听起来更谨慎的替代车、放大两个好人之间已有的分歧、或者对焦点提一个他答不上来的具体问题。连否几次之后第五案的强制通过对你也是资源",
      disputed: false,
    },
    {
      id: "es.evil-manufacture-consensus",
      scope: { kind: "side", side: "evil" },
      reads: ["side", "position.proposedTeam", "publicLog"],
      when: "你想让一辆对你有利的车过掉",
      consider:
        "让它看起来像是桌面共识：早一点表态、引用别人的话当作支持、把反对说成拖延。但共识越是被你推着走，一旦这辆车挂了，回头去数谁推过它的人就越容易找到你",
      disputed: false,
    },

    /* ── 全员：焦点是位置，不是人 ─────────────────────────────────────── */
    {
      id: "es.focal-is-a-position",
      scope: { kind: "all" },
      reads: ["publicLog", "position.standingClaims"],
      when: "牌桌上出现了一个大家都在参照的人",
      consider:
        "那是一个**位置**，不是一种身份。忠臣、梅林、甚至莫甘娜都可能坐在上面，而且它可以易主。真正该跟踪的是「现在谁坐在这里、凭的是哪条公开记录、什么会让他下来」",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.minority-that-was-right",
      scope: { kind: "all" },
      reads: ["publicLog", "position.missionTrack", "position.fails"],
      when: "一辆车挂了，而之前有人给出过具体理由反对它",
      consider:
        "他这一轮的分量应该上升，而且值得让他来组下一辆车。但要分清「他反对过」和「他反对的理由成立」—— 坏人也会反对一辆注定要挂的车来买信誉，区别在于当时给的理由现在还站不站得住",
      disputed: false,
      obligation: true,
    },
    {
      id: "es.fifth-proposal-changes-following",
      scope: { kind: "all" },
      reads: ["position.attempt", "position.rejectionStreak", "position.proposedTeam"],
      when: "已经连否到最后一次提案",
      consider:
        "这一票不再是「我信不信这辆车」，而是「这辆车和直接判负比，哪个更差」。跟或不跟一个焦点的代价在这里完全不同 —— 之前跟着他反对是便宜的，现在不是",
      disputed: false,
    },
  ],
};

/**
 * `expert-claim-contest` — everything `expert-social` says, plus the fight.
 *
 * WHY A FOURTH PROFILE. Three fingerprints are already recorded in shipped
 * artifacts, and `expert-social` is what an unrun M5.1 pilot is specified
 * against. Adding an entry to any of them would make a recorded arm describe a
 * profile that no longer exists. So this one SPREADS `expert-social` — which
 * itself spreads `expert-cognitive` — and appends.
 *
 * THE CORRECTION THIS PROFILE CARRIES. `expert-social` assumes the table can
 * find a focal player. Strong early play often has no single one: several seats
 * claim or imply Percival at once and compete for the table's authority. Every
 * role can do it, for different reasons and off different information, so the
 * entries below are organised by ROLE and each names both what the claim buys
 * and what it costs.
 *
 * TWO THINGS ARE DELIBERATELY NOT SAID ANYWHERE HERE:
 *
 *   NOT "a claim is evidence of a role", in either direction. Every entry that
 *   touches a claim treats it as a MOVE with a price.
 *   NOT "attacking a rival means calling them evil". `ecc.attack-is-not-an-accusation`
 *   is explicit about the difference, and it is the difference that lets a true
 *   Percival fight a Loyal servant's cover claim without burning a good seat.
 *
 * OBERON gets a `reads` list without `knowledge` on its contest entries, and the
 * leakage suite checks the rendered text: nothing here can hand him teammates he
 * does not have.
 */
const EXPERT_CLAIM_CONTEST: StrategyDefinition = {
  id: "expert-claim-contest",
  name: "专家认知 + 桌面协调 + 派权争夺",
  status: "draft",
  summary:
    "在专家认知与桌面协调的基础上，加上派权争夺：谁在自称派西维尔、怎么比、要不要进场、进场之后怎么打。" +
    "**任何身份都可以声称任何身份**，下面按身份列出各自跳派的收益与代价。" +
    "**打法全部可选** —— 标了「必须看到」的仍然只约束你看见什么，不约束你怎么做。",
  heuristics: [
    ...EXPERT_SOCIAL.heuristics,

    /* ── 全员：这个场是怎么回事 ───────────────────────────────────────── */
    {
      id: "ecc.anyone-can-claim",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "publicLog"],
      when: "桌上出现自称派西维尔的人",
      consider:
        "**任何身份都可以说这句话** —— 真派西维尔、莫甘娜、梅林、忠臣、刺客、莫德雷德、奥伯伦，动机各不相同。所以「有人跳派」本身不携带信息，携带信息的是他跳的时机、他讲的候选对、以及之后他的车和票对不对得上",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.compare-do-not-poll",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "publicLog", "position.missionTrack"],
      when: "同时有两个或更多人站在同一个身份上",
      consider:
        "把他们**放在一起比**，而不是一个一个单独打分。可比的东西全是公开的：谁先说的、谁是对跳的、候选对前后一致吗、发过什么车、怎么投的、任务结果打没打脸、说会发生的事发生了吗、被质疑时答不答、给的建议能不能执行。跟着他的人是在复述证据，还是只在造声势",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.attack-is-not-an-accusation",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "publicLog"],
      when: "你要削弱某个声称者的可信度",
      consider:
        "**打声称和指认坏人是两个动作。** 指出时机不对、故事对不上、票和话不一致 —— 这些只说明「这个声称站不住」，不说明他是坏人：一个编了掩护故事又被戳穿的忠臣，声称是碎的、人是好的。直接指认代价大得多，而且打错一个好人比放过一个坏人更贵",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.propose-a-distinction-test",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "position.proposedTeam", "position.missionNumber"],
      when: "两个声称者的说法你分不开",
      consider:
        "给一个**公开检验**：一辆车、一次投票、一个具体问题，结果出来之后全桌能看出谁说对了。分不开又不给检验，等于把判断推给下一轮而下一轮同样分不开",
      disputed: false,
    },
    {
      id: "ecc.claim-timing-and-position",
      scope: { kind: "all" },
      reads: [
        "position.speakingOrder",
        "position.alreadySpoken",
        "position.missionNumber",
        "position.attempt",
        "position.standingClaims",
      ],
      when: "你在决定这一轮跳不跳、或者在评估别人跳的时机",
      consider:
        "位置改变的是这一手的性质，不只是语气：靠前跳是在**定调**，全桌之后都拿它当参照；靠后跳是在**比较之后进场**，你看过前面所有人怎么说；对跳是在**挑战一个已经成立的框架**；已经挂过一轮之后跳，你手上多了结果可以用；第五案之前跳，你要的是这一票不是长期权威",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.retraction-is-a-move",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "publicLog", "position.missionTrack"],
      when: "有人退水，或者你在考虑退水",
      consider:
        "退水**不删除任何东西**：原来声称过什么、什么时候、推过什么车、踩过谁，全都留在公开记录里。判断一次退水要看它换到了什么 —— 制造了有用信息、保住了别人、试了反应、躲开了一个即将成立的矛盾、还是撑不住了。**退水既不自动加分也不自动减分**",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.followers-repeat-evidence",
      scope: { kind: "all" },
      reads: ["publicLog", "position.standingClaims"],
      when: "有人在公开支持某个声称者",
      consider:
        "区分「复述了他的具体依据」和「只是表态站他」。前者让那条依据变成全桌能用的东西，后者只制造声势 —— 而声势正是坏人最便宜的资源",
      disputed: false,
    },
    {
      id: "ecc.reject-all-claimants-still-needs-a-plan",
      scope: { kind: "all" },
      reads: ["position.standingClaims", "position.proposedTeam"],
      when: "你觉得场上没有一个声称者可信",
      consider:
        "那也要给出替代方案：一套自己的比较办法、或者一辆按公开记录组出来的车。谁都不信而且什么都不提，等于把桌子交给声音最大的人",
      disputed: false,
    },

    /* ── 真派西维尔：进场、打下去 ─────────────────────────────────────── */
    {
      id: "ecc.percival-claim-tradeoff",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "position.speakingOrder", "position.missionNumber"],
      when: "你是派西维尔，在权衡跳不跳",
      consider:
        "换到的：把候选对变成公开的组织依据、给好人一个锚点、不让莫甘娜独占这个身份、把你的私有信息变成能执行的车和票。付出的：暴露你在保哪一边、帮刺客把梅林范围缩到两个人、被一个说早了的故事绑住、以及可能被几个对跳同时冲",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.percival-fight-the-rival",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "position.standingClaims", "publicLog", "position.proposedTeam"],
      when: "你是派西维尔，而且已经跳了，桌上出现了另一个自称派西维尔的人",
      consider:
        "**他抢的是你的权威，不是在发表平行意见。** 通常应该正面争：打他的时机、打他的候选对故事、打他的声称和他的车票结果之间的矛盾、或者逼一个能分开你们的检验。「打」是削弱他的可信度和领导权 —— 不等于断定他是坏人，也确实可能是一个好人在给别人做掩护",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.percival-delay-needs-a-recovery-plan",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "position.standingClaims", "position.missionNumber", "memory"],
      when: "你是派西维尔，场上有竞争者，而你决定先不正面冲",
      consider:
        "拖是合法的，但它需要四样东西而不是一句「再看看」：为什么**现在**拖更好、你在拉谁进你这一边、**具体什么事件**会让你动手、以及在他拿下一辆决定性的车之前你怎么把话语权拿回来。一句和上一轮一样的拖延理由，说明这个决定没有被重新做过",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.percival-claim-must-be-actionable",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "knowledge", "position.proposedTeam", "position.leader"],
      when: "你是派西维尔，这一次发言你要跳",
      consider:
        "带上可执行的东西：候选对怎么处理、这一辆车用谁或避开谁、大家该怎么投、以及有人对跳你打算怎么办。只报身份不给方案，等于把信息卖了却没换到组织权",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.percival-proxy-instead-of-self",
      scope: { kind: "roles", roles: ["percival"] },
      reads: ["role", "publicLog", "position.standingClaims"],
      when: "你是派西维尔，正面冲会把梅林的范围暴露得更清楚",
      consider:
        "可以扶一个信得过的人去打那个竞争者，自己留在后面。代价是你要把判断依据交给他，而他不一定用得对",
      disputed: true,
    },

    /* ── 莫甘娜 ───────────────────────────────────────────────────────── */
    {
      id: "ecc.morgana-claim-tradeoff",
      scope: { kind: "roles", roles: ["morgana"] },
      reads: ["role", "position.standingClaims", "position.missionNumber", "publicLog"],
      when: "你是莫甘娜，在权衡跳不跳派西维尔",
      consider:
        "换到的：你本来就在真候选对里，说得出细节；抢在真派前面跳能占住这个身份、逼他表态、把桌子往梅林或者不安全的车上带、还能把好人劈成两半。付出的：你的票和任务史随时可能和你讲的视角对不上；打真派打得太狠会露出坏人的味道；编错的候选对故事以后会塌；而且太焦点会毁掉长期掩护",
      disputed: false,
      obligation: true,
    },
    {
      id: "ecc.morgana-many-lines",
      scope: { kind: "roles", roles: ["morgana"] },
      reads: ["role", "position.standingClaims", "position.missionTrack"],
      when: "你是莫甘娜，场上已经有人跳了派西维尔",
      consider:
        "先跳、对跳、防守、退水、或者干脆去捧另一个假焦点 —— 全都是真实存在的线，没有哪一条是标准答案。选的依据是你的公开记录还撑得住哪一种",
      disputed: true,
    },

    /* ── 梅林 ─────────────────────────────────────────────────────────── */
    {
      id: "ecc.merlin-claim-tradeoff",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "position.standingClaims", "publicLog"],
      when: "你是梅林，在考虑跳派西维尔",
      consider:
        "换到的：替真派西维尔挡一层、给刺客造一个假目标、用你的信息去支持好人联盟、或者去挑一个危险的假派。付出的：你读得太准会直接暴露；候选对怎么讲很容易说漏；和真派抢会把好人票劈开；而且刺客本来就会把「跳派」当成一种掩护行为来看",
      disputed: true,
    },
    {
      id: "ecc.merlin-claim-needs-a-cover-plan",
      scope: { kind: "roles", roles: ["merlin"] },
      reads: ["role", "knowledge", "publicLog"],
      when: "你是梅林，而你决定跳派西维尔",
      consider:
        "同时维护一套刺杀掩护：你讲的候选对不能正好是你真看见的坏人组合，你的判断也不能每一次都对。一个信息完美的派西维尔就是一个梅林",
      disputed: false,
      obligation: true,
    },

    /* ── 忠臣 ─────────────────────────────────────────────────────────── */
    {
      id: "ecc.loyal-claim-tradeoff",
      scope: { kind: "side", side: "good" },
      reads: ["side", "role", "position.standingClaims", "publicLog"],
      when: "你是忠臣，在考虑跳派西维尔",
      consider:
        "换到的：给真派和梅林当掩护、自己去当一个可以被牺牲的焦点、把火力引到自己身上、或者逼场上的声称者把故事讲清楚。付出的：**你手上没有候选对**，编出来的故事以后可能被任何一条公开记录打穿；你还可能把好人票劈开，甚至压过真派西维尔的领导权。所以值得先问清楚这一跳的具体掩护或组织目的是什么 —— 说不出目的的跳不是免费的噪音，是在劈好人的票",
      disputed: true,
      obligation: true,
    },
    {
      id: "ecc.loyal-fake-pair-costs",
      scope: { kind: "side", side: "good" },
      reads: ["side", "position.standingClaims", "position.missionTrack"],
      when: "你是好人，而你打算讲一个自己没有的候选对",
      consider:
        "编之前先想它以后要对上什么：任务结果、票型、别人跳出来的对跳。编不圆的故事会在最需要你可信的那一轮塌掉",
      disputed: false,
    },

    /* ── 刺客 ─────────────────────────────────────────────────────────── */
    {
      id: "ecc.assassin-claim-tradeoff",
      scope: { kind: "roles", roles: ["assassin"] },
      reads: ["role", "position.standingClaims", "publicLog"],
      when: "你是刺客，在考虑跳派西维尔",
      consider:
        "换到的：逼真派西维尔和梅林做出反应，而反应本身就是刺杀情报；顺手占住领导权；制造一个假的对比。付出的：你会失去低调观察的位置；可能露出坏人之间的协调痕迹；要维护一个假的候选对故事；而且公开带节奏和赢任务经常打架",
      disputed: true,
    },
    {
      id: "ecc.assassin-keep-two-books",
      scope: { kind: "roles", roles: ["assassin"] },
      reads: ["role", "position.successes", "position.fails", "publicLog"],
      when: "你是刺客，场上正在争派权",
      consider:
        "赢任务和找梅林是两本账，这一手不一定同时有利。派权争夺里谁在保谁、谁在替谁挡刀，是最好的一批梅林线索 —— 但拿到它的代价可能是这一辆车",
      disputed: false,
      obligation: true,
    },

    /* ── 莫德雷德 ─────────────────────────────────────────────────────── */
    {
      id: "ecc.mordred-claim-tradeoff",
      scope: { kind: "roles", roles: ["mordred"] },
      reads: ["role", "position.standingClaims", "position.missionTrack"],
      when: "你是莫德雷德，在考虑跳派西维尔",
      consider:
        "换到的：唯一有视野的好人看不见你，所以你的公开记录可以很干净，很适合当一个可信的假焦点。付出的：你放弃了「待在盲区里」这件事本身的价值；你要维护一个说得通的私有信息故事；而且一个被打穿的声称会把一个战略价值很高的坏人身份暴露掉",
      disputed: true,
    },

    /* ── 奥伯伦 ───────────────────────────────────────────────────────── */
    {
      id: "ecc.oberon-claim-tradeoff",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "position.standingClaims", "publicLog"],
      when: "你是奥伯伦，在考虑跳派西维尔",
      consider:
        "换到的：制造独立的混乱、劈开好人联盟、占住或者去打一个焦点位。付出的：**你不知道队友是谁**，所以你可能正在打自己人，也可能正在替真派西维尔挡刀；而且你手上编故事的材料是全场最少的",
      disputed: true,
      obligation: true,
    },
    {
      id: "ecc.oberon-claim-does-not-buy-information",
      scope: { kind: "roles", roles: ["oberon"] },
      reads: ["role", "position.standingClaims"],
      when: "你是奥伯伦，而你跳了或者打算跳",
      consider:
        "跳这一下**不会让你知道任何队友**。别人的反应也不能当成队友信号来读 —— 一个坏人配合你的样子和一个好人被你说服的样子，在公开层面上是一样的",
      disputed: false,
      obligation: true,
    },
  ],
};

export const STRATEGIES: Readonly<Record<CatalogStrategyId, StrategyDefinition>> =
  Object.freeze({
    baseline: BASELINE,
    "community-meta": COMMUNITY_META,
    "expert-cognitive": EXPERT_COGNITIVE,
    "expert-social": EXPERT_SOCIAL,
    "expert-claim-contest": EXPERT_CLAIM_CONTEST,
  });

export const CATALOG_IDS: readonly CatalogStrategyId[] = [
  "baseline",
  "community-meta",
  "expert-cognitive",
  "expert-social",
  "expert-claim-contest",
];

export function strategyById(id: CatalogStrategyId): StrategyDefinition {
  const strategy = STRATEGIES[id];
  if (!strategy) throw new Error(`unknown strategy: ${id}`);
  return strategy;
}

/**
 * A user-supplied strategy.
 *
 * Treated as CONFIGURATION: it goes into the private research trace verbatim
 * so a result can be traced to the exact words that produced it. It is not
 * validated for content — that is the experimenter's call — but it is still
 * rendered inside the "these are options, not rules" frame, because a custom
 * profile that read as a rulebook would break the same comparison the drafts
 * are careful about.
 */
export function makeCustomStrategy(text: string, name = "自定义"): StrategyDefinition {
  return {
    id: "custom",
    name,
    status: "draft",
    summary: "由实验者提供，原文记录在运行清单里。",
    heuristics: [],
    customText: text,
  };
}

/**
 * Does this consideration apply to the seat reading it?
 *
 * Reads ONLY `observation.role` and `observation.side` — both facts the seat
 * already holds about itself. Nothing about any other seat can reach this
 * function, so the rendered text cannot carry information the seat is not
 * entitled to. `strategies.leak.test.ts` proves that by construction rather
 * than by inspection.
 */
export function heuristicApplies(heuristic: Heuristic, observation: Observation): boolean {
  const scope = heuristic.scope ?? { kind: "all" };
  switch (scope.kind) {
    case "all":
      return true;
    case "roles":
      return scope.roles.includes(observation.role);
    case "side":
      return scope.side === observation.side;
  }
}

/** The considerations one seat actually sees, in catalog order. */
export function applicableHeuristics(
  strategy: StrategyDefinition,
  observation: Observation,
): readonly Heuristic[] {
  return strategy.heuristics.filter((h) => heuristicApplies(h, observation));
}

/**
 * A stable fingerprint of a strategy profile, for the private trace.
 *
 * Hashes the FULL rendered catalog — every heuristic, whatever any one seat
 * happens to see — plus the id, name and each entry's disputed flag. Two runs
 * claiming the same profile either produce the same digest or they were not
 * running the same profile, and a paired comparison that quietly changed one
 * arm between games is exactly the failure this exists to make visible.
 *
 * `provenance` is excluded, for the same reason it is never rendered: it is a
 * note to a human reviewer, and editing one must not look like a changed
 * experiment.
 */
export function strategyFingerprint(strategy: StrategyDefinition): string {
  const material = JSON.stringify({
    id: strategy.id,
    name: strategy.name,
    status: strategy.status,
    summary: strategy.summary,
    customText: strategy.customText ?? null,
    heuristics: strategy.heuristics.map((h) => ({
      id: h.id,
      scope: h.scope ?? { kind: "all" },
      reads: h.reads,
      when: h.when,
      consider: h.consider,
      disputed: h.disputed,
      // Only serialised when present. `community-meta` and `baseline` have no
      // obligations, so adding the field leaves their digests untouched —
      // asserted by `strategies.test.ts`, because two shipped artifacts record
      // those exact digests.
      ...(h.obligation ? { obligation: true } : {}),
    })),
    rendered: renderStrategy(strategy),
  });
  return createHash("sha256").update(material).digest("hex");
}


/**
 * Layer 6 as it reaches the model. `provenance` is deliberately absent.
 *
 * With an observation, role-specific considerations are filtered to the seat
 * that can act on them; without one, the whole catalog renders — which is what
 * a documentation dump or a fingerprint of the full profile wants.
 */
export function renderStrategy(
  strategy: StrategyDefinition,
  observation?: Observation,
): string {
  const lines = [
    `## 六、策略档：${strategy.name}（${strategy.status === "complete" ? "已定稿" : "草稿"}）`,
    "",
    strategy.summary,
  ];

  if (strategy.customText) {
    lines.push("", "实验者给你的说明：", "", strategy.customText);
  }

  const heuristics = observation
    ? applicableHeuristics(strategy, observation)
    : strategy.heuristics;

  if (heuristics.length > 0) {
    lines.push(
      "",
      "下面是一些**可以考虑**的做法。它们不是规则，不照做也完全合法；",
      "标了「有争议」的，是老玩家之间本来就没谈拢的打法，更要自己判断。",
      "",
    );
    for (const h of heuristics) {
      const suffix = h.disputed ? "（有争议）" : "";
      if (h.obligation) {
        // Phrased as seeing, never as doing: "must notice", not "must do".
        lines.push(`- **【必须看到】**当${h.when}时：${h.consider}。${suffix}`);
      } else {
        lines.push(`- 当${h.when}时，可以考虑${h.consider}。${suffix}`);
      }
    }
  } else if (!strategy.customText) {
    lines.push("", "（这一档不给任何具体做法。）");
  }

  return lines.join("\n");
}
