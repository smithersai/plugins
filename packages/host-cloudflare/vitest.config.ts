import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // BrowserBundle bundling can exceed the 5s default under CI load;
    // assertions are unchanged.
    testTimeout: 15000,
    coverage: {
      enabled: true,
      provider: "v8",
      thresholds: {
        statements: 55,
        branches: 34,
        functions: 43,
        lines: 56
      }
    }
  }
})
