/**
 * A standing claim stays standing.
 *
 * WHAT THE LIVE GAMES DID. Seat 8 emitted `claim: "percival"` at sequences 4,
 * 45 and 79 of the M5.4 game. The referee's `standingClaims` already held it
 * from sequence 4 onward — nothing had retracted it, nobody had contested it,
 * and the two later events changed no public state. The seat's own contest
 * block noticed and read it as instability: 「声称在 seq 4、45、79 重复成立又失效，
 * 稳定性不足」. The Assassin used that as a reason to rate the claim `weak`.
 *
 * So a modelling habit — restating your identity because the schema has a field
 * for it — became a public signal that the claim was shaky. That is not a rule
 * violation, it is a REALISM failure: at a real table you say 「我是派西维尔」
 * once and afterwards you say 「按我之前说的」.
 *
 * NOT A PROHIBITION. Re-claiming is a real move and three situations need it:
 *
 *   ANSWERING A CHALLENGE. Somebody said your claim is false, or claimed the
 *   same role. Restating it is the reply.
 *
 *   RESOLVING AMBIGUITY. The table is acting as though the claim lapsed, or a
 *   retraction was ambiguous.
 *
 *   RE-ENTERING AFTER A RETRACTION. You withdrew it and are putting it back —
 *   which the referee records as a genuinely new claim, so it is never
 *   redundant.
 *
 * What is repaired is the FOURTH case: the same claim, again, with none of the
 * above true. The check asks the model to name which purpose applies and then
 * verifies that purpose against the public record, so the answer is a claim
 * about the log rather than a self-assessment.
 */

import type { PublicEvent } from "../core/events";
import type { ClaimPurpose, Seat } from "../core/types";
import type { RoleType } from "@/lib/types/game";

/* ── The purpose a repeated claim must carry ────────────────────────────── */

/*
 * The purpose enum lives in `core/types.ts`, with the action it is a field of.
 * Re-exported here so every reader of this module keeps one import, and so the
 * canonical parser and this checker can never disagree about the list.
 *
 *   first-claim         nothing stands yet
 *   answering-challenge somebody disputed it, or claimed the same role
 *   resolving-ambiguity the table is treating the claim as lapsed
 *   re-entering         it was retracted and is being put back
 */
export type { ClaimPurpose } from "../core/types";
export { CLAIM_PURPOSES } from "../core/types";

/* ── What the referee's record says ─────────────────────────────────────── */

export interface ClaimState {
  /** The role this seat currently has standing, or null. */
  readonly standing: RoleType | null;
  /** Sequence at which the standing claim was made. */
  readonly since: number | null;
  /** Has this seat ever retracted a claim? */
  readonly retracted: boolean;
  /** Another seat has claimed the same role, or disputed this one, since. */
  readonly contestedSince: boolean;
}

/**
 * This seat's claim situation, read from the public log alone.
 *
 * From the LOG rather than from the seat's memory, deliberately: a check that
 * consulted the model's own belief about whether it had claimed would be a
 * check the model can pass by being confidently wrong.
 */
export function claimStateFor(
  seat: Seat,
  role: RoleType | null,
  publicLog: readonly PublicEvent[],
): ClaimState {
  let standing: RoleType | null = null;
  let since: number | null = null;
  let retracted = false;
  let contestedSince = false;

  for (const event of publicLog) {
    if (event.type !== "speech") continue;
    if (event.speaker === seat) {
      if (event.retractClaim === true) {
        standing = null;
        since = null;
        retracted = true;
      }
      if (event.claim) {
        standing = event.claim;
        since = event.sequence;
      }
      continue;
    }
    if (since === null) continue;
    // A rival claim to the same role, or an explicit stance against this seat,
    // is what makes a restatement a reply rather than a repetition.
    if (event.claim && role !== null && event.claim === role) contestedSince = true;
    const stance = (event.stances ?? []).find((s) => s.seat === seat);
    if (stance && stance.valence < 0) contestedSince = true;
  }
  return { standing, since, retracted, contestedSince };
}

/* ── What can make a standing claim look lapsed ─────────────────────────── */

