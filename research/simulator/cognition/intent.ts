/**
 * The bounded envelope that crosses the firewall.
 *
 * THE ONE THING THAT MOVES between the private strategist and the public
 * spokesperson. Everything else about stage 1 — the role, the pair, the
 * vision, the roster, the Lady truth, the ledger, the hypotheses, the cover
 * story, the private rationale — stops at this boundary because it is not in
 * this type. That is deliberate and it is the whole mechanism: the spokesperson
 * cannot paraphrase the pair because the spokesperson has never held it.
 *
 * WHY IT IS SO SMALL. Every field here is a field the table could in principle
 * have inferred, or a decision already taken. `publicProposition` is a
 * sentence the table can accept or refuse; `publicBasisIds` are ids that
 * resolve in a PUBLIC-ONLY registry; `requestedTeam` and `requestedVote` are
 * asks, already chosen by stage 1. Nothing in the envelope answers the
 * question "how do you know" with anything but a public record.
 *
 * WHAT THE MODEL DOES NOT FILL IN. `factsThatMustRemainPrivate` is computed by
 * the system from the seat's observation and is attached AFTER the model
 * answers. The M5.2 pilot proved why: it asked the model to record
 * `informationToConceal`, the model recorded it accurately every turn, and the
 * seat published the pair anyway. A field the speaker writes is a note about
 * intent, not a constraint on behaviour.
 */

import type { Seat } from "../core/types";
import type { Fragment } from "../model/json-schema";
import { CLAIM_ACT_VALUES, type ClaimAct } from "./contest";
import type { SecretClass } from "./classification";

/* ── The type ───────────────────────────────────────────────────────────── */

/** Where the words are going. Checked against the task, never trusted. */
export type IntentChannel = "table-public" | "evil-council";

export type RequestedVote = "approve" | "reject" | "none";

/** What the model fills in. Bounded, and entirely about the public layer. */
export interface CommunicationIntent {
  readonly channel: IntentChannel;
  /** What this turn is for, in the speaker's own words. One sentence. */
  readonly publicGoal: string;
  /** Seats this turn is aimed at. Empty when it is aimed at the table. */
  readonly targetSeats: readonly Seat[];
  /** The claim-contest act already chosen by stage 1. */
  readonly selectedClaimAction: ClaimAct;
  /** The team this turn asks for, or null. Stage 1 chose it. */
  readonly requestedTeam: readonly Seat[] | null;
  readonly requestedVote: RequestedVote;
  /**
   * Public fact and claim ids the wording may lean on.
   *
   * Resolved against a PUBLIC-ONLY registry by the firewall. A private,
   * unknown or stale id does not reach the spokesperson — it is stripped and
   * recorded, because a spokesperson handed `p.pair` would at best write
   * around a symbol it cannot read and at worst quote it.
   */
  readonly publicBasisIds: readonly string[];
  /** One sentence the table can agree with or refuse. Not a feeling. */
  readonly publicProposition: string;
  /** What the speaker wants the table to DO with it. */
  readonly desiredTableEffect: string;
}

/**
 * The intent as the spokesperson receives it: sanitised, with the system's own
 * list of what must not appear attached.
 *
 * A separate type rather than a flag, so the compiler distinguishes "what the
 * model said it wants" from "what the firewall approved". A function taking a
 * `SanitisedIntent` cannot be handed a raw one by accident.
 */
export interface SanitisedIntent {
  readonly channel: IntentChannel;
  readonly publicGoal: string;
  readonly targetSeats: readonly Seat[];
  readonly selectedClaimAction: ClaimAct;
  readonly requestedTeam: readonly Seat[] | null;
  readonly requestedVote: RequestedVote;
  /** Every id here resolves to a `table-public` classification. */
  readonly publicBasisIds: readonly string[];
  /** Each id rendered as its public label, so the wording can cite it. */
  readonly publicBasis: readonly { readonly id: string; readonly label: string }[];
  readonly publicProposition: string;
  readonly desiredTableEffect: string;
  /** Persona id. Style only — carries nothing about the deal. */
  readonly styleId: string;
  /**
   * SYSTEM-COMPUTED. The secret classes this seat holds right now.
   *
   * CLASSES, not values. The spokesperson is told that a Percival pair exists
   * and must not be published; it is never told which two seats. Naming them
   * here would put the secret back in the prompt that was designed not to
   * carry it — which is the mistake the whole milestone is about.
   */
  readonly factsThatMustRemainPrivate: readonly SecretClass[];
}

