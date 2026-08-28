/**
 * What a player is, from the referee's point of view.
 *
 * Deliberately narrow. An agent receives an `Observation` and returns an
 * `Action`; it is handed no game state, no deal and no other seat's anything,
 * so the difference between a scripted policy and a language model is only how
 * the decision is made, never what may be looked at. That is the same shape
 * `SeatAgent` in `src/lib/decision/brief.ts` settled on, and for the same
 * reason: the arms of a comparison must differ in exactly one thing.
 *
 * `act` may return a promise so the LLM agent fits this interface unchanged.
 * Scripted agents return synchronously and the runner awaits either.
 */

import type { Observation } from "../core/observation";
import type { Action, Seat } from "../core/types";

/**
 * Why the previous answer was thrown out, when the runner is asking again.
 *
 * The referee rejects an illegal action WITHOUT mutating anything, so a bad
 * answer costs a retry rather than a game — and the message it rejected with
 * is the most useful thing a model can be told. Handing it back is repair, not
 * a fallback: the model still decides, and if it cannot produce something
 * legal within the retry budget the game FAILS rather than quietly having a
 * scripted policy play the turn. A substituted turn would belong to neither
 * arm of any comparison.
 */
export interface RejectionFeedback {
  /** 1 for the first retry. */
  readonly attempt: number;
  /** The referee's own message, or a parse error. Safe to show a model. */
  readonly error: string;
}

export interface Agent {
  /** Stable label. Goes into the run manifest beside the seat. */
  readonly name: string;
  act(observation: Observation, feedback?: RejectionFeedback): Action | Promise<Action>;
}

/** One agent per seat. Built before the game starts and never re-bound. */
export type AgentTable = Readonly<Record<Seat, Agent>>;
