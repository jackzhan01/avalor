/**
 * Every number Product V1 ships with, in one place, with its provenance.
 *
 * Scattered constants are how a frozen algorithm stops being frozen: someone
 * nudges a threshold, nothing obviously breaks, and six weeks later nobody can
 * say what version produced a screenshot. So each value here carries where it
 * came from, and `ALGORITHM_VERSION` moves whenever any of them does.
 *
 * The behavioural parameters — approve rates, fail-card tables, proposal
 * loading, the role tempering — are NOT here. They belong to frozen Belief
 * Engine V1 and live beside the code that measured them, in lib/inference.
 * This file is the decision layer only.
 */

/**
 * Bumped whenever the same input could produce a different answer.
 *
 * Semantic: major for a change in what the product claims, minor for a new
 * capability, patch for a value that moves a number without changing meaning.
 */
export const ALGORITHM_VERSION = "product-v1.0.0";

/**
 * Monte Carlo worlds per action, per evaluation.
 *
 * At four hundred a ten-player vote takes about three and a half seconds on a
 * laptop and the paired standard error on the value difference lands near two
 * and a half points of win probability. Both halves of that matter: raising it
 * tightens the interval as the square root, so ten times the wait buys three
 * times the resolution, and the wait is already at the edge of what someone
 * will hold a phone through at a live table.
 */
export const DEFAULT_WORLDS = 400;

/**
 * How many of the exhaustively ranked teams get a rollout.
 *
 * The search over legal teams is complete — all 252 of them at the largest
 * table, scored exactly. Only the VALUATION is sampled, and valuing all of
 * them by rollout would take hours, so the cheap exact ranking picks the
 * shortlist and the expensive estimator ranks that.
 */
export const DEFAULT_SHORTLIST = 5;

/**
 * Worlds per candidate team, and far fewer than a vote gets.
 *
 * The proposal recommendation comes from the exact risk ranking, not from the
 * rollout, and so does its confidence. The rollout only puts a win number
 * beside each option. Spending a vote's worth of effort on a display value
 * would double the wait for nothing.
 */
export const DEFAULT_PROPOSAL_WORLDS = 150;

/**
 * How far apart two action values must be before the gap is worth acting on,
 * in win probability.
 *
 * Three points. Below that the honest answer is that both moves are about as
 * good, whatever the arithmetic prefers today — and given the simulator's own
 * documented calibration gap, a smaller claimed edge would be spurious
 * precision rather than advice.
 */
export const MEANINGFUL_DELTA = 0.03;

/**
 * How many standard errors a value difference must clear before it counts.
 *
 * Two, so a lucky run of Monte Carlo draws does not get promoted into a
 * recommendation. This is the gate that produces "too close to call", and at a
 * nine-player table it fires often — one seat's vote decides the outcome only
 * when the other eight split evenly, so most single votes genuinely are worth
 * about the same either way. That is the game, not a defect.
 */
export const CONFIDENCE_SIGMAS = 2;

/** Table sizes Product V1 supports. Smaller games were never calibrated. */
export const SUPPORTED_PLAYER_COUNTS = [7, 8, 9, 10] as const;