/**
 * A public event that could reasonably put a standing claim back in question.
 *
 * WHY THIS EXISTS. `resolving-ambiguity` was the one purpose the log could not
 * adjudicate, so it was accepted and merely counted — which makes it the escape
 * hatch a seat can use every turn. The fix is NOT a numeric cap. A cap is
 * arbitrary in both directions: two legitimate clarifications in a long game
 * would be refused, and one bogus one in a short game would pass.
 *
 * What is asked instead is EVIDENCE: name a public event, after your claim, of a
 * kind that could actually create the ambiguity. The claim then rests on the
 * record rather than on the seat's own report of how the table feels.
 *
 * THE LIST IS DELIBERATELY GENEROUS. It is not trying to decide whether the
 * table really was confused — that is a reading, and the seat is entitled to
 * it. It only refuses the case where NOTHING happened: no rival claim, nobody
 * pushed back, nobody was named, no result landed. In that world there is no
 * ambiguity to resolve and the restatement is the habit this file is about.
 */
export type AmbiguityKind =
  /** Somebody else claimed a role — the same one, or any role at all. */
  | "rival-claim"
  /** Somebody retracted a claim, which muddies who is standing on what. */
  | "retraction"
  /** A seat took a public stance on this seat, either direction. */
  | "stance-on-me"
  /** A mission resolved, which resets what the table is arguing about. */
  | "mission-result"
  /** A Lady announcement named somebody, including possibly this seat. */
  | "lady-announcement";

export interface AmbiguityEvent {
  /** The referee sequence it happened at. Resolvable in the public log. */
  readonly sequence: number;
  readonly kind: AmbiguityKind;
}

/**
 * Every event after `since` that could put this seat's claim back in question.
 *
 * PRIVATE. The ids are recorded in the trace and rendered into the seat's own
 * prompt; they never reach a public message — `firewall.ts` refuses machine ids
 * in speech under 0.6.0 and later, and nothing here writes to a public field.
 */
export function ambiguityEventsAfter(
  seat: Seat,
  since: number,
  publicLog: readonly PublicEvent[],
): AmbiguityEvent[] {
  const out: AmbiguityEvent[] = [];
  for (const event of publicLog) {
    if (event.sequence <= since) continue;
    if (event.type === "mission_result") {
      out.push({ sequence: event.sequence, kind: "mission-result" });
      continue;
    }
    if (event.type === "lady_announced") {
      out.push({ sequence: event.sequence, kind: "lady-announcement" });
      continue;
    }
    if (event.type !== "speech") continue;
    if (event.speaker === seat) continue;
    if (event.retractClaim === true) {
      out.push({ sequence: event.sequence, kind: "retraction" });
    }
    if (event.claim) {
      out.push({ sequence: event.sequence, kind: "rival-claim" });
    }
    if ((event.stances ?? []).some((st) => st.seat === seat)) {
      out.push({ sequence: event.sequence, kind: "stance-on-me" });
    }
  }
  return out;
}

/* ── The check ──────────────────────────────────────────────────────────── */

export interface ClaimCheckInput {
  readonly seat: Seat;
  /** The claim this speech is submitting, or null. */
  readonly submittedClaim: RoleType | null;
  readonly retracting: boolean;
  /** What the model says this claim is FOR. Required under 0.7.0. */
  readonly purpose: ClaimPurpose | null;
  /**
   * Sequences the model cites as having created the ambiguity.
   *
   * Only read for `resolving-ambiguity`. Each must name a real public event,
   * after the standing claim, of a kind that could plausibly cause it.
   */
  readonly ambiguityEventIds?: readonly number[];
  readonly publicLog: readonly PublicEvent[];
}

export interface ClaimVerdict {
  /** Null when nothing is wrong. */
  readonly problem: string | null;
  /** True when the claim repeats a standing one with no new public purpose. */
  readonly purposeless: boolean;
  readonly state: ClaimState;
  /** The cited events that were accepted. PRIVATE — trace and prompt only. */
  readonly acceptedAmbiguity: readonly AmbiguityEvent[];
  /** What was available to cite, whether or not the model used it. */
  readonly availableAmbiguity: readonly AmbiguityEvent[];
}

