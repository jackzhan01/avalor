import { describe, expect, it } from "vitest";
import { game } from "@/lib/fixtures/builder";
import type { SocialEvidence } from "@/lib/social";
import type { RoleType } from "@/lib/types/game";
import { renderBrief, seatBrief } from "./brief";
import { informationSets } from "./rollout";

/**
 * The information boundary, checked rather than asserted.
 *
 * Every arm of the coming comparison reads its game through `seatBrief`, so if
 * this leaks, the whole comparison is measuring cheating. A language model is
 * the worst possible place to be relaxed about it: it will happily use a role
 * name that appeared once in the prompt and nobody will notice why it got good.
 */

/** A nine-player casting with one of everything worth having. */
const CASTING = new Map<string, RoleType>([
  ["p1", "merlin"],
  ["p2", "percival"],
  ["p3", "loyal"],
  ["p4", "loyal"],
  ["p5", "loyal"],
  ["p6", "loyal"],
  ["p7", "morgana"],
  ["p8", "mordred"],
  ["p9", "assassin"],
]);

const built = game(9)
  .proposal(1, [1, 2, 3])
  .vote({ 1: "approve", 2: "approve", 3: "approve", 4: "reject" }, "passed")
  .mission("fail", 1)
  .opinion(4, 7, 2)
  .build();

const info = informationSets(CASTING);

describe("what a seat is allowed to see", () => {
  it("gives Merlin the evils he can see and not Mordred", () => {
    const brief = seatBrief(built.game, built.events, info.get("p1")!);
    const marks = brief.events.filter((e) => e.type === "role_mark");
    const seen = marks.map((e) => (e.type === "role_mark" ? e.targetId : ""));
    expect(new Set(seen)).toEqual(new Set(["p7", "p9"]));
    expect(seen).not.toContain("p8");
  });

  it("gives Percival an unordered pair and no way to order it", () => {
    const brief = seatBrief(built.game, built.events, info.get("p2")!);
    const marks = brief.events.filter((e) => e.type === "role_mark");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      if (mark.type !== "role_mark") continue;
      expect(mark.mark).toEqual({ kind: "merlin_or_morgana" });
      expect(["p1", "p7"]).toContain(mark.targetId);
    }
  });

  it("gives Oberon nothing at all", () => {
    const oberon = new Map(CASTING);
    oberon.set("p9", "oberon");
    const sets = informationSets(oberon);
    const brief = seatBrief(built.game, built.events, sets.get("p9")!);
    expect(brief.events.filter((e) => e.type === "role_mark")).toHaveLength(0);
  });

  it("gives an ordinary evil his teammates but never Oberon", () => {
    const withOberon = new Map(CASTING);
    withOberon.set("p9", "oberon");
    const sets = informationSets(withOberon);
    const brief = seatBrief(built.game, built.events, sets.get("p7")!);
    const seen = brief.events
      .filter((e) => e.type === "role_mark")
      .map((e) => (e.type === "role_mark" ? e.targetId : ""));
    expect(new Set(seen)).toEqual(new Set(["p8"]));
  });

  it("gives a loyal servant nothing but the public log", () => {
    const brief = seatBrief(built.game, built.events, info.get("p3")!);
    expect(brief.events.filter((e) => e.type === "role_mark")).toHaveLength(0);
    expect(brief.game.viewerRole).toBe("loyal");
  });
});

