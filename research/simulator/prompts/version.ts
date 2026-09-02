/**
 * The prompt version, stamped into every built prompt and every trace.
 *
 * Moves whenever a change could produce a different answer from the same
 * observation: new wording in any layer, a new task schema, a changed persona
 * or strategy text. Two runs that disagree are only comparable if this agrees,
 * and `build.test.ts` pins it to `config.promptVersion` so the recorded value
 * and the code cannot drift apart.
 *
 * Semantics, matching `ALGORITHM_VERSION` in the frozen decision layer: major
 * for a change in what the prompts ask for, minor for a new capability, patch
 * for wording that does not change the task.
 */
/**
 * The legacy layer stack: seven layers, no cognition, full history verbatim.
 * Experiments 2 and 3 ran under this and must stay reproducible.
 */
export const PROMPT_VERSION_LEGACY = "prompt-0.2.0";

/**
 * The M5 stack: adds the cognition protocol layer, the referee fact tables and
 * the seat's own bounded ledger.
 *
 * A separate constant rather than a bump, because both must remain buildable
 * at once — a run either takes the old path or the new one, and an artifact
 * has to say which without anyone reading the code that produced it.
 */
export const PROMPT_VERSION_COGNITIVE = "prompt-0.3.0";

/**
 * The M5.1 stack: canonical fact ids rendered beside every citable line, the
 * public-action bridge, and the bounded social model.
 *
 * A third constant rather than a bump for the same reason 0.3.0 was: the
 * completed pilot must stay rebuildable, and an artifact has to say which stack
 * produced it without anyone reading the code.
 */
export const PROMPT_VERSION_COGNITIVE_V2 = "prompt-0.3.1";

/**
 * The M5.2 stack: the public claim contest — 派权争夺 — on top of M5.1.
 *
 * A MINOR bump rather than a patch, and a material one: it adds a public act
 * (退水), a new referee-derived table, a new block in the response schema, and
 * a new field in the speech schema. Any of those alone would make two runs
 * incomparable; together they are a different experiment.
 */
export const PROMPT_VERSION_CONTEST = "prompt-0.4.0";

/**
 * The M5.3 stack: private cognition and public communication are separated,
 * and a system-owned disclosure firewall sits between them.
 *
 * A MINOR bump, and the most invasive one so far: under 0.5.0 a seat that
 * speaks answers TWICE. The private strategist picks the action and a bounded
 * `CommunicationIntent`; a public spokesperson — which never receives the role,
 * the pair, the vision, the roster, the Lady result or the ledger — writes the
 * wording. Any of the three earlier stacks produced the public sentence from a
 * prompt that also held the deal-dependent layer, so a 0.4.0 game and a 0.5.0
 * game are not two runs of one experiment.
 *
 * WHY IT EXISTS. The completed 0.4.0 pilot ended with the true Percival saying
 * 「7、9一梅林一莫甘娜」 in public at sequences 45 and 58. That is the private
 * pair, verbatim, and seat 7 was the false-claiming Morgana — so the sentence
 * reduced Merlin to one seat for the Assassin. The action was right and the
 * disclosure was catastrophic, and no amount of "consider not revealing it"
 * in a strategy profile makes that class of failure structurally hard.
 */
export const PROMPT_VERSION_DISCLOSURE = "prompt-0.5.0";

/**
 * The M5.4 stack: the folding repair, plus four gameplay-quality changes.
 *
 * A MINOR bump, and it carries one CORRECTION and four additions. The
 * correction is that `social` and `contest` are actually folded — under 0.5.0
 * they were asked for, answered, and discarded (see `prompts/capabilities.ts`),
 * so a 0.5.0 game and a 0.6.0 game differ in what the agents REMEMBER, not
 * only in what they are asked. That alone makes them incomparable.
 *
 * The four additions: natural-language public speech with no machine evidence
 * ids, the private evil mission-card coordination convention, structured
 * proposal/vote evaluation after a mission result, and a bounded assassination
 * candidate ranking.
 */
export const PROMPT_VERSION_M54 = "prompt-0.6.0";

/**
 * The M5.5 stack: a realism and correctness patch on top of 0.6.0.
 *
 * A MINOR bump, and every one of its five changes alters what the model is
 * asked or what it is allowed to answer, so a 0.6.0 game and a 0.7.0 game are
 * not two runs of one experiment:
 *
 *   OBERON STOPS BEING TOLD A CONVENTION EXISTS. Under 0.6.0 the coordination
 *   FIELD was version-gated while the coordination SECTION was seat-gated, so
 *   Oberon was asked to fill a block whose instruction pointed at a section his
 *   prompt did not contain. His schema, and therefore his prompt, changes.
 *
 *   EVIDENCE REFERENCES ARE VALIDATED. One id per array element, and it has to
 *   exist. The live 0.6.0 game produced eight strings that packed several ids
 *   into one element with full-width delimiters; they were accepted and then
 *   silently failed to resolve.
 *
 *   THE LADY STOPS BEING EVIDENCE AGAINST MERLIN. Two live Assassins in a row
 *   discounted the true Merlin because he had announced a Lady result — an
 *   ALTERNATIVE EXPLANATION treated as a counter-argument. The assassination
 *   block now asks the question in parts, and refuses an assessment whose only
 *   counter-evidence is that the candidate held the Lady.
 *
 *   THE DILUTED PAIR CHANNEL CLOSES. 0.5.0 stopped Percival from saying
 *   「7、9一梅林一莫甘娜」. It did not stop 「1、3、7、9我都看不清」, which is
 *   the same two seats inside a set of four.
 *
 *   A STANDING CLAIM STAYS STANDING. Re-emitting an identical claim with no
 *   new public purpose is now a bounded repair rather than a habit.
 */
export const PROMPT_VERSION_M55 = "prompt-0.7.0";

/** Every version that runs the cognition stack. */
export const COGNITIVE_VERSIONS: readonly string[] = [
  PROMPT_VERSION_COGNITIVE,
  PROMPT_VERSION_COGNITIVE_V2,
  PROMPT_VERSION_CONTEST,
  PROMPT_VERSION_DISCLOSURE,
  PROMPT_VERSION_M54,
  PROMPT_VERSION_M55,
];

/**
 * `separatesStages` USED TO LIVE HERE and was itself the pattern this
 * milestone removes: a boolean derived by comparing the version string against
 * a constant. It is now `capabilitiesFor(v).twoStageSpeech` —
 * see `prompts/capabilities.ts`, which also explains why.
 */

/** Default for a config that has not opted in. */
export const PROMPT_VERSION = PROMPT_VERSION_LEGACY;
