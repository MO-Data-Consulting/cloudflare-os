import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Vitest isolates files in fork processes. Two workers overlap workerd startup without letting
    // the full repository test run create one workerd fleet per CPU.
    fileParallelism: true,
    maxWorkers: 2,
  },
});
