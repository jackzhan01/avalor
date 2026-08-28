/**
 * The public identity of one game — and why it may not be derived from the seed.
 *
 * The earlier version hashed `runId` and the seed together with FNV-1a. Its own
 * comment admitted the digest was brute-forceable, and that admission was the
 * bug: seeds are small integers, so anyone holding a public replay and this
 * source could enumerate the seed space, match the digest, and re-derive the
 * whole deal — before reading the final reveal the public artifact is
 * carefully ordered to withhold. A label that is a function of the secret is
 * not a label, it is the secret with extra steps.
 *
 * So a game id is now OPAQUE and SUPPLIED. It comes from the run boundary,
 * carries no seed-derived material, and is shared verbatim by the public
 * replay and the private trace so the two can be joined without either of them
 * leaking the other's contents.
 *
 * At a CLI it is a cryptographically random UUID. In a test it is whatever the
 * test passes in, because a deterministic id is what makes a replay comparison
 * meaningful — determinism and secrecy are different requirements and only one
 * of them belongs in the generator.
 */

import { randomUUID } from "node:crypto";

/** Opaque, seed-free, shared by both artifacts. */
export type GameId = string;

const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

export class GameIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameIdError";
  }
}

/**
 * A fresh random id. The normal path at a CLI.
 *
 * `randomUUID` is cryptographically random, so there is nothing to enumerate:
 * the id carries no information about the seed, the deal, or anything else
 * about the game.
 */
export function newGameId(): GameId {
  return `g-${randomUUID()}`;
}

/**
 * Accept an id somebody supplied.
 *
 * The shape check is for artifacts and filenames, not for security — a caller
 * determined to pass the seed as the id can do so, and no validator can tell
 * the difference. What stops that is that nothing in this codebase DERIVES an
 * id from a seed any more, plus `artifacts.test.ts`, which fails if changing
 * only the seed moves the id.
 */
export function asGameId(value: unknown): GameId {
  if (typeof value !== "string" || !SHAPE.test(value)) {
    throw new GameIdError(
      `game id must be 3-64 chars of [A-Za-z0-9._:-] starting alphanumeric, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * A stable id for tests and fixtures.
 *
 * Deliberately takes a LABEL rather than a seed. If it took a seed it would be
 * exactly the derivation this module exists to remove, and it would be reached
 * for by the first caller who found passing an id inconvenient.
 */
export function fixedGameId(label: string): GameId {
  return asGameId(`g-fixed-${label}`);
}
