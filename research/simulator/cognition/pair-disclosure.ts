/**
 * The diluted pair channel, and why blocking the sentence was not enough.
 *
 * M5.3 built a firewall because the 0.4.0 Percival said 「7、9一梅林一莫甘娜」 in
 * public — the private pair, verbatim. The firewall stops that sentence. The
 * live 0.6.0 game shows what it does not stop. Seat 8, the true Percival,
 * opened with:
 *
 *     「8、1、3只是意向车：1、3、7、9我都看不清」
 *
 * Seats 7 and 9 were Morgana and Merlin. He named four seats as unreadable and
 * two of them were the pair. Nothing about that sentence states a relation, so
 * every rule in `firewall.ts` passes it — and an Assassin who believes Percival
 * is honest has been handed a four-seat set containing Merlin, which is a 25%
 * kill against a 1-in-6 baseline. The padding is the whole disclosure: the
 * smaller the group, the more it gives away.
 *
 * WHAT IS AND IS NOT A GROUPING. This file draws one line and defends it:
 *
 *   A GROUPING is an EPISTEMIC or IDENTITY statement about a set of seats —
 *   「这几个我看不清」, 「我重点比较 3、7、9」, 「这四个人里最可疑的」. It says
 *   something about what the speaker KNOWS or SUSPECTS.
 *
 *   A TEAM LIST is not. 「我提 8、1、3」, 「二轮 2、4、6、7 出了两张失败」 —
 *   these are proposals and referee facts. Blocking them would make Percival
 *   unable to play, and a firewall that forces silence is a firewall nobody
 *   keeps switched on. The whole M5.3 lesson is that the private plan and the
 *   public wording are separable; that stays true here.
 *
 * CUMULATIVE NARROWING IS THE HARDER HALF. One 「5、6、7、9」 and one
 * 「3、7、8、9」 each look innocent; their intersection is exactly {7, 9}. So
 * the check runs over this seat's OWN prior public groupings, taken from the
 * public log, and refuses a sentence whose intersection with them closes on a
 * small pair-containing set. Reading them back from the log rather than from
 * remembered state keeps the check reproducible from an artifact alone.
 *
 * THE SPOKESPERSON NEVER SEES ANY OF THIS. It runs on the finished sentence,
 * inside `validatePublicMessage`, on the private side of the wall. A rejection
 * produces a byte-identical retry with NO note — the same rule as every other
 * disclosure refusal, and for the same reason: the note would have to say which
 * seats not to group, which is the secret.
 */

import type { Observation } from "../core/observation";
import type { PublicEvent } from "../core/events";
import type { Seat } from "../core/types";

/* ── Reading a grouping out of a sentence ───────────────────────────────── */

/**
 * The words that turn a list of seats into a statement about knowledge.
 *
 * A CLOSED LIST, and short on purpose. Every entry is a phrase the completed
 * games actually produced, and the cost of a miss is a telemetry line rather
 * than a leak that cannot be undone — the group-size metric records near
 * misses so the list can be extended from evidence instead of imagination.
 */
const EPISTEMIC_MARKERS: readonly string[] = [
  "看不清",
  "分不清",
  "看不出",
  "分不出",
  "不确定",
  "拿不准",
  "最可疑",
  "更可疑",
  "怀疑",
  "重点比较",
  "重点看",
  "重点盯",
  "这几个",
  "这四个",
  "这三个",
  "这两个",
  "里面有",
  "其中一个",
  "其中之一",
  "二选一",
  "一好一坏",
];

/**
 * A clause that names seats AND says something epistemic about them.
 *
 * Split on sentence punctuation first, because a message may legitimately hold
 * a team list in one clause and a knowledge statement in another — 「我提 8、1、3；
 * 7、9 我看不清」 must be caught on the second clause and not excused by the
 * first, and must not be reported as a six-seat group either.
 */
export interface SeatGrouping {
  readonly seats: readonly Seat[];
  /** Which marker made it a grouping. For telemetry, never for a prompt. */
  readonly marker: string;
}

const CLAUSE_SPLIT = /[。；;！!？?\n]+/;

/** Seat numbers inside one clause: `7号`, `7、9`, `1，3`. */
function seatsIn(clause: string): Seat[] {
  const out = new Set<number>();
  // `7号` and the bare runs `1、3、7、9` that Chinese Avalon speech uses.
  for (const m of clause.matchAll(/(\d{1,2})\s*号/g)) out.add(Number(m[1]));
  for (const run of clause.matchAll(/(?:\d{1,2}\s*[、,，和与]\s*){1,}\d{1,2}/g)) {
    for (const m of run[0].matchAll(/\d{1,2}/g)) out.add(Number(m[0]));
  }
  return [...out].filter((n): n is Seat => n >= 1 && n <= 10).sort((a, b) => a - b);
}

/**
 * Every epistemic grouping in one public message.
 *
 * Returns [] for a message that names seats without saying anything about
 * knowing them — which is most messages, and deliberately so.
 */
