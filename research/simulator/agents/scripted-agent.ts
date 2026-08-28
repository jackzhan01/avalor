/**
 * Deterministic players. No network, no model, no cost.
 *
 * These exist to make the referee testable at a scale a language model never
 * could be — a thousand complete games in a unit test — and to give the mocked
 * arm of every later comparison a fixed opponent. They are NOT a model of how
 * humans play and must never be used as one; the repository already has a
 * measured human-policy model for that, in the frozen decision layer, and this
 * is deliberately not it.
 *
 * Every decision comes from a named child stream of the run seed, so an
 * agent's behaviour depends on (seed, seat, profile) and on nothing else. Add
 * a draw in the referee and these still play the same game, which is what
 * makes replay hold across refactors.
 *
 * The profiles between them cover every branch the rules have: both opening
 * directions, tables that approve everything and tables that approve nothing,
 * evil that fails quests and evil that strategically passes them, Lady holders
 * who tell the truth and Lady holders who lie.
 */

import type { Observation } from "../core/observation";
import { childRng, randomInt, shuffled, type Rng } from "../core/rng";
import {
  SEATS,
  type Action,
  type LadySide,
  type PrivateMemoryPatch,
  type Seat,
} from "../core/types";
import type { Agent, AgentTable } from "./agent";
import { normalisePatch } from "./memory";

export interface ScriptedProfile {
  readonly name: string;
  /** "seed" lets the opening leader's own stream decide. */
  readonly ladySide: LadySide | "seed";
  /** P(approve) on an ordinary vote. */
  readonly approveRate: number;
  /**
   * Whether the fifth car gets waved through.
   *
   * Real tables fold on the hammer because rejecting it hands evil the game.
   * Turning it OFF is what lets a profile drive the rejection track to five and
   * exercise that ending.
   */
  readonly hammerApprove: boolean;
  /** P(an evil seat aboard plays the fail card). 0 = always passes. */
  readonly evilFailRate: number;
  /** P(the Lady holder announces the opposite of what they were shown). */
  readonly ladyLieRate: number;
  /** How the assassin picks among the seats it has not been shown are evil. */
  readonly assassinPick: "lowest" | "highest" | "random";
  /** Whether an evil leader loads its own car with teammates it can see. */
  readonly evilLoadsTeam: boolean;
  /** Whether speeches float a 意向车. */
  readonly floatTentative: boolean;
}

export const PROFILES: Readonly<Record<string, ScriptedProfile>> = {
  /** The default sweep table: everything happens sometimes. */
  mixed: {
    name: "mixed",
    ladySide: "seed",
    approveRate: 0.62,
    hammerApprove: false,
    evilFailRate: 0.6,
    ladyLieRate: 0.35,
    assassinPick: "random",
    evilLoadsTeam: true,
    floatTentative: true,
  },
  /** Approves everything and fails every quest it can. Quick evil wins. */
  agreeable: {
    name: "agreeable",
    ladySide: "seed",
    approveRate: 1,
    hammerApprove: true,
    evilFailRate: 1,
    ladyLieRate: 0,
    assassinPick: "lowest",
    evilLoadsTeam: true,
    floatTentative: true,
  },
  /** Rejects everything. Five in a row hands evil the game — that ending. */
  contrarian: {
    name: "contrarian",
    ladySide: "seed",
    approveRate: 0,
    hammerApprove: false,
    evilFailRate: 1,
    ladyLieRate: 1,
    assassinPick: "lowest",
    evilLoadsTeam: false,
    floatTentative: false,
  },
  /**
   * Evil never plays a card. Every quest comes back clean, good reaches three,
   * and the game is decided by the assassin — which is the only way to
   * exercise the whole endgame path.
   */
  passiveEvil: {
    name: "passiveEvil",
    ladySide: "seed",
    approveRate: 1,
    hammerApprove: true,
    evilFailRate: 0,
    ladyLieRate: 0.5,
    assassinPick: "random",
    evilLoadsTeam: false,
    floatTentative: true,
  },
  /** Opening direction pinned left, and the Lady always tells the truth. */
  truthfulLeft: {
    name: "truthfulLeft",
    ladySide: "left",
    approveRate: 1,
    hammerApprove: true,
    evilFailRate: 0,
    ladyLieRate: 0,
    assassinPick: "lowest",
    evilLoadsTeam: false,
    floatTentative: false,
  },
  /** Opening direction pinned right, and the Lady always lies. */
  lyingRight: {
    name: "lyingRight",
    ladySide: "right",
    approveRate: 1,
    hammerApprove: true,
    evilFailRate: 0,
    ladyLieRate: 1,
    assassinPick: "highest",
    evilLoadsTeam: false,
    floatTentative: false,
  },
};

