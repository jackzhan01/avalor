/**
 * Every catalog fingerprint, printed.
 *
 * Two of these are recorded in shipped artifacts of Experiments 2 and 3, and a
 * third in the completed M5 pilot's manifest. A change to any of them means an
 * artifact now describes a profile that no longer exists — so this exists to be
 * diffed by eye after a change to `strategies.ts`, and `strategies.test.ts`
 * pins the frozen two.
 */
import { CATALOG_IDS, strategyById, strategyFingerprint } from "../prompts/strategies";

for (const id of CATALOG_IDS) {
  console.log(`${id.padEnd(18)} ${strategyFingerprint(strategyById(id))}`);
}