/* ── Bounds ─────────────────────────────────────────────────────────────── */

/**
 * Character bounds for the envelope.
 *
 * Tight on purpose. A `publicGoal` with room for four hundred characters is a
 * place to put reasoning, and reasoning in the envelope is reasoning that
 * crosses the firewall. The public message itself is 220 non-whitespace
 * characters, so an envelope substantially larger than the message it produces
 * is carrying something the message will not.
 */
export const INTENT_LIMITS = {
  publicGoalChars: 100,
  publicPropositionChars: 160,
  desiredTableEffectChars: 100,
  maxTargetSeats: 4,
  maxPublicBasisIds: 6,
} as const;

/* ── The schema fragment ────────────────────────────────────────────────── */

const SEAT: Fragment = { type: "integer", minimum: 1, maximum: 10 };

/**
 * What stage 1 must return in place of `publicMessage`.
 *
 * Strict mode: every property required, `additionalProperties: false`. An
 * "optional" field is a required one that may be null.
 */
export function intentFragment(): Fragment {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "channel",
      "publicGoal",
      "targetSeats",
      "selectedClaimAction",
      "requestedTeam",
      "requestedVote",
      "publicBasisIds",
      "publicProposition",
      "desiredTableEffect",
    ],
    properties: {
      channel: { type: "string", enum: ["table-public", "evil-council"] },
      publicGoal: { type: "string", maxLength: INTENT_LIMITS.publicGoalChars * 3 },
      targetSeats: {
        type: "array",
        items: SEAT,
        maxItems: INTENT_LIMITS.maxTargetSeats,
      },
      selectedClaimAction: { type: "string", enum: [...CLAIM_ACT_VALUES] },
      requestedTeam: {
        type: ["array", "null"],
        items: SEAT,
        minItems: 0,
        maxItems: 10,
      },
      requestedVote: { type: "string", enum: ["approve", "reject", "none"] },
      publicBasisIds: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: INTENT_LIMITS.maxPublicBasisIds,
      },
      publicProposition: {
        type: "string",
        minLength: 1,
        maxLength: INTENT_LIMITS.publicPropositionChars * 3,
      },
      desiredTableEffect: {
        type: "string",
        maxLength: INTENT_LIMITS.desiredTableEffectChars * 3,
      },
    },
  };
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

export type IntentParse =
  | { readonly ok: true; readonly intent: CommunicationIntent }
  | { readonly ok: false; readonly error: string };

const isSeat = (v: unknown): v is Seat =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10;

function seatArray(value: unknown, path: string): readonly Seat[] | string {
  if (!Array.isArray(value)) return `${path} 必须是数组`;
  for (const v of value) if (!isSeat(v)) return `${path} 里有不是 1-10 座位号的东西`;
  return value as Seat[];
}

/**
 * Shape-check the envelope. Structure only — content is the firewall's job.
 *
 * Deliberately separate from `sanitiseIntent`: a malformed envelope is a
 * repairable model error and gets a repair note, while a LEAKING envelope is
 * a security event that gets redacted and audited. Conflating them would send
 * the planner a repair note describing the secret it just tried to publish.
 */
