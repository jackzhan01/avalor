import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Separate config so the research suite never runs in CI.
 *
 * These tests need a dataset that is not in the repo (see README), take
 * minutes rather than seconds, and validate the model rather than the code.
 * Mixing them into `npm test` would make the fast suite slow and make CI
 * depend on a third-party download.
 *
 *   npx vitest run --config research/vitest.config.ts
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["research/**/*.test.ts"],
    root: fileURLToPath(new URL("..", import.meta.url)),
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
