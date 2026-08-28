/**
 * Layer 3 — what this role IS, and layer 4 — what it was actually shown.
 *
 * The split matters. Layer 3 is the same text for every Merlin in every game:
 * the CATEGORY of information the role gets, its victory condition, and the
 * tension that makes the role interesting to play. Layer 4 is the only thing
 * in the whole prompt that depends on the deal, which is what makes auditing
 * information leakage a matter of reading one short function.
 *
 * These are BASELINE role prompts. They state what the role legally knows,
 * what it needs to win, and where the difficulty is — and then stop. They are
 * deliberately NOT a strategy tutorial: how to play Merlin is what the
 * strategy profiles are for, and baking a preferred line in here would give
 * every profile the same hidden advice and destroy the comparison.
 */

import type { RoleType } from "@/lib/types/game";
import type { Observation } from "../core/observation";
import { renderKnowledge } from "../core/visibility";
import { roleName } from "./transcript";

export interface RolePrompt {
  readonly role: RoleType;
  readonly name: string;
  /** What the rules give this seat. A category, never a value. */
  readonly legalKnowledge: string;
  readonly victory: string;
  /** The thing that makes the role hard. One sentence, no recommendation. */
  readonly tension: string;
}

const GOOD_VICTORY =
  "三轮任务成功，并且在最后的刺杀环节里梅林没有被刺中。任何一条不成立，好人就输了。";
const EVIL_VICTORY =
  "三轮任务失败，或者同一轮连否五次，或者好人拿到三轮成功之后刺客刺中梅林。三条满足任意一条即可。";

export const ROLE_PROMPTS: Readonly<Partial<Record<RoleType, RolePrompt>>> = {
  merlin: {
    role: "merlin",
    name: "梅林",
    legalKnowledge:
      "你看得到除莫德雷德以外的每一个坏人是哪个座位。你只看得到「他是坏人」，看不到他具体是莫甘娜、刺客还是奥伯伦。莫德雷德在你的视野之外，你分不出他和好人。",
    victory: GOOD_VICTORY,
    tension:
      "你知道的比任何人都多，而这正是你的危险来源：一旦坏人从你的发言或投票里认出你，三轮成功也救不了这局。",
  },
  percival: {
    role: "percival",
    name: "派西维尔",
    legalKnowledge:
      "你看到两个座位，其中一个是梅林，另一个是莫甘娜。你分不清哪个是哪个 —— 规则给你的就是这一对，没有先后、没有提示。",
    victory: GOOD_VICTORY,
    tension:
      "你是唯一有机会保住梅林的人，但你手上有两个候选，保错一个就等于替坏人指路。",
  },
  loyal: {
    role: "loyal",
    name: "忠臣",
    legalKnowledge: "你没有任何私有信息。你知道的一切都写在公开记录里，和别人看到的一样多。",
    victory: GOOD_VICTORY,
    tension:
      "你什么都不知道，但你有一票，而且好人这边人数占优 —— 你判断得准不准，直接决定车能不能过。",
  },
  morgana: {
    role: "morgana",
    name: "莫甘娜",
    legalKnowledge:
      "你认识另外两个互相认识的坏人是哪两个座位，但不知道他们各自的身份。你不认识奥伯伦，他也不认识你。按规则，派西维尔看到的那一对里有一个就是你 —— 他分不清你和梅林。",
    victory: EVIL_VICTORY,
    tension:
      "你有机会被当成梅林，这是坏人这边最强的一张牌；但装得越像，真梅林的行为就越容易把你比下去。",
  },
  assassin: {
    role: "assassin",
    name: "刺客",
    legalKnowledge:
      "你认识另外两个互相认识的坏人是哪两个座位，但不知道他们各自的身份。你不认识奥伯伦。最后的刺杀由你来指认。",
    victory: EVIL_VICTORY,
    tension:
      "就算三轮任务全崩了你也用不上刺杀；可一旦好人拿到三轮成功，全场的胜负就压在你一个人的判断上，而你整局都得一边参与破坏一边留着眼睛看谁像梅林。",
  },
  mordred: {
    role: "mordred",
    name: "莫德雷德",
    legalKnowledge:
      "你认识另外两个互相认识的坏人是哪两个座位，但不知道他们各自的身份。你不认识奥伯伦。**梅林看不见你** —— 在他眼里你和好人没有区别。",
    victory: EVIL_VICTORY,
    tension:
      "你可以站在全场最干净的位置上，因为唯一有视野的好人认不出你；但这个优势只存在于你的票型和发车还站得住的时候。",
  },
  oberon: {
    role: "oberon",
    name: "奥伯伦",
    legalKnowledge:
      "你没有任何队友信息 —— 你不知道另外三个坏人是谁，他们也不知道你是谁。但梅林看得见你。",
    victory: EVIL_VICTORY,
    tension:
      "你要在完全不知道同伴是谁的情况下帮坏人赢，而你做的每一件事都可能砸到自己人；同时你是坏人里唯一被梅林盯着的。",
  },
};


