import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/load";
import { createGame } from "../core/referee";
import { observationFor } from "../core/observation";
import { runGame } from "../run/runner";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import { SEATS, type Seat } from "../core/types";
import {
  applyCognitionUpdate,
  claimsFrom,
  deriveConstraint,
  ledgerFrom,
  premiseFromClaim,
  premiseFromFact,
  premiseFromOwnRole,
  publicFactsFrom,
  unverifiedConstraints,
  validateLedger,
  LEDGER_SCHEMA,
  type EpistemicLedger,
} from "./ledger";
import { COGNITION_LIMITS } from "./limits";

/**
 * The ledger's one job: keep three kinds of thing from turning into each other.
 *
 * A fact is what the referee recorded. A claim is what somebody said. A
 * constraint is what this seat worked out, and it is only ever as hard as its
 * softest premise. Experiment 3 lost a winnable position because one agent
 * collapsed the second into the first; these tests exist so that collapse
 * cannot be expressed in this codebase.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("cognition tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONFIG = loadConfig();

/** A real finished game, so the fact tables come from real referee output. */
async function finishedGame(seed: number) {
  return runGame({ seed, agents: scriptedTable({ seed, profile: PROFILES.mixed }), config: CONFIG, runId: "cog" });
}

function ledgerAt(state: Parameters<typeof observationFor>[0], seat: Seat): EpistemicLedger {
  return ledgerFrom(observationFor(state, seat), SEATS);
}

describe("public hard facts", () => {
  it("are built only from referee events", async () => {
    const { state } = await finishedGame(11);
    const facts = publicFactsFrom(state.log);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      // Every fact traces to a sequence in the log. Nothing else can make one.
      const provenance = fact.provenance;
      expect(provenance.kind).toBe("referee");
      if (provenance.kind === "referee") {
        expect(state.log.some((e) => e.sequence === provenance.sequence)).toBe(true);
      }
    }
  });

  it("never treat a speech as a fact", async () => {
    const { state } = await finishedGame(12);
    const facts = publicFactsFrom(state.log);
    const speechSequences = state.log.filter((e) => e.type === "speech").map((e) => e.sequence);
    expect(speechSequences.length).toBeGreaterThan(0);
    for (const fact of facts) {
      const provenance = fact.provenance;
      if (provenance.kind !== "referee") continue;
      expect(speechSequences).not.toContain(provenance.sequence);
    }
  });

  it("carry the team a vote was about, which the vote event does not", async () => {
    const { state } = await finishedGame(13);
    const votes = publicFactsFrom(state.log).filter((f) => f.kind === "vote");
    expect(votes.length).toBeGreaterThan(0);
    for (const v of votes) {
      if (v.kind !== "vote") continue;
      // A vote fact must be readable on its own: "who voted how on which team".
      expect(v.team.length).toBeGreaterThan(0);
    }
  });

  it("record a Lady announcement as a fact AND as a claim", async () => {
    // The announcement happening is a fact; its content is not. Collapsing the
    // two is precisely the Experiment 3 error.
    const { state } = await finishedGame(14);
    const announcements = state.log.filter((e) => e.type === "lady_announced");
    if (announcements.length === 0) return;
    const facts = publicFactsFrom(state.log).filter((f) => f.kind === "lady_announcement");
    const claims = claimsFrom(state.log).filter((c) => c.kind === "lady_claim");
    expect(facts).toHaveLength(announcements.length);
    expect(claims).toHaveLength(announcements.length);
  });
});

describe("claims", () => {
  it("are never marked verified, because a claim has no verification status", async () => {
    const { state } = await finishedGame(15);
    const claims = claimsFrom(state.log);
    for (const claim of claims) {
      expect(claim.provenance.kind).toBe("table-claim");
      // The type has no such field; this asserts nobody added one.
      expect((claim as unknown as { verified?: unknown }).verified).toBeUndefined();
    }
  });

  it("record a re-claim as a retraction rather than by deleting history", () => {
    const log = [
      {
        type: "speech" as const,
        sequence: 5,
        missionNumber: 1,
        attempt: 1,
        speaker: 3 as Seat,
        slot: "regular" as const,
        publicMessage: "我是梅林",
        tentativeTeam: null,
        noTeamYet: true,
        claim: "merlin" as const,
        stances: [],
      },
      {
        type: "speech" as const,
        sequence: 9,
        missionNumber: 1,
        attempt: 1,
        speaker: 3 as Seat,
        slot: "regular" as const,
        publicMessage: "算了，我是忠臣",
        tentativeTeam: null,
        noTeamYet: true,
        claim: "loyal" as const,
        stances: [],
      },
    ];
    const claims = claimsFrom(log).filter((c) => c.kind === "role_claim");
    expect(claims).toHaveLength(2);
    const first = claims[0];
    if (first.kind !== "role_claim") throw new Error("shape");
    // The change of mind is itself evidence, so the old claim stays.
    expect(first.claimed).toBe("merlin");
    expect(first.retractedAtSequence).toBe(9);
  });
});

