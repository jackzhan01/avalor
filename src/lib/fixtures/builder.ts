/**
 * Fluent fixture builder, so tests read like a transcript of a real game:
 *
 *   game(9).opinion(3, 6, 4).proposal(1, [1, 4, 7])
 *          .vote({ 1: "approve", 2: "reject" }, "rejected")
 *          .build()
 *
 * Everything is addressed by SEAT NUMBER, the way people talk at a table. The
 * builder maps seats to player ids.
 *
 * Note that the builder tracks mission/proposal numbering with its own simple
 * bookkeeping rather than calling deriveTimeline. That is deliberate: it gives
 * the test suite a second, independent implementation of the numbering rules to
 * cross-check the fold against, instead of validating the fold against itself.
 */

import type {
  GameEvent,
  MissionEvent,
  OpinionEvent,
  ProposalEvent,
  Rating,
  TextEvent,
  VoteEvent,
} from "@/lib/types/events";
import type {
  GameRecord,
  MissionResult,
  Player,
  PlayerCount,
  VoteChoice,
} from "@/lib/types/game";

/** Fixed epoch so fixtures are byte-stable across runs. */
const BASE_TIME = Date.parse("2026-08-16T19:00:00.000Z");

export type SeatVotes = Record<number, VoteChoice>;

export class GameBuilder {
  private readonly players: Player[];
  private readonly playerCount: PlayerCount;
  private readonly gameId = "g1";
  private readonly events: GameEvent[] = [];

  private seq = 0;
  private missionNumber = 1;
  private proposalNumber = 1;
  /** Id of the most recent proposal, so vote()/mission() can reference it. */
  private lastProposalId: string | null = null;
  private firstLeaderSeat = 1;
  private status: GameRecord["status"] = "active";
  private winningSide: GameRecord["winningSide"] = null;

  constructor(playerCount: PlayerCount, names?: Record<number, string>) {
    this.playerCount = playerCount;
    this.players = Array.from({ length: playerCount }, (_, i) => {
      const seat = i + 1;
      const name = names?.[seat];
      return { id: `p${seat}`, seat, ...(name ? { name } : {}) };
    });
  }

  /** Seat number → player id. Throws loudly on a typo'd seat in a fixture. */
  id(seat: number): string {
    const player = this.players.find((p) => p.seat === seat);
    if (!player) {
      throw new Error(
        `Seat ${seat} does not exist in a ${this.playerCount}-player game`,
      );
    }
    return player.id;
  }

  private next(): { id: string; sequence: number; timestamp: string } {
    this.seq += 1;
    return {
      id: `e${this.seq}`,
      sequence: this.seq,
      // 30 s apart: ordering by timestamp would coincidentally work here, which
      // is why the tests assert ordering by sequence explicitly.
      timestamp: new Date(BASE_TIME + this.seq * 30_000).toISOString(),
    };
  }

  private base() {
    return {
      ...this.next(),
      gameId: this.gameId,
      missionNumber: this.missionNumber,
      proposalNumber: this.proposalNumber,
    };
  }

  firstLeader(seat: number): this {
    this.firstLeaderSeat = seat;
    return this;
  }

  /** speaker seat → target seat = rating. */
  opinion(speakerSeat: number, targetSeat: number, rating: Rating): this {
    const event: OpinionEvent = {
      ...this.base(),
      type: "opinion",
      speakerId: this.id(speakerSeat),
      targetId: this.id(targetSeat),
      rating,
    };
    this.events.push(event);
    return this;
  }

  /** 点车: leader seat proposes the given team seats. */
  proposal(leaderSeat: number, teamSeats: number[]): this {
    const event: ProposalEvent = {
      ...this.base(),
      type: "proposal",
      leaderId: this.id(leaderSeat),
      teamPlayerIds: teamSeats.map((s) => this.id(s)),
    };
    this.events.push(event);
    this.lastProposalId = event.id;
    return this;
  }

