import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["eval.test.ts"],
    testTimeout: 15_000,
  },
});
