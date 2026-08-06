import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // CliHarness-driven suites spawn real adapter processes and can exceed the
    // 5s default under CI load; assertions are unchanged.
    testTimeout: 15000,
    coverage: {
      enabled: true,
      provider: "v8",
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 78,
        lines: 84
      }
    }
  }
})
