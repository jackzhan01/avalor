/**
 * Shapes produced by the selector layer. Nothing here is ever persisted — it is
 * all recomputed from the event log.
 */

import type {
  GameEvent,
  MissionEvent,
  OpinionEvent,
  ProposalEvent,
  Rating,
  TextEvent,
  VoteEvent,
} from "./events";
import type {
  GamePhase,
  MissionResult,
  ProposalStatus,
  VoteChoice,
} from "./game";

export interface ProposalState {
  event: ProposalEvent;
  status: ProposalStatus;
  missionNumber: number;
  proposalNumber: number;
  /** The authoritative vote for this proposal, if one was recorded. */
  vote: VoteEvent | null;
  /** The authoritative mission result, if this proposal passed and ran. */
  mission: MissionEvent | null;
  expectedTeamSize: number;
  teamSizeMismatch: boolean;
}

export interface MissionSummary {
  missionNumber: number;
  status: "upcoming" | "in_progress" | "completed";
  /** From the official rules table, for this table size. */
  expectedTeamSize: number;
  requiredFails: 1 | 2;
  /** Every proposal attempted in this mission, including superseded drafts. */
  proposalIds: string[];
  passedProposalId: string | null;
  missionEventId: string | null;
  result: MissionResult | null;
  /** null means "not recorded", which is different from 0. */
  failCount: number | null;
  /** Who actually went, per the mission event's own snapshot. */
  teamPlayerIds: string[] | null;
}

export type IntegrityWarningKind =
  | "orphan_vote"
  | "orphan_mission"
  | "superseded_vote"
  | "superseded_mission"
  | "vote_result_mismatch"
  | "mission_team_mismatch"
  | "fail_count_below_required"
  | "rejection_limit_reached";

export interface IntegrityWarning {
  kind: IntegrityWarningKind;
  /** The event the warning is about, when there is one. */
  eventId?: string;
  missionNumber?: number;
  message: string;
}

export interface EventContext {
  missionNumber: number;
  proposalNumber: number;
}

export type LeaderSource = "active_proposal" | "rotation" | "initial";

export interface DerivedTimeline {
  /** Controls the primary CTA only — see GamePhase. */
  phase: GamePhase;
  isComplete: boolean;
  completionReason:
    | "missions_good"
    | "missions_evil"
    | "rejection_limit"
    | "manual"
    | null;
  missionNumber: number;
  proposalNumber: number;
  activeProposalId: string | null;
  proposalsById: Map<string, ProposalState>;
  /** Proposal ids in the order they were recorded. */
  proposalOrder: string[];
  /** Always length 5. */
  missions: MissionSummary[];
  currentLeaderId: string | null;
  leaderSource: LeaderSource;
  /** Consecutive rejected proposals in the current mission. 5 hands evil the win. */
  rejectionStreak: number;
  successCount: number;
  failCount: number;
  /** Which mission/proposal each event belongs to. */
  eventContext: Map<string, EventContext>;
  warnings: IntegrityWarning[];
}

/* ── Opinions ──────────────────────────────────────────────────────────── */

export interface OpinionCell {
  rating: Rating;
  eventId: string;
  sequence: number;
  timestamp: string;
  missionNumber: number;
  /** How many times this speaker→target pair has been rated in total. */
  revisionCount: number;
}

export interface DerivedOpinions {
  /**
   * speakerId → targetId → cell.
   *
   * AN ABSENT KEY MEANS "NEVER EXPRESSED AN OPINION". It does not mean neutral.
   * Neutral is an explicit rating of 3. Never collapse the two.
   */
  current: Map<string, Map<string, OpinionCell>>;
  /** "speakerId|targetId" → every revision, ascending. Nothing is overwritten. */
  history: Map<string, OpinionEvent[]>;
}

export interface OpinionEdge {
  speakerId: string;
  targetId: string;
  cell: OpinionCell;
}

/* ── Player-scoped views ───────────────────────────────────────────────── */

export interface PlayerVoteRecord {
  voteEventId: string;
  proposalEventId: string;
  missionNumber: number;
  proposalNumber: number;
  /**
   * "unknown" = recorded as unknown. `null` = this seat is absent from the
   * votes map entirely, i.e. never recorded. Same discipline as opinions.
   */
  vote: VoteChoice | null;
  finalResult: "passed" | "rejected";
  wasOnTeam: boolean;
  leaderId: string;
  teamPlayerIds: string[];
  sequence: number;
  timestamp: string;
}

export interface PlayerVoteHistory {
  records: PlayerVoteRecord[];
  tally: {
    approve: number;
    reject: number;
    unknown: number;
    /** Proposals where this seat was never recorded at all. */
    unrecorded: number;
  };
}

export interface ProposalRecord {
  proposalEventId: string;
  missionNumber: number;
  proposalNumber: number;
  leaderId: string;
  teamPlayerIds: string[];
  status: ProposalStatus;
  sequence: number;
}

export interface PlayerProposalHistory {
  asLeader: ProposalRecord[];
  asMember: ProposalRecord[];
  timesLed: number;
  timesIncluded: number;
  /** Raw counts only. No inference, no "trust score". */
  asLeaderOutcome: { passed: number; rejected: number };
}

export interface PlayerMissionParticipation {
  missionNumber: number;
  result: MissionResult;
  failCount: number | null;
}

export type AnyEventOf<T extends GameEvent["type"]> = Extract<
  GameEvent,
  { type: T }
>;

export type { OpinionEvent, TextEvent, VoteEvent, MissionEvent, ProposalEvent };
