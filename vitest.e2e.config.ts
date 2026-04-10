import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/** E2E hits a shared DB — run test files sequentially to avoid cross-suite collisions. */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/e2e/**/*.test.ts"],
      setupFiles: ["tests/e2e/setup.ts"],
      fileParallelism: false,
      maxConcurrency: 1,
      // AI tests may call Gemini (up to 60s); allow 90s per test so the suite
      // doesn't time out when running under load alongside other test files.
      testTimeout: 90_000,
      hookTimeout: 30_000,
    },
  }),
);
