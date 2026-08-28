import { describe, expect, it } from "vitest";
import { drive, referenceDeal, testConfig } from "../fixtures/harness";
import { observationFor } from "../core/observation";
import { SEATS, type Seat } from "../core/types";
import { loadProfile } from "../config/load";
import {
  buildFactRegistry,
  CURRENT_STATE_ID,
  FACT_ID_LEGEND,
  failComparisonId,
  failConstraintId,
  isVerifiedPremise,
  ladyResultId,
  LEGACY_OWN_ROLE_ID,
  PRIVATE_IDS,
  resolvePremiseId,
} from "./fact-ids";
import { renderFactTables, renderOwnPrivateFacts } from "./context-pack";
import { ledgerFrom } from "./ledger";
import { applyFusedUpdate, type FusedCognition } from "./response";

/**
 * The M5.1 repair, checked against the thing that actually broke.
 *
 * The completed pilot asked for `premiseIds` and rendered none, so the model
 * invented `f_private_8_percival_pair_7_9` and `f_current_state` and wrote
 * eleven raw prose strings — and all 871 citations came back unverified. Every
 * test here is written against a RENDERED prompt rather than against the
 * registry alone, because the registry was never the broken half.
 */

const CONFIG = testConfig();

/** A game far enough in to have missions, votes, claims and a Lady result. */
function midGame() {
  return drive({
    deal: referenceDeal(),
    config: CONFIG,
    stopWhen: (state) => state.missionNumber >= 3,
  });
}

function registryFor(seat: Seat, state = midGame().state) {
  const observation = observationFor(state, seat);
  const ledger = ledgerFrom(observation, SEATS);
  return {
    observation,
    ledger,
    registry: buildFactRegistry(ledger.publicFacts, ledger.claims, observation),
  };
}

/** Ids as the prompt actually prints them: `` `[id]` ``. */
function idsInText(text: string): string[] {
  return [...text.matchAll(/`\[([^\]]+)\]`/g)]
    .map((m) => m[1])
    .filter((id) => /^[\x21-\x7e]+$/.test(id));
}

describe("what the prompt prints is what the registry resolves", () => {
  it("prints an id beside every referee fact, and every one of them verifies", () => {
    const { observation, ledger, registry } = registryFor(4);
    const rendered = renderFactTables(ledger.publicFacts, ledger.claims, observation, {
      withIds: true,
    });
    const printed = idsInText(rendered);
    expect(printed.length).toBeGreaterThan(5);
    for (const id of printed) {
      expect(resolvePremiseId(registry, id).status, id).not.toBe("unknown");
    }
  });

  it("prints one id per public fact, none missing", () => {
    const { observation, ledger } = registryFor(4);
    const rendered = renderFactTables(ledger.publicFacts, ledger.claims, observation, {
      withIds: true,
    });
    for (const fact of ledger.publicFacts) {
      // `leader_change` is bookkeeping the tables do not list; everything a
      // premise would plausibly cite is here.
      if (fact.kind === "leader_change" || fact.kind === "game_end") continue;
      expect(rendered, fact.kind).toContain(`\`[${fact.id}]\``);
    }
  });

  it("prints the current-state and failed-team ids the pilot invented by hand", () => {
    const { observation, ledger } = registryFor(4);
    const rendered = renderFactTables(ledger.publicFacts, ledger.claims, observation, {
      withIds: true,
    });
    // The pilot's model wrote `f_current_state` unprompted. It now exists.
    expect(rendered).toContain(`\`[${CURRENT_STATE_ID}]\``);
  });

  it("renders the legend that says what each prefix means", () => {
    const { observation, ledger } = registryFor(4);
    const rendered = renderFactTables(ledger.publicFacts, ledger.claims, observation, {
      withIds: true,
    });
    expect(rendered).toContain(FACT_ID_LEGEND);
  });

  it("prints nothing extra on the frozen 0.3.0 path", () => {
    const { observation, ledger } = registryFor(4);
    const withIds = renderFactTables(ledger.publicFacts, ledger.claims, observation, {
      withIds: true,
    });
    const without = renderFactTables(ledger.publicFacts, ledger.claims, observation);
    expect(idsInText(without)).toHaveLength(0);
    expect(without.length).toBeLessThan(withIds.length);
    // Defaulting to the old shape is what keeps the completed pilot buildable.
    expect(renderFactTables(ledger.publicFacts, ledger.claims, observation, {})).toBe(without);
  });
});

