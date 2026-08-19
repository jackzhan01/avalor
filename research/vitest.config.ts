import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Research harnesses, kept out of `npm test` on purpose.
 *
 * They read the corpus and re-enumerate hundreds of games, so they run in
 * minutes, not milliseconds. Run one with:
 *   npx vitest run --config research/vitest.config.ts <file>
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["research/**/*.test.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
