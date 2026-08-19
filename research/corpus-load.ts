import type { GameEvent } from "@/lib/types/events";
import type {
  GameRecord,
  PlayerCount,
  RoleSetConfig,
  RoleType,
  VoteChoice,
} from "@/lib/types/game";
import { evilCount } from "@/lib/rules/avalon";
import { readFileSync } from "node:fs";

const CORPUS =
  "./research/data/games.json";

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

export /** Omit that distributes over the event union — a plain Omit collapses it
 * to the shared fields, which is what made every type-specific field fail. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** AvalonLogs role names → ours. `ASSASSIN` is rare; the flag is the real marker. */
const ROLE_MAP: Record<string, RoleType> = {
  MERLIN: "merlin",
  PERCIVAL: "percival",
  "LOYAL FOLLOWER": "loyal",
  MORGANA: "morgana",
  MORDRED: "mordred",
  OBERON: "oberon",
  "EVIL MINION": "minion",
  ASSASSIN: "assassin",
};

interface Converted {
  game: GameRecord;
  events: GameEvent[];
  /** Ground truth: player ids of the real evils. */
  evil: string[];
  truth: {
    /** role → the player id holding it. Unique roles only. */
    roles: Map<RoleType, string>;
    /** player id → role, including the filler roles. */
    byPlayer: Map<string, RoleType>;
  };
}

/** AvalonLogs → our event log. Returns null for games we cannot represent. */
/**
 * The line-up this game was actually dealt, so the model is not asked to infer
 * roles it has been told do not exist.
 *
 * Without this the loader silently handed every game the app's DEFAULT line-up
 * for its size, and 2,315 of the 6,002 seven-to-ten-player games really
 * contain a Mordred that default does not — the model then assigns him
 * probability zero everywhere and the log loss on that row measures the
 * mismatch rather than the model.
 */
function roleSetOf(raw: Raw): RoleSetConfig {
  const included = new Set<RoleType>();
  for (const entry of raw.outcome?.roles ?? []) {
    const mapped = ROLE_MAP[entry.role];
    if (mapped) included.add(mapped);
    // The assassin is a flag on an evil role in this corpus, not a role name.
    if (entry.assassin) included.add("assassin");
  }
  return { rolesIncluded: [...included] };
}

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

  const roleSet = roleSetOf(raw);

  const game: GameRecord = {
    id: `corpus-${index}`,
    schemaVersion: 1,
    playerCount,
    roleSet,
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

  // Ground truth roles. The assassin flag wins over the role label, since
  // most assassins are recorded as EVIL MINION with assassin: true.
  const roles = new Map<RoleType, string>();
  const byPlayer = new Map<string, RoleType>();
  for (const entry of raw.outcome.roles) {
    const id = idOf.get(entry.name);
    if (!id) continue;
    const mapped = entry.assassin ? "assassin" : ROLE_MAP[entry.role];
    if (!mapped) continue;
    byPlayer.set(id, mapped);
    if (mapped !== "loyal" && mapped !== "minion") roles.set(mapped, id);
  }

  return { game, events, evil, truth: { roles, byPlayer } };
}

export function loadCorpus(): Converted[] {
  const raw = JSON.parse(readFileSync(CORPUS, "utf8")) as Raw[];
  return raw
    .map((g, i) => convert(g, i))
    .filter((c): c is Converted => c !== null);
}

