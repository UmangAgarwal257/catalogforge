import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