describe("derived constraints", () => {
  it("compute restsOnUnverified rather than accepting it", () => {
    const solid = deriveConstraint({
      id: "k1",
      statement: "第一轮 1、3、8 里至少一个坏人",
      premises: [{ id: "f10", verified: true, label: "第一轮挂了" }],
      atSequence: 10,
    });
    expect(solid.restsOnUnverified).toBe(false);

    const shaky = deriveConstraint({
      id: "k2",
      statement: "所以 2、3、5 恰有两坏",
      premises: [
        { id: "f10", verified: true, label: "第二轮挂了两张" },
        { id: "c40", verified: false, label: "6号自称忠臣" },
      ],
      atSequence: 41,
    });
    // One soft premise makes the whole conclusion soft. This is the mechanism.
    expect(shaky.restsOnUnverified).toBe(true);
  });

  it("cannot be laundered into hardness by relabelling", () => {
    const c = deriveConstraint({
      id: "k3",
      statement: "6号是好人",
      premises: [premiseFromClaim({ kind: "assertion", id: "c1" } as never, "他说的")],
      atSequence: 5,
    });
    expect(c.restsOnUnverified).toBe(true);
    expect(c.provenance.kind).toBe("inference");
    // And it is frozen, so nothing can flip the flag afterwards.
    expect(() => {
      (c as unknown as { restsOnUnverified: boolean }).restsOnUnverified = false;
    }).toThrow();
  });

  it("separates verified premise sources correctly", async () => {
    const { state } = await finishedGame(16);
    const facts = publicFactsFrom(state.log);
    const claims = claimsFrom(state.log);
    expect(premiseFromFact(facts[0], "任务结果").verified).toBe(true);
    expect(premiseFromOwnRole("我自己的身份").verified).toBe(true);
    if (claims.length > 0) expect(premiseFromClaim(claims[0], "某人说的").verified).toBe(false);
  });

  it("lists the ones a prompt has to carry a caveat for", async () => {
    const { state } = await finishedGame(17);
    const base = ledgerAt(state, 1);
    const updated = applyCognitionUpdate(base, observationFor(state, 1), {
      constraints: [
        deriveConstraint({
          id: "a",
          statement: "硬的",
          premises: [{ id: "f1", verified: true, label: "任务结果" }],
          atSequence: 1,
        }),
        deriveConstraint({
          id: "b",
          statement: "软的",
          premises: [{ id: "c1", verified: false, label: "他说的" }],
          atSequence: 2,
        }),
      ],
      hypotheses: [
        { id: "h1", label: "世界一", evilSeats: [2], rationale: "", standing: "unresolved", premises: [], provenance: { kind: "inference", premises: [] } },
        { id: "h2", label: "世界二", evilSeats: [3], rationale: "", standing: "unresolved", premises: [], provenance: { kind: "inference", premises: [] } },
      ],
    });
    expect(unverifiedConstraints(updated).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("ownership", () => {
  it("rebuilds referee halves from the observation, never from the model", async () => {
    const { state } = await finishedGame(18);
    const observation = observationFor(state, 4);
    const base = ledgerAt(state, 4);

    // A model update that tries to smuggle in facts: the type has no field for
    // it, and a cast is defeated because the referee halves are re-derived.
    const tampered = applyCognitionUpdate(base, observation, {
      publicFacts: [],
      privateFacts: { seat: 1 },
    } as never);

    expect(tampered.publicFacts).toEqual(publicFactsFrom(state.log));
    expect(tampered.privateFacts.seat).toBe(4);
    expect(tampered.privateFacts.role).toBe(observation.role);
  });

  it("refuses another seat's observation", async () => {
    const { state } = await finishedGame(19);
    const base = ledgerAt(state, 2);
    expect(() => applyCognitionUpdate(base, observationFor(state, 3), {})).toThrow(/2号/);
  });

  it("is frozen all the way down", async () => {
    const { state } = await finishedGame(20);
    const ledger = ledgerAt(state, 5);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(() => {
      (ledger.publicFacts as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (ledger as unknown as { seat: number }).seat = 9;
    }).toThrow();
  });

  it("stamps its schema", async () => {
    const { state } = await finishedGame(21);
    expect(ledgerAt(state, 1).schema).toBe(LEDGER_SCHEMA);
  });
});

describe("private facts follow the observation boundary", () => {
  it("give each seat exactly what observationFor gave it", async () => {
    const { state } = await finishedGame(22);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const ledger = ledgerFrom(observation, SEATS);
      expect(ledger.privateFacts.role).toBe(observation.role);
      expect(ledger.privateFacts.knowledge).toEqual(observation.knowledge);
      expect(ledger.privateFacts.ladyResults).toEqual([...observation.ladyResults]);
    }
  });

  it("give every seat the same public halves", async () => {
    const { state } = await finishedGame(23);
    const first = ledgerFrom(observationFor(state, 1), SEATS);
    for (const seat of SEATS) {
      const ledger = ledgerFrom(observationFor(state, seat), SEATS);
      // The public record is shared by definition. Any per-seat difference here
      // would be a leak in the other direction.
      expect(JSON.stringify(ledger.publicFacts)).toBe(JSON.stringify(first.publicFacts));
      expect(JSON.stringify(ledger.claims)).toBe(JSON.stringify(first.claims));
    }
  });
});

describe("validation", () => {
  it("passes a fresh ledger", async () => {
    const { state } = await finishedGame(24);
    expect(validateLedger(ledgerAt(state, 1))).toEqual([]);
  });

  it("catches an over-long piece of evidence", async () => {
    const { state } = await finishedGame(25);
    const base = ledgerAt(state, 1);
    const long = "很".repeat(COGNITION_LIMITS.evidenceChars + 5);
    const bad = applyCognitionUpdate(base, observationFor(state, 1), {
      dossiers: {
        3: {
          evidenceFor: [{ text: long, provenance: { kind: "own-role" }, atSequence: 1 }],
        },
      },
    });
    const violations = validateLedger(bad);
    expect(violations.some((v) => v.path.includes("evidenceFor") && v.kind === "chars")).toBe(true);
  });

  it("catches a single hypothesis, because one world is premature lock-in", async () => {
    const { state } = await finishedGame(26);
    const base = ledgerAt(state, 1);
    const bad = applyCognitionUpdate(base, observationFor(state, 1), {
      hypotheses: [
        {
          id: "only",
          label: "只有一种可能",
          evilSeats: [2, 3, 4, 7],
          rationale: "",
          standing: "strong-evil",
          premises: [],
          provenance: { kind: "inference", premises: [] },
        },
      ],
    });
    expect(validateLedger(bad).some((v) => v.path === "hypotheses")).toBe(true);
  });

  it("catches too many hypotheses too", async () => {
    const { state } = await finishedGame(27);
    const base = ledgerAt(state, 1);
    const many = Array.from({ length: COGNITION_LIMITS.maxHypotheses + 2 }, (_, i) => ({
      id: `h${i}`,
      label: `世界${i}`,
      evilSeats: [2 as Seat],
      rationale: "",
      standing: "unresolved" as const,
      premises: [],
      provenance: { kind: "inference" as const, premises: [] },
    }));
    const bad = applyCognitionUpdate(base, observationFor(state, 1), { hypotheses: many });
    expect(validateLedger(bad).some((v) => v.path === "hypotheses" && v.kind === "count")).toBe(true);
  });
});

describe("the game that motivated this", () => {
  it("cannot express Experiment 3's mistake", () => {
    // Seat 6 built "2、3、5 恰有两坏" on "I am loyal" and "seat 9's announcement
    // is true". Both premises are claims. There is no way to write that
    // constraint here and have it come out hard.
    const constraint = deriveConstraint({
      id: "exp3",
      statement: "2、3、5 恰有两坏",
      premises: [
        { id: "f-mission2", verified: true, label: "第二轮两张失败票" },
        { id: "c-self", verified: false, label: "6号自称忠臣" },
        { id: "c-lady", verified: false, label: "9号公布6号是好人" },
      ],
      atSequence: 41,
    });
    expect(constraint.restsOnUnverified).toBe(true);
    expect(constraint.premises.filter((p) => !p.verified)).toHaveLength(2);
  });
});
