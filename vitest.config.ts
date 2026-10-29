import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // `pnpm test:db` (--mode db) also runs the tests that talk to the Neon dev branch.
    env: mode === "db" ? { DB_TESTS: "1" } : {},
    // Neon round trips are ~0.5 s each; a DB test makes a dozen.
    testTimeout: mode === "db" ? 60_000 : 5_000,
  },
}));