/** Seats this observation's owner has been shown are on the other team. */
function knownEvilSeats(observation: Observation): Seat[] {
  const knowledge = observation.knowledge;
  if (knowledge.kind === "sees_evil" || knowledge.kind === "knows_teammates") {
    return [...knowledge.seats];
  }
  return [];
}

/** Bounded, deterministic, and comfortably inside the 220-character budget. */
function speechText(observation: Observation, tag: string): string {
  const p = observation.position;
  return `[${tag}] 我是${observation.seat}号。第${p.missionNumber}轮第${p.attempt}车，车主${p.leader}号。目前${p.successes}成${p.fails}败，连否${p.rejectionStreak}次。`;
}

function pickTeam(observation: Observation, rng: Rng, profile: ScriptedProfile): Seat[] {
  const size = observation.position.teamSizeThisMission;
  const self = observation.seat;
  const team: Seat[] = [self];

  // An evil leader that loads its car puts one seat it can see aboard, which
  // is what makes quests fail often enough for the failure branch to be
  // exercised without hand-writing a game.
  if (profile.evilLoadsTeam && observation.side === "evil") {
    for (const seat of knownEvilSeats(observation)) {
      if (team.length >= size) break;
      if (!team.includes(seat)) team.push(seat);
    }
  }

  for (const seat of shuffled(rng, SEATS)) {
    if (team.length >= size) break;
    if (!team.includes(seat)) team.push(seat);
  }
  return team.slice(0, size);
}

function assassinTarget(observation: Observation, rng: Rng, profile: ScriptedProfile): Seat {
  // By this phase the roster has been revealed, so the assassin genuinely
  // knows which six seats are good. Merlin is one of them.
  const evil = new Set(
    observation.evilRoster
      ? observation.evilRoster.map((entry) => entry.seat)
      : [observation.seat, ...knownEvilSeats(observation)],
  );
  const candidates = SEATS.filter((seat) => !evil.has(seat) && seat !== observation.seat);
  if (candidates.length === 0) {
    // Cannot happen at this line-up (six good seats), but a fallback beats a
    // crash inside a thousand-game sweep.
    return SEATS.find((seat) => seat !== observation.seat) as Seat;
  }
  if (profile.assassinPick === "lowest") return candidates[0];
  if (profile.assassinPick === "highest") return candidates[candidates.length - 1];
  return candidates[randomInt(rng, candidates.length)];
}

/**
 * A small, honest memory write.
 *
 * Only what the seat could actually justify: the teammates it was dealt, and
 * anyone the Lady privately showed it. Note the Lady entries go into a BELIEF
 * at probability 1 — the hard record itself lives in `ladyResults` and is not
 * touched, which is the separation this whole design rests on.
 */
function memoryPatch(observation: Observation): PrivateMemoryPatch {
  const beliefs = knownEvilSeats(observation).map((seat) => ({
    seat,
    pEvil: 1,
    note: "发牌时看到的",
  }));
  for (const result of observation.ladyResults) {
    beliefs.push({
      seat: result.target,
      pEvil: result.trueSide === "evil" ? 1 : 0,
      note: `第${result.missionNumber}轮我验的`,
    });
  }
  return normalisePatch({
    beliefs,
    intentions: [`第${observation.position.missionNumber}轮继续观察`],
  });
}

export interface ScriptedAgentOptions {
  readonly seed: number;
  readonly profile: ScriptedProfile;
}

