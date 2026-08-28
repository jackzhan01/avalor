/**
 * 派权争夺 — the public record of who claimed what, when, and who fought about it.
 *
 * WHY THIS EXISTS. The M5.1 social layer assumes a table can identify who is
 * leading. A real high-level table often cannot, because several players are
 * simultaneously CLAIMING the same authority: Percival. Morgana pre-empts,
 * true Percival counterclaims, a Loyal servant claims for cover, Mordred claims
 * off a clean record. The interesting object is not "the leader" — it is the
 * CONTEST, and a contest has a history.
 *
 * REFEREE-OWNED, AND DERIVED ONLY FROM PUBLIC EVENTS. Every function here takes
 * `PublicEvent[]` and nothing else. There is no parameter through which hidden
 * role truth could enter, so a status in this file can never mean "this claim
 * is false" — only "this claim was contradicted by that public thing".
 *
 * A RETRACTION NEVER DELETES. `退水` moves a claim from `active` to `retracted`
 * and leaves everything attached to it: when it was made, what pair was told,
 * what teams and votes were asked for, who was attacked while it stood. That is
 * the whole point — a table evaluating a retraction needs the thing that was
 * retracted, and a registry that erased it would make "was that a planned cover
 * or a collapsed lie" unanswerable.
 *
 * WHAT IS NOT DERIVED HERE. Whether a retraction was clever, whether an attack
 * landed, whether a claimant is good. Those are model conclusions and live in
 * `contest.ts`, per seat, bounded, and private.
 *
 * IDs are `k…` and resolve through the same M5.1 registry that resolves `f…`,
 * `c…` and `p…`. A claim-contest EVENT is a fact (the referee saw it happen);
 * the CONTENT of a claim is not, and stays a `c…` claim id.
 */

import type { RoleType } from "@/lib/types/game";
import type { PublicEvent } from "../core/events";
import { deepFreeze } from "../core/freeze";
import type { Seat } from "../core/types";

/* ── Public status ──────────────────────────────────────────────────────── */

/**
 * What the table can see about one seat's claim, and nothing more.
 *
 * `contested` is a public fact — somebody publicly attacked it — not a verdict.
 * `implied` covers a seat that behaved as the pair-holder without saying the
 * word, and is only ever set from something the action format represents
 * EXPLICITLY (see `impliedFrom`); guessing at implication from prose would be
 * the keyword-matching Part J forbids.
 */
export type PublicClaimStatus =
  | "none"
  | "implied"
  | "active"
  | "contested"
  | "retracted";

export const CLAIM_STATUS_VALUES: readonly PublicClaimStatus[] = [
  "none",
  "implied",
  "active",
  "contested",
  "retracted",
];

/* ── Events ─────────────────────────────────────────────────────────────── */

/**
 * One thing that publicly happened in the contest.
 *
 * Each carries the sequence it happened at, so the whole registry is
 * reconstructible in order and every id is deterministic across replay.
 */
export type ContestEvent =
  | {
      readonly kind: "claim";
      readonly id: string;
      readonly sequence: number;
      readonly seat: Seat;
      readonly claimed: RoleType;
      /** True when this seat had already claimed something and is now changing. */
      readonly repeat: boolean;
      /** True when at least one other seat was already standing on this role. */
      readonly counter: boolean;
    }
  | {
      readonly kind: "retract";
      readonly id: string;
      readonly sequence: number;
      readonly seat: Seat;
      /** What was being stood on at the moment of withdrawal. */
      readonly retracted: RoleType;
      /** The sequence of the claim being withdrawn. */
      readonly claimSequence: number;
    }
  | {
      /** A claimant asked the table for a specific team while claiming. */
      readonly kind: "team_ask";
      readonly id: string;
      readonly sequence: number;
      readonly seat: Seat;
      readonly team: readonly Seat[] | null;
      readonly noTeamYet: boolean;
    }
  | {
      /**
       * A public stance BY a claimant ABOUT another claimant.
       *
       * Derived from `stances`, which is a structured field the action format
       * already carries — not from reading the speech text. `valence < 0` is an
       * attack and `> 0` is an endorsement; exactly zero is "I explicitly
       * cannot tell", which is neither.
       */
      readonly kind: "claimant_stance";
      readonly id: string;
      readonly sequence: number;
      readonly from: Seat;
      readonly to: Seat;
      readonly direction: "attack" | "endorse";
      readonly valence: number;
      readonly confidence: number;
      /** True when the speaker was itself standing on a claim at the time. */
      readonly fromClaimant: boolean;
    }
  | {
      /** A non-claimant publicly took a side about a claimant. */
      readonly kind: "bystander_stance";
      readonly id: string;
      readonly sequence: number;
      readonly from: Seat;
      readonly to: Seat;
      readonly direction: "attack" | "endorse";
      readonly valence: number;
      readonly confidence: number;
    };

