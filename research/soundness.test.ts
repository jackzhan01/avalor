import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deriveSideInference } from "@/lib/inference/side";
import { evilCount } from "@/lib/rules/avalon";
import type { GameEvent } from "@/lib/types/events";
import type { GameRecord, PlayerCount, VoteChoice } from "@/lib/types/game";

// TEMPORARY — validates the hard layer against 12,882 real human games.

const CORPUS =
  "C:/Users/jackz/AppData/Local/Temp/claude/d--UIUC-25fall-courses-Avalon/6fbca13e-e6cb-4759-9969-7b673f582af2/scratchpad/games.json";

const EVIL_ROLES = new Set([
  "MORGANA",
  "MORDRED",
  "OBERON",
  "EVIL MINION",
  "ASSASSIN",
]);

interface Raw {
  players: { name: string }[];
  missions: {
    teamSize: number;
    team?: string[];
    state?: string;
    numFails?: number;
    failsRequired?: number;
    proposals?: {
      proposer: string;
      team: string[];
      votes?: string[];
      state?: string;
    }[];
  }[];
  outcome: {
    roles: { name: string; role: string; assassin?: boolean }[];
    votes?: Record<string, boolean>[];
    state?: string;
  };
}

/** Omit that distributes over the event union — a plain Omit collapses it
 * to the shared fields, which is what made every type-specific field fail. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Converted {
  game: GameRecord;
  events: GameEvent[];
  /** Ground truth: player ids of the real evils. */
  evil: string[];
}

/** AvalonLogs → our event log. Returns null for games we cannot represent. */
function convert(raw: Raw, index: number): Converted | null {
  const n = raw.players.length;
  if (n < 5 || n > 10) return null;
  const playerCount = n as PlayerCount;

  const idOf = new Map<string, string>();
  raw.players.forEach((p, i) => idOf.set(p.name, `p${i + 1}`));

  const evil = raw.outcome.roles
    .filter((r) => EVIL_ROLES.has(r.role))
    .map((r) => idOf.get(r.name))
    .filter((id): id is string => id != null);

  // House rules exist in this corpus; a table whose evil count disagrees with
  // the official table is outside what our rules module models, and testing
  // against it would be testing the wrong thing.
  if (evil.length !== evilCount(playerCount)) return null;

  const game: GameRecord = {
    id: `corpus-${index}`,
    schemaVersion: 1,
    playerCount,
    players: raw.players.map((p, i) => ({ id: `p${i + 1}`, seat: i + 1 })),
    firstLeaderId: "p1",
    status: "completed",
    winningSide: null,
    lastSequence: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const events: GameEvent[] = [];
  let sequence = 0;
  const push = (
    partial: DistributiveOmit<GameEvent, "id" | "gameId" | "sequence" | "timestamp" | "missionNumber">,
    missionNumber: number,
  ) => {
    sequence += 1;
    events.push({
      ...partial,
      id: `e${sequence}`,
      gameId: game.id,
      sequence,
      timestamp: "2026-01-01T00:00:00.000Z",
      missionNumber,
    } as GameEvent);
  };

  raw.missions.forEach((mission, mi) => {
    const missionNumber = mi + 1;
    if (missionNumber > 5) return;
    let lastProposalId: string | null = null;

    for (const proposal of mission.proposals ?? []) {
      const leaderId = idOf.get(proposal.proposer);
      const team = proposal.team
        ?.map((name) => idOf.get(name))
        .filter((id): id is string => id != null);
      if (!leaderId || !team?.length) continue;

      push({ type: "proposal", leaderId, teamPlayerIds: team }, missionNumber);
      lastProposalId = `e${sequence}`;

      // `votes` lists the APPROVERS; everyone else rejected. This is complete
      // seat-level information, which is exactly what our layer wants.
      if (proposal.votes) {
        const approvers = new Set(
          proposal.votes
            .map((name) => idOf.get(name))
            .filter((id): id is string => id != null),
        );
        const votes: Record<string, VoteChoice> = {};
        for (const player of game.players) {
          votes[player.id] = approvers.has(player.id) ? "approve" : "reject";
        }
        push(
          {
            type: "vote",
            proposalId: lastProposalId,
            votes,
            finalResult: proposal.state === "APPROVED" ? "passed" : "rejected",
          },
          missionNumber,
        );
      }
    }

    const team = mission.team
      ?.map((name) => idOf.get(name))
      .filter((id): id is string => id != null);
    if (mission.state && team?.length && lastProposalId) {
      const result = mission.state === "SUCCESS" ? "success" : "fail";
      push(
        {
          type: "mission",
          proposalId: lastProposalId,
          teamPlayerIds: team,
          result,
          ...(typeof mission.numFails === "number"
            ? { failCount: mission.numFails }
            : {}),
        },
        missionNumber,
      );
    }
  });

  return { game, events, evil };
}

function loadCorpus(): Converted[] {
  const raw = JSON.parse(readFileSync(CORPUS, "utf8")) as Raw[];
  return raw
    .map((g, i) => convert(g, i))
    .filter((c): c is Converted => c !== null);
}

describe("the hard layer against 12,882 real human games", () => {
  const corpus = loadCorpus();

  it("never rules out the truth in any real game", () => {
    let checked = 0;
    const failures: string[] = [];

    for (const { game, events, evil } of corpus) {
      const truth = [...evil].sort().join(",");
      const side = deriveSideInference(events, game);
      checked += 1;
      if (side.contradictory) {
        failures.push(`${game.id}: contradictory`);
        continue;
      }
      const alive = side.surviving.some(
        (h) => [...h.evil].sort().join(",") === truth,
      );
      if (!alive) failures.push(`${game.id}: real evils ${truth} eliminated`);
    }

    console.log(`\n检验了 ${checked} 局真实人类对局`);
    console.log(`失败 ${failures.length} 局`);
    if (failures.length) console.log(failures.slice(0, 10));
    expect(failures).toEqual([]);
  });

  it("never states a false proof", () => {
    const wrong: string[] = [];
    let provenSeats = 0;

    for (const { game, events, evil } of corpus) {
      const side = deriveSideInference(events, game);
      if (side.contradictory) continue;
      const evilSet = new Set(evil);
      for (const id of side.provenEvil) {
        provenSeats += 1;
        if (!evilSet.has(id)) wrong.push(`${game.id}: ${id} wrongly proven evil`);
      }
      for (const id of side.provenGood) {
        provenSeats += 1;
        if (evilSet.has(id)) wrong.push(`${game.id}: ${id} wrongly proven good`);
      }
    }

    console.log(`断言过 ${provenSeats} 个「确定」，错 ${wrong.length} 个`);
    if (wrong.length) console.log(wrong.slice(0, 10));
    expect(wrong).toEqual([]);
  });

  it("reports how far it narrows a real game", () => {
    const buckets: Record<number, { total: number; remaining: number; n: number }> =
      {};
    for (const { game, events } of corpus) {
      const side = deriveSideInference(events, game);
      if (side.contradictory) continue;
      const b = (buckets[game.playerCount] ??= { total: 0, remaining: 0, n: 0 });
      b.total += side.total;
      b.remaining += side.surviving.length;
      b.n += 1;
    }
    console.log("\n打完整局后，纯硬约束把空间压到多少（没有任何视野）:");
    for (const [size, b] of Object.entries(buckets)) {
      console.log(
        `  ${size} 人局 ×${b.n}：平均 ${(b.total / b.n).toFixed(0)} → ${(b.remaining / b.n).toFixed(1)} 种`,
      );
    }
  });
});
