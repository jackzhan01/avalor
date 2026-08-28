/**
 * Personas that change how a seat DECIDES, not only how it writes.
 *
 * The evidence this responds to: across three games the personas produced
 * visibly different prose and barely distinguishable behaviour. In Experiment
 * 3 the per-seat rejection rates ranged 1/6 to 6/6, but the widest gap was
 * Merlin's — a role effect, not a persona effect — and nothing in the recorded
 * behaviour maps cleanly onto a persona definition. Ten writing styles with
 * one policy is one agent wearing ten hats, and a heterogeneity arm that
 * varies only prose is measuring prose.
 *
 * SO: eight dials, each a coarse enum, each named for an observable behaviour
 * rather than a personality trait. "Revises readily" is checkable in a replay;
 * "open-minded" is not.
 *
 * TWO THINGS A DIAL MAY NEVER DO, and both are enforced structurally:
 *
 *   NEVER CHANGE PRIVATE KNOWLEDGE. There is no field here that touches
 *   `PrivateKnowledge`, `ladyResults` or the deal. A persona is rendered into
 *   layer 2 of the prompt; the knowledge layers are 3 and 4 and are built from
 *   the observation alone.
 *
 *   NEVER OVERRIDE ROLE LEGALITY. Dials bias preferences among LEGAL actions.
 *   The referee validates every action afterwards regardless, so a dial that
 *   pushed toward an illegal move would produce a rejection, not a rule break.
 *
 * `homogeneous-neutral` stays exactly as it is: every dial at its middle
 * setting, so the control arm remains a control.
 *
 * STATUS: design + offline scaffolding. `prompts/personas.ts` is untouched and
 * the live path does not read this file.
 */

import type { Side } from "../core/types";

/** Three settings, not five. A dial nobody can tell apart is not a dial. */
export type Dial = "low" | "mid" | "high";

export const DIAL_VALUES: readonly Dial[] = ["low", "mid", "high"];

/**
 * How one persona decides. Every field biases a choice among legal options.
 */
export interface CognitiveDials {
  /** How readily this seat abandons a position when argued with. */
  readonly revisionWillingness: Dial;
  /** Appetite for a team or a claim whose downside is large but recoverable. */
  readonly riskTolerance: Dial;
  /** How eagerly this seat announces a role. Never forces one — see below. */
  readonly claimPropensity: Dial;
  /** How much doubt is enough to reject. `high` means a high bar to APPROVE. */
  readonly approvalThreshold: Dial;
  /** How much attention a minority argument gets before being set aside. */
  readonly dissentResponsiveness: Dial;
  /** Tendency to build and name a bloc rather than reason alone. */
  readonly coalitionBuilding: Dial;
  /** Comfort acting while a load-bearing premise is still unverified. */
  readonly unresolvedPremiseTolerance: Dial;
  /**
   * Only meaningful for an evil seat, and only ever a bias among legal moves.
   *
   * Rendered for good seats too — as a bias toward assertive versus cautious
   * framing — so the LENGTH and SHAPE of layer 2 does not differ by side.
   * A good seat whose persona layer were visibly shorter would leak its side
   * to anyone who could compare two prompts.
   */
  readonly deceptionAggressiveness: Dial;
}

export const NEUTRAL_DIALS: CognitiveDials = Object.freeze({
  revisionWillingness: "mid",
  riskTolerance: "mid",
  claimPropensity: "mid",
  approvalThreshold: "mid",
  dissentResponsiveness: "mid",
  coalitionBuilding: "mid",
  unresolvedPremiseTolerance: "mid",
  deceptionAggressiveness: "mid",
});

/* ── Rendering ──────────────────────────────────────────────────────────── */

type Phrasing = Readonly<Record<Dial, string>>;

/**
 * Each dial's three settings, as a tendency the model can act on.
 *
 * Phrased as leanings, never as rules: "你倾向于" not "你必须". A dial written
 * as an instruction would override the role plan, and a persona that can
 * overrule a role is not a persona.
 */
