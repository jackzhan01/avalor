import { describe, expect, it } from "vitest";
import { drive, referenceDeal, testConfig } from "../fixtures/harness";
import { applyAction, createGame } from "../core/referee";
import { observationFor } from "../core/observation";
import { IllegalActionError, SEATS, type Action, type Seat } from "../core/types";
import { loadProfile } from "../config/load";
import {
  claimContestFrom,
  contestEventId,
  everyClaimant,
  impliedFrom,
  renderClaimContest,
  standingClaimants,
  wasClaimingAt,
} from "./claim-contest";
import { buildFactRegistry, isVerifiedPremise, resolvePremiseId } from "./fact-ids";
import { ledgerFrom } from "./ledger";

/**
 * The public claim contest: what the referee recorded, and nothing else.
 *
 * The property under test throughout is that this registry can say a great deal
 * about what HAPPENED and nothing at all about who anybody IS. Every derivation
 * takes `PublicEvent[]`; there is no parameter through which the deal could
 * enter, and `contestSeesNoRoles` checks the rendered output for it directly.
 *
 * The second property is that retraction never deletes. A table that cannot see
 * what was retracted cannot judge the retraction, and "was that planned cover or
 * a collapsed lie" is the question scenarios 15-17 are entirely about.
 */

const CONFIG = testConfig();

/** A speech that claims, retracts, or does neither. */
function speech(
  patch: Partial<Extract<Action, { kind: "speech" }>> = {},
): Extract<Action, { kind: "speech" }> {
  return {
    kind: "speech",
    publicMessage: "说点什么。",
    tentativeTeam: null,
    noTeamYet: false,
    stances: [],
    claim: null,
    ...patch,
  };
}

/**
 * The order seats actually speak in, discovered rather than assumed.
 *
 * The opening direction decides it, so hard-coding "seat 3 speaks before seat
 * 6" would make these tests depend on a seed in a way nobody could see. Every
 * ordering-sensitive fixture below indexes into this instead.
 */
function speakingOrder(): Seat[] {
  const seen: Seat[] = [];
  drive({
    deal: referenceDeal(),
    config: CONFIG,
    onObservation: (observation) => {
      if (observation.request?.kind !== "speech") return;
      if (!seen.includes(observation.seat)) seen.push(observation.seat);
    },
    stopWhen: (state) => state.missionNumber >= 2,
  });
  return seen;
}

const ORDER = speakingOrder();
/** The Nth seat to speak, 0-indexed. */
const speaker = (n: number): Seat => ORDER[n];

/**
 * Drive a game, replacing a seat's Nth speech with a scripted one.
 *
 * Uses the real referee, so every claim and retraction below is a legal move
 * that produced a real public event — not a hand-built log that could contain
 * a shape the referee never emits. Runs to mission 3 so every seat gets a
 * second speech, which is what a retraction needs.
 */
function play(script: Partial<Record<Seat, Extract<Action, { kind: "speech" }>[]>>) {
  const used = new Map<Seat, number>();
  return drive({
    deal: referenceDeal(),
    config: CONFIG,
    override: (observation) => {
      if (observation.request?.kind !== "speech") return undefined;
      const queue = script[observation.seat];
      if (!queue) return undefined;
      const i = used.get(observation.seat) ?? 0;
      if (i >= queue.length) return undefined;
      used.set(observation.seat, i + 1);
      return queue[i];
    },
    stopWhen: (state) => state.missionNumber >= 3,
  });
}

