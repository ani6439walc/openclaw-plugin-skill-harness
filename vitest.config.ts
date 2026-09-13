import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 15_000,
  },
});
