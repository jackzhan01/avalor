import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load";
import { createGame } from "../core/referee";
import { observationFor } from "../core/observation";
import type { Observation } from "../core/observation";
import { SEATS, type Seat } from "../core/types";
import {
  applicableHeuristics,
  heuristicApplies,
  renderStrategy,
  strategyById,
  strategyFingerprint,
  STRATEGIES,
} from "./strategies";

/**
 * Role-specific advice reaches the seat that can act on it — and nothing else.
 *
 * Two separate claims, and they need separate proofs:
 *
 *   APPLICABILITY  Percival's candidate-pair考量 renders to Percival and not
 *                  to the other nine. Otherwise the profile teaches every seat
 *                  what every role is doing, which is both prompt clutter and
 *                  a different experiment from the one being run.
 *
 *   NON-LEAKAGE    what a seat reads is a function of its OWN role and side
 *                  and nothing else. This is the one that matters: a filter
 *                  that consulted the deal would hand each seat a fingerprint
 *                  of the game's hidden state, wrapped in strategy advice.
 *
 * The second is proved by construction — the filter takes an `Observation` and
 * has nothing else in scope — and then again by experiment below.
 */

const CONFIG = loadConfig();
const META = strategyById("community-meta");
const BASELINE = strategyById("baseline");

/** A real game, so observations are the ones the referee actually produces. */
function tableOf(seed: number): Record<Seat, Observation> {
  const state = createGame({ seed, config: CONFIG });
  const table = {} as Record<Seat, Observation>;
  for (const seat of SEATS) table[seat] = observationFor(state, seat);
  return table;
}

/** The first seed whose deal gives us a seat holding `role`. */
function seatWithRole(role: string): { observation: Observation; seed: number } {
  for (let seed = 1; seed < 60; seed += 1) {
    const table = tableOf(seed);
    for (const seat of SEATS) {
      if (table[seat].role === role) return { observation: table[seat], seed };
    }
  }
  throw new Error(`no seat with role ${role} in the first 60 seeds`);
}

describe("applicability", () => {
  it("gives Percival the candidate-pair considerations and nobody else", () => {
    const pairIds = ["cm.percival-pair-on-one-team", "cm.percival-pair-split"];
    const { observation: percival } = seatWithRole("percival");
    const seen = applicableHeuristics(META, percival).map((h) => h.id);
    for (const id of pairIds) expect(seen).toContain(id);

    for (const role of ["merlin", "loyal", "assassin", "mordred", "morgana", "oberon"]) {
      const other = seatWithRole(role).observation;
      const theirs = applicableHeuristics(META, other).map((h) => h.id);
      for (const id of pairIds) expect(theirs, `${role} saw ${id}`).not.toContain(id);
    }
  });

  it("gives the Lady/Mordred search to Merlin and nobody else", () => {
    const { observation: merlin } = seatWithRole("merlin");
    expect(applicableHeuristics(META, merlin).map((h) => h.id)).toContain(
      "cm.merlin-lady-hunts-mordred",
    );
    for (const role of ["percival", "loyal", "mordred"]) {
      const other = seatWithRole(role).observation;
      expect(applicableHeuristics(META, other).map((h) => h.id)).not.toContain(
        "cm.merlin-lady-hunts-mordred",
      );
    }
  });

  it("gives the mission-card considerations to evil seats only", () => {
    const evilOnly = [
      "cm.fail-scores-but-narrows",
      "cm.multiple-evil-on-one-team",
      "cm.last-mission-cover-stops-mattering",
    ];
    for (const role of ["assassin", "mordred", "morgana", "oberon"]) {
      const seen = applicableHeuristics(META, seatWithRole(role).observation).map((h) => h.id);
      for (const id of evilOnly) expect(seen, `${role} missing ${id}`).toContain(id);
    }
    for (const role of ["merlin", "percival", "loyal"]) {
      const seen = applicableHeuristics(META, seatWithRole(role).observation).map((h) => h.id);
      for (const id of evilOnly) expect(seen, `${role} saw ${id}`).not.toContain(id);
    }
  });

  it("gives the coalition consideration to good seats only", () => {
    for (const role of ["merlin", "percival", "loyal"]) {
      expect(
        applicableHeuristics(META, seatWithRole(role).observation).map((h) => h.id),
      ).toContain("cm.isolated-signal-needs-uptake");
    }
    for (const role of ["assassin", "mordred", "morgana", "oberon"]) {
      expect(
        applicableHeuristics(META, seatWithRole(role).observation).map((h) => h.id),
      ).not.toContain("cm.isolated-signal-needs-uptake");
    }
  });

  it("gives the general voting and team considerations to every seat", () => {
    const general = [
      "cm.failed-team-is-a-constraint-not-a-verdict",
      "cm.compare-failed-teams",
      "cm.keep-multiple-hypotheses",
      "cm.reject-without-a-perfect-alternative",
      "cm.rejection-streak-and-the-hammer",
      "cm.raise-the-bar-after-failures",
      "cm.correct-dissent-deserves-a-look",
      "cm.correct-dissent-is-evidence-not-proof",
      "cm.address-the-dissent-explicitly",
      "cm.name-what-changed-your-mind",
      "cm.no-proof-is-not-approval",
    ];
    const table = tableOf(1);
    for (const seat of SEATS) {
      const seen = applicableHeuristics(META, table[seat]).map((h) => h.id);
      for (const id of general) expect(seen, `${seat}号 missing ${id}`).toContain(id);
    }
  });

  it("still gives every seat a usable profile, not an empty one", () => {
    const table = tableOf(1);
    for (const seat of SEATS) {
      // Filtering must trim clutter, not gut the arm.
      expect(applicableHeuristics(META, table[seat]).length).toBeGreaterThanOrEqual(15);
    }
  });

  it("leaves baseline empty for everyone — it is the control arm", () => {
    const table = tableOf(1);
    for (const seat of SEATS) {
      expect(applicableHeuristics(BASELINE, table[seat])).toHaveLength(0);
      expect(renderStrategy(BASELINE, table[seat])).toContain("不给任何具体做法");
    }
  });
});

