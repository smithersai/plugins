import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      enabled: true,
      provider: "v8",
      thresholds: {
        statements: 59,
        branches: 36,
        functions: 52,
        lines: 61
      }
    }
  }
})
