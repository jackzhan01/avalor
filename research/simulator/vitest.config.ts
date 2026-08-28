import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The simulator's own suite.
 *
 * Separate from both existing configs, and for a different reason than
 * `research/vitest.config.ts` is separate. That one is excluded because it
 * needs a dataset nobody has checked in and takes minutes. This one is fast,
 * hermetic and worth running often — it just does not live under `src/`, which
 * is the only thing the root config includes.
 *
 *   npm run test:sim
 *
 * `*.live.test.ts` is excluded here on purpose: anything that would touch a
 * real provider must be opted into explicitly, never picked up by a wildcard.
 * There are no live tests yet; the exclusion exists so that when there are,
 * the default command still costs nothing.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["research/simulator/**/*.test.ts"],
    exclude: ["**/node_modules/**", "research/simulator/**/*.live.test.ts"],
    testTimeout: 120_000,
  },
});