describe("what a seat must never see", () => {
  /*
   * Which roles are DEALT is public — everyone at a nine-player table knows
   * there is a Merlin and a Mordred somewhere. Nor is a DEDUCTION a leak:
   * Merlin, told that seats 7 and 9 are evil, can work out for himself that
   * Mordred is one of the seats left, and the brief says so at 50/50. That is
   * his own reasoning handed back to him.
   *
   * What must never appear is a seat bound to a role with CERTAINTY that this
   * player has no way to reach — the assignment, leaking through.
   */
  const certainBindings = (text: string) => {
    const labels = ["梅林", "派西维尔", "莫甘娜", "莫德雷德", "刺客", "奥伯伦"];
    const out: number[] = [];
    for (const line of text.split(String.fromCharCode(10))) {
      if (!labels.some((l) => line.includes(l))) continue;
      for (const match of line.matchAll(/(\d+)号\s*100%/g)) {
        out.push(Number(match[1]));
      }
    }
    return out.sort((a, b) => a - b);
  };

  it("tells a sightless player nothing certain about anyone", () => {
    const brief = seatBrief(built.game, built.events, info.get("p3")!);
    expect(certainBindings(renderBrief(brief))).toEqual([]);
  });

  it("tells Merlin nothing certain beyond himself and what he was shown", () => {
    const brief = seatBrief(built.game, built.events, info.get("p1")!);
    // Seat 8 is Mordred, whom he cannot see. He must never be certain of it.
    const certain = certainBindings(renderBrief(brief));
    expect(certain).not.toContain(8);
    for (const seat of certain) expect([1, 7, 9]).toContain(seat);
  });

  it("does not carry the private layer of whoever kept the notebook", () => {
    const recorded = game(9)
      .mark(7, { kind: "side", side: "evil" }, "known")
      .proposal(1, [1, 2, 3])
      .build();
    const brief = seatBrief(recorded.game, recorded.events, info.get("p3")!);
    // The user's own mark on p7 must not survive into another seat's view.
    expect(brief.events.filter((e) => e.type === "role_mark")).toHaveLength(0);
  });

  it("does not let a seat hear what it was not in the room for", () => {
    const social: SocialEvidence[] = [
      {
        sequence: 1,
        missionNumber: 1,
        speakerId: "p4",
        targetId: "p7",
        valence: -1,
        confidence: 1,
        source: "synthetic",
        audience: ["p4", "p5"],
      },
      {
        sequence: 2,
        missionNumber: 1,
        speakerId: "p5",
        targetId: "p8",
        valence: 1,
        confidence: 1,
        source: "synthetic",
        audience: null,
      },
    ];
    const outsider = seatBrief(built.game, built.events, info.get("p3")!, { social });
    const insider = seatBrief(built.game, built.events, info.get("p5")!, { social });
    expect(outsider.social).toHaveLength(1);
    expect(insider.social).toHaveLength(2);
  });

  it("does not let a seat hear what was said after it had to decide", () => {
    const social: SocialEvidence[] = [
      {
        sequence: 1,
        missionNumber: 1,
        speakerId: "p4",
        targetId: "p7",
        valence: -1,
        confidence: 1,
        source: "synthetic",
        audience: null,
      },
      {
        sequence: 5000,
        missionNumber: 5,
        speakerId: "p4",
        targetId: "p8",
        valence: -1,
        confidence: 1,
        source: "synthetic",
        audience: null,
      },
    ];
    const brief = seatBrief(built.game, built.events, info.get("p3")!, {
      social,
      upTo: 100,
    });
    expect(brief.social).toHaveLength(1);
  });

  it("does not let a seat read events from later in the game", () => {
    const early = seatBrief(built.game, built.events, info.get("p3")!, { upTo: 1 });
    const late = seatBrief(built.game, built.events, info.get("p3")!);
    expect(early.events.length).toBeLessThan(late.events.length);
    expect(early.events.some((e) => e.type === "mission")).toBe(false);
  });
});

describe("what the brief asks for", () => {
  it("states the car when the seat is voting", () => {
    const brief = seatBrief(built.game, built.events, info.get("p3")!, {
      proposedTeam: ["p1", "p2", "p3"],
    });
    expect(renderBrief(brief)).toContain("上票还是下票");
  });

  it("states the size when the seat is leading", () => {
    const brief = seatBrief(built.game, built.events, info.get("p3")!, {
      legalTeams: [["p1", "p2", "p3"]],
    });
    expect(renderBrief(brief)).toContain("轮到我点车");
  });
});
