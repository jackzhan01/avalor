import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Offline analysis scripts, not part of the app: plain Node with
      // `require`, run by hand against a dataset that is not in the repo.
      // Holding them to the app's browser-oriented rules buys nothing.
      "research/**",
    ],
  },
];

export default eslintConfig;
