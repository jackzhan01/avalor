import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Selectors are pure functions — no DOM, no React renderer needed.
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