  /**
   * Record a vote on the most recent proposal (or an explicit one).
   *
   * Seats omitted from `votes` are omitted from the stored map too — that is
   * how "never recorded" is represented, and it must stay distinguishable from
   * an explicit "unknown".
   */
  vote(
    votes: SeatVotes,
    finalResult: "passed" | "rejected",
    proposalId?: string,
  ): this {
    const target = proposalId ?? this.lastProposalId;
    if (!target) throw new Error("vote() called before any proposal()");

    const mapped: Record<string, VoteChoice> = {};
    for (const [seat, choice] of Object.entries(votes)) {
      mapped[this.id(Number(seat))] = choice;
    }

    const event: VoteEvent = {
      ...this.base(),
      type: "vote",
      proposalId: target,
      votes: mapped,
      finalResult,
    };
    this.events.push(event);

    if (finalResult === "rejected") this.proposalNumber += 1;
    return this;
  }

  /** Record the mission result for the most recent (passed) proposal. */
  mission(
    result: MissionResult,
    failCount?: number,
    proposalId?: string,
  ): this {
    const target = proposalId ?? this.lastProposalId;
    if (!target) throw new Error("mission() called before any proposal()");
    const proposal = this.events.find(
      (e): e is ProposalEvent => e.id === target && e.type === "proposal",
    );
    if (!proposal) throw new Error(`No proposal with id ${target}`);

    const event: MissionEvent = {
      ...this.base(),
      type: "mission",
      proposalId: target,
      teamPlayerIds: [...proposal.teamPlayerIds],
      result,
      ...(failCount != null ? { failCount } : {}),
    };
    this.events.push(event);

    this.missionNumber += 1;
    this.proposalNumber = 1;
    return this;
  }

  /** 意向车: this seat says who they would take if they were leader. */
  intendedTeam(playerSeat: number, teamSeats: number[]): this {
    this.events.push({
      ...this.base(),
      type: "intended_team",
      playerId: this.id(playerSeat),
      teamPlayerIds: teamSeats.map((s) => this.id(s)),
    });
    return this;
  }

  /** 跳派: claim (or retract a claim to) Percival. */
  claim(playerSeat: number, claimed = true): this {
    this.events.push({
      ...this.base(),
      type: "role_claim",
      playerId: this.id(playerSeat),
      claimed,
    });
    return this;
  }

  note(playerSeat: number | null, text: string): this {
    const event: TextEvent = {
      ...this.base(),
      type: "text",
      ...(playerSeat != null ? { playerId: this.id(playerSeat) } : {}),
      text,
    };
    this.events.push(event);
    return this;
  }

  /** Append a hand-made event, for testing malformed logs (orphans, etc). */
  raw(event: GameEvent): this {
    this.events.push(event);
    this.seq = Math.max(this.seq, event.sequence);
    return this;
  }

  complete(winningSide: GameRecord["winningSide"] = null): this {
    this.status = "completed";
    this.winningSide = winningSide;
    return this;
  }

  build(): { game: GameRecord; events: GameEvent[] } {
    const game: GameRecord = {
      id: this.gameId,
      schemaVersion: 1,
      playerCount: this.playerCount,
      players: this.players,
      firstLeaderId: this.id(this.firstLeaderSeat),
      status: this.status,
      winningSide: this.winningSide,
      lastSequence: this.seq,
      createdAt: new Date(BASE_TIME).toISOString(),
      updatedAt: new Date(BASE_TIME + this.seq * 30_000).toISOString(),
    };
    return { game, events: [...this.events] };
  }
}

export function game(
  playerCount: PlayerCount,
  names?: Record<number, string>,
): GameBuilder {
  return new GameBuilder(playerCount, names);
}

/** Every seat approves. */
export function allApprove(playerCount: number): SeatVotes {
  const out: SeatVotes = {};
  for (let seat = 1; seat <= playerCount; seat++) out[seat] = "approve";
  return out;
}

/** Every seat rejects. */
export function allReject(playerCount: number): SeatVotes {
  const out: SeatVotes = {};
  for (let seat = 1; seat <= playerCount; seat++) out[seat] = "reject";
  return out;
}

/** Listed seats approve; everyone else rejects. */
export function approveOnly(
  playerCount: number,
  approvingSeats: number[],
): SeatVotes {
  const out: SeatVotes = {};
  for (let seat = 1; seat <= playerCount; seat++) {
    out[seat] = approvingSeats.includes(seat) ? "approve" : "reject";
  }
  return out;
}