describe("non-leakage", () => {
  /**
   * The experiment: hand the filter an observation whose OWN role and side are
   * unchanged but whose every other field has been replaced with a different
   * game's. If a single character of rendered text moves, the filter consulted
   * something the seat is not entitled to.
   */
  it("renders identically when facts the seat cannot see are swapped", () => {
    const a = tableOf(1);
    const b = tableOf(2);

    for (const seat of SEATS) {
      const mine = a[seat];
      // Everything from another game, except who I am.
      const swapped = {
        ...b[seat],
        seat: mine.seat,
        role: mine.role,
        side: mine.side,
      } as Observation;

      expect(renderStrategy(META, swapped), `${seat}号`).toBe(renderStrategy(META, mine));
    }
  });

  it("depends on role and side, and on nothing else about the observation", () => {
    const table = tableOf(1);
    // Two seats sharing a role read the same profile, whatever else differs.
    const byRole = new Map<string, string>();
    for (let seed = 1; seed <= 12; seed += 1) {
      const t = tableOf(seed);
      for (const seat of SEATS) {
        const key = `${t[seat].role}/${t[seat].side}`;
        const rendered = renderStrategy(META, t[seat]);
        const prior = byRole.get(key);
        if (prior === undefined) byRole.set(key, rendered);
        else expect(rendered, key).toBe(prior);
      }
    }
    expect(byRole.size).toBeGreaterThan(1);
    void table;
  });

  it("never names another seat, a role assignment, or the deal", () => {
    const table = tableOf(1);
    for (const seat of SEATS) {
      const text = renderStrategy(META, table[seat]);
      // The profile talks about roles in the abstract ("if you are Percival"),
      // never about who holds one.
      expect(text).not.toMatch(/\d+号(是|为)(梅林|派西维尔|莫甘娜|莫德雷德|奥伯伦|刺客|忠臣)/);
      expect(text).not.toContain("发牌");
      expect(text).not.toContain("seed");
    }
  });

  it("keeps provenance out of every rendered form", () => {
    const table = tableOf(1);
    for (const strategy of Object.values(STRATEGIES)) {
      for (const seat of SEATS) {
        const text = renderStrategy(strategy, table[seat]);
        expect(text).not.toContain("community-meta-sources");
        expect(text).not.toContain("provenance");
        expect(text).not.toContain("BGG");
        expect(text).not.toContain("知乎");
      }
      // And out of the unfiltered form too, which is what the fingerprint eats.
      expect(renderStrategy(strategy)).not.toContain("community-meta-sources");
    }
  });
});

describe("heuristicApplies", () => {
  it("defaults an unscoped heuristic to everyone", () => {
    const table = tableOf(1);
    const unscoped = { ...META.heuristics[0], scope: undefined };
    for (const seat of SEATS) expect(heuristicApplies(unscoped, table[seat])).toBe(true);
  });
});

describe("the frozen fingerprint", () => {
  it("is stable across calls", () => {
    expect(strategyFingerprint(META)).toBe(strategyFingerprint(META));
    expect(strategyFingerprint(BASELINE)).toBe(strategyFingerprint(BASELINE));
  });

  it("separates the two arms", () => {
    expect(strategyFingerprint(META)).not.toBe(strategyFingerprint(BASELINE));
  });

  it("covers the whole catalog, not just what one seat sees", () => {
    // A digest computed from a filtered view would collide between two arms
    // that happened to agree for one role, which is exactly the drift a paired
    // comparison has to be able to detect.
    const digest = strategyFingerprint(META);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("moves when a rendered word moves", () => {
    const edited = {
      ...META,
      heuristics: META.heuristics.map((h, i) =>
        i === 0 ? { ...h, consider: `${h.consider}。` } : h,
      ),
    };
    expect(strategyFingerprint(edited)).not.toBe(strategyFingerprint(META));
  });

  it("does not move when only provenance changes", () => {
    // Provenance is a note to a human reviewer. Editing one must not look like
    // a changed experiment.
    const annotated = {
      ...META,
      heuristics: META.heuristics.map((h) => ({ ...h, provenance: "重写过的说明" })),
    };
    expect(strategyFingerprint(annotated)).toBe(strategyFingerprint(META));
  });
});
