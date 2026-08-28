/**
 * What each seat is entitled to know at the start of a seeded game.
 *
 * Offline and read-only: it builds one game from the referee and prints the
 * hard-knowledge block per seat. Used to check, after a run, whether a seat's
 * public behaviour was actually consistent with what it could see.
 */
import { loadConfig } from "../config/load";
import { createGame } from "../core/referee";
import { observationFor } from "../core/observation";
import { SEATS } from "../core/types";

const seed = Number(process.argv.slice(2).find((a) => !a.startsWith("-")) ?? 1);
const state = createGame({ seed, config: loadConfig() });
for (const seat of SEATS) {
  const o = observationFor(state, seat);
  console.log(`${seat}号 ${o.role} (${o.side})  ${JSON.stringify(o.knowledge)}`);
}
