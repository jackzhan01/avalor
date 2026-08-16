import { describe, it, expect } from "vitest";
import {
  ImportError,
  SCHEMA_VERSION,
  buildExport,
  exportFileName,
  parseImport,
  serializeExport,
} from "./transfer";
import { ninePlayerGame } from "@/lib/fixtures/nine-player-game";
import { tenPlayerGame } from "@/lib/fixtures/ten-player-game";

describe("export", () => {
  it("stamps the schema version", () => {
    const built = ninePlayerGame();
    expect(buildExport(built.game, built.events).schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("emits events sorted by sequence", () => {
    const built = tenPlayerGame();
    const shuffled = [...built.events].reverse();
    const exported = buildExport(built.game, shuffled);
    const seqs = exported.events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("produces a filename with the table size and date", () => {
    const built = ninePlayerGame();
    const name = exportFileName(built.game);
    expect(name).toMatch(/^avalor-9p-\d{12}\.json$/);
  });
});

describe("round trip", () => {
  for (const [label, fixture] of [
    ["9-player fixture", ninePlayerGame],
    ["10-player fixture", tenPlayerGame],
  ] as const) {
    it(`survives export → import unchanged (${label})`, () => {
      const built = fixture();
      const json = serializeExport(built.game, built.events);
      const parsed = parseImport(json);

      expect(parsed.game).toEqual(built.game);
      expect(parsed.events).toEqual(built.events);
    });
  }
});

describe("import validation", () => {
  it("rejects text that is not JSON", () => {
    expect(() => parseImport("not json at all")).toThrow(ImportError);
  });

  it("rejects an unknown schema version", () => {
    const built = ninePlayerGame();
    const json = JSON.stringify({
      ...buildExport(built.game, built.events),
      schemaVersion: 99,
    });
    expect(() => parseImport(json)).toThrow(/不支持的文件版本/);
  });

  it("rejects a file with no events array", () => {
    const built = ninePlayerGame();
    const json = JSON.stringify({ schemaVersion: 1, game: built.game });
    expect(() => parseImport(json)).toThrow(ImportError);
  });

  it("rejects a file with no players", () => {
    const built = ninePlayerGame();
    const json = JSON.stringify({
      schemaVersion: 1,
      game: { ...built.game, players: [] },
      events: [],
    });
    expect(() => parseImport(json)).toThrow(/没有玩家信息/);
  });

  it("accepts a game with an empty event log", () => {
    const built = ninePlayerGame();
    const json = JSON.stringify({
      schemaVersion: 1,
      game: built.game,
      events: [],
    });
    expect(parseImport(json).events).toEqual([]);
  });
});
