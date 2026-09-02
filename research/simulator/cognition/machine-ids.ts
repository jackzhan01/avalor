/**
 * Machine evidence ids, and why they must not reach a table.
 *
 * WHAT HAPPENED. The completed M5.3 games produced public speech like this:
 *
 *     「[f30] 是 7 号提 1、2、3、4，[f32][f.fail2] 这车 3 失败」
 *
 * Every seat did it, in every round, in both arms. That is not a model quirk —
 * it is a prompt defect I wrote. The spokesperson's fact tables render each
 * line with its id, and the legend above them said, in as many words,
 * 「说话时可以直接指给别人看」. The model did exactly what it was told.
 *
 * WHY IT MATTERS. Three separate reasons, and only the first is cosmetic:
 *
 *   A table of people does not speak in database keys. A transcript full of
 *   `[f.fail2]` is not a record of a conversation.
 *
 *   An id is an OPAQUE POINTER. 「[f30][f32] 证明这车坏」 asserts a conclusion
 *   and hides the evidence behind two symbols the listener has to resolve.
 *   The natural sentence 「第二轮 7 号发的 1、2、3、4 出了三张失败票」 carries the
 *   same claim AND the thing it rests on, which is the entire point of asking
 *   for public reasons.
 *
 *   The id namespace is shared with the PRIVATE one. `p.pair` and `f.fail2`
 *   look alike, and a table that has learned to quote ids is a table one
 *   character away from quoting the wrong one.
 *
 * THE FIX IS STRUCTURAL FIRST. Under `naturalPublicSpeech` the spokesperson's
 * fact tables are rendered WITHOUT ids at all, so there is nothing to copy —
 * the same shape as M5.3's guarantee that it never holds the pair. This
 * detector is the backstop, and it is a backstop because the planner's envelope
 * still carries ids and a determined model could echo one.
 *
 * NEVER SILENTLY STRIP. A sentence built around 「[f30] 证明…」 does not become
 * correct by deleting four characters; it becomes 「 证明…」, which asserts the
 * same conclusion with the evidence removed. The whole sentence is refused and
 * the spokesperson is asked again.
 */

/** One machine id found in text meant for people. */
export interface MachineIdHit {
  /** Stable, so a test and a repair note can name the same rule. */
  readonly kind:
    | "fact-id"
    | "derived-fact-id"
    | "claim-id"
    | "contest-id"
    | "private-id"
    | "commitment-id"
    | "schema-field"
    | "citation-syntax";
  readonly text: string;
  /** What the speaker should have said instead. One line, human-facing. */
  readonly guidance: string;
}

/**
 * The id shapes, as they are actually minted.
 *
 * Anchored to a word boundary and to the exact prefixes `fact-ids.ts` mints,
 * so an ordinary sentence containing 「f」 or a seat number cannot trip them.
 * `f.now` / `f.fail2` / `f.cmp1x2` are listed separately from `f17` because
 * they are different shapes, and a single loose pattern that matched both
 * would also match a decimal.
 */
const PATTERNS: readonly {
  readonly kind: MachineIdHit["kind"];
  readonly re: RegExp;
  readonly guidance: string;
}[] = [
  {
    kind: "derived-fact-id",
    re: /\bf\.(now|fail\d+|cmp\d+x\d+)\b/g,
    guidance: "把这条裁判算术用自己的话说出来（哪一轮、哪几个人、几张失败票）",
  },
  {
    kind: "fact-id",
    re: /\bf\d+\b/g,
    guidance: "把这条裁判记录用自己的话说出来（第几轮、谁发的车、结果是什么）",
  },
  {
    kind: "claim-id",
    re: /\bc\d+:[a-z]+\b/g,
    guidance: "说清是谁、在什么时候、说过什么，而不是引用编号",
  },
  {
    kind: "contest-id",
    re: /\bk\d+[:.][a-z]+\b/g,
    guidance: "说清谁在什么时候跳了、退了、踩了谁",
  },
  {
    kind: "private-id",
    re: /\bp\.[a-zA-Z0-9]+\b/g,
    guidance: "这是私有信息的编号，任何情况下都不能出现在公开发言里",
  },
  {
    kind: "commitment-id",
    re: /\bk\d+\.\d+\b/g,
    guidance: "把那条承诺的内容说出来，而不是它的编号",
  },
  {
    kind: "citation-syntax",
    re: /\[[a-zA-Z][a-zA-Z0-9_.:-]*\]/g,
    guidance: "方括号引用是给机器审计用的记法，牌桌上不要用",
  },
];

/**
 * Schema and internal field names.
 *
 * Kept separate from `secrets.ts`'s list, which exists to catch private
 * COGNITION leaking. These are the same strings for a different reason: a
 * public sentence containing `requestedTeam` is not a leak, it is a sentence
 * nobody at a table would say. Both lists are checked; the messages differ.
 */
const FIELD_NAMES: readonly string[] = [
  "publicBasisIds",
  "publicProposition",
  "desiredTableEffect",
  "selectedClaimAction",
  "requestedTeam",
  "requestedVote",
  "communicationIntent",
  "tentativeTeam",
  "noTeamYet",
  "retractClaim",
  "publicMessage",
  "memoryPatch",
  "factsUsed",
  "premiseIds",
  "premiseLabels",
  "evidenceIds",
  "basisIds",
  "seatReads",
  "closedCommitments",
  "newCommitments",
  "resolution",
];

/**
 * Every machine id in a sentence meant for people.
 *
 * Returns hits rather than a boolean so the repair note can say WHICH shape was
 * found and what to say instead — a refusal that only says "no ids" leaves the
 * model to guess which of eight things it did.
 */
export function findMachineIds(text: string): readonly MachineIdHit[] {
  const out: MachineIdHit[] = [];
  for (const { kind, re, guidance } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ kind, text: m[0], guidance });
    }
  }
  for (const name of FIELD_NAMES) {
    if (text.includes(name)) {
      out.push({
        kind: "schema-field",
        text: name,
        guidance: "这是输出字段名，不是中文；说事情本身",
      });
    }
  }
  // Deduplicated by (kind, text): the same id twice is one problem.
  const seen = new Set<string>();
  return out.filter((h) => {
    const key = `${h.kind}:${h.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The repair note for a refused sentence. Carries the SHAPES, not the sentence. */
export function machineIdRepairNote(hits: readonly MachineIdHit[]): string {
  const lines = [
    "",
    "## ⚠ 上一句里出现了给机器看的编号",
    "",
    "牌桌上没有人会念编号。把它指向的**事情本身**说出来：",
    "",
  ];
  for (const h of hits.slice(0, 6)) {
    lines.push(`- \`${h.text}\` —— ${h.guidance}`);
  }
  lines.push(
    "",
    "例如，不要说「[f30][f32] 这车坏」，要说",
    "**「第二轮 7 号发的 1、2、3、4 出了三张失败票」**。",
    "",
    "请重写这一句。内容不变，只把编号换成话。",
  );
  return lines.join("\n");
}
