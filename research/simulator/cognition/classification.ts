/**
 * Who may hear a thing, and through which act it may ever become public.
 *
 * SYSTEM-OWNED. Every label in this file is computed from the referee's own
 * data — an id's shape, the registry entry behind it, the seat's observation.
 * Nothing here reads a model-written field, and nothing the model writes can
 * change a label. That is the whole design: the M5.2 pilot asked the model to
 * record `informationToConceal`, the model filled it in honestly every single
 * turn, and it published the pair anyway. A secret the speaker gets to define
 * is not a secret, it is a note.
 *
 * WHY IT IS A SEPARATE FILE FROM `fact-ids.ts`. The registry answers "may this
 * seat cite this id". This answers "may the TABLE hear it". Those two came
 * apart in exactly the way that produced 「7、9一梅林一莫甘娜」: `p.pair` was a
 * perfectly legal premise for seat 8 to reason from, and an illegal thing for
 * seat 8 to say. One function cannot hold both meanings without one of them
 * quietly winning.
 *
 * DERIVED CONSTRAINTS INHERIT. A conclusion is as private as its most private
 * premise — `strongestOf` is that rule. It is the mirror of the ledger's
 * existing "a conclusion is at most as hard as its weakest premise": hardness
 * and privacy travel in opposite directions along the same edges.
 */

import type { Phase } from "../core/state";
import type { Seat, Side } from "../core/types";
import type { FactIdKind, VisibleFactRegistry } from "./fact-ids";
import { PRIVATE_IDS, LEGACY_OWN_ROLE_ID } from "./fact-ids";

/* ── Channels ───────────────────────────────────────────────────────────── */

/**
 * Where a piece of information is allowed to travel.
 *
 * Ordered below by how RESTRICTIVE each is, which is not the same as by how
 * many people it reaches — `phase-authorised` reaches the whole table, but
 * only after a legal act, and that gate is what makes it different from
 * `table-public` rather than the size of its audience.
 */
export type VisibilityChannel =
  /** The table hears it. Everything in the public log is already here. */
  | "table-public"
  /** One seat only. The deal-dependent layer of that seat's prompt. */
  | "seat-private"
  /** The evil seats, and only in a phase where the rules let them talk. */
  | "evil-council"
  /**
   * Public, but ONLY once a specific legal action has been taken.
   *
   * The Lady result is the case that matters. The holder knows the truth; the
   * table learns a value only through `lady_announce`, and the announced value
   * may be a lie. What the act declassifies is the ANNOUNCEMENT, never the
   * referee's answer — so ordinary speech cannot declassify it at all.
   */
  | "phase-authorised"
  /** Revealed by the rules when the game ends. Not one moment before. */
  | "postgame-public";

/**
 * How restrictive a channel is. Higher wins when premises are combined.
 *
 * `evil-council` outranks `phase-authorised` because a phase gate can be
 * opened by an act available to the speaker, and membership of the evil team
 * cannot be opened by anything.
 */
const CHANNEL_RANK: Readonly<Record<VisibilityChannel, number>> = {
  "table-public": 0,
  "postgame-public": 1,
  "phase-authorised": 2,
  "evil-council": 3,
  "seat-private": 4,
};

/* ── Secret classes ─────────────────────────────────────────────────────── */

/**
 * What KIND of secret this is, when it is one.
 *
 * Separate from the channel because two things can share a channel and need
 * different handling. This seat's own role and this seat's Percival pair are
 * both `seat-private`, but only one of them is a fact about somebody else, and
 * only one of them narrows Merlin to two seats when it leaks.
 */
export type SecretClass =
  /** This seat's own role. Declassifiable — a claim is a legal public act. */
  | "private-role"
  /** Percival's two candidates. The M5.3 headline. NEVER declassifiable. */
  | "private-percival-pair"
  /** Merlin's visible evil. Never declassifiable as a complete set. */
  | "private-merlin-vision"
  /** An evil seat's known teammates, or the revealed roster. */
  | "private-evil-roster"
  /** What the Lady actually showed. Only the ANNOUNCEMENT ever goes public. */
  | "private-lady-result"
  /** The seat's own ledger: hypotheses, dossiers, plans, premise bookkeeping. */
  | "private-cognition"
  /** A deliberately false public story. Publishing it defeats its purpose. */
  | "private-cover-plan";

/**
 * Every secret class, as a fixed list.
 *
 * WHY A CONSTANT AND NOT THE SEAT'S ACTUAL HOLDINGS. The public spokesperson
 * has to be told what kind of thing it must never write. Telling it the
 * classes THIS seat actually holds would leak the role: "you hold a Merlin
 * vision" is a complete identification, and "you hold a Percival pair" narrows
 * it to one seat. The role-substitution non-interference test catches exactly
 * that, and it caught it in development.
 *
 * So stage 2 is told the same list every time, for every seat, in every game —
 * which is both byte-invariant and true: none of these may appear in a public
 * sentence, whoever is speaking. The seat's ACTUAL holdings are recorded in the
 * private audit, where they belong.
 */
