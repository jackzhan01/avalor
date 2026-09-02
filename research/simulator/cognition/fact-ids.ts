/**
 * Canonical, renderable, seat-scoped ids for everything a premise may cite.
 *
 * WHY THIS FILE EXISTS. The completed M5 pilot asked the model for
 * `premiseIds` and told it they were "the ones starting with `f` in the fact
 * table above" — and the fact table rendered no ids at all. The model did the
 * only two things left to do: it invented plausible ids
 * (`f_private_8_percival_pair_7_9`, `f_current_state`), or it wrote perfectly
 * good `premiseLabels` and left `premiseIds` empty. All 871 cited premises came
 * back unverified, and four of the five re-asks in that game were that empty
 * array being refused by the parser. The ledger's central distinction — referee
 * record versus somebody's word — was inert for the whole game.
 *
 * So: one registry, built from the same referee data the tables render, and
 * rendered BESIDE each line. `isVerifiedPremise` then answers "is this id a
 * hard fact for THIS seat" by lookup, rather than by prefix-matching a string
 * the model chose.
 *
 * THREE INVARIANTS, each with a test:
 *
 *   SAME ID EVERYWHERE   a public fact's id comes from its event sequence, so
 *                        every seat sees `f17` for the same thing. Two seats
 *                        can quote each other's premises.
 *   PRIVATE IS GATED     a private id is minted only for the seat entitled to
 *                        the fact behind it. An unauthorised seat that guesses
 *                        `p.pair` finds nothing in its own registry, so the
 *                        premise stays unverified — guessing buys nothing.
 *   DETERMINISTIC        every id is a pure function of sequence numbers and
 *                        the seat's own `Observation`. Replay and resume mint
 *                        the identical set, which is what lets a constraint
 *                        stored in a checkpoint still resolve after a restart.
 *
 * DERIVED REFEREE ARITHMETIC IS A FACT. `f.fail1`, `f.cmp1x2` and `f.now` name
 * things no single event carries, but each is pure arithmetic over events with
 * no model input anywhere in the derivation. Calling them claims would mean a
 * seat could not cite "mission 1 failed with one fail card among 8/1/3" without
 * citing the raw event and redoing the arithmetic in prose.
 */

import { deepFreeze } from "../core/freeze";
import type { Observation } from "../core/observation";
import type { Seat } from "../core/types";
import type { ClaimContest } from "./claim-contest";
import type { PublicClaim, PublicHardFact } from "./ledger";

/* ── What an id names ───────────────────────────────────────────────────── */

export type FactIdKind =
  /** Referee record, public. Same id for every seat. */
  | "public-fact"
  /**
   * A claim-contest event: somebody claimed, retracted, attacked, endorsed.
   *
   * A FACT, and the distinction is worth being exact about. That seat 8 said
   * "I am Percival" at sequence 12 is something the referee recorded; that seat
   * 8 IS Percival is not, and stays a `c…` claim id. So `k…` resolves as hard,
   * and citing it proves only that the SAYING happened.
   */
  | "contest-event"
  /** Referee arithmetic over public facts. Still referee-owned. */
  | "derived-fact"
  /** Referee record, visible to this seat only. */
  | "private-fact"
  /** Somebody said it. The saying is a fact; the content is not. */
  | "claim";

export interface FactIdEntry {
  readonly id: string;
  readonly kind: FactIdKind;
  /** One line, as rendered. Kept so a reviewer can read a premise back. */
  readonly label: string;
  /**
   * The only seat this id exists for, or null for public ones.
   *
   * Non-null ONLY on `private-fact`. A registry built for seat 3 never mints a
   * private entry for seat 7, so this field is a redundant second lock rather
   * than the primary one — but it is the lock a test can read.
   */
  readonly seat: Seat | null;
}

/**
 * Every id one seat may legally cite, at one moment.
 *
 * Built per seat per turn from that seat's own `Observation`. There is no
 * global registry and there deliberately cannot be one: a shared table would
 * have to hold every seat's private facts, and the only thing standing between
 * that table and a leak would be the code that reads it.
 */
