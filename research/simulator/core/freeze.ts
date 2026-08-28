/**
 * Runtime immutability, because `readonly` is not one.
 *
 * TypeScript's `readonly` disappears at compile time. An agent — or, later, a
 * repair loop patching a malformed model output — holding an observation can
 * cast it away in one line and push onto the array it was handed. If that
 * array is the referee's own public log, the game changes and nothing reports
 * it. So the boundary is enforced with `Object.freeze`, which fails loudly in
 * strict mode (every ES module here is strict, so a write throws rather than
 * silently doing nothing).
 *
 * The rule the whole simulator keeps, and the reason this is cheap:
 *
 *     EVERY ARRAY AND OBJECT REACHABLE FROM GameState IS FROZEN, AND GROWS BY
 *     REPLACEMENT RATHER THAN MUTATION.
 *
 * Appending an event builds a new frozen array and assigns it to the field.
 * That is O(n) per append, which for a game of roughly a hundred and fifty
 * events is nothing, and it buys two things at once: an observation can hand
 * out the log BY REFERENCE with no copy, and a retained observation can never
 * gain a future event, because the array it points at is never touched again.
 *
 * `deepFreeze` short-circuits on anything already frozen. That is what keeps
 * freezing an observation O(small) instead of O(history) — the log and its
 * events were frozen when they were created, so the walk stops at the edge.
 * It also makes the function safe on cyclic structures, though nothing here
 * has one.
 */

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  // Already sealed by construction, and by the rule above everything under it
  // is too. Stopping here is both the cycle guard and the fast path.
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** A frozen array with one more element. The append used everywhere. */
export function frozenAppend<T>(list: readonly T[], item: T): readonly T[] {
  return Object.freeze([...list, deepFreeze(item)]);
}

/** A frozen copy, deeply. For arrays built fresh at a call site. */
export function frozenList<T>(items: readonly T[]): readonly T[] {
  return deepFreeze([...items]) as readonly T[];
}

export const EMPTY: readonly never[] = Object.freeze([]);

/**
 * Did an attempted write actually fail?
 *
 * Used by the adversarial tests: a frozen write throws in strict mode, but the
 * assertion worth making is not "it threw" — it is "the authoritative state is
 * unchanged either way". This runs the attempt and swallows the throw so the
 * test can assert the second thing.
 */
export function attemptMutation(mutate: () => void): "threw" | "silent" {
  try {
    mutate();
    return "silent";
  } catch {
    return "threw";
  }
}
