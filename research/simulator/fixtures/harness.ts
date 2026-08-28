/**
 * Test-only helpers for driving a game to an exact position.
 *
 * These read `GameState` directly — the deal included — and that is fine:
 * a test is not a player. The rule the leakage suite enforces is that nothing
 * an AGENT touches can reach the deal, and the only function agents are given
 * is `observationFor`. A harness that had to play blind could not set up the
 * situations worth testing.
 */

import { loadConfig, type SimConfig } from "../config/load";
import { dealFromAssignment, type Deal } from "../core/deal";
import { applyAction, createGame } from "../core/referee";
import { observationFor, type Observation } from "../core/observation";
import type { GameState } from "../core/state";
import { SEATS, type Action, type RoleType, type Seat } from "../core/types";
import type { Agent, AgentTable } from "../agents/agent";
import type { RecordedAction } from "../run/artifacts";
import { PROFILES, scriptedTable, type ScriptedProfile } from "../agents/scripted-agent";

export function testConfig(overrides?: Parameters<typeof loadConfig>[0]): SimConfig {
  return loadConfig(overrides);
}

/**
 * A fixed, readable deal. Seat 1 Merlin, 2 Percival, 3-6 loyal, then the four
 * villains. Every visibility assertion in the suite is written against this so
 * a reader can check the expected answer by eye.
 */
export const REFERENCE_ASSIGNMENT: Readonly<Record<Seat, RoleType>> = {
  1: "merlin",
  2: "percival",
  3: "loyal",
  4: "loyal",
  5: "loyal",
  6: "loyal",
  7: "morgana",
  8: "assassin",
  9: "mordred",
  10: "oberon",
};

export function referenceDeal(): Deal {
  return dealFromAssignment(REFERENCE_ASSIGNMENT);
}

/** The same table with Merlin and Morgana swapped, for the invariance test. */
export function swappedDeal(): Deal {
  return dealFromAssignment({
    ...REFERENCE_ASSIGNMENT,
    1: "morgana",
    7: "merlin",
  });
}

export interface DrivenGame {
  readonly state: GameState;
  /** Every observation handed out, in order. */
  readonly observations: Observation[];
  /**
   * The same shape `runGame` records, so a driven game can be handed straight
   * to `replayGame` or `checkInvariants` without a second conversion.
   */
  readonly actions: RecordedAction[];
}

export interface DriveOptions {
  readonly seed?: number;
  readonly deal?: Deal;
  readonly initialLeader?: Seat;
  readonly config?: SimConfig;
  readonly profile?: ScriptedProfile;
  readonly agents?: AgentTable;
  /**
   * Take over any decision. Returning undefined falls through to the scripted
   * agent, which is what lets a test override one thing and leave the rest
   * playing normally.
   */
  readonly override?: (
    observation: Observation,
    state: GameState,
  ) => Action | undefined;
  /** Stop before acting, leaving the game standing at that decision. */
  readonly stopWhen?: (state: GameState, observation: Observation) => boolean;
  readonly maxActions?: number;
  /** Inspect every observation as it is produced. Used by the leakage sweep. */
  readonly onObservation?: (observation: Observation, state: GameState) => void;
}

/**
 * Play a game synchronously, with hooks.
 *
 * Synchronous on purpose: scripted agents never await, and a thousand-game
 * sweep that went through the microtask queue half a million times would take
 * long enough to discourage running it.
 */
export function drive(options: DriveOptions = {}): DrivenGame {
  const config = options.config ?? testConfig();
  const state = createGame({
    seed: options.seed ?? 1,
    config,
    ...(options.deal ? { deal: options.deal } : {}),
    ...(options.initialLeader ? { initialLeader: options.initialLeader } : {}),
  });
  const agents: AgentTable =
    options.agents ??
    scriptedTable({
      seed: options.seed ?? 1,
      profile: options.profile ?? PROFILES.mixed,
    });

  const observations: Observation[] = [];
  const actions: RecordedAction[] = [];
  const limit = options.maxActions ?? config.limits.maxActionsPerGame;

  while (state.pending) {
    if (actions.length >= limit) throw new Error("drive() hit its action limit");
    const seat = state.pending.seat;
    const observation = observationFor(state, seat);
    observations.push(observation);
    options.onObservation?.(observation, state);
    if (options.stopWhen?.(state, observation)) break;

    const chosen = options.override?.(observation, state) ?? syncAct(agents[seat], observation);
    actions.push({ atSequence: state.sequence, seat, action: chosen });
    applyAction(state, seat, chosen);
  }

  return { state, observations, actions };
}

function syncAct(agent: Agent, observation: Observation): Action {
  const result = agent.act(observation);
  if (result instanceof Promise) {
    throw new Error("drive() needs synchronous agents; use runGame for async ones");
  }
  return result;
}

/** Every seat's observation right now. The leakage suite's unit of work. */
export function allObservations(state: GameState): Observation[] {
  return SEATS.map((seat) => observationFor(state, seat));
}

/** A string of `n` non-whitespace characters, for the speech-limit tests. */
export function textOfLength(n: number): string {
  return "字".repeat(n);
}
