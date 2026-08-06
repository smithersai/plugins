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
      // Raised to the measured floor of the hardened suite (92.20 / 79.77 /
      // 95.19 / 94.94), less a small margin. Raise these again rather than
      // lowering them when coverage improves.
      thresholds: {
        statements: 91,
        branches: 78,
        functions: 94,
        lines: 93
      }
    }
  }
})
