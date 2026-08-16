import { describe, it, expect } from "vitest";
import {
  TEAM_SIZES,
  EVIL_COUNTS,
  PLAYER_COUNTS,
  teamSize,
  requiredFails,
  evilCount,
  goodCount,
  getTeamSizeWarning,
  isPlayerCount,
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

describe("isPlayerCount", () => {
  it("accepts 5 through 10 and rejects everything else", () => {
    for (const n of [5, 6, 7, 8, 9, 10]) expect(isPlayerCount(n)).toBe(true);
    for (const n of [0, 1, 4, 11, 12, -5, 2.5]) {
      expect(isPlayerCount(n)).toBe(false);
    }
  });
});
