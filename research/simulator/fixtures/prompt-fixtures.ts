/**
 * Reaching every decision kind, deterministically, so prompts can be goldened.
 *
 * Test-only, and it reads `GameState` directly — see `harness.ts` for why that
 * is fine: a test is not a player. What is built HERE from the state is only
 * the driving; the prompts themselves are built from observations, which is
 * the property the leakage tests then attack.
 */

import type { Observation } from "../core/observation";
import { observationFor } from "../core/observation";
import type { GameState } from "../core/state";
import type { Action, RoleType, Seat } from "../core/types";
import { SEATS } from "../core/types";
import { buildPlayerPrompt, type BuiltPrompt } from "../prompts/build";
import { personaById, type PersonaDefinition } from "../prompts/personas";
import { strategyById, type StrategyDefinition } from "../prompts/strategies";
import { drive, referenceDeal, REFERENCE_ASSIGNMENT } from "./harness";

/** Fixed persona and strategy, so a golden file changes only when prompts do. */
export const FIXED_PERSONA: PersonaDefinition = personaById("steady");
export const FIXED_STRATEGY: StrategyDefinition = strategyById("baseline");

export function promptFor(
  observation: Observation,
  persona = FIXED_PERSONA,
  strategy = FIXED_STRATEGY,
): BuiltPrompt {
  return buildPlayerPrompt({ observation, persona, strategy });
}

/** The seat holding a role in the reference deal. */
export function seatOfRole(role: RoleType): Seat {
  const seat = SEATS.find((s) => REFERENCE_ASSIGNMENT[s] === role);
  if (!seat) throw new Error(`no seat holds ${role} in the reference deal`);
  return seat;
}

/**
 * The very first prompt a role ever sees.
 *
 * Built by making that role's seat the opening leader, which is the only
 * decision available before anyone has spoken — so this really is the reveal,
 * with an empty transcript.
 */
export function revealPrompt(role: RoleType, ladySide: "left" | "right" = "left"): BuiltPrompt {
  const seat = seatOfRole(role);
  const { state } = drive({
    seed: 1,
    deal: referenceDeal(),
    initialLeader: seat,
    stopWhen: (s) => s.phase === "opening_direction",
  });
  void ladySide;
  return promptFor(observationFor(state, seat));
}

/**
 * Play one game that visits every decision kind, keeping the first prompt of
 * each.
 *
 * The track is engineered rather than sampled: every car carries exactly one
 * villain who plays SUCCESS, so quests come back clean (which is what reaches
 * the assassination) while still producing a mission-card request (which only
 * an evil seat ever gets).
 */
export function capturePrompts(seed = 42): {
  readonly prompts: Map<string, BuiltPrompt>;
  readonly state: GameState;
} {
  const prompts = new Map<string, BuiltPrompt>();

  const { state } = drive({
    seed,
    deal: referenceDeal(),
    override: (observation, s): Action | undefined => {
      const request = observation.request;
      if (!request) return undefined;

      const prompt = promptFor(observation);
      if (!prompts.has(prompt.taskId)) prompts.set(prompt.taskId, prompt);

      switch (request.kind) {
        case "choose_opening_direction":
          return {
            kind: "choose_opening_direction",
            ladySide: "left",
            publicMessage: "女神给我左手边，顺序往右走。",
          };
        case "speech":
          return {
            kind: "speech",
            publicMessage: `我是${observation.seat}号，先听听大家怎么说。`,
            tentativeTeam: request.slot === "opening" ? [1, 2, 3] : null,
          };
        case "leader_close_and_propose": {
          // One villain aboard, so a mission card really gets requested.
          const team = [s.deal.evilSeats[0], ...s.deal.goodSeats].slice(0, request.teamSize);
          return {
            kind: "leader_close_and_propose",
            publicMessage: "听完之后我还是带这几个。",
            team,
          };
        }
        case "vote":
          return { kind: "vote", choice: "approve" };
        case "mission":
          // Passing on purpose: the quest track has to reach three successes.
          return { kind: "mission", card: "success" };
        case "lady_select":
          return { kind: "lady_select", target: request.eligible[0] };
        case "lady_announce":
          return {
            kind: "lady_announce",
            announced: "good",
            publicMessage: "我验了他，是好人。",
          };
        case "evil_discuss":
          return { kind: "evil_discuss", message: "我押发言最少的那个。" };
        case "assassinate":
          return {
            kind: "assassinate",
            target: s.deal.goodSeats.find((x) => x !== s.deal.merlin)!,
          };
      }
    },
  });

  return { prompts, state };
}

/** Every task id the schemas can produce, so a test can assert full coverage. */
export const ALL_TASK_IDS: readonly string[] = [
  "opening-direction",
  "speech-opening",
  "speech-regular",
  "leader-close-and-propose",
  "vote",
  "mission-card",
  "lady-select",
  "lady-announce",
  "evil-discuss",
  "assassinate",
];