/** One scripted seat. Its whole behaviour is (seed, seat, profile). */
export function scriptedAgent(seat: Seat, options: ScriptedAgentOptions): Agent {
  const rng = childRng(options.seed, `agent:${seat}:${options.profile.name}`);
  const profile = options.profile;

  return {
    name: `scripted:${profile.name}`,
    act(observation: Observation): Action {
      const request = observation.request;
      if (!request) throw new Error(`seat ${seat} asked to act with no pending request`);

      switch (request.kind) {
        case "choose_opening_direction": {
          const ladySide: LadySide =
            profile.ladySide === "seed"
              ? rng() < 0.5
                ? "left"
                : "right"
              : profile.ladySide;
          return {
            kind: "choose_opening_direction",
            ladySide,
            publicMessage: `我是${seat}号，开局把湖中女神给我${ladySide === "left" ? "左" : "右"}手边，顺序往${ladySide === "left" ? "右" : "左"}走。`,
          };
        }

        case "speech": {
          const tentative = profile.floatTentative
            ? pickTeam(observation, rng, profile)
            : null;
          return {
            kind: "speech",
            publicMessage: speechText(observation, request.slot),
            tentativeTeam: tentative,
            noTeamYet: false,
            stances: [],
            claim: null,
            // Written on the opening turn only. Every turn would be honest too,
            // and would allocate half a million objects in the sweep for no
            // extra coverage.
            ...(request.slot === "opening" ? { memoryPatch: memoryPatch(observation) } : {}),
          };
        }

        case "leader_close_and_propose":
          // One decision, two published facts. The scripted table keeps them
          // consistent trivially; a model has to, which is the point.
          return {
            kind: "leader_close_and_propose",
            publicMessage: speechText(observation, "closing"),
            team: pickTeam(observation, rng, profile),
            rationale: "scripted",
          };

        case "vote": {
          const hammer = observation.position.attempt >= 5;
          const approve = hammer && profile.hammerApprove ? true : rng() < profile.approveRate;
          return { kind: "vote", choice: approve ? "approve" : "reject" };
        }

        case "mission": {
          // The referee only asks evil seats; a good seat is pre-filled and
          // never offered the illegal option.
          const fail = observation.side === "evil" && rng() < profile.evilFailRate;
          return { kind: "mission", card: fail ? "fail" : "success" };
        }

        case "lady_select": {
          const eligible = request.eligible;
          return {
            kind: "lady_select",
            target: eligible[randomInt(rng, eligible.length)],
          };
        }

        case "lady_announce": {
          const latest = observation.ladyResults[observation.ladyResults.length - 1];
          if (!latest) throw new Error("asked to announce with no private result");
          const lie = rng() < profile.ladyLieRate;
          const announced = lie
            ? latest.trueSide === "good"
              ? "evil"
              : "good"
            : latest.trueSide;
          return {
            kind: "lady_announce",
            announced,
            publicMessage: `我验了${latest.target}号，我说他是${announced === "good" ? "好人" : "坏人"}。`,
          };
        }

        case "evil_discuss":
          return {
            kind: "evil_discuss",
            message: `${seat}号：我们该刺谁，说说各自的判断。`,
          };

        case "assassinate":
          return {
            kind: "assassinate",
            target: assassinTarget(observation, rng, profile),
            rationale: "scripted",
          };
      }
    },
  };
}

/** Ten seats, all on the same profile. */
export function scriptedTable(options: ScriptedAgentOptions): AgentTable {
  const table = {} as Record<Seat, Agent>;
  for (const seat of SEATS) table[seat] = scriptedAgent(seat, options);
  return table;
}

/**
 * Ten seats with a per-seat profile map, for tables that are not uniform.
 * Anything missing falls back to `fallback`.
 */
export function mixedTable(
  seed: number,
  bySeat: Partial<Record<Seat, ScriptedProfile>>,
  fallback: ScriptedProfile = PROFILES.mixed,
): AgentTable {
  const table = {} as Record<Seat, Agent>;
  for (const seat of SEATS) {
    table[seat] = scriptedAgent(seat, { seed, profile: bySeat[seat] ?? fallback });
  }
  return table;
}