export function checkClaim(input: ClaimCheckInput): ClaimVerdict {
  const state = claimStateFor(input.seat, input.submittedClaim, input.publicLog);
  const available =
    state.since === null
      ? []
      : ambiguityEventsAfter(input.seat, state.since, input.publicLog);
  const base = { state, acceptedAmbiguity: [], availableAmbiguity: available };

  if (input.submittedClaim === null) {
    return { ...base, problem: null, purposeless: false };
  }

  const repeats = state.standing === input.submittedClaim && !input.retracting;
  if (!repeats) {
    // A first claim, a different role, or a re-entry after retraction. All
    // genuinely new public events; the purpose field is not interrogated.
    return { ...base, problem: null, purposeless: false };
  }

  const bad = (problem: string): ClaimVerdict => ({ ...base, problem, purposeless: true });

  if (input.purpose === null) {
    return bad(
      `你从 seq ${state.since} 起就一直挂着「${input.submittedClaim}」这个声称，` +
        "没人撤过它。要再报一次，必须写 `claimPurpose` 说明这一次是为了什么。",
    );
  }
  if (input.purpose === "first-claim") {
    return bad(
      `claimPurpose 写的是 first-claim，但你从 seq ${state.since} 起就已经有一个同样的声称在台面上了。`,
    );
  }
  if (input.purpose === "re-entering" && !state.retracted) {
    return bad("claimPurpose 写的是 re-entering，但公开记录里你从来没有退过水。");
  }
  if (input.purpose === "answering-challenge" && !state.contestedSince) {
    return bad(
      "claimPurpose 写的是 answering-challenge，但你上次报身份之后，" +
        "公开记录里没有人跳同一个身份，也没有人踩过你。",
    );
  }

  if (input.purpose === "resolving-ambiguity") {
    // EVIDENCE, NOT A QUOTA. See the note on `AmbiguityKind`: a numeric cap is
    // arbitrary in both directions, so what is asked for instead is a public
    // event, after the claim, of a kind that could actually cause the doubt.
    const cited = input.ambiguityEventIds ?? [];
    if (cited.length === 0) {
      return bad(
        available.length === 0
          ? `你在 seq ${state.since} 报过之后，公开记录里什么都没有发生过 —— ` +
            "没人跳身份、没人退水、没人踩你、也没有新的任务结果。没有可以澄清的歧义。"
          : "claimPurpose 写的是 resolving-ambiguity，但你没有指出是哪一件公开的事" +
            "让这个声称重新变得不清楚。填 `ambiguityEventIds`。",
      );
    }
    const accepted = available.filter((e) => cited.includes(e.sequence));
    if (accepted.length === 0) {
      return bad(
        "你指的那几件事里，没有一件是在你上次报身份之后发生的、" +
          "而且能让这个声称重新变得不清楚的公开事件。",
      );
    }
    return { ...base, problem: null, purposeless: false, acceptedAmbiguity: accepted };
  }

  return { ...base, problem: null, purposeless: false };
}

/* ── What to say instead ────────────────────────────────────────────────── */

/**
 * The repair note. Describes the record, quotes no private reasoning.
 *
 * Says what to do INSTEAD, because "don't" alone leaves the model with a
 * required field and no legal value — and the natural move is the one a person
 * makes: refer to the standing claim in words and leave `claim` null.
 */
export function claimRepairNote(verdict: ClaimVerdict): string {
  return [
    "",
    "## ⚠ 这个身份声称是重复的",
    "",
    verdict.problem ?? "",
    "",
    "**已经成立的声称不需要再报一次。** 把 `claim` 留空，" +
      "在话里自然地引用它就行 —— 「按我之前说的」「我还是那句话」。",
    "",
    "只有这三种情况才该再报一次：有人跳了同一个身份或者当面质疑你、" +
      "牌桌明显在当你没报过、或者你退过水现在要重新报。",
  ].join("\n");
}

/* ── The metric ─────────────────────────────────────────────────────────── */

export interface ClaimRealismMetric {
  /** Claim events this seat produced. */
  readonly claims: number;
  /** How many repeated a standing claim. */
  readonly repeats: number;
  /** How many of those carried no purpose the log supports. */
  readonly purposeless: number;
  readonly byPurpose: Readonly<Record<ClaimPurpose, number>>;
  /**
   * Ambiguity clarifications that cited a real, qualifying public event.
   *
   * PRIVATE, like every id here. The sequences are recorded for a reviewer and
   * rendered into the seat's own prompt; nothing writes them to a public field,
   * and the firewall refuses machine ids in speech from 0.6.0 onward.
   */
  readonly acceptedAmbiguity: number;
  /** `resolving-ambiguity` claims refused for citing nothing that qualifies. */
  readonly rejectedAmbiguity: number;
  /** The sequences actually accepted, in order. */
  readonly ambiguityEventIds: readonly number[];
}

