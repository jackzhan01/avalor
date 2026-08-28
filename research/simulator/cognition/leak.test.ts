import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOD_ROLES, EVIL_ROLES } from "@/lib/types/game";
import { loadConfig } from "../config/load";
import { observationFor } from "../core/observation";
import type { Observation } from "../core/observation";
import { PROFILES, scriptedTable } from "../agents/scripted-agent";
import { runGame } from "../run/runner";
import { SEATS, type Seat } from "../core/types";
import { packContext, renderPack } from "./context-pack";
import { ledgerFrom } from "./ledger";
import { claimContestFrom, renderClaimContest } from "./claim-contest";
import { contestFragment } from "./contest";
import { buildFactRegistry, isVerifiedPremise, PRIVATE_IDS } from "./fact-ids";
import { limitsFor } from "./limits";
import {
  DECISION_PROTOCOL_LAYER,
  DECISION_PROTOCOL_LAYER_V2,
  DECISION_PROTOCOL_LAYER_V3,
} from "./protocol";
import { socialFragment } from "./social";
import { dialsFor, renderDials, NEUTRAL_DIALS, PROPOSED_DIALS } from "./persona-dials";

/**
 * The property everything else rests on: a seat's prompt is a function of what
 * that seat is entitled to know, and of nothing else.
 *
 * The M2 leakage suite proved this for `observationFor`. M5 adds three new
 * things that reach a prompt — a ledger, a context pack, and persona dials —
 * and each is a new opportunity to leak. The test that matters is the swap:
 * take a seat's observation, replace the facts it is NOT entitled to with a
 * different game's, and require the rendered prompt to be byte-identical. Any
 * dependence on a hidden fact shows up as a diff.
 *
 * Note what is NOT asserted: that role names never appear. They legitimately
 * do — "你是 percival" is the seat's own role, and the private-facts block
 * exists to say it. The claim is narrower and stronger: nothing about ANOTHER
 * seat's hidden state may move a byte.
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
const ROLE_NAMES = new Set<string>([...GOOD_ROLES, ...EVIL_ROLES]);

async function game(seed: number) {
  return runGame({
    seed,
    agents: scriptedTable({ seed, profile: PROFILES.mixed }),
    config: CONFIG,
    runId: "cog",
  });
}

/**
 * Fabricated evil-only content.
 *
 * Deliberately synthetic rather than borrowed from a second game: a finished
 * game leaves `evilDiscussion` empty and `evilRoster` null for every seat, so a
 * donor-game swap injects nothing and the byte-identity assertion passes for
 * the wrong reason. Made-up values are unmistakably present, which makes the
 * gate's job — refusing to render them for a seat that may not see them —
 * something the test can actually observe.
 */
const FABRICATED_ROSTER = [
  { seat: 2 as Seat, role: "assassin" as const },
  { seat: 3 as Seat, role: "mordred" as const },
  { seat: 7 as Seat, role: "morgana" as const },
  { seat: 4 as Seat, role: "oberon" as const },
];
const FABRICATED_DISCUSSION = [
  { sequence: 1, speaker: 2 as Seat, message: "这一轮我来踩，你们别动" },
  { sequence: 2, speaker: 3 as Seat, message: "收到，我保持干净" },
];

function render(observation: Observation): string {
  const ledger = ledgerFrom(observation, SEATS);
  return renderPack(
    packContext({
      observation,
      ledger,
      cognitionText: "",
      taskAndSchema: "## 本次任务\n请投票。",
      olderArguments: [],
    }),
  );
}

