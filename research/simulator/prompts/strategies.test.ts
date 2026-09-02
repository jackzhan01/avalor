import { describe, expect, it } from "vitest";
import { drive, referenceDeal } from "../fixtures/harness";
import { observationFor, type Observation } from "../core/observation";
import {
  CATALOG_IDS,
  makeCustomStrategy,
  renderStrategy,
  STRATEGIES,
  strategyById,
  strategyFingerprint,
  type CatalogStrategyId,
  type Heuristic,
  type ObservationField,
} from "./strategies";

/**
 * Strategy profiles are options, never rules — and never a channel for this
 * repository's own measurements.
 *
 * Three properties carry the weight.
 *
 * FIRST, the catalog is exactly three. An earlier version shipped four
 * data-informed profiles whose rendered text quoted corpus discrimination
 * ratios and per-round improvements. That was rejected: a prompt that hands a
 * model a number derived from the data is not giving it a consideration, it is
 * giving it a conclusion, and any result from a table primed that way measures
 * the priming.
 *
 * SECOND, nothing is phrased as an obligation. The moment 「派西维尔第一轮必须跳」
 * becomes a rule, the choice it describes stops being a choice and the
 * experiment stops being about anything.
 *
 * THIRD, every condition reads a field that actually exists on an
 * `Observation`. A condition phrased against an imaginary field is advice
 * nobody can act on and nobody can audit.
 */

/** Words that would turn a heuristic into an instruction. */
const IMPERATIVES = ["必须", "一定要", "务必", "不得不", "规则要求", "只能这样", "禁止"];

/**
 * Anything that would smuggle a repository measurement into a prompt.
 *
 * Deliberately blunt. A profile that needs one of these has drifted back into
 * being data-informed gameplay prompting, and the fix is to rewrite it rather
 * than to widen the filter.
 */
const BANNED_IN_PROMPT = [
  "12,882",
  "12882",
  "语料",
  "数据集",
  "胜率",
  "似然比",
  "判别力",
  "实测",
  "统计上最优",
  "最优解",
  "research/README",
  "Brier",
];

function everyHeuristic(): Heuristic[] {
  return Object.values(STRATEGIES).flatMap((s) => s.heuristics);
}

function resolve(observation: Observation, path: ObservationField): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, observation as unknown);
}

function sampleObservation(): Observation {
  const { state } = drive({
    seed: 9,
    deal: referenceDeal(),
    stopWhen: (s) => s.pending?.kind === "leader_close_and_propose",
  });
  return observationFor(state, state.leader);
}