export const ALL_SECRET_CLASSES: readonly SecretClass[] = [
  "private-role",
  "private-percival-pair",
  "private-merlin-vision",
  "private-evil-roster",
  "private-lady-result",
  "private-cognition",
  "private-cover-plan",
];

/* ── The label ──────────────────────────────────────────────────────────── */

/** How, if at all, a thing may legally become public. */
export interface Declassification {
  readonly permitted: boolean;
  /**
   * The action that does it, when one exists.
   *
   * A STRING NAMING A LEGAL ACT, never a permission the model can assert. The
   * point of naming it is that the firewall can check the act actually
   * happened in the same answer.
   */
  readonly viaAction: string | null;
  /** What that act publishes. Deliberately narrower than the secret itself. */
  readonly publishes: string | null;
}

export interface Classification {
  readonly channel: VisibilityChannel;
  /** The seats entitled to it. `null` means every seat. */
  readonly authorisedSeats: readonly Seat[] | null;
  /** The side entitled to it, when the entitlement is by side. */
  readonly authorisedSide: Side | null;
  /** The phases in which it may be spoken at all. `null` means any. */
  readonly authorisedPhases: readonly Phase[] | null;
  readonly secretClass: SecretClass | null;
  readonly declassification: Declassification;
}

const PUBLIC: Classification = {
  channel: "table-public",
  authorisedSeats: null,
  authorisedSide: null,
  authorisedPhases: null,
  secretClass: null,
  declassification: { permitted: true, viaAction: null, publishes: null },
};

const NEVER: Declassification = { permitted: false, viaAction: null, publishes: null };

function seatPrivate(
  seat: Seat,
  secretClass: SecretClass,
  declassification: Declassification = NEVER,
): Classification {
  return {
    channel: "seat-private",
    authorisedSeats: [seat],
    authorisedSide: null,
    authorisedPhases: null,
    secretClass,
    declassification,
  };
}

/* ── Classifying an id ──────────────────────────────────────────────────── */

/**
 * The label for one fact id, as this seat's registry knows it.
 *
 * Reads the registry ENTRY rather than the id string wherever it can, so a
 * renamed id cannot silently downgrade itself. The string is consulted only to
 * tell the private ids apart from one another — they all share `kind:
 * "private-fact"`, and which secret they are is what decides whether any legal
 * public act exists for them.
 */
export function classifyFactId(
  registry: VisibleFactRegistry,
  id: string,
): Classification {
  const entry = registry.byId.get(id);
  if (!entry) {
    // Unknown to this seat. Treated as maximally private rather than as
    // nonexistent: an id the seat cannot resolve is one it must not be
    // repeating in public either, and the firewall wants one answer here.
    return {
      channel: "seat-private",
      authorisedSeats: [],
      authorisedSide: null,
      authorisedPhases: null,
      secretClass: null,
      declassification: NEVER,
    };
  }
  return classifyEntry(registry.seat, id, entry.kind);
}

/** The same decision, from a kind rather than a lookup. Exported for tests. */
export function classifyEntry(seat: Seat, id: string, kind: FactIdKind): Classification {
  switch (kind) {
    case "public-fact":
    case "derived-fact":
    case "contest-event":
    case "claim":
      return PUBLIC;
    case "private-fact":
      return classifyPrivateId(seat, id);
  }
}

function classifyPrivateId(seat: Seat, id: string): Classification {
  switch (id) {
    case PRIVATE_IDS.self:
    case LEGACY_OWN_ROLE_ID:
      // The one private thing with a legal public act attached. Note what the
      // act publishes: a CLAIM, which the table may disbelieve. Claiming
      // Percival publishes "he says he is Percival" and nothing else — in
      // particular it does not publish the pair, which is the entire point of
      // this milestone.
      return seatPrivate(seat, "private-role", {
        permitted: true,
        viaAction: "speech.claim",
        publishes: "一个身份声称 —— 只是「他这么说」，不是任何私有信息的内容",
      });
    case PRIVATE_IDS.percivalPair:
      return seatPrivate(seat, "private-percival-pair");
    case PRIVATE_IDS.seesEvil:
      return seatPrivate(seat, "private-merlin-vision");
    case PRIVATE_IDS.teammates:
    case PRIVATE_IDS.evilRoster:
      return {
        channel: "evil-council",
        authorisedSeats: [seat],
        authorisedSide: "evil",
        authorisedPhases: [
          "assassination_reveal",
          "assassination_discuss",
          "assassination_strike",
        ],
        secretClass: "private-evil-roster",
        declassification: NEVER,
      };
    default:
      break;
  }
  if (id.startsWith("p.lady")) {
    return {
      channel: "phase-authorised",
      authorisedSeats: [seat],
      authorisedSide: null,
      authorisedPhases: ["lady_announce"],
      secretClass: "private-lady-result",
      declassification: {
        permitted: true,
        viaAction: "lady_announce",
        publishes:
          "宣布的那个值 —— 而且宣布的值可以是假的。公开的是「他宣布了什么」，不是裁判给他的真实结果",
      },
    };
  }
  // A private id nobody enumerated. Private, and no act opens it.
  return seatPrivate(seat, "private-cognition");
}