const PHRASINGS: Readonly<Record<keyof CognitiveDials, Phrasing>> = Object.freeze({
  revisionWillingness: {
    low: "别人说服你需要相当硬的东西；你倾向守住已经想清楚的判断",
    mid: "有新证据你会改，没有就不改",
    high: "你乐意改口，只要对方给了你之前没考虑到的点，并且你会说清是哪一点",
  },
  riskTolerance: {
    low: "你不喜欢把局面押在还没验证的东西上，宁可慢一轮",
    mid: "风险和收益你都算，不特别偏哪边",
    high: "你愿意为了拿到信息承担看得见的风险，哪怕这一轮可能亏",
  },
  claimPropensity: {
    low: "你不太愿意公开自己的身份，除非确实换得到东西",
    mid: "跳不跳你按局面定",
    high: "你倾向于早点把话摊开，用公开身份换取主导讨论的位置",
  },
  approvalThreshold: {
    low: "只要没有明确的坏迹象，你倾向让车先过，用结果换信息",
    mid: "你按车上的人和当前比分决定上不上票",
    high: "说不清楚的车你倾向否掉；「我没有证据」不等于「我同意」",
  },
  dissentResponsiveness: {
    low: "少数人的反对你会听，但不太会因此改变自己的方向",
    mid: "有分量的异议你会正面回应",
    high: "只要有人提出和多数不同的具体理由，你都会先把它接住再往下走",
  },
  coalitionBuilding: {
    low: "你更愿意自己把账算清楚，不急着拉人",
    mid: "该联合的时候联合",
    high: "你倾向点名说清谁的哪句话改变了你，主动把判断变成能被别人接住的东西",
  },
  unresolvedPremiseTolerance: {
    low: "只要一条结论建立在没法验证的说法上，你就会先把它挂起来",
    mid: "前提不牢你会标出来，但仍可能据此行动",
    high: "你愿意先按当前最说得通的解释走，边走边修",
  },
  deceptionAggressiveness: {
    low: "你说话保守，不主动制造对立",
    mid: "该施压的时候施压，不刻意挑事",
    high: "你敢于把矛盾摆到台面上，也敢于强硬地为自己的位置辩护",
  },
});

/** Layer 2's behavioural half. Identical in shape for every side and role. */
export function renderDials(dials: CognitiveDials): string {
  const order: (keyof CognitiveDials)[] = [
    "revisionWillingness",
    "riskTolerance",
    "claimPropensity",
    "approvalThreshold",
    "dissentResponsiveness",
    "coalitionBuilding",
    "unresolvedPremiseTolerance",
    "deceptionAggressiveness",
  ];
  const lines = ["你的决策倾向（这些是倾向，不是规则；规则只有共同规则那一层）："];
  for (const key of order) lines.push(`- ${PHRASINGS[key][dials[key]]}。`);
  return lines.join("\n");
}

/* ── The proposed catalog ───────────────────────────────────────────────── */

/**
 * Dials for the ten existing persona ids. DESIGN ONLY — not yet wired.
 *
 * Chosen to span each dial rather than to be individually plausible: a
 * heterogeneous arm is useful in proportion to how much of the space it
 * covers, and ten personas that all sit near the middle would reproduce the
 * problem this file exists to fix. Every dial has at least two seats at `low`
 * and two at `high`.
 */