export function rolePrompt(role: RoleType): RolePrompt {
  const prompt = ROLE_PROMPTS[role];
  if (!prompt) {
    throw new Error(`no baseline role prompt for ${role} — is it in the 10-player set?`);
  }
  return prompt;
}

/** Layer 3: the role, as a category. Identical for every game. */
export function renderRoleLayer(role: RoleType): string {
  const prompt = rolePrompt(role);
  return [
    `## 三、你的身份：${prompt.name}`,
    "",
    "**规则给你的信息**",
    prompt.legalKnowledge,
    "",
    "**你怎么才算赢**",
    prompt.victory,
    "",
    "**这个身份难在哪**",
    prompt.tension,
    "",
    "以上是身份本身的说明。具体该怎么打，看后面的策略档 —— 这里不给打法。",
  ].join("\n");
}

/**
 * Layer 4: the concrete values.
 *
 * The ONLY layer that depends on the deal, and it reads nothing but the
 * observation's own `knowledge`, `ladyResults` and `evilRoster`. Everything
 * the leakage suite has to check about prompts checks this function.
 */
export function renderPrivateKnowledgeLayer(observation: Observation): string {
  const lines = [`## 四、你实际看到的东西（只有你看得到）`, ""];

  lines.push(`你是 ${observation.seat}号，${roleName(observation.role)}。`);
  lines.push("");
  lines.push("**发牌时给你的（硬信息，永远不变）**");
  lines.push(renderKnowledge(observation.knowledge));

  if (observation.ladyResults.length > 0) {
    lines.push("");
    lines.push("**湖中女神私下告诉你的（硬信息，永远不变）**");
    for (const result of observation.ladyResults) {
      const side = result.trueSide === "good" ? "好人" : "坏人";
      lines.push(
        `- 第${result.missionNumber}轮之后你验了 ${result.target}号，裁判给你的真实答案是：**${side}**。` +
          `（你当众怎么说是另一回事，这一条是真的。）`,
      );
    }
  }

  if (observation.evilRoster) {
    lines.push("");
    lines.push("**刺杀环节的互认（只有这个环节才有）**");
    lines.push(
      `坏人这一边的确切身份是：${observation.evilRoster
        .map((entry) => `${entry.seat}号 ${roleName(entry.role)}`)
        .join("，")}。`,
    );
  }

  if (observation.evilDiscussion.length > 0) {
    lines.push("");
    lines.push("**坏人密谈（好人听不到）**");
    for (const line of observation.evilDiscussion) {
      lines.push(`- ${line.speaker}号：「${line.message}」`);
    }
  }

  lines.push("");
  if (observation.memory.version === 0) {
    lines.push("**你自己的笔记（软判断）**：还没有写过。");
  } else {
    lines.push("**你自己的笔记（软判断，可以随时改）**");
    if (observation.memory.beliefs.length > 0) {
      lines.push(
        `- 怀疑度：${observation.memory.beliefs
          .map((b) => `${b.seat}号 ${Math.round(b.pEvil * 100)}%${b.note ? `（${b.note}）` : ""}`)
          .join("；")}`,
      );
    }
    if (observation.memory.intentions.length > 0) {
      lines.push(`- 你打算做的：${observation.memory.intentions.join("；")}`);
    }
    if (observation.memory.commitments.length > 0) {
      lines.push(`- 你已经公开承诺过的：${observation.memory.commitments.join("；")}`);
    }
  }

  return lines.join("\n");
}