describe("a claim stays a claim", () => {
  it("resolves a role claim to `claim`, never to `fact`", () => {
    const played = drive({
      deal: referenceDeal(),
      config: CONFIG,
      override: (observation) =>
        observation.request?.kind === "speech" && observation.seat === 3
          ? {
              kind: "speech",
              publicMessage: "我是梅林。",
              claim: "merlin",
              stances: [],
              tentativeTeam: null,
              noTeamYet: false,
            }
          : undefined,
      stopWhen: (state) => state.missionNumber >= 2,
    });
    const { registry } = registryFor(5, played.state);
    const claims = registry.entries.filter((e) => e.kind === "claim");
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(resolvePremiseId(registry, claim.id).status).toBe("claim");
      expect(isVerifiedPremise(registry, claim.id)).toBe(false);
    }
  });

  it("gives a Lady announcement two ids: the announcing, and the assertion", () => {
    const played = drive({
      deal: referenceDeal(),
      config: CONFIG,
      stopWhen: (state) => state.log.some((e) => e.type === "lady_announced"),
    });
    const { observation, ledger, registry } = registryFor(5, played.state);
    const announcement = ledger.publicFacts.find((f) => f.kind === "lady_announcement");
    const assertion = ledger.claims.find((c) => c.kind === "lady_claim");
    expect(announcement).toBeTruthy();
    expect(assertion).toBeTruthy();
    // Announcing is a referee record. What was announced is not.
    expect(isVerifiedPremise(registry, announcement!.id)).toBe(true);
    expect(isVerifiedPremise(registry, assertion!.id)).toBe(false);
    const rendered = renderFactTables(ledger.publicFacts, ledger.claims, observation, {
      withIds: true,
    });
    expect(rendered).toContain(`\`[${announcement!.id}]\``);
    expect(rendered).toContain(`\`[${assertion!.id}]\``);
  });
});

describe("a fabricated id buys nothing", () => {
  it("refuses the exact ids the pilot's model invented", () => {
    const { registry } = registryFor(2);
    for (const invented of [
      "f_private_8_percival_pair_7_9",
      "f_current_state",
      "c8_opening",
      "R1#1任务失败：8、1、3号且有1张失败票",
      "f999",
      "",
    ]) {
      expect(resolvePremiseId(registry, invented).status, invented).toBe("unknown");
      expect(isVerifiedPremise(registry, invented)).toBe(false);
    }
  });

  it("marks a constraint built on a fabricated id as resting on nothing hard", () => {
    const { observation, ledger, registry } = registryFor(2);
    const result = applyFusedUpdate(
      ledger,
      observation,
      cognitionCiting(["f_current_state"]),
      10,
      { registry },
    );
    expect(result.premisesVerified).toBe(0);
    expect(result.premisesOverridden).toBe(1);
    expect(result.ledger.constraints[0].restsOnUnverified).toBe(true);
  });

  it("marks a constraint built on a REAL id as hard", () => {
    const { observation, ledger, registry } = registryFor(2);
    const result = applyFusedUpdate(ledger, observation, cognitionCiting([CURRENT_STATE_ID]), 10, {
      registry,
    });
    expect(result.premisesVerified).toBe(1);
    expect(result.premisesOverridden).toBe(0);
    expect(result.ledger.constraints[0].restsOnUnverified).toBe(false);
  });
});

