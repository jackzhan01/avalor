import { describe, it, expect } from "vitest";
import {
  TEAM_SIZES,
  EVIL_COUNTS,
  PLAYER_COUNTS,
  DEFAULT_ROLE_SET,
  teamSize,
  requiredFails,
  evilCount,
  goodCount,
  getTeamSizeWarning,
  isPlayerCount,
  defaultRoleSet,
  describeComposition,
  rolesInPlay,
} from "./avalon";
import type { PlayerCount } from "@/lib/types/game";

describe("TEAM_SIZES", () => {
  // Transcribed from the official rules sheet. If a cell here is wrong, every
  // team-size hint in the app is wrong, so assert the table literally.
  const EXPECTED: Record<number, number[]> = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
  };

  it("covers every supported table size", () => {
    expect(Object.keys(TEAM_SIZES).map(Number).sort((a, b) => a - b)).toEqual([
      5, 6, 7, 8, 9, 10,
    ]);
  });

  it("matches the official table in all 30 cells", () => {
    for (const count of PLAYER_COUNTS) {
      for (let mission = 1; mission <= 5; mission++) {
        expect(teamSize(count, mission)).toBe(EXPECTED[count][mission - 1]);
      }
    }
  });

  it("never asks for more players than are at the table", () => {
    for (const count of PLAYER_COUNTS) {
      for (let mission = 1; mission <= 5; mission++) {
        expect(teamSize(count, mission)).toBeLessThanOrEqual(count);
        expect(teamSize(count, mission)).toBeGreaterThan(0);
      }
    }
  });
});

describe("requiredFails", () => {
  it("returns 2 only for mission 4 at 7+ players — all 30 combinations", () => {
    for (const count of PLAYER_COUNTS) {
      for (let mission = 1; mission <= 5; mission++) {
        const expected = mission === 4 && count >= 7 ? 2 : 1;
        expect(requiredFails(count, mission)).toBe(expected);
      }
    }
  });

  it("keeps mission 4 at one fail for 5 and 6 players", () => {
    expect(requiredFails(5, 4)).toBe(1);
    expect(requiredFails(6, 4)).toBe(1);
  });

  it("requires two fails on mission 4 for 7, 8, 9 and 10 players", () => {
    for (const count of [7, 8, 9, 10] as PlayerCount[]) {
      expect(requiredFails(count, 4)).toBe(2);
    }
  });
});

describe("EVIL_COUNTS", () => {
  it("matches the official evil counts", () => {
    expect(EVIL_COUNTS).toEqual({ 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 });
  });

  it("splits the table into good and evil with nothing left over", () => {
    for (const count of PLAYER_COUNTS) {
      expect(evilCount(count) + goodCount(count)).toBe(count);
      expect(goodCount(count)).toBeGreaterThan(evilCount(count));
    }
  });
});

describe("getTeamSizeWarning", () => {
  it("is silent when the count matches", () => {
    const result = getTeamSizeWarning(9, 3, teamSize(9, 3));
    expect(result.severity).toBe("none");
    expect(result.message).toBeUndefined();
  });

  it("warns on a mismatch and reports both numbers", () => {
    const result = getTeamSizeWarning(9, 3, 3);
    expect(result.severity).toBe("warn");
    expect(result.expected).toBe(4);
    expect(result.selected).toBe(3);
    expect(result.message).toContain("4");
  });

  // House rules exist and users mistype. A wrong team size must never stop a
  // save — it is advisory only (spec §51).
  it("never returns a blocking severity, for any input", () => {
    for (const count of PLAYER_COUNTS) {
      for (let mission = 1; mission <= 5; mission++) {
        for (let selected = 0; selected <= count; selected++) {
          const { severity } = getTeamSizeWarning(count, mission, selected);
          expect(["none", "warn"]).toContain(severity);
        }
      }
    }
  });
});

