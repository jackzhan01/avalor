import { describe, it, expect } from "vitest";
import {
  derivePrivate,
  getAllRoleMarks,
  getKnownSeats,
  getRoleMark,
  getRoleMarkHistory,
} from "./private";
import { deriveTimeline } from "./derive-timeline";
import { deriveOpinions } from "./opinions";
import { visionFor } from "@/lib/rules/avalon";
import { buildExport, parseImport, serializeExport } from "@/lib/db/transfer";
import { allApprove, game } from "@/lib/fixtures/builder";
import { isPrivateEvent } from "@/lib/types/events";

describe("role marks", () => {
  it("returns null for an unmarked seat", () => {
    const built = game(9).mark(3, { kind: "side", side: "evil" }).build();
    expect(getRoleMark(built.events, "p5")).toBeNull();
  });

  it("keeps the latest mark and the whole chain", () => {
    const built = game(9)
      .mark(3, { kind: "side", side: "good" })
      .mark(3, { kind: "side", side: "evil" })
      .mark(3, { kind: "role", role: "assassin" })
      .build();

    expect(getRoleMark(built.events, "p3")!.mark).toEqual({
      kind: "role",
      role: "assassin",
    });
    expect(getRoleMarkHistory(built.events, "p3")).toHaveLength(3);
    expect(getRoleMark(built.events, "p3")!.revisionCount).toBe(3);
  });

  it("drops the seat entirely when the mark is cleared", () => {
    const built = game(9)
      .mark(3, { kind: "side", side: "evil" })
      .mark(3, null)
      .build();

    expect(getRoleMark(built.events, "p3")).toBeNull();
    expect(getAllRoleMarks(built.events).has("p3")).toBe(false);
    // The clear is still in the log, so undo and history stay intact.
    expect(getRoleMarkHistory(built.events, "p3")).toHaveLength(2);
  });

  it("separates what the user knows from what they are reading", () => {
    const built = game(9)
      .mark(2, { kind: "side", side: "evil" }, "known")
      .mark(4, { kind: "side", side: "evil" }, "guess")
      .build();

    expect(getRoleMark(built.events, "p2")!.certainty).toBe("known");
    expect(getRoleMark(built.events, "p4")!.certainty).toBe("guess");
    expect(getKnownSeats(built.events)).toEqual(["p2"]);
  });

  it("carries Percival's pair constraint as its own mark kind", () => {
    const built = game(9)
      .mark(5, { kind: "merlin_or_morgana" }, "known")
      .mark(8, { kind: "merlin_or_morgana" }, "known")
      .build();
    expect(getRoleMark(built.events, "p5")!.mark.kind).toBe("merlin_or_morgana");
    expect(getKnownSeats(built.events).sort()).toEqual(["p5", "p8"]);
  });
});

describe("the private layer never leaks into the public one", () => {
  const built = game(9)
    .opinion(1, 2, 4)
    .mark(2, { kind: "side", side: "evil" }, "known")
    .mark(3, { kind: "role", role: "merlin" }, "guess")
    .proposal(1, [1, 2, 3])
    .vote(allApprove(9), "passed")
    .mission("success", 0)
    .build();

  it("does not move the game forward", () => {
    const timeline = deriveTimeline(built.events, built.game);
    expect(timeline.missionNumber).toBe(2);
    expect(timeline.proposalNumber).toBe(1);
    expect(timeline.warnings).toEqual([]);
  });

  it("is not mistaken for an opinion", () => {
    // Marking 2号 as evil must not create any 保踩 record.
    const opinions = deriveOpinions(built.events);
    expect(opinions.current.size).toBe(1);
    expect(opinions.current.get("p1")!.size).toBe(1);
    expect(opinions.current.get("p1")!.has("p2")).toBe(true);
    expect(opinions.current.get("p1")!.has("p3")).toBe(false);
  });

  it("is identifiable by type, so it can be stripped wholesale", () => {
    const privateEvents = built.events.filter(isPrivateEvent);
    expect(privateEvents).toHaveLength(2);
    expect(privateEvents.every((e) => e.type === "role_mark")).toBe(true);
  });
});

describe("export can drop the private layer", () => {
  const built = game(9)
    .opinion(1, 2, 4)
    .mark(2, { kind: "side", side: "evil" }, "known")
    .build();
  const withRole = {
    ...built.game,
    viewerRole: "merlin" as const,
  };

  it("includes it by default — it is the user's own backup", () => {
    const full = buildExport(withRole, built.events);
    expect(full.containsPrivate).toBe(true);
    expect(full.events.some(isPrivateEvent)).toBe(true);
    expect(full.game.viewerRole).toBe("merlin");
  });

  it("strips both the marks and the user's own role when asked", () => {
    const publicOnly = buildExport(withRole, built.events, {
      includePrivate: false,
    });
    expect(publicOnly.containsPrivate).toBe(false);
    expect(publicOnly.events.some(isPrivateEvent)).toBe(false);
    expect(publicOnly.game.viewerRole).toBeUndefined();
    // The public record itself is untouched.
    expect(publicOnly.events).toHaveLength(1);
  });

  it("round-trips the flag so a reader never has to guess", () => {
    const json = serializeExport(withRole, built.events, {
      includePrivate: false,
    });
    expect(parseImport(json).containsPrivate).toBe(false);
  });
});

describe("visionFor — the rulebook, not inference", () => {
  it("gives an evil player their teammates", () => {
    // 9 players: 3 evil, so two teammates.
    expect(visionFor("assassin", 9)).toMatchObject({
      count: 2,
      mark: { kind: "side", side: "evil" },
    });
  });

  it("hides Oberon from his own side", () => {
    const vision = visionFor("assassin", 9, {
      rolesIncluded: ["assassin", "morgana", "oberon"],
    })!;
    expect(vision.count).toBe(1);
    expect(vision.hint).toContain("奥伯伦");
  });

  it("gives Oberon himself nothing", () => {
    expect(visionFor("oberon", 9)).toBeNull();
  });

  it("gives Merlin every evil, minus Mordred when he is in play", () => {
    expect(visionFor("merlin", 10)!.count).toBe(4);
    expect(
      visionFor("merlin", 10, { rolesIncluded: ["mordred", "assassin"] })!.count,
    ).toBe(3);
  });

  it("gives Percival an ambiguous pair when Morgana is in play", () => {
    const vision = visionFor("percival", 9, {
      rolesIncluded: ["merlin", "percival", "morgana"],
    })!;
    expect(vision.count).toBe(2);
    expect(vision.mark).toEqual({ kind: "merlin_or_morgana" });
  });

  it("gives Percival a single certain seat when Morgana is absent", () => {
    const vision = visionFor("percival", 9, {
      rolesIncluded: ["merlin", "percival"],
    })!;
    expect(vision.count).toBe(1);
    expect(vision.mark).toEqual({ kind: "role", role: "merlin" });
  });

  it("gives a loyal servant nothing", () => {
    expect(visionFor("loyal", 9)).toBeNull();
  });
});