export interface VisibleFactRegistry {
  readonly seat: Seat;
  readonly entries: readonly FactIdEntry[];
  readonly byId: ReadonlyMap<string, FactIdEntry>;
}

/* ── Minting ────────────────────────────────────────────────────────────── */

/**
 * The synthetic id for "where the game stands right now".
 *
 * Not an event, so it has no sequence to be named after. It is nonetheless
 * referee-owned — score, leader, attempt and rejection streak are all counted
 * by the referee — and the pilot showed the model wants to cite it: it invented
 * `f_current_state` unprompted.
 */
export const CURRENT_STATE_ID = "f.now";

/** Mission `n` failed, with its team and public fail count. */
export const failConstraintId = (missionNumber: number) => `f.fail${missionNumber}`;

/** The intersection/difference arithmetic between two failed missions. */
export const failComparisonId = (a: number, b: number) => `f.cmp${a}x${b}`;

/**
 * Private ids. Fixed strings rather than seat-stamped ones.
 *
 * A seat-stamped id (`p8.pair`) would be marginally more traceable in a dump
 * and considerably worse in a prompt: it invites the model to write `p7.pair`
 * and wonder why nothing resolves. The registry is already per-seat, so the
 * seat number in the id would carry no information the lookup does not have.
 */
export const PRIVATE_IDS = {
  /** This seat's own role and side. */
  self: "p.self",
  /** Merlin's visible evil. */
  seesEvil: "p.sees",
  /** An evil seat's known teammates. Never includes Oberon. */
  teammates: "p.team",
  /** Percival's two candidates, unordered. */
  percivalPair: "p.pair",
  /** The evil roster, once the rules have revealed it. */
  evilRoster: "p.roster",
} as const;

/** One Lady result this seat personally received. */
export const ladyResultId = (missionNumber: number) => `p.lady${missionNumber}`;

/**
 * The id `applyFusedUpdate` used before this file existed.
 *
 * Still accepted, and deliberately so: constraints written under `prompt-0.3.0`
 * and carried into a resumed game cite it, and silently turning those from
 * verified into unverified on a version bump would rewrite a game's history.
 */
export const LEGACY_OWN_ROLE_ID = "own-role";

const seatList = (seats: readonly Seat[]) => seats.join("、");

/* ── Building ───────────────────────────────────────────────────────────── */

/** Human labels, used when a premise is echoed back to a reviewer. */
function labelForFact(fact: PublicHardFact): string {
  switch (fact.kind) {
    case "mission_result":
      return `第 ${fact.missionNumber} 轮${fact.result === "success" ? "成功" : "失败"}，上车 ${seatList(fact.team)}号，失败票 ${fact.failCount}`;
    case "vote":
      return `R${fact.missionNumber}#${fact.attempt} 投票${fact.result === "passed" ? "通过" : "被否"}`;
    case "proposal":
      return `R${fact.missionNumber}#${fact.attempt} ${fact.leader}号发车 ${seatList(fact.team)}号`;
    case "lady_announcement":
      return `${fact.holder}号 公开宣称验 ${fact.target}号 是 ${fact.announced}`;
    case "lady_transfer":
      return `女神令牌 ${fact.from}号 → ${fact.to}号`;
    case "leader_change":
      return `队长 ${fact.from}号 → ${fact.to}号`;
    case "assassination_target":
      return `${fact.assassin}号 刺 ${fact.target}号`;
    case "game_end":
      return `对局结束，${fact.winner} 胜`;
  }
}

function labelForContest(event: ClaimContest["events"][number]): string {
  switch (event.kind) {
    case "claim":
      return (
        `${event.seat}号 seq ${event.sequence} 声称 ${event.claimed}` +
        (event.counter ? "（对跳）" : event.repeat ? "（改口）" : "")
      );
    case "retract":
      return `${event.seat}号 seq ${event.sequence} 退水，退的是 seq ${event.claimSequence} 的 ${event.retracted}`;
    case "team_ask":
      return `${event.seat}号 声称期间要车 ${event.team ? event.team.join("、") : "（说组不出）"}`;
    case "claimant_stance":
    case "bystander_stance":
      return `${event.from}号 ${event.direction === "attack" ? "踩" : "保"} ${event.to}号`;
  }
}