/* ── One seat's public claim history ────────────────────────────────────── */

export interface ClaimRecord {
  readonly seat: Seat;
  readonly status: PublicClaimStatus;
  /** What they are standing on now, or what they last stood on. */
  readonly claimed: RoleType | null;
  readonly firstClaimSequence: number | null;
  readonly lastClaimSequence: number | null;
  readonly retractedAtSequence: number | null;
  /** Every claim this seat has ever made, oldest first. Never pruned. */
  readonly history: readonly {
    readonly claimed: RoleType;
    readonly sequence: number;
    readonly retractedAtSequence: number | null;
  }[];
  /** Teams asked for while standing on a claim. */
  readonly teamAsks: readonly { readonly sequence: number; readonly team: readonly Seat[] | null }[];
  /** Seats this claimant publicly attacked while claiming. */
  readonly attacked: readonly Seat[];
  /** Seats that publicly attacked this claimant. */
  readonly attackedBy: readonly Seat[];
  /** Seats that publicly endorsed this claimant. */
  readonly endorsedBy: readonly Seat[];
}

export interface ClaimContest {
  readonly events: readonly ContestEvent[];
  readonly bySeat: Readonly<Partial<Record<Seat, ClaimRecord>>>;
  /** Seats currently standing on a `percival` claim. The contest itself. */
  readonly activePercivalClaimants: readonly Seat[];
  /** Seats that stood on `percival` and withdrew. */
  readonly retractedPercivalClaimants: readonly Seat[];
  readonly atSequence: number;
}

/* ── Ids ────────────────────────────────────────────────────────────────── */

export const contestEventId = (kind: string, sequence: number, suffix = ""): string =>
  `k${sequence}:${kind}${suffix ? `:${suffix}` : ""}`;

/* ── Derivation ─────────────────────────────────────────────────────────── */

/**
 * Does this speech IMPLY a Percival claim without saying it?
 *
 * Deliberately narrow, and deliberately structural. The only thing the action
 * format represents explicitly enough to count is a seat that publicly takes
 * opposite stances on exactly two other seats in the same speech — the shape of
 * "one of these two is Merlin and one is Morgana" — while claiming nothing.
 *
 * This is a WEAK signal and it is labelled `implied`, never `active`. Reading
 * implication out of the prose would be the brittle keyword matching Part J
 * forbids, and the failure mode is bad in a specific way: it would let a
 * confident phrase become a public fact.
 */
export function impliedFrom(event: PublicEvent): boolean {
  if (event.type !== "speech") return false;
  if (event.claim != null) return false;
  const opinionated = event.stances.filter((s) => s.valence !== 0);
  if (opinionated.length !== 2) return false;
  const [a, b] = opinionated;
  // Opposite signs: one protected, one suspected, and nobody else named.
  return a.valence * b.valence < 0;
}

const other = (a: readonly Seat[], seat: Seat) => (a.includes(seat) ? a : [...a, seat]);

/**
 * Build the whole contest from the public log.
 *
 * Pure and total: same log in, same registry out, every id derived from a
 * sequence number. That is what lets a constraint written before a checkpoint
 * still resolve after a resume.
 */
