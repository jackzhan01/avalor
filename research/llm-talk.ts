import { renderBrief, seatBrief } from "@/lib/decision/brief";
import type { TalkInput, TalkSource } from "@/lib/decision/rollout";
import type { SocialEvidence } from "@/lib/social";
import type { GameRecord } from "@/lib/types/game";
import { askAll } from "./llm-client";

/**
 * A table of language models, talking inside a simulated game.
 *
 * Every seat gets the brief it would get in a recorded game — the public log
 * of what the simulation has done so far, plus its own legitimate sight — and
 * answers with stances that come back through the ordinary SocialEvidence
 * schema. Nothing bypasses the belief: the stances are absorbed as a
 * likelihood over worlds and the ordinary policies decide from the posterior.
 *
 * Two things learned earlier are built in rather than rediscovered.
 *
 * The evil prompt is EXPLICIT. Under a neutral instruction the model betrays a
 * teammate it can see in 58% of its stances, which produces a table where
 * nobody lies and good wins 0.61 of the time against a real 0.43. Told plainly
 * that speech is a weapon it reaches +0.44 on the deception axis.
 *
 * The math posterior is OPTIONAL, and that is the whole point of two arms.
 * Handed nothing but the log the model does not sharpen across a game at all;
 * handed the posterior it does, and it reorders the top suspects better than
 * the posterior alone. Whether that holds in a closed loop is the question.
 */

const SHARED = `只输出 JSON，不要解释，不要 markdown 代码块：
{"stances": [{"seat": 座位号, "valence": -1.0到1.0, "confidence": 0.0到1.0}, ...]}

valence：-1 = 强踩（我说他是坏人），0 = 看不清，+1 = 强保（我说他是好人）。
confidence：你对这个判断本身有多确定。
每一个其他座位都要给，不要给自己。`;

const GOOD_SYSTEM = `你在玩线下《阿瓦隆》，你是好人阵营。你只知道简报里写的东西 —— 公开发生过的事，加上你自己身份带来的视野。

你的目标只有一个：让好人赢。发言是你找出坏人、并让其他好人也看见的工具。谁上过挂掉的车、谁的票投得反常、谁在保一个已经很脏的人 —— 用这些东西说话，不要凭感觉。

${SHARED}`;

const EVIL_SYSTEM = `你在玩线下《阿瓦隆》，你是坏人阵营。

你的目标只有一个：让坏人赢。发言是你的武器，不是你的报告。你说出来的话不必等于你相信的事。

具体地：
- 你的队友（简报里写明你看得见的那些人）必须被你保住。给他们正的 valence。绝不要踩自己人 —— 那等于直接输掉这局。
- 把怀疑引向你确信是好人的座位，尤其是那些看起来在带节奏、被大家信任的人。给他们负的 valence。
- 别做得太整齐。留一两个中性，偶尔对一个好人给弱正，这样你的发言像在推理而不是在念稿。

${SHARED}`;

export interface LlmTalkOptions {
  /**
   * Let a speaker read what the table has already said, in earlier rounds.
   *
   * Off in the first closed-loop arms, which turned out to matter: the false
   * consensus was already there at 3.7x with nobody able to see anyone else's
   * stance, so it cannot be imitation. This switch is what turns that from an
   * inference into a measurement.
   *
   * Only earlier rounds. Within a round the table speaks at once, and letting
   * a later seat read an earlier one would invent a speaking order the game
   * does not have.
   */
  socialHistory?: boolean;
  /**
   * Hand each speaker the current posterior as external belief memory.
   *
   * The memory ablation says this is the only intervention that made the model
   * accumulate a game — its own carried notes made it worse, anchoring it on
   * an early read it then refused to update.
   */
  mathMemory: boolean;
  /** Collected for measurement; the rollout never reads it back. */
  onEvidence?: (evidence: readonly SocialEvidence[], round: number) => void;
}

function seatLine(
  game: GameRecord,
  seats: readonly string[],
  read: ReadonlyMap<string, number>,
): string {
  return seats
    .map((s, i) => `${i + 1}号 ${(read.get(s) ?? 0).toFixed(2)}`)
    .join("，");
}

export function llmTalk(options: LlmTalkOptions): TalkSource {
  // Everything said so far in this game, carried across rounds.
  const said: SocialEvidence[] = [];

  return async (input: TalkInput): Promise<SocialEvidence[]> => {
    const { seats, info, game, events, round, read, sequence } = input;

    const asked: string[] = [];
    const prompts: { system: string; user: string }[] = [];
    for (const seat of seats) {
      const who = info.get(seat);
      if (!who) continue;
      let user = renderBrief(
        seatBrief(game as GameRecord, events, who, {
          // Always the same cut on events; only the social channel varies, so
          // the conditions differ in exactly one thing.
          upTo: sequence,
          social: options.socialHistory ? said : undefined,
        }),
      );
      if (options.mathMemory) {
        user += `

## 一个纯逻辑的排除法引擎给出的当前概率（它只看公开信息，没有我的视野）
${seatLine(game as GameRecord, seats, read)}`;
      }
      asked.push(seat);
      prompts.push({
        system: who.side === "evil" ? EVIL_SYSTEM : GOOD_SYSTEM,
        user,
      });
    }

    const answers = await askAll(prompts);
    const out: SocialEvidence[] = [];

    for (let i = 0; i < answers.length; i += 1) {
      const rows = answers[i]?.stances;
      if (!Array.isArray(rows)) continue;
      const speaker = asked[i];
      for (const row of rows as Record<string, unknown>[]) {
        const target = seats[Number(row.seat) - 1];
        if (!target || target === speaker) continue;
        const valence = Number(row.valence);
        if (!Number.isFinite(valence)) continue;
        const confidence = Number(row.confidence);
        out.push({
          sequence: sequence + out.length + 1,
          missionNumber: round,
          speakerId: speaker,
          targetId: target,
          valence: Math.min(1, Math.max(-1, valence)),
          confidence: Number.isFinite(confidence)
            ? Math.min(1, Math.max(0, confidence))
            : 0.5,
          source: "dialogue",
          audience: null,
        });
      }
    }

    said.push(...out);
    options.onEvidence?.(out, round);
    return out;
  };
}