describe("the context pack depends only on what the seat may see", () => {
  it("is byte-identical when facts a good seat may NOT see are swapped in", async () => {
    const a = await game(31);
    const b = await game(32);

    // Scoped to good seats deliberately. `evilRoster` and `evilDiscussion` are
    // FORBIDDEN for them and ENTITLED for an evil seat, so swapping them into
    // an evil seat would be swapping legitimate content and would prove
    // nothing. The forbidden case is the one worth locking down.
    void b;
    let checked = 0;
    for (const seat of SEATS) {
      const mine = observationFor(a.state, seat);
      if (mine.side !== "good") continue;

      const swapped = Object.freeze({
        ...mine,
        evilRoster: FABRICATED_ROSTER,
        evilDiscussion: FABRICATED_DISCUSSION,
      }) as unknown as Observation;

      const text = render(swapped);
      expect(text, `${seat}号`).toBe(render(mine));
      // And specifically: none of the injected content surfaced.
      expect(text).not.toContain("这一轮我来踩");
      expect(text).not.toContain("坏人密谈");
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("does render that same content for a seat entitled to it", async () => {
    // The other half of the gate. Without this, "nothing leaked" could simply
    // mean "the renderer never emits this field at all", which would make the
    // test above vacuous.
    const { state } = await game(32);
    const evilSeat = SEATS.find((s) => observationFor(state, s).side === "evil");
    expect(evilSeat).toBeDefined();
    const entitled = Object.freeze({
      ...observationFor(state, evilSeat as Seat),
      evilDiscussion: FABRICATED_DISCUSSION,
    }) as unknown as Observation;
    const text = render(entitled);
    expect(text).toContain("坏人密谈");
    expect(text).toContain("这一轮我来踩");
  });

  it("differs between two seats, so the test above is not vacuous", async () => {
    const { state } = await game(33);
    const one = render(observationFor(state, 1));
    const two = render(observationFor(state, 2));
    // Different seats see different private blocks. If these matched, the
    // byte-identity assertion would be proving nothing.
    expect(two).not.toBe(one);
  });

  it("never names another seat's role outside the seat's own entitlement", async () => {
    const { state } = await game(34);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const text = render(observation);

      // Strip the block the seat is entitled to, then look for role names.
      const privateStart = text.indexOf("## 只有你知道的硬信息");
      const privateEnd = text.indexOf("\n## ", privateStart + 1);
      const withoutOwnBlock =
        privateStart >= 0
          ? text.slice(0, privateStart) + (privateEnd > 0 ? text.slice(privateEnd) : "")
          : text;

      for (const role of ROLE_NAMES) {
        // `game_end` reveals the deal, but a finished game is not packed for a
        // decision. Any role name outside the private block is a leak.
        expect(withoutOwnBlock, `${seat}号 leaked ${role}`).not.toContain(role);
      }
    }
  });

  it("never carries the seed or the deal", async () => {
    const { state } = await game(35);
    for (const seat of SEATS) {
      const text = render(observationFor(state, seat));
      expect(text).not.toContain("seed");
      expect(text).not.toContain("bySeat");
      expect(text).not.toContain("missionCards");
      expect(text).not.toContain("pendingVotes");
      expect(text).not.toContain("trueSide");
    }
  });

  it("gives a good seat no evil discussion, whatever was passed in", async () => {
    const a = await game(36);
    const b = await game(37);
    void b;
    for (const seat of SEATS) {
      const mine = observationFor(a.state, seat);
      if (mine.side !== "good") continue;
      const swapped = Object.freeze({
        ...mine,
        evilDiscussion: FABRICATED_DISCUSSION,
      }) as unknown as Observation;
      expect(render(swapped)).toBe(render(mine));
      expect(render(swapped)).not.toContain("坏人密谈");
    }
  });
});

describe("the ledger depends only on what the seat may see", () => {
  it("gives every seat the same public halves and its own private half", async () => {
    const { state } = await game(38);
    const first = ledgerFrom(observationFor(state, 1), SEATS);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const ledger = ledgerFrom(observation, SEATS);
      expect(JSON.stringify(ledger.publicFacts)).toBe(JSON.stringify(first.publicFacts));
      expect(ledger.privateFacts.seat).toBe(seat);
      expect(ledger.privateFacts.knowledge).toEqual(observation.knowledge);
    }
  });

  it("is unchanged for a good seat when evil-only fields are swapped in", async () => {
    const a = await game(39);
    let checked = 0;
    for (const seat of SEATS) {
      const mine = observationFor(a.state, seat);
      if (mine.side !== "good") continue;
      const swapped = Object.freeze({
        ...mine,
        evilRoster: FABRICATED_ROSTER,
        evilDiscussion: FABRICATED_DISCUSSION,
      }) as unknown as Observation;
      // The ledger gates the roster on the seat's own side, so a hand-built
      // observation cannot hand a good seat the answer sheet.
      expect(ledgerFrom(swapped, SEATS).privateFacts.evilRoster).toBeNull();
      expect(JSON.stringify(ledgerFrom(swapped, SEATS))).toBe(
        JSON.stringify(ledgerFrom(mine, SEATS)),
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("persona dials carry no alignment", () => {
  it("render identically for the same persona whatever side holds it", () => {
    for (const id of Object.keys(PROPOSED_DIALS)) {
      const text = renderDials(dialsFor(id, "heterogeneous"));
      // The dial text is a pure function of the persona id. Side never enters.
      expect(renderDials(dialsFor(id, "heterogeneous"))).toBe(text);
      expect(text).not.toContain("坏人");
      expect(text).not.toContain("好人");
    }
  });

  it("render the same NUMBER of lines for every persona", () => {
    // A good seat whose persona block were visibly shorter would leak its side
    // to anyone comparing two prompts side by side.
    const counts = Object.keys(PROPOSED_DIALS).map(
      (id) => renderDials(dialsFor(id, "heterogeneous")).split("\n").length,
    );
    expect(new Set(counts).size).toBe(1);
    expect(renderDials(NEUTRAL_DIALS).split("\n").length).toBe(counts[0]);
  });

  it("collapse to neutral in the control mode", () => {
    for (const id of Object.keys(PROPOSED_DIALS)) {
      expect(dialsFor(id, "neutral")).toEqual(NEUTRAL_DIALS);
    }
  });

  it("mention no role and no seat number", () => {
    for (const id of Object.keys(PROPOSED_DIALS)) {
      const text = renderDials(dialsFor(id, "heterogeneous"));
      for (const role of ROLE_NAMES) expect(text).not.toContain(role);
      expect(text).not.toMatch(/\d+号/);
    }
  });
});

describe("the protocol layer is the same for everyone", () => {
  it("contains no seat, role, side or game state", () => {
    for (const role of ROLE_NAMES) expect(DECISION_PROTOCOL_LAYER).not.toContain(role);
    expect(DECISION_PROTOCOL_LAYER).not.toMatch(/\d+号/);
    expect(DECISION_PROTOCOL_LAYER).not.toContain("seed");
  });

  it("asks for conclusions, never for a reasoning transcript", () => {
    // The protocol says to think and NOT to write the thinking down. A layer
    // that asked for the process would grow every later prompt by its length.
    expect(DECISION_PROTOCOL_LAYER).toContain("不要写出来");
    expect(DECISION_PROTOCOL_LAYER).toContain("不要写进公开发言");
  });
});

/* ── The M5.1 surfaces ──────────────────────────────────────────────────── */

describe("rendered fact ids leak nothing the seat may not see", () => {
  /** The same pack, with `prompt-0.3.1` id rendering on. */
  function renderWithIds(observation: Observation): string {
    const ledger = ledgerFrom(observation, SEATS);
    return renderPack(
      packContext({
        observation,
        ledger,
        cognitionText: "",
        taskAndSchema: "## 本次任务\n请投票。",
        olderArguments: [],
        withIds: true,
      }),
    );
  }

  it("is byte-identical when forbidden facts are swapped in", async () => {
    const { state } = await game(31);
    let checked = 0;
    for (const seat of SEATS) {
      const mine = observationFor(state, seat);
      if (mine.side !== "good") continue;
      const swapped = Object.freeze({
        ...mine,
        evilRoster: FABRICATED_ROSTER,
        evilDiscussion: FABRICATED_DISCUSSION,
      }) as unknown as Observation;
      expect(renderWithIds(swapped), `${seat}号`).toBe(renderWithIds(mine));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("mints a private id only into the registry of the seat entitled to it", async () => {
    const { state } = await game(31);
    for (const seat of SEATS) {
      const mine = observationFor(state, seat);
      const registry = buildFactRegistry([], [], mine);
      for (const entry of registry.entries) {
        // A private entry always names THIS seat. There is no path by which a
        // registry could hold another seat's — it is built from one observation.
        if (entry.kind === "private-fact") expect(entry.seat, entry.id).toBe(seat);
      }
      // And the pair id exists exactly when the rules gave this seat a pair.
      expect(isVerifiedPremise(registry, PRIVATE_IDS.percivalPair), `${seat}`).toBe(
        mine.knowledge.kind === "merlin_or_morgana",
      );
    }
  });

  it("prints the same public id to every seat, so premises are quotable", async () => {
    const { state } = await game(31);
    const publicIds = SEATS.map((seat) => {
      const mine = observationFor(state, seat);
      const ledger = ledgerFrom(mine, SEATS);
      return buildFactRegistry(ledger.publicFacts, ledger.claims, mine)
        .entries.filter((e) => e.kind !== "private-fact")
        .map((e) => e.id)
        .join(",");
    });
    for (const ids of publicIds) expect(ids).toBe(publicIds[0]);
  });

  it("never renders another seat's private id into this seat's pack", async () => {
    const { state } = await game(33);
    for (const seat of SEATS) {
      const mine = observationFor(state, seat);
      const own = buildFactRegistry([], [], mine);
      const printed = [...renderWithIds(mine).matchAll(/`\[(p\.[^\]]+)\]`/g)].map((m) => m[1]);
      for (const id of printed) expect(own.byId.has(id), `${seat} printed ${id}`).toBe(true);
    }
  });
});

describe("the social model is private, and its basis is checked", () => {
  const SOCIAL_FIELDS = [
    "focalCandidates",
    "conditionToReconsider",
    "reasonsToFollow",
    "reasonsToChallenge",
    "coalitionPlan",
    "strongestDissent",
    "restsOnUnverified",
  ];

  it("appears in no rendered pack unless the seat wrote one", async () => {
    const { state } = await game(31);
    for (const seat of SEATS) {
      const text = renderPack(
        packContext({
          observation: observationFor(state, seat),
          ledger: ledgerFrom(observationFor(state, seat), SEATS),
          cognitionText: "",
          taskAndSchema: "## 本次任务\n请投票。",
          olderArguments: [],
          withIds: true,
        }),
      );
      for (const field of SOCIAL_FIELDS) expect(text, field).not.toContain(field);
    }
  });

  it("carries no seat's side or role in the vocabulary itself", () => {
    // The enums are about the TABLE, not about alignment. A value named
    // "evil-leader" would put role truth into a model-writable field.
    const json = JSON.stringify(socialFragment(limitsFor("prompt-0.3.1")));
    for (const role of ROLE_NAMES) expect(json, role).not.toContain(role);
    expect(json).not.toContain("evil");
    expect(json).not.toContain("good");
  });

  it("keeps the 0.3.1 protocol layer free of seat, role and state", () => {
    for (const role of ROLE_NAMES) {
      expect(DECISION_PROTOCOL_LAYER_V2, role).not.toContain(role);
    }
    expect(DECISION_PROTOCOL_LAYER_V2).not.toMatch(/\d+号/);
    expect(DECISION_PROTOCOL_LAYER_V2).not.toContain("seed");
  });

  it("still asks for conclusions, never a transcript, after the bridge", () => {
    expect(DECISION_PROTOCOL_LAYER_V2).toContain("这六步的过程同样不要写出来");
  });
});

/* ── The M5.2 surfaces ──────────────────────────────────────────────────── */

describe("the public claim contest carries no role truth", () => {
  it("renders identically whichever seat is asking, because it is public", async () => {
    const { state } = await game(41);
    const contest = claimContestFrom(state.log);
    const rendered = SEATS.map(() => renderClaimContest(contest));
    for (const text of rendered) expect(text).toBe(rendered[0]);
  });

  it("is a function of the public log and nothing else", async () => {
    const a = await game(41);
    // Same log, two derivations, byte-identical output. There is no parameter
    // through which the deal could enter this function.
    expect(renderClaimContest(claimContestFrom(a.state.log))).toBe(
      renderClaimContest(claimContestFrom([...a.state.log])),
    );
  });

  it("names no role anywhere in its rendering", async () => {
    const { state } = await game(41);
    const text = renderClaimContest(claimContestFrom(state.log));
    for (const role of ROLE_NAMES) expect(text, role).not.toContain(role);
  });

  it("mints the same contest ids for every seat", async () => {
    const { state } = await game(42);
    const contest = claimContestFrom(state.log);
    const ids = SEATS.map((seat) => {
      const mine = observationFor(state, seat);
      const ledger = ledgerFrom(mine, SEATS);
      return buildFactRegistry(ledger.publicFacts, ledger.claims, mine, contest)
        .entries.filter((e) => e.kind === "contest-event")
        .map((e) => e.id)
        .join(",");
    });
    for (const list of ids) expect(list).toBe(ids[0]);
  });
});

describe("the private contest block is private", () => {
  const CONTEST_FIELDS = [
    "ownClaimStrategy",
    "situationSpecificBenefit",
    "situationSpecificRisk",
    "triggerToClaim",
    "triggerToRetract",
    "candidatePairStory",
    "concealmentCost",
    "claimantAssessments",
    "currentAssessment",
    "conditionToUpgrade",
    "conditionToDowngrade",
    "rivalPlans",
    "attackCase",
    "expectedDefense",
    "riskOfOverattacking",
    "distinctionTest",
    "publicClaimMove",
    "informationToConceal",
  ];

  it("appears in no rendered pack unless the seat wrote one", async () => {
    const { state } = await game(41);
    for (const seat of SEATS) {
      const observation = observationFor(state, seat);
      const text = renderPack(
        packContext({
          observation,
          ledger: ledgerFrom(observation, SEATS),
          cognitionText: "",
          taskAndSchema: "## 本次任务\n请投票。",
          olderArguments: [],
          withIds: true,
          withClaimContest: true,
        }),
      );
      for (const field of CONTEST_FIELDS) expect(text, field).not.toContain(field);
    }
  });

  it("carries no seat's side or role in its vocabulary", () => {
    // `claim-percival` and `counterclaim-percival` are ACTS — things a seat
    // does. No enum value names a role anybody HAS.
    const json = JSON.stringify(contestFragment(limitsFor("prompt-0.4.0")));
    for (const role of ROLE_NAMES) {
      if (role === "percival") continue;
      expect(json, role).not.toContain(role);
    }
    expect(json).not.toContain('"evil"');
    expect(json).not.toContain('"good"');
  });

  it("keeps the 0.4.0 protocol layer free of seat, role and state", () => {
    for (const role of ROLE_NAMES) {
      expect(DECISION_PROTOCOL_LAYER_V3, role).not.toContain(role);
    }
    expect(DECISION_PROTOCOL_LAYER_V3).not.toMatch(/\d+号/);
    expect(DECISION_PROTOCOL_LAYER_V3).not.toContain("seed");
  });

  it("still asks for conclusions rather than a transcript", () => {
    expect(DECISION_PROTOCOL_LAYER_V3).toContain("这六步的过程同样不要写出来");
    expect(DECISION_PROTOCOL_LAYER_V3).toContain("过程同样不要写出来");
  });
});
