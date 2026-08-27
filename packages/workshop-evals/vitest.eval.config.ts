import { defineConfig } from "vitest/config";
import { EVAL_TEST_TIMEOUT_MS } from "./src/config.js";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: EVAL_TEST_TIMEOUT_MS,
    hookTimeout: 3 * 60_000,
  },
});
