import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOD_ROLES, EVIL_ROLES } from "@/lib/types/game";
import { SCENARIOS, scenarioById, type Scenario } from "./scenarios";
import { CRITICAL_TASK_CANDIDATES, passesFor, planRequests, projectModeCost } from "./modes";
import { dialSpread, DIAL_VALUES, NEUTRAL_DIALS, PROPOSED_DIALS } from "./persona-dials";

/**
 * The fixtures have to be well-formed before they can grade anything.
 *
 * The property worth the most here is the one about action families: no
 * fixture may name a single legal action as the only expert answer. A rubric
 * that did would score conformity rather than skill — and would quietly delete
 * the very choice (claim / delay / counterclaim / conceal) that the Percival
 * experiments exist to study.
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

const ROLE_NAMES = new Set<string>([...GOOD_ROLES, ...EVIL_ROLES]);

describe("the fixture set", () => {
  it("covers all thirteen required positions", () => {
    expect(SCENARIOS).toHaveLength(13);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(13);
  });

  it("covers each required subject at least once", () => {
    const has = (fragment: string) => SCENARIOS.some((s) => s.id.includes(fragment));
    for (const subject of [
      "percival-early",
      "percival-late",
      "percival-pair-on-one-team",
      "merlin-lady",
      "two-failures",
      "unverified-claim",
      "minority-dissent",
      "reject-without-replacement",
      "two-evil-on-one-team",
      "assassin-tracking",
      "oberon-without-teammates",
      "fifth-proposal",
      "compaction",
    ]) {
      expect(has(subject), subject).toBe(true);
    }
  });

  it("tests every role that has a distinct plan", () => {
    const roles = new Set(SCENARIOS.map((s) => s.tested.role));
    for (const role of ["percival", "merlin", "loyal", "assassin", "oberon"]) {
      expect(roles.has(role as never), role).toBe(true);
    }
  });

  it("is retrievable by id and refuses an unknown one", () => {
    expect(scenarioById("s01.percival-early-position").tested.role).toBe("percival");
    expect(() => scenarioById("nope")).toThrow(/unknown scenario/);
  });
});

describe("no fixture prescribes a single expert action", () => {
  it("offers at least two defensible families, except where the position is degenerate", () => {
    for (const s of SCENARIOS) {
      if (s.id === "s13.long-history-needs-compaction") {
        // The one exception, and it is honest about itself: this fixture tests
        // whether facts survived compaction, not what the right move is, so its
        // single family accepts either vote.
        expect(s.acceptableActionFamilies[0].description).toContain("都可以");
        continue;
      }
      expect(s.acceptableActionFamilies.length, s.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps every Percival line open — claim, delay, counterclaim and conceal", () => {
    const percival = SCENARIOS.filter((s) => s.tested.role === "percival");
    const families = percival.flatMap((s) => s.acceptableActionFamilies.map((f) => f.id));
    expect(families).toContain("claim-early");
    expect(families).toContain("delay-one-round");
    expect(families).toContain("counterclaim");
    expect(families).toContain("stay-hidden-and-probe");
  });

  it("grades the justification rather than the choice", () => {
    for (const s of SCENARIOS) {
      for (const family of s.acceptableActionFamilies) {
        // A family with nothing to justify is a free pass, which is the same
        // failure as a prescribed action wearing the opposite hat.
        expect(family.mustJustify.length, `${s.id}/${family.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the evil mission card genuinely open in both directions", () => {
    const s = scenarioById("s09.two-evil-on-one-team");
    const ids = s.acceptableActionFamilies.map((f) => f.id);
    // No mandatory fail convention: playing success is a listed expert line.
    expect(ids).toContain("play-success-for-cover");
    expect(ids).toContain("coordinate-single-fail");
    expect(ids).toContain("double-fail-deliberately");
  });
});

describe("analysis obligations", () => {
  it("exist for every fixture and are specific", () => {
    for (const s of SCENARIOS) {
      expect(s.analysisObligations.length, s.id).toBeGreaterThan(0);
      for (const o of s.analysisObligations) expect(o.length).toBeGreaterThan(6);
    }
  });

  it("make the Percival pair deduction mandatory even though the action is not", () => {
    const s = scenarioById("s03.percival-pair-on-one-team");
    // Noticing is compulsory; what you then do about it is not. That split is
    // the whole design of these rubrics.
    expect(s.analysisObligations.some((o) => o.includes("一定有莫甘娜"))).toBe(true);
    expect(s.acceptableActionFamilies.length).toBeGreaterThanOrEqual(3);
  });

  it("make Merlin separate visible evil from the Mordred blind spot", () => {
    const s = scenarioById("s04.merlin-lady-unresolved-mordred");
    expect(s.analysisObligations.some((o) => o.includes("莫德雷德"))).toBe(true);
    expect(s.analysisObligations.some((o) => o.includes("换不到任何新信息"))).toBe(true);
  });

  it("make the unverified-premise fixture about premises, not arithmetic", () => {
    const s = scenarioById("s06.persuasive-conclusion-on-unverified-claim");
    expect(s.analysisObligations.some((o) => o.includes("说法"))).toBe(true);
    expect(s.analysisObligations.some((o) => o.includes("算术在前提成立时是对的"))).toBe(true);
  });
});

describe("forbidden leaks", () => {
  it("are declared wherever the tested seat holds hidden knowledge", () => {
    for (const s of SCENARIOS) {
      const hasSecret = s.tested.knowledge.kind !== "none" || s.tested.side === "evil";
      if (!hasSecret) continue;
      expect(s.forbiddenLeaks.length, s.id).toBeGreaterThan(0);
    }
  });

  it("never appear in the fixture's own public material", () => {
    for (const s of SCENARIOS) {
      const publicText = [
        s.title,
        ...s.claims.map((c) => c.text),
        ...s.acceptableActionFamilies.flatMap((f) => [f.description, ...f.mustJustify]),
      ].join("\n");
      for (const leak of s.forbiddenLeaks) {
        expect(publicText, `${s.id}: ${leak}`).not.toContain(leak);
      }
    }
  });

  it("do not forbid a seat from stating its own role where that is a legal move", () => {
    // Percival claiming is a listed family; the forbidden strings must be about
    // the PAIR, never about the act of claiming.
    const s = scenarioById("s01.percival-early-position");
    expect(s.forbiddenLeaks.every((l) => !l.includes("我是派西维尔"))).toBe(true);
  });
});

describe("fixture consistency", () => {
  it("keeps the score consistent with the mission facts", () => {
    for (const s of SCENARIOS) {
      const missions = s.publicFacts.filter((f) => f.kind === "mission");
      const successes = missions.filter((f) => f.kind === "mission" && f.result === "success").length;
      const fails = missions.filter((f) => f.kind === "mission" && f.result === "fail").length;
      expect(s.score.successes, `${s.id} successes`).toBe(successes);
      expect(s.score.fails, `${s.id} fails`).toBe(fails);
    }
  });

  it("keeps a proposed team consistent with the last proposal fact", () => {
    for (const s of SCENARIOS) {
      if (!s.proposedTeam) continue;
      const proposals = s.publicFacts.filter(
        (f): f is Extract<Scenario["publicFacts"][number], { kind: "proposal" }> =>
          f.kind === "proposal",
      );
      if (proposals.length === 0) continue;
      const last = proposals[proposals.length - 1];
      expect([...last.team].sort(), s.id).toEqual([...s.proposedTeam].sort());
    }
  });

  it("gives Percival a two-seat pair and Merlin a visible-evil list", () => {
    for (const s of SCENARIOS) {
      if (s.tested.role === "percival") {
        expect(s.tested.knowledge.kind).toBe("merlin_or_morgana");
        if (s.tested.knowledge.kind === "merlin_or_morgana") {
          expect(s.tested.knowledge.pair).toHaveLength(2);
        }
      }
      if (s.tested.role === "merlin") {
        expect(s.tested.knowledge.kind).toBe("sees_evil");
      }
      if (s.tested.role === "oberon") {
        // Oberon's whole point: evil with no teammate knowledge.
        expect(s.tested.side).toBe("evil");
        expect(s.tested.knowledge.kind).toBe("none");
      }
    }
  });

  it("names expert failure modes rather than generic mistakes", () => {
    for (const s of SCENARIOS) {
      expect(s.expertFailureModes.length, s.id).toBeGreaterThan(0);
      for (const mode of s.expertFailureModes) expect(mode.length).toBeGreaterThan(8);
    }
  });

  it("mentions no role name in a fixture title, which a grader might see", () => {
    void ROLE_NAMES;
    for (const s of SCENARIOS) {
      // Chinese role words are fine and intended; the English enum values would
      // suggest the fixture was generated from the deal rather than authored.
      for (const role of ROLE_NAMES) expect(s.title).not.toContain(role);
    }
  });
});

describe("cognition modes are described but not chosen", () => {
  it("defaults to nothing — two-pass with no critical tasks is just fused", () => {
    expect(passesFor({ kind: "fused" }, "vote")).toBe(1);
    expect(passesFor({ kind: "two-pass-critical", criticalTasks: [] }, "vote")).toBe(1);
  });

  it("splits only the configured critical tasks", () => {
    const mode = {
      kind: "two-pass-critical" as const,
      criticalTasks: ["lady-select" as const],
    };
    expect(passesFor(mode, "lady-select")).toBe(2);
    expect(passesFor(mode, "speech-regular")).toBe(1);
  });

  it("says what each pass would cost without sending anything", () => {
    const mode = {
      kind: "two-pass-critical" as const,
      criticalTasks: ["leader-close-and-propose" as const],
    };
    const plan = planRequests(mode, "leader-close-and-propose");
    expect(plan.passes).toBe(2);
    expect(plan.labels).toEqual([
      "analyse:leader-close-and-propose",
      "act:leader-close-and-propose",
    ]);
    // Both passes carry the same history, so input is paid roughly twice.
    expect(plan.inputMultiplier).toBe(2);
  });

  it("projects a mix rather than hard-coding one game's shape", () => {
    const mix = { "speech-regular": 80, vote: 40, "leader-close-and-propose": 6 };
    const fused = projectModeCost({ kind: "fused" }, mix);
    const twoPass = projectModeCost(
      { kind: "two-pass-critical", criticalTasks: ["leader-close-and-propose"] },
      mix,
    );
    expect(fused.calls).toBe(126);
    expect(twoPass.calls).toBe(132);
    expect(twoPass.inputUnits).toBeGreaterThan(fused.inputUnits);
  });

  it("gives a reason for every critical-task candidate", () => {
    expect(CRITICAL_TASK_CANDIDATES).toHaveLength(5);
    for (const c of CRITICAL_TASK_CANDIDATES) expect(c.why.length).toBeGreaterThan(10);
  });
});

describe("persona dials span the space they claim to", () => {
  it("varies every dial across the catalog", () => {
    const spread = dialSpread();
    for (const [key, distinct] of Object.entries(spread)) {
      // A dial that is the same for all ten personas is not a dial, and would
      // reproduce exactly the "ten writing styles, one policy" problem.
      expect(distinct, key).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses only the three declared settings", () => {
    for (const dials of Object.values(PROPOSED_DIALS)) {
      for (const value of Object.values(dials)) expect(DIAL_VALUES).toContain(value);
    }
  });

  it("keeps the neutral control genuinely neutral", () => {
    for (const value of Object.values(NEUTRAL_DIALS)) expect(value).toBe("mid");
  });

  it("covers all ten existing persona ids", () => {
    for (const id of [
      "connector",
      "steady",
      "mediator",
      "terse",
      "gambler",
      "ledger",
      "direct",
      "challenger",
      "listener",
      "skeptic",
    ]) {
      expect(PROPOSED_DIALS[id], id).toBeDefined();
    }
  });
});