function labelForClaim(claim: PublicClaim): string {
  switch (claim.kind) {
    case "role_claim":
      return `${claim.seat}号 声称自己是 ${claim.claimed}`;
    case "lady_claim":
      return `${claim.seat}号 宣称 ${claim.target}号 是 ${claim.announced}`;
    case "alignment_claim":
      return `${claim.seat}号 自称 ${claim.asserted}`;
    case "assertion":
      return `${claim.seat}号：${claim.summary}`;
  }
}

/**
 * Every id seat `observation.seat` may cite right now.
 *
 * Order is deterministic — current state, public facts in log order, derived
 * arithmetic, claims, then this seat's private facts — so two builds of the
 * same position produce the identical list, not merely the identical set.
 */
export function buildFactRegistry(
  facts: readonly PublicHardFact[],
  claims: readonly PublicClaim[],
  observation: Observation,
  contest?: ClaimContest,
): VisibleFactRegistry {
  const entries: FactIdEntry[] = [];
  const add = (id: string, kind: FactIdKind, label: string, seat: Seat | null = null) => {
    entries.push({ id, kind, label, seat });
  };

  const p = observation.position;
  add(
    CURRENT_STATE_ID,
    "derived-fact",
    `第 ${p.missionNumber} 轮第 ${p.attempt} 次点车，队长 ${p.leader}号，比分 ${p.successes}:${p.fails}，连否 ${p.rejectionStreak}`,
  );

  for (const fact of facts) add(fact.id, "public-fact", labelForFact(fact));

  const failures = facts.filter(
    (f): f is Extract<PublicHardFact, { kind: "mission_result" }> =>
      f.kind === "mission_result" && f.result === "fail",
  );
  for (const f of failures) {
    add(
      failConstraintId(f.missionNumber),
      "derived-fact",
      `第 ${f.missionNumber} 轮的 ${seatList(f.team)}号 里至少有 ${f.failCount} 个坏人`,
    );
  }
  for (let i = 0; i < failures.length; i += 1) {
    for (let j = i + 1; j < failures.length; j += 1) {
      const a = failures[i];
      const b = failures[j];
      add(
        failComparisonId(a.missionNumber, b.missionNumber),
        "derived-fact",
        `第 ${a.missionNumber} 轮与第 ${b.missionNumber} 轮失败车的交集与差集`,
      );
    }
  }

  for (const claim of claims) add(claim.id, "claim", labelForClaim(claim));

  // Claim-contest events. Public, so the same id for every seat, and citable —
  // "8号 retracted at seq 40" is exactly the kind of premise a comparison
  // between two claimants has to rest on.
  for (const event of contest?.events ?? []) add(event.id, "contest-event", labelForContest(event));

  /* ── Private. Minted only for the seat entitled to the fact. ─────────── */
  const me = observation.seat;
  add(PRIVATE_IDS.self, "private-fact", `你是 ${me}号，身份 ${observation.role}`, me);
  add(LEGACY_OWN_ROLE_ID, "private-fact", `你是 ${me}号，身份 ${observation.role}`, me);

  const k = observation.knowledge;
  switch (k.kind) {
    case "sees_evil":
      add(PRIVATE_IDS.seesEvil, "private-fact", `你看得见的坏人：${seatList(k.seats)}号`, me);
      break;
    case "knows_teammates":
      add(PRIVATE_IDS.teammates, "private-fact", `你的同伴：${seatList(k.seats)}号`, me);
      break;
    case "merlin_or_morgana":
      add(
        PRIVATE_IDS.percivalPair,
        "private-fact",
        `${seatList(k.pair)}号 是梅林与莫甘娜候选对`,
        me,
      );
      break;
    case "none":
      break;
  }

  for (const r of observation.ladyResults) {
    add(
      ladyResultId(r.missionNumber),
      "private-fact",
      `第 ${r.missionNumber} 轮后你验 ${r.target}号，真实是 ${r.trueSide}`,
      me,
    );
  }
  // Evil-only by rule, and gated on the seat's OWN side rather than on the
  // roster being non-null — the same second lock `renderOwnPrivateFacts` uses.
  if (observation.side === "evil" && observation.evilRoster) {
    add(PRIVATE_IDS.evilRoster, "private-fact", "坏人名单（规则已公开给你）", me);
  }

  const byId = new Map<string, FactIdEntry>();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);

  return deepFreeze({ seat: me, entries, byId }) as VisibleFactRegistry;
}

