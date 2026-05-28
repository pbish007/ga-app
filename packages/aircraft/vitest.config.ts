import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // DB-backed suites spin up a fresh PGlite and replay all migrations per
    // test/hook; under `pnpm -r --parallel` on a 2-core CI runner that setup
    // slips past vitest's 5s/10s defaults and flakes (PMB-63).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