export function emptyClaimMetric(): ClaimRealismMetric {
  return {
    claims: 0,
    repeats: 0,
    purposeless: 0,
    byPurpose: {
      "first-claim": 0,
      "answering-challenge": 0,
      "resolving-ambiguity": 0,
      "re-entering": 0,
    },
    acceptedAmbiguity: 0,
    rejectedAmbiguity: 0,
    ambiguityEventIds: [],
  };
}

/** Fold one decision's verdict into the running metric. */
export function foldClaimMetric(
  metric: ClaimRealismMetric,
  purpose: ClaimPurpose | null,
  verdict: ClaimVerdict,
): ClaimRealismMetric {
  const repeated = verdict.purposeless || verdict.acceptedAmbiguity.length > 0;
  const rejectedAmbiguity =
    purpose === "resolving-ambiguity" && verdict.purposeless ? 1 : 0;
  return {
    claims: metric.claims + 1,
    repeats: metric.repeats + (repeated ? 1 : 0),
    purposeless: metric.purposeless + (verdict.purposeless ? 1 : 0),
    byPurpose: purpose
      ? { ...metric.byPurpose, [purpose]: metric.byPurpose[purpose] + 1 }
      : metric.byPurpose,
    acceptedAmbiguity: metric.acceptedAmbiguity + (verdict.acceptedAmbiguity.length > 0 ? 1 : 0),
    rejectedAmbiguity: metric.rejectedAmbiguity + rejectedAmbiguity,
    ambiguityEventIds: [
      ...metric.ambiguityEventIds,
      ...verdict.acceptedAmbiguity.map((e) => e.sequence),
    ],
  };
}

/* ── The instruction ────────────────────────────────────────────────────── */

/**
 * What the seat is told about its own standing claim, if it has one.
 *
 * WRITTEN FROM THE PUBLIC LOG, so it states a fact rather than a policy: the
 * claim is already on the table and has not been withdrawn. A seat with nothing
 * standing gets the short form, because telling it not to repeat a claim it has
 * not made is noise in every prompt.
 *
 * When something HAS happened since, the qualifying sequences are listed. That
 * is the difference between "you may cite an ambiguity" and a field the model
 * has to guess at — and it is private: these are the seat's own prompt, never a
 * public message.
 */
export function claimPersistenceInstruction(observation: {
  readonly seat: Seat;
  readonly publicLog: readonly PublicEvent[];
}): string {
  const state = claimStateFor(observation.seat, null, observation.publicLog);
  if (state.standing === null) {
    return [
      "### 身份声称",
      "",
      "报不报身份都可以。**报过一次之后它就一直成立**，直到你自己退水 —— ",
      "不需要每次发言都再报一遍。",
    ].join("\n");
  }
  const available =
    state.since === null
      ? []
      : ambiguityEventsAfter(observation.seat, state.since, observation.publicLog);
  return [
    "### 你已经有一个成立中的身份声称",
    "",
    `你在 seq ${state.since} 公开声称过「${state.standing}」，到现在没有撤回过，**它一直成立**。`,
    "",
    "**不要再报一次。** 想用它就在话里自然地提：「按我之前说的」「我还是那句话」。",
    "把 `claim` 留空 —— 留空不等于收回，收回要填 `retractClaim`。",
    "",
    "只有这三种情况才该再报：有人跳了同一个身份或者当面质疑你（`answering-challenge`）、",
    "牌桌明显在当你没报过（`resolving-ambiguity`）、或者你退过水现在要重新报（`re-entering`）。",
    "`claimPurpose` 要说明是哪一种，**而且会拿公开记录核对**。",
    "",
    available.length > 0
      ? "填 `resolving-ambiguity` 的话，还要在 `ambiguityEventIds` 里指出是哪一件公开的事" +
        `让它变得不清楚。你上次报身份之后能引的有：${available
          .map((e) => `seq ${e.sequence}`)
          .join("、")}。`
      : "你上次报身份之后，公开记录里还没有发生过任何能造成歧义的事 —— " +
        "现在填 `resolving-ambiguity` 会被打回。",
  ].join("\n");
}