describe("private ids are seat-scoped", () => {
  const state = midGame().state;

  it("mints Percival's pair only for Percival", () => {
    for (const seat of SEATS) {
      const { observation, registry } = registryFor(seat, state);
      const entitled = observation.knowledge.kind === "merlin_or_morgana";
      expect(isVerifiedPremise(registry, PRIVATE_IDS.percivalPair), `${seat}`).toBe(entitled);
    }
    // And exactly one seat is entitled, in this deal: seat 2.
    expect(observationFor(state, 2).knowledge.kind).toBe("merlin_or_morgana");
  });

  it("mints Merlin's visible evil only for Merlin", () => {
    const merlin = registryFor(1, state);
    expect(isVerifiedPremise(merlin.registry, PRIVATE_IDS.seesEvil)).toBe(true);
    for (const seat of SEATS) {
      if (seat === 1) continue;
      const { registry } = registryFor(seat, state);
      expect(isVerifiedPremise(registry, PRIVATE_IDS.seesEvil), `${seat}`).toBe(false);
    }
  });

  it("mints the teammate list only for evil seats that have one", () => {
    for (const seat of SEATS) {
      const { observation, registry } = registryFor(seat, state);
      const entitled = observation.knowledge.kind === "knows_teammates";
      expect(isVerifiedPremise(registry, PRIVATE_IDS.teammates), `${seat}`).toBe(entitled);
    }
  });

  it("cannot be guessed: an unauthorised seat citing a private id gets nothing", () => {
    // Seat 5 is a plain loyal. It writes seat 2's id, which it could have read
    // in a published trace. Its own registry has never heard of it.
    const { observation, ledger, registry } = registryFor(5, state);
    const result = applyFusedUpdate(
      ledger,
      observation,
      cognitionCiting([PRIVATE_IDS.percivalPair, PRIVATE_IDS.seesEvil]),
      10,
      { registry },
    );
    expect(result.premisesVerified).toBe(0);
    expect(result.premisesOverridden).toBe(2);
    expect(result.ledger.constraints[0].restsOnUnverified).toBe(true);
  });

  it("still gives an entitled seat the same id, so the gate is the registry", () => {
    // The paired half. Without it, the test above would pass even if private
    // ids never worked for anybody.
    const { observation, ledger, registry } = registryFor(2, state);
    const result = applyFusedUpdate(
      ledger,
      observation,
      cognitionCiting([PRIVATE_IDS.percivalPair]),
      10,
      { registry },
    );
    expect(result.premisesVerified).toBe(1);
    expect(result.ledger.constraints[0].restsOnUnverified).toBe(false);
  });

  it("never renders another seat's private id into this seat's prompt", () => {
    for (const seat of SEATS) {
      const { observation } = registryFor(seat, state);
      const rendered = renderOwnPrivateFacts(observation, { withIds: true });
      const printed = idsInText(rendered);
      const mine = buildFactRegistry([], [], observation);
      for (const id of printed) {
        expect(mine.byId.has(id), `${seat} printed ${id}`).toBe(true);
      }
    }
  });

  it("gives a seat its own Lady results and nobody else's", () => {
    const played = drive({
      deal: referenceDeal(),
      config: CONFIG,
      stopWhen: (state) => state.log.filter((e) => e.type === "lady_announced").length >= 1,
    });
    const holders = SEATS.filter(
      (seat) => observationFor(played.state, seat).ladyResults.length > 0,
    );
    expect(holders.length).toBeGreaterThan(0);
    for (const seat of SEATS) {
      const { observation, registry } = registryFor(seat, played.state);
      for (const r of observation.ladyResults) {
        expect(isVerifiedPremise(registry, ladyResultId(r.missionNumber))).toBe(true);
      }
      if (observation.ladyResults.length === 0) {
        for (const n of [1, 2, 3, 4, 5]) {
          expect(isVerifiedPremise(registry, ladyResultId(n)), `${seat}/${n}`).toBe(false);
        }
      }
    }
  });
});

