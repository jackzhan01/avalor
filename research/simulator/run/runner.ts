/**
 * Play one game from a seed and a table of agents.
 *
 * The loop is three lines long on purpose. Everything that could be a rule
 * lives in `referee.ts`, everything that could be a leak lives in
 * `observation.ts`, and this file only carries the game from one decision to
 * the next — so "did the runner accidentally let somebody see something"
 * cannot be a question anyone has to ask.
 *
 * NO NETWORK. Nothing in this path imports a client, reads an environment
 * variable or calls fetch, and `replay.test.ts` asserts it by failing the
 * global fetch and playing games anyway.
 *
 * NOTE what the observation hook does NOT receive. It used to be handed the
 * `GameState` alongside the observation, which meant any agent-adjacent code
 * that registered a callback — a logger, a metrics collector, a future model
 * client wanting to record prompts — could reach the deal through a hook whose
 * name suggested nothing of the sort. It now gets the observation and nothing
 * else. Tests that genuinely need the state use `drive()` in `fixtures/`,
 * which lives under a directory named for what it is.
 */

import { createHash } from "node:crypto";
import { loadConfig, type SimConfig } from "../config/load";
import { applyAction, createGame } from "../core/referee";
import { observationFor, type Observation } from "../core/observation";
import type { GameState, Outcome } from "../core/state";
import { IllegalActionError, type Action, type Seat } from "../core/types";
import type { AgentTable, RejectionFeedback } from "../agents/agent";
import type { RecordedAction } from "./artifacts";

export interface RunGameOptions {
  readonly seed: number;
  readonly agents: AgentTable;
  readonly config?: SimConfig;
  readonly runId?: string;
  /** Opaque and seed-free. Defaults to a fresh random UUID. */
  readonly gameId?: string;
  /**
   * Called with every observation handed out.
   *
   * Deliberately given the observation ALONE. See the file header: a hook that
   * also received `GameState` is a side door into the deal.
   */
  readonly onObservation?: (observation: Observation) => void;
  /** Every rejected attempt, so a trace can count how often repair was needed. */
  /**
   * `source` says which of the two rejection paths fired.
   *
   * `agent` covers a malformed action and a broken cognition block — the agent
   * threw before the referee ever saw a move. `referee` is an
   * `IllegalActionError` from `applyAction`. They arrive at the same handler
   * and mean different things, and conflating them already produced one wrong
   * report.
   */
  readonly onRejection?: (
    seat: Seat,
    feedback: RejectionFeedback,
    source: "agent" | "referee",
  ) => void;
  /**
   * Continue an interrupted game instead of starting one.
   *
   * `state` comes from `replayPrefix`, so it was rebuilt from the seed and the
   * recorded actions rather than deserialised. `actions` are those same
   * settled actions, carried forward so the finished game's log is complete
   * and the model is never asked about a decision that already happened.
   */
  readonly resume?: {
    readonly state: GameState;
    readonly actions: readonly RecordedAction[];
  };
  /**
   * Every action the referee accepted, as it is accepted.
   *
   * Deliberately NOT the state. A caller that needs the position after an
   * interruption rebuilds it with `replayPrefix` from exactly these actions —
   * the same deterministic path a resume takes — rather than being handed a
   * live `GameState` through a callback, which is the side door this file
   * spent a milestone closing.
   */
  readonly onActionApplied?: (action: RecordedAction) => void;
}

/**
 * The model could not produce a legal action within the retry budget.
 *
 * The game FAILS here rather than continuing with a substituted turn. A
 * scripted stand-in would produce a game belonging to neither arm of any
 * comparison, and calling such a run "completed" would be worse than a
 * failure because nothing downstream could tell the difference.
 */
export class UnrecoverableAgentError extends Error {
  constructor(
    readonly seat: Seat,
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(`${seat}号 连试 ${attempts} 次仍未给出合法动作：${lastError}`);
    this.name = "UnrecoverableAgentError";
  }
}

export interface GameResult {
  readonly state: GameState;
  readonly outcome: Outcome;
  readonly actions: RecordedAction[];
}

/**
 * The referee decides when a game is over; this bound only catches a referee
 * that cannot. A game that will not end is a bug in the rules, not a draw.
 */
function guardFor(config: SimConfig): number {
  return config.limits.maxActionsPerGame;
}