/* ── Combination ────────────────────────────────────────────────────────── */

/**
 * The label a conclusion drawn from these premises carries.
 *
 * Most restrictive wins, on every axis independently: the channel by rank, the
 * seats by intersection, the phases by intersection, and declassification only
 * if EVERY premise permits it — a conclusion mixing a declassifiable premise
 * with a permanent secret is a permanent secret.
 *
 * The empty list is `table-public`: a conclusion resting on nothing private is
 * not private. That is the correct default and it is also the dangerous one,
 * which is why `publicBasisIds` is resolved against a public-only registry
 * before any of it reaches here.
 */
export function strongestOf(classifications: readonly Classification[]): Classification {
  if (classifications.length === 0) return PUBLIC;

  let channel: VisibilityChannel = "table-public";
  for (const c of classifications) {
    if (CHANNEL_RANK[c.channel] > CHANNEL_RANK[channel]) channel = c.channel;
  }

  let seats: readonly Seat[] | null = null;
  for (const c of classifications) {
    const allowed = c.authorisedSeats;
    if (allowed === null) continue;
    seats = seats === null ? allowed : seats.filter((s) => allowed.includes(s));
  }

  let phases: readonly Phase[] | null = null;
  for (const c of classifications) {
    const allowed = c.authorisedPhases;
    if (allowed === null) continue;
    phases = phases === null ? allowed : phases.filter((p) => allowed.includes(p));
  }

  let side: Side | null = null;
  for (const c of classifications) {
    if (c.authorisedSide === null) continue;
    // Two premises restricted to opposite sides leave nobody, which the seat
    // intersection above already records as an empty list.
    side = side === null || side === c.authorisedSide ? c.authorisedSide : side;
  }

  // The strongest secret class present, ranked so the pair — the one this
  // milestone exists for — never loses to a weaker label sharing the premises.
  const secretClass = strongestSecret(classifications.map((c) => c.secretClass));

  const everyPremisePermits = classifications.every((c) => c.declassification.permitted);
  const named = classifications.find((c) => c.declassification.viaAction !== null);
  const declassification: Declassification = everyPremisePermits
    ? (named?.declassification ?? { permitted: true, viaAction: null, publishes: null })
    : NEVER;

  return {
    channel,
    authorisedSeats: seats,
    authorisedSide: side,
    authorisedPhases: phases,
    secretClass,
    declassification,
  };
}

const SECRET_RANK: Readonly<Record<SecretClass, number>> = {
  "private-cover-plan": 1,
  "private-cognition": 2,
  "private-role": 3,
  "private-lady-result": 4,
  "private-evil-roster": 5,
  "private-merlin-vision": 6,
  "private-percival-pair": 7,
};

export function strongestSecret(
  classes: readonly (SecretClass | null)[],
): SecretClass | null {
  let best: SecretClass | null = null;
  for (const c of classes) {
    if (c === null) continue;
    if (best === null || SECRET_RANK[c] > SECRET_RANK[best]) best = c;
  }
  return best;
}

/* ── Questions the firewall asks ────────────────────────────────────────── */

/** May this classification's content reach the whole table, right now? */
export function reachesTablePublic(
  classification: Classification,
  phase: Phase,
): boolean {
  if (classification.channel === "table-public") return true;
  if (classification.channel === "phase-authorised") {
    return (
      classification.declassification.permitted &&
      (classification.authorisedPhases === null ||
        classification.authorisedPhases.includes(phase))
    );
  }
  return false;
}

/** Is this id safe to hand a spokesperson as a public basis? */
export function isPublicBasis(registry: VisibleFactRegistry, id: string): boolean {
  return classifyFactId(registry, id).channel === "table-public";
}

/** Human labels, for the audit record and the review package. */
export const CHANNEL_LABELS: Readonly<Record<VisibilityChannel, string>> = {
  "table-public": "牌桌公开",
  "seat-private": "座位私有",
  "evil-council": "坏人密谈",
  "phase-authorised": "需合法动作解密",
  "postgame-public": "局终公开",
};

export const SECRET_LABELS: Readonly<Record<SecretClass, string>> = {
  "private-role": "自己的身份",
  "private-percival-pair": "派西维尔候选对",
  "private-merlin-vision": "梅林视野",
  "private-evil-roster": "坏人名单",
  "private-lady-result": "女神真实结果",
  "private-cognition": "私有推理记录",
  "private-cover-plan": "掩护故事",
};