describe("the catalog", () => {
  it("is exactly the seven shipped arms, plus custom built per run", () => {
    const shipped = [
      "baseline",
      "community-meta",
      "expert-claim-contest",
      "expert-cognitive",
      "expert-disciplined",
      "expert-disclosure-safe",
      "expert-social",
    ];
    expect([...CATALOG_IDS].sort()).toEqual(shipped);
    expect(Object.keys(STRATEGIES).sort()).toEqual(shipped);
  });

  it("no longer carries the four data-informed profiles", () => {
    const catalog = Object.keys(STRATEGIES);
    for (const removed of [
      "community-balanced",
      "claim-forward",
      "concealment-first",
      "adaptive",
    ]) {
      expect(catalog).not.toContain(removed);
    }
  });

  it("has a complete baseline that gives no tactics at all", () => {
    expect(STRATEGIES.baseline.status).toBe("complete");
    // The control arm. Whatever community-meta adds has to be measured
    // against a table that was told the rules and its goal and nothing else.
    expect(STRATEGIES.baseline.heuristics).toEqual([]);
  });

  it("marks community-meta a draft, because the survey is incomplete", () => {
    expect(STRATEGIES["community-meta"].status).toBe("draft");
    expect(STRATEGIES["community-meta"].heuristics.length).toBeGreaterThan(8);
  });

  it("has stable, unique heuristic ids within each profile", () => {
    // Uniqueness is per profile, not across the catalog: `expert-social`
    // INHERITS every `expert-cognitive` entry, so those ids appear twice by
    // design. A global uniqueness check would forbid the inheritance.
    for (const strategy of Object.values(STRATEGIES)) {
      const ids = strategy.heuristics.map((h) => h.id);
      expect(new Set(ids).size, strategy.id).toBe(ids.length);
    }
    expect(strategyById("community-meta").id).toBe("community-meta");
  });

  it("builds each expert arm as a strict superset of the last", () => {
    // Identity, not equality: the inherited entries are the SAME objects, so a
    // future edit to one cannot silently produce two versions of a heuristic.
    const chain: [CatalogStrategyId, CatalogStrategyId, string][] = [
      ["expert-cognitive", "expert-social", "es."],
      ["expert-social", "expert-claim-contest", "ecc."],
    ];
    for (const [parentId, childId, prefix] of chain) {
      const parent = strategyById(parentId).heuristics;
      const child = strategyById(childId).heuristics;
      expect(child.slice(0, parent.length), childId).toEqual(parent);
      for (const [i, h] of parent.entries()) expect(child[i], `${childId}[${i}]`).toBe(h);
      expect(child.length, childId).toBeGreaterThan(parent.length);
      for (const h of child.slice(parent.length)) {
        expect(h.id.startsWith(prefix), h.id).toBe(true);
      }
    }
  });

  it("keeps every arm a finished game recorded byte-identical", () => {
    // Each of these is written into a shipped artifact's manifest. A change to
    // one makes that game describe a profile that no longer exists — and the
    // failure would surface months later, when somebody tried to rebuild it.
    expect(strategyFingerprint(strategyById("baseline"))).toBe(
      "71793ece5269104b0720487155ce96a6c6fc3e548e6fbcf2191b6ba35921f868",
    );
    expect(strategyFingerprint(strategyById("community-meta"))).toBe(
      "386267250486a7e628694af4ee7991063e5bbd075f188ddcb6190840f41683ba",
    );
    // The completed M5 pilot, `g-a0b76ac9`.
    expect(strategyFingerprint(strategyById("expert-cognitive"))).toBe(
      "911f22f5dc924f04051ed22daeab70d369edf7e03a60eccec9e958244e81adf1",
    );
  });
});

