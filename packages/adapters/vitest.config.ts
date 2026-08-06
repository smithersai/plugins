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
      // Raised to the measured floor of the hardened suite (98.83 / 95.51 /
      // 98.39 / 99.42), less a small margin. Raise these again rather than
      // lowering them when coverage improves.
      thresholds: {
        statements: 98,
        branches: 95,
        functions: 98,
        lines: 99
      }
    }
  }
})