export async function runGame(options: RunGameOptions): Promise<GameResult> {
  const config = options.config ?? loadConfig();
  const state =
    options.resume?.state ??
    createGame({
      seed: options.seed,
      config,
      runId: options.runId,
      ...(options.gameId ? { gameId: options.gameId } : {}),
    });
  // Settled decisions carried forward: the loop below starts at whatever the
  // referee is waiting for, so nothing already answered is asked again.
  const actions: RecordedAction[] = [...(options.resume?.actions ?? [])];
  const guard = guardFor(config);

  // One extra pass per retry, not per turn: the referee leaves the state
  // untouched when it rejects, so asking again is genuinely the same decision.
  const maxRetries = config.run.maxRetries;

  while (state.pending) {
    if (actions.length >= guard) {
      throw new Error(
        `game ${options.seed} passed ${guard} actions without ending — referee bug`,
      );
    }
    const seat: Seat = state.pending.seat;
    const observation = observationFor(state, seat);
    options.onObservation?.(observation);

    let feedback: RejectionFeedback | undefined;
    let settled = false;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let action: Action;
      try {
        action = await options.agents[seat].act(observation, feedback);
      } catch (error) {
        // A malformed answer is a rejection like any other. A PAUSE (input or
        // cost ceiling) is not, and must propagate untouched.
        if (!isRepairable(error)) throw error;
        feedback = { attempt: attempt + 1, error: messageOf(error) };
        options.onRejection?.(seat, feedback, "agent");
        continue;
      }
      try {
        applyAction(state, seat, action);
      } catch (error) {
        if (!(error instanceof IllegalActionError)) throw error;
        feedback = { attempt: attempt + 1, error: error.message };
        options.onRejection?.(seat, feedback, "referee");
        continue;
      }
      const applied: RecordedAction = {
        atSequence: observation.publicLog.length,
        seat,
        action,
      };
      actions.push(applied);
      options.onActionApplied?.(applied);
      settled = true;
      break;
    }

    if (!settled) {
      throw new UnrecoverableAgentError(seat, maxRetries + 1, feedback?.error ?? "unknown");
    }
  }

  if (!state.outcome) throw new Error("game ended with no outcome");
  return { state, outcome: state.outcome, actions };
}

/**
 * Re-run a game from its recorded actions, with no agents at all.
 *
 * This is what makes "deterministic replay" a claim rather than a hope: the
 * referee is fed exactly the actions it was fed the first time, and the
 * resulting state must match event for event. If a rule changed, this is where
 * it shows up — the replay diverges, loudly, instead of a run quietly meaning
 * something different from the one it is being compared against.
 */
export function replayGame(
  seed: number,
  recorded: readonly RecordedAction[],
  config?: SimConfig,
): GameResult {
  const resolved = config ?? loadConfig();
  const state = createGame({ seed, config: resolved });
  const actions: RecordedAction[] = [];

  for (const entry of recorded) {
    if (!state.pending) {
      throw new Error(`replay had ${recorded.length} actions but the game ended early`);
    }
    if (state.pending.seat !== entry.seat) {
      throw new Error(
        `replay divergence: referee wants ${state.pending.seat}号, log has ${entry.seat}号`,
      );
    }
    const action: Action = entry.action;
    actions.push({ atSequence: state.sequence, seat: entry.seat, action });
    applyAction(state, entry.seat, action);
  }

  if (state.pending) throw new Error("replay ran out of actions before the game ended");
  if (!state.outcome) throw new Error("replay ended with no outcome");
  return { state, outcome: state.outcome, actions };
}

/**
 * A compact fingerprint of everything a replay must reproduce.
 *
 * Comparing whole states would also compare object identity and insertion
 * order of maps; comparing this compares the game.
 */
/**
 * Rebuild a game from a PREFIX of its actions and hand back the running state.
 *
 * This is what makes a checkpoint resumable. `replayGame` demands that the log
 * describes a finished game and throws if the actions run out — correct for
 * verifying a completed run, useless for continuing an interrupted one.
 *
 * Deterministic reconstruction, deliberately: the checkpoint stores the seed,
 * the config, the game id and the ACTIONS, never a serialised `GameState`. A
 * pickled mutable state would be authoritative the moment anything about the
 * referee changed, and would silently resume a game the current rules would
 * never have produced. Replaying the actions through today's referee either
 * reproduces the position or fails loudly.
 */
export function replayPrefix(
  seed: number,
  recorded: readonly RecordedAction[],
  options: { config?: SimConfig; gameId?: string; runId?: string } = {},
): GameState {
  const config = options.config ?? loadConfig();
  const state = createGame({
    seed,
    config,
    runId: options.runId ?? "live",
    ...(options.gameId ? { gameId: options.gameId } : {}),
  });

  for (const [index, entry] of recorded.entries()) {
    if (!state.pending) {
      throw new Error(
        `checkpoint has ${recorded.length} actions but the game ended after ${index}`,
      );
    }
    if (state.pending.seat !== entry.seat) {
      throw new Error(
        `replay divergence at action ${index}: referee wants ${state.pending.seat}号, checkpoint has ${entry.seat}号`,
      );
    }
    applyAction(state, entry.seat, entry.action);
  }
  return state;
}

/** A malformed model answer. Anything else — a pause, a bug — propagates. */
function isRepairable(error: unknown): boolean {
  return error instanceof Error && error.name === "UnparseableAnswer";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A short digest of the fingerprint, for a checkpoint.
 *
 * The full fingerprint is a whole game serialised; storing it in a checkpoint
 * would double the file for no gain. What a resume needs is a yes/no answer to
 * "did reconstruction produce the same position", and a hash answers that.
 */
export function fingerprintDigest(state: GameState): string {
  return createHash("sha256").update(fingerprint(state)).digest("hex");
}

export function fingerprint(state: GameState): string {
  return JSON.stringify({
    seed: state.seed,
    deal: state.deal.bySeat,
    direction: state.playDirection,
    ladyHeldBy: state.ladyHeldBy,
    outcome: state.outcome,
    log: state.log,
    privateLog: state.privateLog,
    memory: state.memory,
    ladyResults: state.ladyResults,
  });
}