describe("claims and counterclaims", () => {
  it("records a single claim as active, with a citable id", () => {
    const { state } = play({ 3: [speech({ claim: "percival" })] });
    const contest = claimContestFrom(state.log);
    expect(contest.bySeat[3]?.status).toBe("active");
    expect(contest.bySeat[3]?.claimed).toBe("percival");
    expect(contest.activePercivalClaimants).toContain(3);
    const event = contest.events.find((e) => e.kind === "claim");
    expect(event?.id).toBe(contestEventId("claim", event!.sequence));
  });

  it("marks BOTH sides contested when a second seat claims the same role", () => {
    const { state } = play({
      3: [speech({ claim: "percival" })],
      6: [speech({ claim: "percival" })],
    });
    const contest = claimContestFrom(state.log);
    // Two people standing on one identity: neither is unchallenged, and the
    // registry says so without saying which is lying.
    expect(contest.bySeat[3]?.status).toBe("contested");
    expect(contest.bySeat[6]?.status).toBe("contested");
    expect(contest.activePercivalClaimants).toEqual([3, 6]);
    const counter = contest.events.find((e) => e.kind === "claim" && e.counter);
    expect(counter).toBeTruthy();
  });

  it("does not mark a DIFFERENT role's claim as a counterclaim", () => {
    const { state } = play({
      3: [speech({ claim: "percival" })],
      6: [speech({ claim: "merlin" })],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.bySeat[3]?.status).toBe("active");
    expect(contest.bySeat[6]?.status).toBe("active");
    expect(contest.events.some((e) => e.kind === "claim" && e.counter)).toBe(false);
  });

  it("keeps a superseded claim in history rather than erasing it", () => {
    const { state } = play({
      3: [speech({ claim: "merlin" }), speech({ claim: "percival" })],
    });
    const contest = claimContestFrom(state.log);
    const record = contest.bySeat[3]!;
    expect(record.history).toHaveLength(2);
    expect(record.history[0].claimed).toBe("merlin");
    expect(record.history[0].retractedAtSequence).not.toBeNull();
    expect(record.claimed).toBe("percival");
    expect(record.status).toBe("active");
  });

  it("counts three simultaneous claimants", () => {
    const { state } = play({
      2: [speech({ claim: "percival" })],
      5: [speech({ claim: "percival" })],
      8: [speech({ claim: "percival" })],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.activePercivalClaimants).toEqual([2, 5, 8]);
    expect(standingClaimants(contest)).toEqual([2, 5, 8]);
  });
});

describe("retraction changes status and deletes nothing", () => {
  // The first two speakers, so the attack lands on somebody who has already
  // claimed — the registry only tracks stances ABOUT claimants.
  const first = speaker(0);
  const second = speaker(1);

  function retracted() {
    return play({
      [first]: [speech({ claim: "percival" })],
      [second]: [
        speech({
          claim: "percival",
          tentativeTeam: [1, 3, 5],
          stances: [{ seat: first, valence: -0.6, confidence: 0.5 }],
        }),
        speech({ retractClaim: true }),
      ],
    });
  }

  it("moves the claim to retracted and records the withdrawal", () => {
    const contest = claimContestFrom(retracted().state.log);
    const record = contest.bySeat[second]!;
    expect(record.status).toBe("retracted");
    expect(record.retractedAtSequence).not.toBeNull();
    const event = contest.events.find((e) => e.kind === "retract");
    expect(event).toBeTruthy();
    if (event?.kind === "retract") {
      expect(event.seat).toBe(second);
      expect(event.retracted).toBe("percival");
      expect(event.claimSequence).toBeLessThan(event.sequence);
    }
  });

  it("keeps the original claim, its team ask and its attacks", () => {
    const contest = claimContestFrom(retracted().state.log);
    const record = contest.bySeat[second]!;
    // Everything attached to the withdrawn claim survives: this is what makes
    // "was that cover or collapse" an answerable question.
    expect(record.history[0].claimed).toBe("percival");
    expect(record.history[0].sequence).toBeGreaterThan(0);
    expect(record.teamAsks.length).toBeGreaterThan(0);
    expect(record.attacked).toContain(first);
    expect(record.firstClaimSequence).not.toBeNull();
  });

  it("renders the withdrawn claim AND the withdrawal", () => {
    const contest = claimContestFrom(retracted().state.log);
    const text = renderClaimContest(contest);
    expect(text).toContain("已退水");
    expect(text).toContain("公开退水");
    expect(text).toContain("声称 percival");
  });

  it("drops the seat from standing claimants but keeps it in every-claimant", () => {
    const contest = claimContestFrom(retracted().state.log);
    expect(standingClaimants(contest)).not.toContain(second);
    expect(everyClaimant(contest)).toContain(second);
    expect(contest.retractedPercivalClaimants).toContain(second);
  });

  it("answers whether a seat was claiming at a past moment", () => {
    const contest = claimContestFrom(retracted().state.log);
    const record = contest.bySeat[second]!;
    const claimed = record.history[0].sequence;
    const withdrawn = record.retractedAtSequence!;
    expect(wasClaimingAt(contest, second, claimed)).toBe(true);
    expect(wasClaimingAt(contest, second, withdrawn - 1)).toBe(true);
    expect(wasClaimingAt(contest, second, withdrawn + 1)).toBe(false);
    const bystander = SEATS.find((x) => x !== first && x !== second)!;
    expect(wasClaimingAt(contest, bystander, claimed)).toBe(false);
  });
});

describe("the referee's own rules for 退水", () => {
  function fresh() {
    const state = createGame({ seed: 1, config: loadProfile("m5-2-pilot"), deal: referenceDeal() });
    // Walk to the first speech.
    while (state.pending && state.pending.kind !== "speech") {
      const seat = state.pending.seat;
      applyAction(state, seat, {
        kind: "choose_opening_direction",
        ladySide: "right",
        publicMessage: "开局。",
      });
    }
    return state;
  }

  it("refuses a retraction from a seat that never claimed", () => {
    const state = fresh();
    const seat = state.pending!.seat;
    expect(() => applyAction(state, seat, speech({ retractClaim: true }))).toThrow(
      IllegalActionError,
    );
  });

  it("refuses retracting and claiming something new in one speech", () => {
    const state = fresh();
    const seat = state.pending!.seat;
    applyAction(state, seat, speech({ claim: "percival" }));
    const next = state.pending!.seat;
    expect(() =>
      applyAction(state, next, speech({ claim: "merlin", retractClaim: true })),
    ).toThrow(/不能既退水又声称/);
  });

  it("leaves the state untouched when it refuses", () => {
    const state = fresh();
    const seat = state.pending!.seat;
    const before = state.log.length;
    expect(() => applyAction(state, seat, speech({ retractClaim: true }))).toThrow();
    expect(state.log.length).toBe(before);
    expect(state.pending!.seat).toBe(seat);
  });

  it("removes the seat from standingClaims, so the position reflects it", () => {
    const state = fresh();
    const seat = state.pending!.seat;
    applyAction(state, seat, speech({ claim: "percival" }));
    expect(state.standingClaims.some((c) => c.seat === seat)).toBe(true);
    // Walk back around to the same seat's next speech.
    while (state.pending && !(state.pending.kind === "speech" && state.pending.seat === seat)) {
      const other = state.pending.seat;
      if (state.pending.kind === "speech") applyAction(state, other, speech());
      else break;
    }
    if (state.pending?.kind === "speech" && state.pending.seat === seat) {
      applyAction(state, seat, speech({ retractClaim: true }));
      expect(state.standingClaims.some((c) => c.seat === seat)).toBe(false);
    }
  });

  it("emits `retractClaim` only when true, so older replays keep their bytes", () => {
    const state = fresh();
    const seat = state.pending!.seat;
    applyAction(state, seat, speech({ claim: "percival" }));
    const event = state.log[state.log.length - 1];
    expect(event.type).toBe("speech");
    // The key is ABSENT, not false. A always-present `false` would change every
    // replayed speech in every game recorded before this field existed.
    expect(Object.prototype.hasOwnProperty.call(event, "retractClaim")).toBe(false);
  });
});

describe("stances about claimants", () => {
  const early = speaker(0);
  const later = speaker(1);

  it("records an attack by a claimant on a claimant, and marks the target contested", () => {
    const { state } = play({
      [early]: [speech({ claim: "percival" })],
      [later]: [
        speech({ claim: "percival", stances: [{ seat: early, valence: -0.7, confidence: 0.6 }] }),
      ],
    });
    const contest = claimContestFrom(state.log);
    const attack = contest.events.find(
      (e) => e.kind === "claimant_stance" && e.from === later && e.to === early,
    );
    expect(attack).toBeTruthy();
    expect(contest.bySeat[early]?.status).toBe("contested");
    expect(contest.bySeat[early]?.attackedBy).toContain(later);
    expect(contest.bySeat[later]?.attacked).toContain(early);
  });

  it("separates a bystander stance from a claimant one", () => {
    const { state } = play({
      [early]: [speech({ claim: "percival" })],
      [later]: [speech({ stances: [{ seat: early, valence: 0.8, confidence: 0.7 }] })],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.events.some((e) => e.kind === "bystander_stance")).toBe(true);
    expect(contest.events.some((e) => e.kind === "claimant_stance")).toBe(false);
    expect(contest.bySeat[early]?.endorsedBy).toContain(later);
  });

  it("ignores a stance of exactly zero, which means 明确说看不清", () => {
    const { state } = play({
      [early]: [speech({ claim: "percival" })],
      [later]: [speech({ stances: [{ seat: early, valence: 0, confidence: 0.9 }] })],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.events.some((e) => e.kind === "bystander_stance")).toBe(false);
    expect(contest.bySeat[early]?.attackedBy).toHaveLength(0);
    expect(contest.bySeat[early]?.endorsedBy).toHaveLength(0);
  });

  it("ignores stances about seats that have never claimed", () => {
    const { state } = play({
      [later]: [speech({ stances: [{ seat: early, valence: -0.9, confidence: 0.9 }] })],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.events).toHaveLength(0);
  });
});

describe("implication is read from structure, never from prose", () => {
  it("marks a seat implied when it takes opposite stances on exactly two seats", () => {
    const { state } = play({
      4: [
        speech({
          stances: [
            { seat: 5, valence: 0.6, confidence: 0.5 },
            { seat: 9, valence: -0.6, confidence: 0.5 },
          ],
        }),
      ],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.bySeat[4]?.status).toBe("implied");
  });

  it("does not read implication from a confident sentence", () => {
    // The failure mode Part J forbids: a phrase becoming a public fact.
    const spoken = speech({ publicMessage: "我手上有一对候选，我知道谁是莫甘娜。" });
    expect(impliedFrom({ ...spoken, type: "speech", speaker: 1, slot: "regular", sequence: 1, missionNumber: 1, attempt: 1 } as never)).toBe(
      false,
    );
  });

  it("never lets an implied signal override a spoken claim", () => {
    const { state } = play({
      4: [
        speech({ claim: "loyal" }),
        speech({
          stances: [
            { seat: 5, valence: 0.6, confidence: 0.5 },
            { seat: 9, valence: -0.6, confidence: 0.5 },
          ],
        }),
      ],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.bySeat[4]?.status).toBe("active");
    expect(contest.bySeat[4]?.claimed).toBe("loyal");
  });
});

describe("the registry knows what happened and not who anybody is", () => {
  it("renders no role truth, whatever the deal", () => {
    const { state } = play({
      2: [speech({ claim: "percival" })],
      7: [speech({ claim: "percival" })],
    });
    const text = renderClaimContest(claimContestFrom(state.log));
    // Seat 7 is Morgana in the reference deal and seat 2 is Percival. Nothing
    // in the rendering may distinguish them.
    expect(text).toContain("2号");
    expect(text).toContain("7号");
    expect(text).not.toContain("morgana");
    expect(text).not.toContain("莫甘娜");
    expect(text).toContain("本身不说明谁真谁假");
  });

  it("is identical for every seat, because it is public", () => {
    const { state } = play({ 2: [speech({ claim: "percival" })] });
    const contest = claimContestFrom(state.log);
    const rendered = SEATS.map(() => renderClaimContest(contest));
    for (const text of rendered) expect(text).toBe(rendered[0]);
  });

  it("derives identically twice from the same log", () => {
    const { state } = play({ 2: [speech({ claim: "percival" })], 5: [speech({ claim: "percival" })] });
    const a = claimContestFrom(state.log);
    const b = claimContestFrom(state.log);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

describe("contest ids resolve through the M5.1 registry", () => {
  it("mints a hard-fact id for every contest event, for every seat", () => {
    const { state } = play({
      2: [speech({ claim: "percival" })],
      5: [speech({ claim: "percival", stances: [{ seat: 2, valence: -0.5, confidence: 0.5 }] })],
    });
    const contest = claimContestFrom(state.log);
    expect(contest.events.length).toBeGreaterThan(1);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const ledger = ledgerFrom(observation, SEATS);
      const registry = buildFactRegistry(ledger.publicFacts, ledger.claims, observation, contest);
      for (const event of contest.events) {
        // A `k…` id is a FACT: the referee saw the saying happen. What was said
        // stays a `c…` claim.
        expect(resolvePremiseId(registry, event.id).status, event.id).toBe("fact");
        expect(isVerifiedPremise(registry, event.id)).toBe(true);
      }
    }
  });

  it("does not mint contest ids when no contest is supplied", () => {
    const { state } = play({ 2: [speech({ claim: "percival" })] });
    const contest = claimContestFrom(state.log);
    const observation = observationFor(state, 4);
    const ledger = ledgerFrom(observation, SEATS);
    const without = buildFactRegistry(ledger.publicFacts, ledger.claims, observation);
    for (const event of contest.events) {
      expect(isVerifiedPremise(without, event.id), event.id).toBe(false);
    }
  });

  it("keeps the id stable across a rebuild of the same position", () => {
    const one = play({ 2: [speech({ claim: "percival" })] });
    const two = play({ 2: [speech({ claim: "percival" })] });
    const a = claimContestFrom(one.state.log).events.map((e) => e.id);
    const b = claimContestFrom(two.state.log).events.map((e) => e.id);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