export function parseIntent(raw: unknown): IntentParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "communicationIntent 必须是一个对象" };
  }
  const o = raw as Record<string, unknown>;

  const channel = o.channel;
  if (channel !== "table-public" && channel !== "evil-council") {
    return { ok: false, error: "communicationIntent.channel 只能是 table-public 或 evil-council" };
  }

  const act = o.selectedClaimAction;
  if (typeof act !== "string" || !(CLAIM_ACT_VALUES as readonly string[]).includes(act)) {
    return {
      ok: false,
      error: `communicationIntent.selectedClaimAction 必须是这九个之一：${CLAIM_ACT_VALUES.join(" / ")}`,
    };
  }

  const vote = o.requestedVote;
  if (vote !== "approve" && vote !== "reject" && vote !== "none") {
    return { ok: false, error: "communicationIntent.requestedVote 只能是 approve / reject / none" };
  }

  const targets = seatArray(o.targetSeats, "communicationIntent.targetSeats");
  if (typeof targets === "string") return { ok: false, error: targets };

  let team: readonly Seat[] | null = null;
  if (o.requestedTeam !== null && o.requestedTeam !== undefined) {
    const parsed = seatArray(o.requestedTeam, "communicationIntent.requestedTeam");
    if (typeof parsed === "string") return { ok: false, error: parsed };
    team = parsed;
  }

  if (!Array.isArray(o.publicBasisIds) || o.publicBasisIds.some((v) => typeof v !== "string")) {
    return { ok: false, error: "communicationIntent.publicBasisIds 必须是字符串数组" };
  }

  const proposition = o.publicProposition;
  if (typeof proposition !== "string" || proposition.trim().length === 0) {
    return {
      ok: false,
      error: "communicationIntent.publicProposition 必须写一句可以被同意或拒绝的话，不能留空",
    };
  }

  const goal = typeof o.publicGoal === "string" ? o.publicGoal : "";
  const effect = typeof o.desiredTableEffect === "string" ? o.desiredTableEffect : "";

  return {
    ok: true,
    intent: {
      channel,
      publicGoal: goal,
      targetSeats: targets,
      selectedClaimAction: act as ClaimAct,
      requestedTeam: team,
      requestedVote: vote,
      publicBasisIds: o.publicBasisIds as readonly string[],
      publicProposition: proposition,
      desiredTableEffect: effect,
    },
  };
}

/* ── How the planner is told to fill it in ──────────────────────────────── */

/**
 * The stage-1 instruction for the envelope. Appended to the task layer.
 *
 * Says what goes in each field AND says why the envelope is small, because a
 * model that does not know the envelope is a boundary will try to be helpful
 * by explaining itself in `publicGoal`.
 */
export const INTENT_INSTRUCTION = [
  "### 你不写公开发言 —— 你写一个 `communicationIntent`",
  "",
  "**这一步你不产出说给牌桌听的那句话。** 你决定要做什么，然后填一个信封；",
  "另一个只看得到公开信息的发言者会根据这个信封把话写出来。",
  "**他看不到你的身份、你的候选对、你的视野、你的队友、你的验人结果、",
  "也看不到你的任何推理记录。** 所以：",
  "",
  "- 信封里写进去的东西**等于你交给牌桌的东西**。私有信息不要往里放 ——",
  "  放了会被系统整段抹掉，发言者拿到的是一个空字段，你这一步就白费了。",
  "- 你选的动作**已经定下来了**，发言者改不了：车、票、任务牌、",
  "  女神目标、宣布的值、跳身份、退水、刺杀目标，全部由你这一步决定。",
  "",
  "字段：",
  "",
  "- `channel`：`table-public`（全桌听得到）或 `evil-council`（只有刺杀环节的坏人密谈）。",
  "  普通发言一律 `table-public`。",
  "- `publicGoal`：这一步你想在牌桌上达成什么。一句话。",
  "- `targetSeats`：这一步针对谁。针对全桌就给空数组。",
  "- `selectedClaimAction`：你这一步的公开身份动作，从那九个里选。不谈身份就 `stay-hidden`。",
  "- `requestedTeam`：你要求的车（人数要对），没有就 null。",
  "- `requestedVote`：你要求大家怎么投，`approve` / `reject` / `none`。",
  "- `publicBasisIds`：**只能是公开的 id** —— `f…` / `c…` / `k…`。",
  "  填 `p…` 开头的私有 id 会被系统剔除并记录下来，发言者一个字都拿不到。",
  "- `publicProposition`：**一句可以被同意或拒绝的话**，而且它必须是",
  "  **别人靠公开记录就能自己判断的**。不是「我觉得他有问题」，",
  "  是「7号 三次要车都把自己放进去，却没解释过 R2 那辆车为什么带 6号」。",
  "- `desiredTableEffect`：你希望牌桌接下来做什么。",
  "",
  "**检验自己有没有越界的办法：** 把 `publicProposition` 交给一个只看过公开记录的人，",
  "他能不能自己核对？能，就是安全的；要相信你看得到什么才成立，就是泄露。",
].join("\n");