export function groupingsIn(message: string): SeatGrouping[] {
  const out: SeatGrouping[] = [];
  for (const clause of message.split(CLAUSE_SPLIT)) {
    const marker = EPISTEMIC_MARKERS.find((m) => clause.includes(m));
    if (!marker) continue;
    const seats = seatsIn(clause);
    if (seats.length < 2) continue;
    out.push({ seats, marker });
  }
  return out;
}

/* ── The verdict ────────────────────────────────────────────────────────── */

/** Groups this size or smaller are refused when they hold the whole pair. */
export const MAX_SAFE_GROUP = 4;

export type PairRisk =
  /** Refuse the sentence. */
  | {
      readonly kind: "grouping" | "cumulative";
      readonly groupSize: number;
      readonly marker: string;
      readonly rule: string;
    };

export interface PairCheckInput {
  readonly message: string;
  readonly observation: Observation;
}

/** This seat's own prior public groupings, from the log it can already see. */
export function priorGroupings(observation: Observation): SeatGrouping[] {
  const out: SeatGrouping[] = [];
  for (const event of observation.publicLog as readonly PublicEvent[]) {
    if (event.type !== "speech") continue;
    if (event.speaker !== observation.seat) continue;
    out.push(...groupingsIn(event.publicMessage));
  }
  return out;
}

/**
 * Does this sentence narrow the pair — now, or together with what came before?
 *
 * Null for every seat that is not the true Percival, because only that seat
 * has a pair to leak. Merlin's vision and the evil roster are different
 * secrets with their own rules in `firewall.ts`.
 */
export function pairRisk(input: PairCheckInput): PairRisk | null {
  const k = input.observation.knowledge;
  if (k.kind !== "merlin_or_morgana") return null;
  const pair = new Set<number>(k.pair);

  const groups = groupingsIn(input.message);
  for (const g of groups) {
    const holdsPair = [...pair].every((s) => g.seats.includes(s as Seat));
    if (holdsPair && g.seats.length <= MAX_SAFE_GROUP) {
      return {
        kind: "grouping",
        groupSize: g.seats.length,
        marker: g.marker,
        rule: "percival-pair-grouping",
      };
    }
  }

  // CUMULATIVE. Each of this seat's prior groupings that holds the pair is a
  // set the listener can intersect with a new one. A single new group that is
  // itself large is still a leak if the intersection closes.
  const priors = priorGroupings(input.observation).filter((g) =>
    [...pair].every((s) => g.seats.includes(s as Seat)),
  );
  for (const g of groups) {
    if (![...pair].every((s) => g.seats.includes(s as Seat))) continue;
    for (const prior of priors) {
      const inter = g.seats.filter((s) => prior.seats.includes(s));
      if (inter.length <= MAX_SAFE_GROUP) {
        return {
          kind: "cumulative",
          groupSize: inter.length,
          marker: g.marker,
          rule: "percival-pair-cumulative",
        };
      }
    }
  }
  return null;
}

/* ── Metrics ────────────────────────────────────────────────────────────── */

export interface PairDisclosureMetric {
  /** Every epistemic grouping this seat has published, largest first. */
  readonly groupSizes: readonly number[];
  /** How many of them contained the whole pair. */
  readonly pairCoverage: number;
  /**
   * Padding. `groupSize / pairSize` for the tightest pair-containing group,
   * or null when there is none.
   *
   * 1.0 is the naked pair; 2.0 is the live game's 「1、3、7、9」. Reported rather
   * than thresholded, because the right cut-off is an empirical question and
   * `MAX_SAFE_GROUP` is the only number that gates anything.
   */
  readonly dilutionRatio: number | null;
  /** The smallest intersection of any two pair-containing groups. */
  readonly cumulativeIntersection: number | null;
  readonly rejections: number;
}

export function pairDisclosureMetric(
  observation: Observation,
  rejections: number,
): PairDisclosureMetric {
  const k = observation.knowledge;
  const groups = priorGroupings(observation);
  const sizes = groups.map((g) => g.seats.length).sort((a, b) => b - a);
  if (k.kind !== "merlin_or_morgana") {
    return {
      groupSizes: sizes,
      pairCoverage: 0,
      dilutionRatio: null,
      cumulativeIntersection: null,
      rejections,
    };
  }
  const pair = k.pair;
  const covering = groups.filter((g) => pair.every((s) => g.seats.includes(s)));
  let smallest: number | null = null;
  for (let i = 0; i < covering.length; i += 1) {
    for (let j = i + 1; j < covering.length; j += 1) {
      const n = covering[i].seats.filter((s) => covering[j].seats.includes(s)).length;
      if (smallest === null || n < smallest) smallest = n;
    }
  }
  const tightest = covering.length
    ? Math.min(...covering.map((g) => g.seats.length))
    : null;
  return {
    groupSizes: sizes,
    pairCoverage: covering.length,
    dilutionRatio: tightest === null ? null : tightest / pair.length,
    cumulativeIntersection: smallest,
    rejections,
  };
}