describe("no rendered prompt carries a repository measurement", () => {
  it("contains none of the banned terms", () => {
    for (const strategy of Object.values(STRATEGIES)) {
      const rendered = renderStrategy(strategy);
      for (const banned of BANNED_IN_PROMPT) {
        expect(rendered, `${strategy.id} leaked "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("contains no empirical percentage or probability figure", () => {
    for (const strategy of Object.values(STRATEGIES)) {
      const rendered = renderStrategy(strategy);
      expect(rendered).not.toMatch(/\d+(\.\d+)?\s*%/);
      // A bare decimal like 0.768 was how the old profiles quoted rates.
      expect(rendered).not.toMatch(/\b0\.\d{2,}\b/);
    }
  });

  /**
   * `provenance` exists for the humans reading the source survey and is
   * deliberately not rendered — rendering it would put citations, and the
   * temptation to put numbers beside them, back into the prompt.
   */
  it("never renders provenance", () => {
    const withProvenance = everyHeuristic().filter((h) => h.provenance);
    expect(withProvenance.length).toBeGreaterThan(0);
    const rendered = Object.values(STRATEGIES).map((s) => renderStrategy(s)).join("\n");
    for (const h of withProvenance) {
      expect(rendered).not.toContain(h.provenance as string);
    }
    expect(rendered).not.toContain("community-meta-sources");
  });
});

describe("nothing in a profile is a rule", () => {
  it("uses no imperative language", () => {
    for (const h of everyHeuristic()) {
      for (const word of IMPERATIVES) {
        expect(`${h.when} ${h.consider}`, h.id).not.toContain(word);
      }
    }
  });

  /**
   * Named explicitly because it is the single most common thing a table will
   * assert as if it were in the rulebook — and because it is exactly the
   * convention this profile was asked to carry as an OPTION.
   */
  it("does not encode 「派西维尔第一轮必须跳」", () => {
    const all = Object.values(STRATEGIES).map((s) => renderStrategy(s)).join("\n");
    expect(all).not.toContain("必须跳");
    expect(all).toContain("跳、不跳、拖一轮再跳、对跳别人、跳完再反跳、一直藏着");
  });

  it("renders every heuristic as something to consider", () => {
    for (const strategy of Object.values(STRATEGIES)) {
      if (strategy.heuristics.length === 0) continue;
      const rendered = renderStrategy(strategy);
      expect(rendered).toContain("它们不是规则，不照做也完全合法");
      for (const h of strategy.heuristics) {
        if (h.obligation) {
          // An obligation constrains what the agent must NOTICE, never what it
          // must do — so it renders as 「必须看到」 and the action stays open.
          expect(rendered).toContain(`【必须看到】**当${h.when}时：${h.consider}`);
        } else {
          expect(rendered).toContain(`当${h.when}时，可以考虑${h.consider}`);
        }
      }
    }
  });

  it("labels the tactics experienced players actually argue about", () => {
    const disputed = everyHeuristic().filter((h) => h.disputed);
    expect(disputed.length).toBeGreaterThan(4);
    for (const strategy of Object.values(STRATEGIES)) {
      const rendered = renderStrategy(strategy);
      for (const h of strategy.heuristics) {
        if (!h.disputed) continue;
        const line = rendered.split("\n").find((l) => l.includes(h.consider));
        expect(line, h.id).toContain("有争议");
      }
    }
  });
});

describe("the Percival convention, as an option", () => {
  const heuristics = STRATEGIES["community-meta"].heuristics;
  const early = heuristics.find((h) => h.id === "cm.percival-early-position");
  const late = heuristics.find((h) => h.id === "cm.percival-late-position");

  it("covers both the early and the late speaking position", () => {
    expect(early).toBeDefined();
    expect(late).toBeDefined();
  });

  it("is disputed on both sides, not presented as settled", () => {
    expect(early!.disputed).toBe(true);
    expect(late!.disputed).toBe(true);
  });

  it("conditions on real speaking-position fields", () => {
    expect(early!.reads).toContain("position.speakingOrder");
    expect(early!.reads).toContain("position.alreadySpoken");
    expect(late!.reads).toContain("position.standingClaims");
  });

  it("names the cost of claiming as well as the benefit", () => {
    // A one-sided recommendation would be advice; naming both sides is what
    // leaves the decision with the agent.
    expect(early!.consider).toContain("代价");
    expect(late!.consider).toContain("先听完再决定");
  });

  it("keeps every other option open alongside it", () => {
    const choice = heuristics.find((h) => h.id === "cm.claim-is-always-a-choice");
    expect(choice).toBeDefined();
    expect(choice!.disputed).toBe(false);
    expect(choice!.consider).toContain("全部是合法选项");
  });
});

describe("community-meta is role-aware and position-aware", () => {
  const heuristics = STRATEGIES["community-meta"].heuristics;

  it("says something specific about each awkward role", () => {
    const text = heuristics.map((h) => `${h.when} ${h.consider}`).join("\n");
    expect(text).toContain("莫德雷德");
    expect(text).toContain("奥伯伦");
    expect(text).toContain("派西维尔");
    expect(text).toContain("梅林");
  });

  it("uses turn order and distance-to-leading as conditions", () => {
    const reads = new Set(heuristics.flatMap((h) => h.reads));
    expect(reads).toContain("position.speakingOrder");
    expect(reads).toContain("position.alreadySpoken");
    expect(reads).toContain("position.seatsUntilILead");
  });
});

describe("conditions read fields that exist", () => {
  it("resolves every declared path on a real observation", () => {
    const observation = sampleObservation();
    const missing: string[] = [];
    for (const h of everyHeuristic()) {
      expect(h.reads.length, h.id).toBeGreaterThan(0);
      for (const path of h.reads) {
        if (resolve(observation, path) === undefined) missing.push(`${h.id} → ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("reads only from the observation, never from referee state", () => {
    for (const h of everyHeuristic()) {
      for (const path of h.reads) {
        expect(path).not.toContain("deal");
        expect(path).not.toContain("pendingVotes");
        expect(path).not.toContain("missionCards");
      }
    }
  });
});

describe("a custom profile", () => {
  it("carries the experimenter's text verbatim, inside the options frame", () => {
    const strategy = makeCustomStrategy("先跟票，第四轮再表态。", "跟票流");
    expect(strategy.id).toBe("custom");
    expect(strategy.customText).toBe("先跟票，第四轮再表态。");
    const rendered = renderStrategy(strategy);
    expect(rendered).toContain("先跟票，第四轮再表态。");
    expect(rendered).toContain("实验者给你的说明");
    expect(rendered).toContain("原文记录在运行清单里");
  });

  it("is marked a draft, because nobody validated it either", () => {
    expect(makeCustomStrategy("随便写点什么").status).toBe("draft");
  });
});