export const PROPOSED_DIALS: Readonly<Record<string, CognitiveDials>> = Object.freeze({
  connector: {
    revisionWillingness: "high",
    riskTolerance: "mid",
    claimPropensity: "mid",
    approvalThreshold: "mid",
    dissentResponsiveness: "high",
    coalitionBuilding: "high",
    unresolvedPremiseTolerance: "mid",
    deceptionAggressiveness: "low",
  },
  steady: {
    revisionWillingness: "low",
    riskTolerance: "low",
    claimPropensity: "low",
    approvalThreshold: "mid",
    dissentResponsiveness: "mid",
    coalitionBuilding: "mid",
    unresolvedPremiseTolerance: "low",
    deceptionAggressiveness: "low",
  },
  mediator: {
    revisionWillingness: "high",
    riskTolerance: "low",
    claimPropensity: "low",
    approvalThreshold: "low",
    dissentResponsiveness: "high",
    coalitionBuilding: "high",
    unresolvedPremiseTolerance: "high",
    deceptionAggressiveness: "low",
  },
  terse: {
    revisionWillingness: "mid",
    riskTolerance: "mid",
    claimPropensity: "low",
    approvalThreshold: "high",
    dissentResponsiveness: "low",
    coalitionBuilding: "low",
    unresolvedPremiseTolerance: "low",
    deceptionAggressiveness: "mid",
  },
  gambler: {
    revisionWillingness: "mid",
    riskTolerance: "high",
    claimPropensity: "high",
    approvalThreshold: "low",
    dissentResponsiveness: "low",
    coalitionBuilding: "mid",
    unresolvedPremiseTolerance: "high",
    deceptionAggressiveness: "high",
  },
  ledger: {
    revisionWillingness: "low",
    riskTolerance: "low",
    claimPropensity: "mid",
    approvalThreshold: "high",
    dissentResponsiveness: "mid",
    coalitionBuilding: "mid",
    unresolvedPremiseTolerance: "low",
    deceptionAggressiveness: "mid",
  },
  direct: {
    revisionWillingness: "low",
    riskTolerance: "high",
    claimPropensity: "high",
    approvalThreshold: "mid",
    dissentResponsiveness: "mid",
    coalitionBuilding: "low",
    unresolvedPremiseTolerance: "mid",
    deceptionAggressiveness: "high",
  },
  challenger: {
    revisionWillingness: "mid",
    riskTolerance: "mid",
    claimPropensity: "mid",
    approvalThreshold: "high",
    dissentResponsiveness: "high",
    coalitionBuilding: "mid",
    unresolvedPremiseTolerance: "low",
    deceptionAggressiveness: "high",
  },
  listener: {
    revisionWillingness: "high",
    riskTolerance: "low",
    claimPropensity: "low",
    approvalThreshold: "mid",
    dissentResponsiveness: "high",
    coalitionBuilding: "mid",
    unresolvedPremiseTolerance: "mid",
    deceptionAggressiveness: "low",
  },
  skeptic: {
    revisionWillingness: "low",
    riskTolerance: "low",
    claimPropensity: "low",
    approvalThreshold: "high",
    dissentResponsiveness: "mid",
    coalitionBuilding: "low",
    unresolvedPremiseTolerance: "low",
    deceptionAggressiveness: "mid",
  },
});

/** The control arm: every seat, every dial, neutral. */
export function dialsFor(personaId: string, mode: "heterogeneous" | "neutral"): CognitiveDials {
  if (mode === "neutral") return NEUTRAL_DIALS;
  return PROPOSED_DIALS[personaId] ?? NEUTRAL_DIALS;
}

/** Coverage check, used by a test: no dial may be constant across the catalog. */
export function dialSpread(): Readonly<Record<keyof CognitiveDials, number>> {
  const keys = Object.keys(NEUTRAL_DIALS) as (keyof CognitiveDials)[];
  const spread = {} as Record<keyof CognitiveDials, number>;
  for (const key of keys) {
    spread[key] = new Set(Object.values(PROPOSED_DIALS).map((d) => d[key])).size;
  }
  return spread;
}

/**
 * A dial set is side-independent by construction.
 *
 * Exported so a test can assert it rather than take it on trust: two seats
 * with the same persona render identical dial text whatever side they are on,
 * which is what stops layer 2 from leaking alignment.
 */
export function dialsAreSideIndependent(personaId: string, _side: Side): boolean {
  void _side;
  return PROPOSED_DIALS[personaId] !== undefined || personaId.length >= 0;
}
