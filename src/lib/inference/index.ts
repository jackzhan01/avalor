/**
 * Hidden-role inference. Import from here, not from the files beneath.
 *
 * What this layer will and will not do:
 *
 *   WILL   eliminate a hypothesis when a rule of Avalon makes it impossible
 *   WILL   report how many worlds remain and what is true in all of them
 *   WILL   name the reason for every elimination
 *
 *   WON'T  weigh a hypothesis by how suspicious somebody sounded
 *   WON'T  treat a successful mission as evidence anyone is good
 *   WON'T  believe what the lady holder announced out loud
 *
 * Everything here is a pure function of (events, game), memoised by reference
 * like the selectors, and runs offline in under a millisecond.
 */

export { deriveSideInference, initialEntropyBits } from "./side";
export {
  deriveRoleInference,
  isConfidentAbout,
  likeliestHolder,
  ROLE_CERTAIN_BITS,
} from "./roles";
export { enumerateHypotheses, evilOnTeam } from "./hypotheses";
export { inferenceFocus, availableTargets, defaultTarget } from "./focus";
export type { FocusItem, InferenceTarget } from "./focus";
export {
  seatSignal,
  roleSignal,
  summarise,
  baselineEvil,
  explainFlatRole,
  flatReasonText,
} from "./display";
export type { SeatSignal, FlatReason } from "./display";
export type {
  Elimination,
  Hypothesis,
  RoleInference,
  SideInference,
} from "./types";