export function claimContestFrom(log: readonly PublicEvent[]): ClaimContest {
  const events: ContestEvent[] = [];
  const records = new Map<Seat, ClaimRecord>();

  const blank = (seat: Seat): ClaimRecord => ({
    seat,
    status: "none",
    claimed: null,
    firstClaimSequence: null,
    lastClaimSequence: null,
    retractedAtSequence: null,
    history: [],
    teamAsks: [],
    attacked: [],
    attackedBy: [],
    endorsedBy: [],
  });
  const get = (seat: Seat): ClaimRecord => records.get(seat) ?? blank(seat);
  const standing = (seat: Seat): boolean => {
    const r = records.get(seat);
    return r ? r.status === "active" || r.status === "contested" : false;
  };

  for (const event of log) {
    if (event.type !== "speech") continue;
    const speaker = event.speaker;

    /* ── A claim ────────────────────────────────────────────────────────── */
    if (event.claim != null) {
      const mine = get(speaker);
      const rivals = [...records.values()].filter(
        (r) => r.seat !== speaker && r.claimed === event.claim && (r.status === "active" || r.status === "contested"),
      );
      events.push({
        kind: "claim",
        id: contestEventId("claim", event.sequence),
        sequence: event.sequence,
        seat: speaker,
        claimed: event.claim,
        repeat: mine.history.length > 0,
        counter: rivals.length > 0,
      });
      // Superseding an own standing claim closes the old one as of now. The old
      // one stays in `history` — a seat that claimed Merlin and later claimed
      // Percival has told the table two different things, and both matter.
      const history = mine.history.map((h) =>
        h.retractedAtSequence === null && mine.status !== "retracted"
          ? { ...h, retractedAtSequence: event.sequence }
          : h,
      );
      records.set(speaker, {
        ...mine,
        status: "active",
        claimed: event.claim,
        firstClaimSequence: mine.firstClaimSequence ?? event.sequence,
        lastClaimSequence: event.sequence,
        retractedAtSequence: null,
        history: [...history, { claimed: event.claim, sequence: event.sequence, retractedAtSequence: null }],
      });
      // A counterclaim makes BOTH sides contested: the table now has two
      // people standing on one identity, and neither is unchallenged.
      for (const rival of rivals) {
        records.set(rival.seat, { ...records.get(rival.seat)!, status: "contested" });
      }
      if (rivals.length > 0) {
        records.set(speaker, { ...records.get(speaker)!, status: "contested" });
      }
    } else if (impliedFrom(event) && get(speaker).status === "none") {
      // Only ever upgrades `none`. An implied signal never overrides a spoken
      // claim, in either direction.
      records.set(speaker, { ...get(speaker), status: "implied" });
    }

    /* ── A retraction ───────────────────────────────────────────────────── */
    if (event.retractClaim === true) {
      const mine = get(speaker);
      const open = [...mine.history].reverse().find((h) => h.retractedAtSequence === null);
      events.push({
        kind: "retract",
        id: contestEventId("retract", event.sequence),
        sequence: event.sequence,
        seat: speaker,
        retracted: (open?.claimed ?? mine.claimed) as RoleType,
        claimSequence: open?.sequence ?? mine.lastClaimSequence ?? event.sequence,
      });
      records.set(speaker, {
        ...mine,
        status: "retracted",
        retractedAtSequence: event.sequence,
        history: mine.history.map((h) =>
          h.retractedAtSequence === null ? { ...h, retractedAtSequence: event.sequence } : h,
        ),
      });
    }

    /* ── A team ask, if the speaker was standing on a claim ─────────────── */
    if (standing(speaker) && (event.tentativeTeam !== null || event.noTeamYet)) {
      events.push({
        kind: "team_ask",
        id: contestEventId("team", event.sequence),
        sequence: event.sequence,
        seat: speaker,
        team: event.tentativeTeam,
        noTeamYet: event.noTeamYet,
      });
      const mine = get(speaker);
      records.set(speaker, {
        ...mine,
        teamAsks: [...mine.teamAsks, { sequence: event.sequence, team: event.tentativeTeam }],
      });
    }

    /* ── Stances about claimants ────────────────────────────────────────── */
    for (const stance of event.stances) {
      const target = records.get(stance.seat);
      if (!target || target.status === "none") continue;
      if (stance.valence === 0) continue;
      const direction = stance.valence < 0 ? "attack" : "endorse";
      const fromClaimant = standing(speaker);
      events.push({
        kind: fromClaimant ? "claimant_stance" : "bystander_stance",
        id: contestEventId(fromClaimant ? "rival" : "side", event.sequence, String(stance.seat)),
        sequence: event.sequence,
        from: speaker,
        to: stance.seat,
        direction,
        valence: stance.valence,
        confidence: stance.confidence,
        ...(fromClaimant ? { fromClaimant: true } : {}),
      } as ContestEvent);

      const updated = records.get(stance.seat)!;
      records.set(stance.seat, {
        ...updated,
        attackedBy: direction === "attack" ? other(updated.attackedBy, speaker) : updated.attackedBy,
        endorsedBy: direction === "endorse" ? other(updated.endorsedBy, speaker) : updated.endorsedBy,
      });
      if (fromClaimant && direction === "attack") {
        const mine = records.get(speaker) ?? blank(speaker);
        records.set(speaker, { ...mine, attacked: other(mine.attacked, stance.seat) });
        // Being publicly attacked is what `contested` means. It is a fact about
        // the table, not a judgement about the claim.
        const hit = records.get(stance.seat)!;
        if (hit.status === "active") records.set(stance.seat, { ...hit, status: "contested" });
      }
    }
  }

  const bySeat: Partial<Record<Seat, ClaimRecord>> = {};
  for (const [seat, record] of [...records.entries()].sort((a, b) => a[0] - b[0])) {
    bySeat[seat] = record;
  }
  const percival = (status: readonly PublicClaimStatus[]) =>
    [...records.values()]
      .filter((r) => r.claimed === "percival" && status.includes(r.status))
      .map((r) => r.seat)
      .sort((a, b) => a - b);

  return deepFreeze({
    events,
    bySeat,
    activePercivalClaimants: percival(["active", "contested"]),
    retractedPercivalClaimants: percival(["retracted"]),
    atSequence: log.length,
  });
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

const tag = (id: string) => `\`[${id}]\``;
const seatList = (seats: readonly Seat[]) => seats.join("、");

const STATUS_LABEL: Readonly<Record<PublicClaimStatus, string>> = {
  none: "没声称过",
  implied: "行为上暗示过（没说出口）",
  active: "声称成立中",
  contested: "声称成立中，但有人公开质疑",
  retracted: "已退水",
};

/**
 * The contest as a table, with ids.
 *
 * Rendered from the referee's own derivation, so every line is quotable as a
 * premise. Note what each line says and does not say: "8号 在 seq 12 声称
 * percival" is a fact; "8号 是 percival" is not, and no line here asserts it.
 */
export function renderClaimContest(contest: ClaimContest): string {
  const lines: string[] = ["## 身份声称与派权争夺（裁判记录了「谁说过什么」，没记录「谁是什么」）"];

  const records = Object.values(contest.bySeat).filter(
    (r): r is ClaimRecord => Boolean(r) && r!.status !== "none",
  );
  if (records.length === 0) {
    lines.push("", "（还没有人声称身份，也没有人做出可以被当成暗示的公开表态）");
    return lines.join("\n");
  }

  lines.push("", "### 每个人的声称历史");
  for (const r of records) {
    lines.push(
      `- ${r.seat}号：**${STATUS_LABEL[r.status]}**` +
        (r.claimed ? `，最近声称的是 ${r.claimed}` : ""),
    );
    for (const h of r.history) {
      const claimEvent = contest.events.find(
        (e) => e.kind === "claim" && e.sequence === h.sequence,
      );
      lines.push(
        `    ${claimEvent ? `${tag(claimEvent.id)} ` : ""}seq ${h.sequence} 声称 ${h.claimed}` +
          (h.retractedAtSequence !== null ? `，seq ${h.retractedAtSequence} 不再成立` : ""),
      );
    }
    const retraction = contest.events.find(
      (e) => e.kind === "retract" && e.seat === r.seat,
    );
    if (retraction && retraction.kind === "retract") {
      lines.push(
        `    ${tag(retraction.id)} seq ${retraction.sequence} **公开退水**` +
          `（退的是 seq ${retraction.claimSequence} 那次 ${retraction.retracted}）`,
      );
    }
    for (const ask of r.teamAsks) {
      lines.push(
        `    声称期间要过车：${ask.team ? `${seatList(ask.team)}号` : "明说组不出车"}（seq ${ask.sequence}）`,
      );
    }
    if (r.attacked.length > 0) lines.push(`    声称期间公开踩过：${seatList(r.attacked)}号`);
    if (r.attackedBy.length > 0) lines.push(`    被公开踩过：${seatList(r.attackedBy)}号`);
    if (r.endorsedBy.length > 0) lines.push(`    被公开保过：${seatList(r.endorsedBy)}号`);
  }

  const contestEvents = contest.events.filter(
    (e) => e.kind === "claimant_stance" || e.kind === "bystander_stance",
  );
  if (contestEvents.length > 0) {
    lines.push("", "### 围绕声称者的公开表态");
    for (const e of contestEvents) {
      if (e.kind !== "claimant_stance" && e.kind !== "bystander_stance") continue;
      const who = e.kind === "claimant_stance" ? "（他自己也在声称）" : "";
      lines.push(
        `- ${tag(e.id)} ${e.from}号 ${e.direction === "attack" ? "踩" : "保"} ${e.to}号` +
          `（valence ${e.valence}，confidence ${e.confidence}）${who}`,
      );
    }
  }

  lines.push("", "### 现在的派权局面");
  if (contest.activePercivalClaimants.length === 0) {
    lines.push("- 目前没有人站在派西维尔这个身份上");
  } else {
    lines.push(
      `- 正在争派西维尔的：**${seatList(contest.activePercivalClaimants)}号**` +
        `（${contest.activePercivalClaimants.length} 个人）`,
    );
  }
  if (contest.retractedPercivalClaimants.length > 0) {
    lines.push(`- 声称过派西维尔又退水的：${seatList(contest.retractedPercivalClaimants)}号`);
  }
  lines.push(
    "- **同时有几个人声称同一个身份，本身不说明谁真谁假** —— 裁判只记录了他们说过。",
  );

  return lines.join("\n");
}

/* ── Queries the private layer needs ────────────────────────────────────── */

/** Was this seat standing on a claim at `sequence`? Used by consistency checks. */
export function wasClaimingAt(contest: ClaimContest, seat: Seat, sequence: number): boolean {
  const r = contest.bySeat[seat];
  if (!r) return false;
  return r.history.some(
    (h) => h.sequence <= sequence && (h.retractedAtSequence === null || h.retractedAtSequence > sequence),
  );
}

/** Every seat that has ever claimed anything, whether or not it still stands. */
export function everyClaimant(contest: ClaimContest): Seat[] {
  return Object.values(contest.bySeat)
    .filter((r): r is ClaimRecord => Boolean(r) && r!.history.length > 0)
    .map((r) => r.seat)
    .sort((a, b) => a - b);
}

/** Seats currently standing on any claim. */
export function standingClaimants(contest: ClaimContest): Seat[] {
  return Object.values(contest.bySeat)
    .filter(
      (r): r is ClaimRecord =>
        Boolean(r) && (r!.status === "active" || r!.status === "contested"),
    )
    .map((r) => r.seat)
    .sort((a, b) => a - b);
}
