/**
 * The disclosure rules, as prompt text.
 *
 * TWO LAYERS, and the split is the same one the rest of the stack uses. The
 * separation rule carries no seat, no role and no game state, so it sits in
 * the cached system prefix and costs one prefix for a whole game. The
 * role-specific rules vary by role only — the same text for every Percival in
 * every game — so they join layer 4, which already varies that way and only
 * that way.
 *
 * WHAT THESE RULES ARE NOT. They are not the mechanism. A rule in a prompt is
 * a request, and the M5.2 pilot is the proof: `ec.percival-do-not-rank-the-
 * pair-publicly` shipped in that game's strategy profile, the seat read it,
 * and the seat published 「7、9一梅林一莫甘娜」 twice anyway. The mechanism is
 * `spokesperson.ts` — the seat that writes the public sentence is never handed
 * the pair. These rules exist so the PLANNER understands why its intent is
 * shaped the way it is, and so a human reading a transcript can see what was
 * asked for.
 *
 * The wording deliberately keeps every ACTION free. Percival may claim, may
 * stay hidden, may reject a team, may attack a rival, may run a distinction
 * test. What is closed is one channel: copying a private value into a public
 * sentence. That is the difference between a rule that removes a leak and a
 * rule that removes the thing being studied.
 */

import type { RoleType } from "@/lib/types/game";

/* ── The stable separation rule (system layer) ──────────────────────────── */

/**
 * The one rule that applies to every seat in every position.
 *
 * Phrased as a SEPARATION rather than a prohibition, because the prohibition
 * alone leaves the agent with nothing to do: "do not say the pair" and a task
 * that needs a reason produces either silence or a paraphrase. Asking for two
 * distinct things — the private reason and the public reason — gives the
 * planner somewhere to put each of them.
 */
export const DISCLOSURE_SEPARATION_LAYER = [
  "",
  "## 私有信息可以决定动作，但不能被抄进公开发言",
  "",
  "**私有信息可以决定你做什么，但它本身不能被复制到公开发言里。**",
  "开口之前，把两样东西分开：",
  "",
  "- **你私下为什么想做这个动作** —— 这里可以用你手上任何私有信息，",
  "  它决定你选哪辆车、怎么投、什么时候跳、打谁、设计什么检验。",
  "- **你在公开场合能安全给出的理由** —— 这一条只能建立在牌桌上人人看得到的东西上：",
  "  谁声称了什么、什么时候说的、发过什么车、怎么投的、任务结果、",
  "  前后矛盾、说会发生却没发生的事。",
  "",
  "两者可以指向同一个动作，而且经常应该指向同一个动作。",
  "**不同的是它们的来源** —— 一个来自只有你知道的东西，一个来自谁都能核对的东西。",
  "",
  "所以：**做什么由私有信息决定，怎么解释由公开记录决定。**",
  "拿不出公开理由，就换一个拿得出的动作，或者少说一点 —— 而不是把私有信息说出来当理由。",
  "",
  "**这不是让你不带信息地说话。** 一个只说「我感觉不对」的发言同样没用。",
  "要做的是：找到那条**公开可核对的**依据，让别人能自己去查，而不是让别人相信你看得到什么。",
].join("\n");

/** Bumped when this text changes in a way that could move behaviour. */
export const DISCLOSURE_LAYER_VERSION = "disclosure-rules-0.1.0";

/* ── Role-specific rules (layer 4) ──────────────────────────────────────── */

/**
 * Percival's rule, which is the one this milestone exists for.
 *
 * The forbidden list is EXAMPLES, not a pattern to route around. The sentence
 * after it says so, because a model handed four banned strings will otherwise
 * treat "not on the list" as "allowed" — and a paraphrase of the pair is the
 * pair.
 *
 * The last clause matters as much as the prohibition: claiming is still legal,
 * and so is every use of the pair that stays inside the seat's own head. A
 * Percival who reads this and stops claiming has read it wrong.
 */
const PERCIVAL_RULE = [
  "**你的候选对是私有信息，跳派西维尔不解密它。**",
  "",
  "规则给了你两个座位，一个梅林一个莫甘娜。这一对**永远不进公开发言** ——",
  "把它说出来，等于替刺客把梅林从六个好人缩到两个人，而刺客只要再猜一次。",
  "",
  "下面这些都是**已经泄露**，不要说，也不要换个说法说：",
  "",
  "- 「7、9一梅林一莫甘娜」",
  "- 「我的两个候选是7号和9号」",
  "- 「7、9中必有莫甘娜，所以这车必坏」",
  "- 任何**把梅林直接缩小到你真实那一对**上的说法，不管用什么措辞。",
  "",
  "**这四条是例子，不是名单。** 换一种说法说同一件事，仍然是说了。",
  "",
  "**你可以用这一对做的事（全部合法，而且这才是它的用处）：**",
  "",
  "- 决定发哪辆车、避开谁、让谁和谁不同车；",
  "- 决定这一票怎么投；",
  "- 决定什么时候跳、什么时候对跳、什么时候先不动；",
  "- 决定打哪一个竞争者、打他哪一点；",
  "- 设计一个**公开的**区分检验 —— 一辆车、一次投票、一个具体问题，",
  "  结果出来之后谁说对了大家都看得见。",
  "",
  "**你可以公开跳派西维尔，而且不需要交出这一对。**",
  "跳这个身份公开的是「他这么说」，不是你手上的任何值。",
  "跳完之后你的公开理由要从公开记录里重建：",
  "对方声称的时机、他的车和票对不对得上、任务结果打没打他的脸、",
  "他说会发生的事发生了吗、被质疑时答不答。",
  "",
  "**拿不出公开理由的时候，反对本身也是合法的。**",
  "「这辆车我没有能公开核对的安全依据，我反对，建议换成 X」",
  "是一个完整的动作，而且没有泄露任何东西。",
  "",
  "（有的房规允许派西维尔公开候选对。**这一局不是那种房规**，",
  "那需要另开一个明确标注的策略档。）",
].join("\n");