describe("DEFAULT_ROLE_SET", () => {
  // Composition is bounded by the table: the named villains only fit once
  // there are evil seats to spend on them.
  it("fits inside each table's good and evil counts", () => {
    for (const count of PLAYER_COUNTS) {
      const composition = describeComposition(count, defaultRoleSet(count));
      expect(composition.problems).toEqual([]);

      const good = composition.good.reduce((n, line) => n + line.count, 0);
      const evil = composition.evil.reduce((n, line) => n + line.count, 0);
      expect(good).toBe(goodCount(count));
      expect(evil).toBe(evilCount(count));
      expect(good + evil).toBe(count);
    }
  });

  it("always includes Merlin and the Assassin", () => {
    for (const count of PLAYER_COUNTS) {
      expect(DEFAULT_ROLE_SET[count]).toContain("merlin");
      expect(DEFAULT_ROLE_SET[count]).toContain("assassin");
    }
  });

  it("pairs Percival with Morgana at every size", () => {
    for (const count of PLAYER_COUNTS) {
      const roles = DEFAULT_ROLE_SET[count];
      expect(roles.includes("percival")).toBe(roles.includes("morgana"));
    }
  });

  it("keeps Mordred and Oberon out of the two-evil tables", () => {
    for (const count of [5, 6] as PlayerCount[]) {
      expect(DEFAULT_ROLE_SET[count]).not.toContain("mordred");
      expect(DEFAULT_ROLE_SET[count]).not.toContain("oberon");
    }
  });

  it("never names more villains than there are evil seats", () => {
    // The real constraint. An earlier version of this file asserted that
    // Oberon needed four evil seats, which was an assumption about taste
    // rather than a rule — 7-player tables commonly run him in the third.
    const named = ["morgana", "mordred", "assassin", "oberon"];
    for (const count of PLAYER_COUNTS) {
      const villains = DEFAULT_ROLE_SET[count].filter((r) => named.includes(r));
      expect(villains.length).toBeLessThanOrEqual(evilCount(count));
    }
  });

  it("matches the line-up each table size actually plays", () => {
    const expected: Record<number, string[]> = {
      5: ["morgana", "assassin"],
      6: ["morgana", "assassin"],
      7: ["morgana", "assassin", "oberon"],
      8: ["morgana", "assassin"], // third evil seat is a plain 爪牙
      9: ["morgana", "assassin", "mordred"],
      10: ["morgana", "assassin", "mordred", "oberon"],
    };
    const named = ["morgana", "mordred", "assassin", "oberon"];
    for (const count of PLAYER_COUNTS) {
      const villains = DEFAULT_ROLE_SET[count]
        .filter((r) => named.includes(r))
        .sort();
      expect(villains).toEqual([...expected[count]].sort());
    }
  });
});

describe("describeComposition", () => {
  it("fills the leftover seats with 忠臣 and 爪牙", () => {
    const composition = describeComposition(10, defaultRoleSet(10));
    expect(composition.good).toEqual([
      { role: "merlin", count: 1 },
      { role: "percival", count: 1 },
      { role: "loyal", count: 4 },
    ]);
    // 10 players: 4 evil, all four named, so no 爪牙 left over.
    expect(composition.evil.find((l) => l.role === "minion")).toBeUndefined();
  });

  it("reports a set that cannot fit in the evil seats", () => {
    const composition = describeComposition(6, {
      rolesIncluded: ["merlin", "morgana", "assassin", "mordred", "oberon"],
    });
    expect(composition.problems.some((p) => p.includes("装不下"))).toBe(true);
  });

  it("flags Percival without Morgana", () => {
    const composition = describeComposition(9, {
      rolesIncluded: ["merlin", "percival", "assassin"],
    });
    expect(composition.problems.some((p) => p.includes("莫甘娜"))).toBe(true);
  });

  it("flags a missing Merlin", () => {
    const composition = describeComposition(9, {
      rolesIncluded: ["assassin", "morgana"],
    });
    expect(composition.problems.some((p) => p.includes("梅林"))).toBe(true);
  });
});

describe("rolesInPlay", () => {
  // This is what the composition is for: once the table is settled, nothing
  // should offer a role that cannot be at it.
  it("leaves Oberon out of a 9-player game", () => {
    const roles = rolesInPlay(9, defaultRoleSet(9));
    expect(roles).not.toContain("oberon");
    expect(roles).toContain("mordred");
  });

  it("leaves Mordred out of a 7-player game and includes Oberon", () => {
    const roles = rolesInPlay(7, defaultRoleSet(7));
    expect(roles).not.toContain("mordred");
    expect(roles).toContain("oberon");
  });

  it("only lists 爪牙 when an evil seat is left over for one", () => {
    // 8 players: two named villains, so the third seat is a 爪牙.
    expect(rolesInPlay(8, defaultRoleSet(8))).toContain("minion");
    // 10 players: all four evil seats are named, so there is no 爪牙.
    expect(rolesInPlay(10, defaultRoleSet(10))).not.toContain("minion");
  });

  it("follows an edited role set rather than the default", () => {
    const roles = rolesInPlay(9, {
      rolesIncluded: ["merlin", "loyal", "morgana", "assassin", "oberon"],
    });
    expect(roles).toContain("oberon");
    expect(roles).not.toContain("mordred");
    expect(roles).not.toContain("percival");
  });

  it("falls back to the standard line-up when no set was stored", () => {
    expect(rolesInPlay(9)).toEqual(rolesInPlay(9, defaultRoleSet(9)));
  });

  it("never lists a role the composition gives zero seats", () => {
    for (const count of PLAYER_COUNTS) {
      const composition = describeComposition(count, defaultRoleSet(count));
      const listed = rolesInPlay(count, defaultRoleSet(count));
      const counts = [...composition.good, ...composition.evil];
      expect(listed).toHaveLength(counts.length);
      expect(counts.every((line) => line.count > 0)).toBe(true);
    }
  });
});

describe("isPlayerCount", () => {
  it("accepts 5 through 10 and rejects everything else", () => {
    for (const n of [5, 6, 7, 8, 9, 10]) expect(isPlayerCount(n)).toBe(true);
    for (const n of [0, 1, 4, 11, 12, -5, 2.5]) {
      expect(isPlayerCount(n)).toBe(false);
    }
  });
});
