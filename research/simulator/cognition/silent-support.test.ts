import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Seat } from "../core/types";
import type { PublicRecord } from "./metrics";
import { silentSupport, type ContestObservation } from "./metrics-contest";

/**
 * Support that never said anything out loud.
 *
 * THE MEASUREMENT THIS EXISTS FOR. The completed M5.2 game ended with seat 7 —
 * the false Percival — holding exactly ONE public backer and still carrying a
 * 7:3 vote. Everything else it received came from seats that had privately
 * picked it and never said so. That is what a false consensus looks like from
 * the outside, and none of the existing metrics could see it: coalitions count
 * declared stances, and a silent follower declares nothing.
 *
 * PRIVATE AND OBSERVATIONAL. It reads ten seats' private contest records, so a
 * runtime that consulted it would be one seat deciding its move by reading
 * everybody else's private state. The last test in this file asserts no
 * runtime module imports it.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("metrics tests must not touch the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function observation(
  seat: Seat,
  atSequence: number,
  overrides: Partial<ContestObservation> = {},
): ContestObservation {
  return {
    seat,
    taskId: "speech-regular",
    atSequence,
    ownClaimStatus: "hidden",
    act: "stay-hidden",
    targetSeats: [],
    requestedTeam: null,
    requestedVote: "none",
    stance: "undecided",
    selectedClaimant: null,
    assessments: [],
    rivalSeats: [],
    ...overrides,
  };
}

function vote(
  atSequence: number,
  votes: Partial<Record<Seat, "approve" | "reject">>,
): PublicRecord["votes"][number] {
  const full = {} as Record<Seat, "approve" | "reject">;
  for (const seat of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as Seat[]) {
    full[seat] = votes[seat] ?? "approve";
  }
  return {
    missionNumber: 1,
    attempt: 1,
    leader: 1,
    team: [1, 2, 3],
    votes: full,
    result: "passed",
    atSequence,
  };
}

const EMPTY: PublicRecord = { votes: [], proposals: [], missions: [], speeches: [] };

describe("沉默支持", () => {
  it("私下站队 + 投一样的票 + 从没公开表态 = 沉默支持", () => {
    const observations = [
      observation(3, 10, { stance: "support", selectedClaimant: 7 }),
      observation(7, 10, { ownClaimStatus: "active", act: "claim-percival" }),
    ];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "reject", 3: "reject" })],
    };
    const [entry] = silentSupport(observations, record);
    expect(entry.claimant).toBe(7);
    expect(entry.votedWithClaimantWithoutPublicEndorsement).toBe(1);
    expect(entry.silentSupportCount).toBe(1);
    expect(entry.publicEndorsementCount).toBe(0);
  });

  it("公开背书过就不算沉默 —— 而且背书要发生在那一票之前", () => {
    const observations = [
      // Endorses in public at seq 5, then votes with the claimant at seq 20.
      observation(3, 5, {
        stance: "support",
        selectedClaimant: 7,
        act: "endorse-claimant",
        targetSeats: [7],
      }),
      observation(3, 10, { stance: "support", selectedClaimant: 7 }),
    ];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "reject", 3: "reject" })],
    };
    const [entry] = silentSupport(observations, record);
    expect(entry.votedWithClaimantWithoutPublicEndorsement).toBe(0);
    expect(entry.publicEndorsementCount).toBe(1);
  });

  it("先沉默投票、后来才公开的，那一票仍然算沉默，并计入转化", () => {
    const observations = [
      observation(3, 10, { stance: "support", selectedClaimant: 7 }),
      // Speaks up only AFTER the vote it silently backed.
      observation(3, 30, {
        stance: "support",
        selectedClaimant: 7,
        act: "endorse-claimant",
        targetSeats: [7],
      }),
    ];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "reject", 3: "reject" })],
    };
    const [entry] = silentSupport(observations, record);
    expect(entry.votedWithClaimantWithoutPublicEndorsement).toBe(1);
    expect(entry.silentSupportCount).toBe(1);
    expect(entry.publicEndorsementCount).toBe(1);
    expect(entry.silentToPublicConversion).toBe(1);
  });

  it("票投反了就不算支持 —— 站队不等于跟票", () => {
    const observations = [observation(3, 10, { stance: "support", selectedClaimant: 7 })];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "reject", 3: "approve" })],
    };
    expect(silentSupport(observations, record)[0]?.votedWithClaimantWithoutPublicEndorsement ?? 0).toBe(0);
  });

  it("反对者和未决者都不算", () => {
    const observations = [
      observation(3, 10, { stance: "oppose", selectedClaimant: 7 }),
      observation(4, 10, { stance: "undecided", selectedClaimant: null }),
    ];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "reject", 3: "reject", 4: "reject" })],
    };
    expect(silentSupport(observations, record)).toEqual([]);
  });

  it("有条件支持也算 —— 它照样落到票上", () => {
    const observations = [
      observation(3, 10, { stance: "conditional-support", selectedClaimant: 7 }),
    ];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "reject", 3: "reject" })],
    };
    expect(silentSupport(observations, record)[0].votedWithClaimantWithoutPublicEndorsement).toBe(1);
  });

  it("从没公开过、却换了支持对象的，算沉默换边", () => {
    const observations = [
      observation(3, 5, { stance: "support", selectedClaimant: 7 }),
      observation(3, 25, { stance: "support", selectedClaimant: 8 }),
    ];
    const entries = silentSupport(observations, EMPTY);
    const seven = entries.find((e) => e.claimant === 7);
    expect(seven?.silentFollowerSwitching).toBe(1);
  });

  it("公开背书过的人换边不算沉默换边", () => {
    const observations = [
      observation(3, 5, {
        stance: "support",
        selectedClaimant: 7,
        act: "endorse-claimant",
        targetSeats: [7],
      }),
      observation(3, 25, { stance: "support", selectedClaimant: 8 }),
    ];
    const seven = silentSupport(observations, EMPTY).find((e) => e.claimant === 7);
    expect(seven?.silentFollowerSwitching ?? 0).toBe(0);
  });

  it("声称者自己跟自己不算", () => {
    const observations = [
      observation(7, 10, { stance: "support", selectedClaimant: 7, ownClaimStatus: "active" }),
    ];
    const record: PublicRecord = { ...EMPTY, votes: [vote(20, { 7: "reject" })] };
    expect(silentSupport(observations, record)).toEqual([]);
  });

  it("M5.2 那一局的形态：一个公开支持者，一堆沉默的票", () => {
    // Seat 7 is the claimant. Seat 5 endorses in public; 1, 4, 10 vote with it
    // and never say a word. That is the shape the report could not measure.
    const observations = [
      observation(7, 4, { ownClaimStatus: "active", act: "claim-percival" }),
      observation(5, 6, {
        stance: "support",
        selectedClaimant: 7,
        act: "endorse-claimant",
        targetSeats: [7],
      }),
      observation(1, 6, { stance: "support", selectedClaimant: 7 }),
      observation(4, 6, { stance: "conditional-support", selectedClaimant: 7 }),
      observation(10, 6, { stance: "support", selectedClaimant: 7 }),
    ];
    const record: PublicRecord = {
      ...EMPTY,
      votes: [vote(20, { 7: "approve", 1: "approve", 4: "approve", 5: "approve", 10: "approve" })],
    };
    const [entry] = silentSupport(observations, record);
    expect(entry.publicEndorsementCount).toBe(1);
    expect(entry.silentSupportCount).toBe(3);
    expect(entry.votedWithClaimantWithoutPublicEndorsement).toBe(3);
    expect(entry.silentToPublicConversion).toBe(0);
  });
});

describe("这些指标不参与运行时", () => {
  it("没有任何运行时模块 import metrics-contest", () => {
    // The metrics read ten seats' private records. A runtime that consulted
    // them would be one seat deciding its move from everybody else's private
    // state — which is the leak this whole simulator is built to prevent.
    const runtime = [
      "agents/llm-agent.ts",
      "cognition/build-cognitive.ts",
      "cognition/response.ts",
      "cognition/firewall.ts",
      "cognition/spokesperson.ts",
      "cognition/store.ts",
      "run/runner.ts",
      "run/live-game.ts",
    ];
    const root = join(process.cwd(), "research", "simulator");
    // IMPORT statements, not any mention: `llm-agent.ts` legitimately says
    // "mirrors `metrics-contest`" in a comment, and a substring check that
    // failed on a comment would be a test about prose.
    const imports = /import[^;]*?from\s+["'][^"']*metrics(?:-contest)?["']/g;
    for (const file of runtime) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text.match(imports), file).toBeNull();
      expect(text.includes("silentSupport("), file).toBe(false);
    }
  });
});
