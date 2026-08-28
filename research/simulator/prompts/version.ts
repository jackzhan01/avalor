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

/** Every version that runs the cognition stack. */
export const COGNITIVE_VERSIONS: readonly string[] = [
  PROMPT_VERSION_COGNITIVE,
  PROMPT_VERSION_COGNITIVE_V2,
  PROMPT_VERSION_CONTEST,
];

/** Default for a config that has not opted in. */
export const PROMPT_VERSION = PROMPT_VERSION_LEGACY;