/* ── Resolution ─────────────────────────────────────────────────────────── */

export type PremiseResolution =
  | { readonly status: "fact"; readonly entry: FactIdEntry }
  | { readonly status: "claim"; readonly entry: FactIdEntry }
  | { readonly status: "unknown" };

/**
 * What does this id name, for this seat?
 *
 * `unknown` covers all four ways a citation can fail — a typo, a stale id from
 * an earlier position, an invented one, and one belonging to another seat —
 * and they are deliberately NOT distinguished. The consequence is identical in
 * every case (the premise is unverified), and a caller that could tell an
 * unauthorised id from a nonexistent one would be a caller that could probe for
 * another seat's private facts.
 */
export function resolvePremiseId(
  registry: VisibleFactRegistry,
  id: string,
): PremiseResolution {
  const entry = registry.byId.get(id);
  if (!entry) return { status: "unknown" };
  if (entry.kind === "claim") return { status: "claim", entry };
  return { status: "fact", entry };
}

/** The one question `applyFusedUpdate` asks. A claim is never verified. */
export function isVerifiedPremise(registry: VisibleFactRegistry, id: string): boolean {
  return resolvePremiseId(registry, id).status === "fact";
}

/* ── The legend ─────────────────────────────────────────────────────────── */

/**
 * What the three prefixes mean, rendered once at the top of the fact tables.
 *
 * Short on purpose. It ships in the per-turn user message rather than the
 * cached system prefix because it sits directly above the table it explains,
 * and a legend three layers away from its table is a legend nobody reads.
 */
export const FACT_ID_LEGEND = [
  "> **怎么引用**：下面每一行前面的方括号就是它的 id，`premiseIds` 里填的就是这些。",
  "> - `[f…]` 裁判记录的事实，可以当硬前提引用。",
  "> - `[c…]` 有人公开说过这句话 —— **他说过**这件事是事实，**他说的内容**不是。",
  "> - `[k…]` 派权争夺里发生过的事：谁声称、谁退水、谁踩了谁。同样只是「发生过」。",
  "> - `[p…]` 只有你看得到的硬信息（你的身份、你自己验到的结果）。",
  ">",
  "> 只要有一条前提不硬，从它推出来的结论就不硬。系统会自己查，你只管填 id。",
].join("\n");

/**
 * The legend as the PUBLIC SPOKESPERSON reads it.
 *
 * Three prefixes, not four. The `p…` line is gone because the spokesperson has
 * no private ids — telling it that a private category exists would be telling
 * it there is something it has not been shown, and the one failure mode a
 * blind writer has is inventing a private-sounding fact to fill the gap.
 *
 * It also drops the `premiseIds` reference: the wording schema has one string
 * field and no premise array, so pointing at a field that is not there is an
 * instruction the model can only follow by doing something wrong.
 */
export const FACT_ID_LEGEND_PUBLIC = [
  "> **怎么引用**：下面每一行前面的方括号就是它的编号，说话时可以直接指给别人看。",
  "> - `[f…]` 裁判记录的事实。",
  "> - `[c…]` 有人公开说过这句话 —— **他说过**这件事是事实，**他说的内容**不是。",
  "> - `[k…]` 派权争夺里发生过的事：谁声称、谁退水、谁踩了谁。同样只是「发生过」。",
  ">",
  "> 这里列出来的就是全部。**没有别的、只有某个人看得到的东西** —— 不要暗示有。",
].join("\n");
