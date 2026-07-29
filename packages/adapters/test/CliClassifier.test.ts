import { describe, expect, it } from "vitest"
import * as AdapterError from "../src/AdapterError.ts"
import { classify, isBenignStderr } from "../src/CliClassifier.ts"

describe("CliClassifier", () => {
  const now = 1_750_000_000_000

  it("classifies all quota forms and extracts retry metadata", () => {
    const absolute = classify({ exitCode: 1, stderr: "quota exceeded; try again at 2026-06-18T09:54:00Z", now })
    expect(absolute?._tag).toBe("flows/adapters/QuotaExhausted")
    expect(absolute).toMatchObject({ resetAt: Date.parse("2026-06-18T09:54:00Z") })

    const zoned = classify({ exitCode: 1, stderr: "You've hit your session limit; resets at 3pm PT", now })
    expect(zoned?._tag).toBe("flows/adapters/QuotaExhausted")
    expect((zoned as AdapterError.QuotaExhausted).resetAt).toBeGreaterThan(now)

    const retry = classify({ exitCode: 429, stderr: "rate limit exceeded; retry-after: 45", now })
    expect(retry).toMatchObject({ _tag: "flows/adapters/QuotaExhausted", retryAfterSeconds: 45, resetAt: now + 45_000 })

    const machine = classify({ exitCode: 1, records: [{ type: "rate_limit_event", status: "rejected" }] })
    expect(machine?._tag).toBe("flows/adapters/QuotaExhausted")
  })

  it("poisons an invalid resume session", () => {
    const result = classify({ exitCode: 1, stderr: "unknown session id: abc123" })
    expect(result).toMatchObject({ _tag: "flows/adapters/SessionLost", discardResumeSession: true })
  })

  it("uses semantic precedence over mixed diagnostics", () => {
    const quota = classify({ exitCode: 1, stderr: "update available\ninvalid api key\nquota exceeded" })
    expect(quota?._tag).toBe("flows/adapters/QuotaExhausted")
    const auth = classify({ exitCode: 1, stderr: "telemetry notice\ninvalid api key\nunknown option" })
    expect(auth?._tag).toBe("flows/adapters/AuthFailed")
    const config = classify({ exitCode: 1, stderr: "update available\nunknown option --wat" })
    expect(config?._tag).toBe("flows/adapters/ConfigInvalid")
  })

  it("filters benign notices and reports unknown failures", () => {
    expect(isBenignStderr("Update available: 1.2.3\nTelemetry is disabled")).toBe(true)
    expect(classify({ exitCode: 0, stderr: "Update available: 1.2.3" })).toBeUndefined()
    expect(classify({ exitCode: 1, stderr: "unexpected wire framing failure" })?._tag).toBe(
      "flows/adapters/ProtocolError"
    )
  })

  it("does not classify successful assistant prose as quota exhaustion", () => {
    expect(
      classify({
        exitCode: 0,
        records: [{ type: "result", answer: "I fixed the quota exceeded diagnostic." }]
      })
    ).toBeUndefined()
    expect(
      classify({
        exitCode: 0,
        stderr: "You've hit your session limit · resets 3pm (America/Los_Angeles)."
      })?._tag
    ).toBe("flows/adapters/QuotaExhausted")
  })

  it("does not classify successful assistant prose as another failure", () => {
    expect(
      classify({
        exitCode: 0,
        records: [{
          type: "assistant",
          text: "Explain the unknown session, invalid API key, and invalid option errors."
        }]
      })
    ).toBeUndefined()
  })

  it("redacts credential-shaped values from typed errors", () => {
    const result = classify({
      exitCode: 1,
      stderr: "401 Unauthorized: api_key=sk-secretvalue123456"
    })
    expect(result?._tag).toBe("flows/adapters/AuthFailed")
    expect(result?.message).not.toContain("sk-secretvalue123456")
    expect(result?.message).toContain("<redacted>")
  })

  it("classifies a semantic failure at the retained diagnostic tail", () => {
    const result = classify({
      exitCode: 1,
      stderr: `${"verbose output\n".repeat(1_000)}unknown session id: lost`
    })
    expect(result).toMatchObject({
      _tag: "flows/adapters/SessionLost",
      discardResumeSession: true
    })
    expect(new TextEncoder().encode(result?.message).byteLength).toBeLessThanOrEqual(4096)
    expect(result?.message).toContain("unknown session id")
  })
})