describe("ids are deterministic", () => {
  it("gives every seat the same id for the same public fact", () => {
    const state = midGame().state;
    const bySeat = SEATS.map((seat) => {
      const { registry } = registryFor(seat, state);
      return registry.entries.filter((e) => e.kind !== "private-fact").map((e) => e.id);
    });
    for (const ids of bySeat) expect(ids).toEqual(bySeat[0]);
  });

  it("mints the identical list twice from the same position", () => {
    const state = midGame().state;
    const a = registryFor(7, state).registry;
    const b = registryFor(7, state).registry;
    expect(a.entries.map((e) => `${e.id}|${e.label}`)).toEqual(
      b.entries.map((e) => `${e.id}|${e.label}`),
    );
  });

  it("survives replay: rebuilding the position from actions mints the same ids", () => {
    const played = midGame();
    const before = registryFor(6, played.state).registry.entries.map((e) => e.id);

    // Re-drive the same deal and seed. Ids come from sequence numbers, so a
    // deterministic replay must reproduce them exactly — which is what lets a
    // constraint stored in a checkpoint still resolve after a resume.
    const again = drive({
      deal: referenceDeal(),
      config: CONFIG,
      stopWhen: (state) => state.missionNumber >= 3,
    });
    const after = registryFor(6, again.state).registry.entries.map((e) => e.id);
    expect(after).toEqual(before);
  });

  it("names the derived arithmetic after the missions it compares", () => {
    expect(failConstraintId(2)).toBe("f.fail2");
    expect(failComparisonId(1, 3)).toBe("f.cmp1x3");
  });
});

describe("the pre-M5.1 id keeps working", () => {
  it("still accepts `own-role`, so a resumed 0.3.0 constraint does not decay", () => {
    const { registry } = registryFor(3);
    expect(isVerifiedPremise(registry, LEGACY_OWN_ROLE_ID)).toBe(true);
  });

  it("resolves premises the old way when no registry is supplied", () => {
    const { observation, ledger } = registryFor(3);
    const factId = ledger.publicFacts[0].id;
    const result = applyFusedUpdate(ledger, observation, cognitionCiting([factId]), 10);
    expect(result.premisesVerified).toBe(1);
    // And the new synthetic ids are NOT verified without a registry — the old
    // path never knew about them, and pretending otherwise would rewrite what
    // a 0.3.0 replay concluded.
    const synthetic = applyFusedUpdate(
      ledger,
      observation,
      cognitionCiting([CURRENT_STATE_ID]),
      10,
    );
    expect(synthetic.premisesVerified).toBe(0);
  });
});

describe("the M5.1 profile actually turns it on", () => {
  it("renders ids under prompt-0.3.1 and not under 0.3.0", () => {
    expect(loadProfile("m5-1-pilot").promptVersion).toBe("prompt-0.3.1");
    expect(loadProfile("m5-pilot").promptVersion).toBe("prompt-0.3.0");
  });
});

/** A minimal legal cognition block whose one constraint cites `ids`. */
function cognitionCiting(ids: readonly string[]): FusedCognition {
  return {
    factsUsed: [],
    claimsReliedOn: [],
    claimsQuestioned: [],
    alternativesConsidered: ["甲", "乙"],
    selectedActionSummary: "测试用",
    intendedPublicSignal: "测试用",
    updatedRolePlan: null,
    constraints: [
      {
        id: "k1",
        statement: "测试约束",
        premiseIds: [...ids],
        premiseLabels: ids.map(() => "前提"),
      },
    ],
    hypotheses: [
      { id: "h1", label: "世界一", evilSeats: [1], rationale: "理由", standing: "unresolved" },
      { id: "h2", label: "世界二", evilSeats: [2], rationale: "理由", standing: "unresolved" },
    ],
    seatReads: [],
    coverStory: "",
    claimPlan: "",
    nextTurnPlan: "",
    newCommitments: [],
  };
}