const MERLIN_RULE = [
  "**你的视野是私有信息。**",
  "",
  "你看得见的那几个坏人，**不能作为一个完整集合被公开说出来**，",
  "也不能说成「我知道」「我看得见」「这几个都是坏人」。",
  "把完整视野说出来就是自报梅林，三轮成功也救不了这局。",
  "",
  "可以用它决定投票、决定推谁的车、决定质疑谁；",
  "公开的时候，理由要从公开记录里找 —— 而且**你的准确度本身就是线索**：",
  "每一次都刚好踩对人的那个座位，是刺客最容易认出来的。",
].join("\n");

const EVIL_RULE = [
  "**你的队友名单是私有信息。**",
  "",
  "你认识的那两个人，**不能在牌桌上被点出来**，",
  "也不能用「我们」「我这边」「和我一伙」这类说法把他们圈进来。",
  "坏人密谈只在刺杀环节才存在，普通发言不是密谈频道。",
  "",
  "可以用它决定投票、决定发车、决定保谁踩谁；",
  "公开的理由必须来自公开记录，而且注意：",
  "**一直互相保、从不互相踩**，本身就是公开记录里看得见的痕迹。",
].join("\n");

const OBERON_RULE = [
  "**你没有队友信息，也不会有。**",
  "",
  "你不知道另外三个坏人是谁，他们也不知道你。",
  "**不要假设任何人是你的同伙，不要向任何人暗示配合。**",
  "别人的发言、投票、车单，都不会告诉你他是不是坏人 ——",
  "你手上的东西和好人一样多，只是你的胜利条件不同。",
].join("\n");

const LOYAL_RULE = [
  "**你没有私有信息，这不是劣势。**",
  "",
  "你说的每一句话本来就建立在公开记录上，所以你不需要担心泄露 ——",
  "你需要担心的是**帮别人泄露**：追问一个自称派西维尔的人「你的两个候选是谁」，",
  "等于在替刺客提问。可以问他的车、他的票、他的时机、他的预测，",
  "这些答案是公开可核对的，而且不会缩小梅林的范围。",
].join("\n");

const ROLE_RULES: Readonly<Partial<Record<RoleType, string>>> = {
  percival: PERCIVAL_RULE,
  merlin: MERLIN_RULE,
  morgana: EVIL_RULE,
  assassin: EVIL_RULE,
  mordred: EVIL_RULE,
  oberon: OBERON_RULE,
  loyal: LOYAL_RULE,
};

/* ── Rules that belong to a channel rather than a role ──────────────────── */

/**
 * The Lady, and the two phase-gated channels.
 *
 * Rendered to every seat, because the Lady may reach any of them and because
 * a seat that knows how the channel works is a seat that can tell an
 * announcement from a verification when somebody else makes one.
 */
const CHANNEL_RULES = [
  "**湖中女神：真实结果和公开宣布是两件事。**",
  "",
  "裁判私下告诉你的那个答案是私有的，**只能通过「宣布」这个合法动作变成公开的**。",
  "普通发言不解密它 —— 在发言里说「我验了 X，他是坏人」不是宣布，是泄露。",
  "而且宣布出去的值**可以是假的**：牌桌得到的永远是「他宣布了什么」，",
  "不是「裁判告诉他什么」。这两件事在公开记录里是分开记的。",
  "",
  "**刺杀环节的坏人密谈和局终亮牌，也各自是一个专门的频道。**",
  "密谈里说的话好人听不到；局终亮牌是规则做的，不是谁说出来的。",
  "**任何信息都不会因为你想说就变成公开的** —— 它要么本来就在公开记录里，",
  "要么需要一个合法动作在允许的阶段把它公开。",
].join("\n");

/**
 * Layer 4's disclosure half: this role's rule, then the channel rules.
 *
 * A function of `role` and nothing else. Two seats holding the same role in
 * different games read identical bytes, which is what makes the
 * non-interference tests able to swap everything else and compare.
 */
export function renderDisclosureRules(role: RoleType): string {
  const rule = ROLE_RULES[role];
  if (!rule) {
    throw new Error(`no disclosure rule for ${role} — is it in the 10-player set?`);
  }
  return ["## 你手上哪些东西不能进公开发言", "", rule, "", CHANNEL_RULES].join("\n");
}
