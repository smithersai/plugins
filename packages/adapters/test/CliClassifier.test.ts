import { describe, expect, it } from "vitest"
import * as AdapterError from "../src/AdapterError.ts"
import {
  classify,
  classifyCliOutput,
  classifyTermination,
  claudeCodePatterns,
  codexPatterns,
  defaultPatterns,
  isBenignStderr,
  type Patterns
} from "../src/CliClassifier.ts"

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

  describe("silent-failure guards", () => {
    it("never reports a non-zero exit with no diagnostics as a success", () => {
      for (
        const input of [
          { exitCode: 1 },
          { exitCode: 1, stderr: "" },
          { exitCode: 137, stderr: "\n  \n" },
          { exitCode: 3, records: [] }
        ]
      ) {
        const result = classify(input)
        expect(result?._tag, `exit ${input.exitCode} must not be silently dropped`).toBe(
          "flows/adapters/ProtocolError"
        )
        expect(result?.message).toBe(`CLI exited with code ${input.exitCode}`)
      }
    })

    it("surfaces a failure reported only in stdout records with empty stderr", () => {
      const result = classify({
        exitCode: 1,
        stderr: "",
        records: [{ type: "error", message: "the CLI aborted the turn" }]
      })
      expect(result?._tag).toBe("flows/adapters/ProtocolError")
      expect(result?.message).toContain("the CLI aborted the turn")
    })

    it("still suppresses a genuine benign-only notice", () => {
      expect(classify({ exitCode: 1, stderr: "Update available: 1.2.3\nchecking for updates" })).toBeUndefined()
      expect(classify({ exitCode: 0, stderr: "Telemetry is disabled" })).toBeUndefined()
    })

    it("reports no failure for a success with no diagnostics", () => {
      expect(classify({ exitCode: 0 })).toBeUndefined()
      expect(classify({ exitCode: 0, stderr: "", records: [] })).toBeUndefined()
    })

    it("reports no failure when the process never produced an exit code", () => {
      // A missing exit status is the caller's protocol failure to report, not a
      // classification: CliHarness fails the attempt before classifying.
      expect(classify({ exitCode: null, stderr: "segmentation fault" })).toBeUndefined()
      expect(classify({ exitCode: undefined, stderr: "segmentation fault" })).toBeUndefined()
    })
  })

  describe("quota gating on a successful exit", () => {
    it("does not treat loose quota prose on a clean exit as quota exhaustion", () => {
      expect(classify({ exitCode: 0, stderr: "quota exceeded" })).toBeUndefined()
      expect(classify({ exitCode: 0, stderr: "too many requests" })).toBeUndefined()
      expect(
        classify({ exitCode: 0, records: [{ type: "assistant", text: "usage limit exceeded is the error" }] })
      ).toBeUndefined()
    })

    it("applies the broad quota patterns once a record marks the turn as failed", () => {
      for (
        const record of [
          { is_error: true, message: "quota exceeded" },
          { type: "error", message: "quota exceeded" },
          { type: "turn.failed", message: "quota exceeded" },
          { subtype: "error_max_turns", message: "quota exceeded" },
          { status: "rejected", message: "quota exceeded" },
          { type: "closed", outcome: "aborted", message: "quota exceeded" }
        ]
      ) {
        expect(classify({ exitCode: 0, records: [record] })?._tag, JSON.stringify(record)).toBe(
          "flows/adapters/QuotaExhausted"
        )
      }
    })

    it("treats a resolved closed record as a non-failure", () => {
      expect(
        classify({ exitCode: 0, records: [{ type: "closed", outcome: "resolved", message: "quota exceeded" }] })
      ).toBeUndefined()
    })

    it("matches the anchored session-limit notices vendors print on a clean exit", () => {
      const anchored = [
        "You've hit your session limit · resets 3pm (America/Los_Angeles).",
        "You're out of usage credits. Run /usage-credits to keep using Claude",
        "Claude usage limit reached. Your limit will reset at 9:30pm (PT)."
      ]
      for (const stderr of anchored) {
        expect(classify({ exitCode: 0, stderr })?._tag, stderr).toBe("flows/adapters/QuotaExhausted")
      }
    })
  })

  describe("quota reset metadata", () => {
    const now = 1_750_000_000_000

    it("reads a JSON retryAfter field", () => {
      expect(classify({ exitCode: 1, stderr: "{\"error\":\"quota exceeded\",\"retryAfter\":30}", now })).toMatchObject({
        retryAfterSeconds: 30,
        resetAt: now + 30_000
      })
    })

    it("expands a unix-second resetAt into epoch milliseconds", () => {
      expect(classify({ exitCode: 1, stderr: "quota exceeded resetAt=1750000000", now })).toMatchObject({
        resetAt: 1_750_000_000_000
      })
    })

    it("keeps a unix-millisecond resetAt unchanged", () => {
      expect(classify({ exitCode: 1, stderr: "quota exceeded reset_at: 1750000000123", now })).toMatchObject({
        resetAt: 1_750_000_000_123
      })
    })

    it("accepts a clock function for the current instant", () => {
      expect(
        classify({ exitCode: 1, stderr: "rate limit exceeded; retry-after: 10", now: () => 5_000 })
      ).toMatchObject({ retryAfterSeconds: 10, resetAt: 15_000 })
    })

    it("keeps the typed quota failure when the reset time zone cannot be resolved", () => {
      const result = classify({ exitCode: 1, stderr: "quota exceeded; resets at 3pm (Not/AZone)", now })
      expect(result?._tag).toBe("flows/adapters/QuotaExhausted")
      expect((result as AdapterError.QuotaExhausted).resetAt).toBeUndefined()
    })

    it("resolves a named zone alias to a future instant", () => {
      const result = classify({ exitCode: 1, stderr: "quota exceeded; resets at 3:30pm EST", now })
      expect((result as AdapterError.QuotaExhausted).resetAt).toBeGreaterThan(now)
    })

    it("ignores an absolute reset instant already in the past", () => {
      const result = classify({ exitCode: 1, stderr: "quota exceeded; try again at 2020-01-01T00:00:00Z", now })
      expect(result?._tag).toBe("flows/adapters/QuotaExhausted")
      expect((result as AdapterError.QuotaExhausted).resetAt).toBeUndefined()
    })
  })

  describe("diagnostic normalization", () => {
    it("strips ANSI escapes from the retained message", () => {
      const escape = String.fromCharCode(27)
      const result = classify({ exitCode: 1, stderr: `${escape}[31mquota exceeded${escape}[0m` })
      expect(result?.message).toBe("quota exceeded")
    })

    it("drops records which cannot be serialized without losing the rest", () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const result = classify({ exitCode: 1, stderr: "unknown option --wat", records: [circular] })
      expect(result?._tag).toBe("flows/adapters/ConfigInvalid")
      expect(result?.message).toBe("unknown option --wat")
    })

    it("redacts bearer tokens and secret-shaped assignments in every classification", () => {
      const result = classify({
        exitCode: 1,
        stderr: "unknown option --wat\nAuthorization: Bearer abc.def-ghi\npassword=hunter2"
      })
      expect(result?._tag).toBe("flows/adapters/ConfigInvalid")
      expect(result?.message).not.toContain("abc.def-ghi")
      expect(result?.message).not.toContain("hunter2")
      expect(result?.message).toContain("<redacted>")
    })

    it("redacts a bearer credential in a bare authorization header", () => {
      const result = classify({ exitCode: 1, stderr: "401 unauthorized\nBearer abc.def-ghi" })
      expect(result?._tag).toBe("flows/adapters/AuthFailed")
      expect(result?.message).not.toContain("abc.def-ghi")
      expect(result?.message).toContain("Bearer <redacted>")
    })

    it("redacts a credential in a JSON diagnostic record", () => {
      const result = classify({
        exitCode: 1,
        stderr: "unknown option --wat",
        records: [{ headers: { authorization: "Bearer abc.def-ghi" }, api_key: "sk-abcdefghijkl0123" }]
      })
      expect(result?.message).not.toContain("abc.def-ghi")
      expect(result?.message).not.toContain("sk-abcdefghijkl0123")
    })
  })

  describe("pattern selection", () => {
    it("classifies through adapter-supplied patterns instead of the defaults", () => {
      const patterns: Patterns = {
        quota: [/\bvendor budget drained\b/i],
        sessionLost: [],
        auth: [],
        config: [],
        benign: []
      }
      expect(classify({ exitCode: 1, stderr: "vendor budget drained", patterns })?._tag).toBe(
        "flows/adapters/QuotaExhausted"
      )
      // The default quota vocabulary is not consulted once patterns are supplied.
      expect(classify({ exitCode: 1, stderr: "quota exceeded", patterns })?._tag).toBe(
        "flows/adapters/ProtocolError"
      )
    })

    it("falls back to the broad quota list when an adapter declares no success-only patterns", () => {
      const patterns: Patterns = {
        quota: [/\bvendor budget drained\b/i],
        sessionLost: [],
        auth: [],
        config: [],
        benign: []
      }
      expect(classify({ exitCode: 0, stderr: "vendor budget drained", patterns })).toBeUndefined()
    })

    it("ships the same default pattern set to both bundled CLI adapters", () => {
      expect(claudeCodePatterns).toBe(defaultPatterns)
      expect(codexPatterns).toBe(defaultPatterns)
    })

    it("resets sticky global regular expressions between classifications", () => {
      const patterns: Patterns = {
        quota: [/quota exceeded/gi],
        sessionLost: [],
        auth: [],
        config: [],
        benign: []
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(classify({ exitCode: 1, stderr: "quota exceeded", patterns })?._tag, `attempt ${attempt}`).toBe(
          "flows/adapters/QuotaExhausted"
        )
      }
    })
  })

  describe("call shapes", () => {
    it("accepts the positional overload", () => {
      expect(classify(1, "invalid api key")?._tag).toBe("flows/adapters/AuthFailed")
      expect(classify(1, "", [{ type: "error", message: "unknown session id" }])?._tag).toBe(
        "flows/adapters/SessionLost"
      )
      expect(classify(0)).toBeUndefined()
    })

    it("exposes the same classifier under both documented aliases", () => {
      expect(classifyCliOutput).toBe(classify)
      expect(classifyTermination).toBe(classify)
      expect(classifyTermination({ exitCode: 1, stderr: "login required" })?._tag).toBe("flows/adapters/AuthFailed")
    })
  })

  describe("isBenignStderr", () => {
    it("reports empty stderr as benign and mixed stderr as not benign", () => {
      expect(isBenignStderr("")).toBe(true)
      expect(isBenignStderr("   \n \n")).toBe(true)
      expect(isBenignStderr("Update available: 1.2.3\nreal failure")).toBe(false)
    })

    it("honors adapter-supplied benign patterns", () => {
      const patterns: Patterns = {
        ...defaultPatterns,
        benign: [/^harmless vendor chatter$/i]
      }
      expect(isBenignStderr("harmless vendor chatter", patterns)).toBe(true)
      expect(isBenignStderr("Update available: 1.2.3", patterns)).toBe(false)
    })
  })

  /**
   * Regression guard. A billing-exhaustion diagnostic used to fall through
   * every quota pattern and land on ProtocolError, which drops the suspended
   * outcome and the reset metadata and presents a spend problem as an opaque
   * adapter fault. A real run lost hours to that misreading.
   */
  describe("billing exhaustion is quota, not a protocol fault", () => {
    const wordings = [
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      "You exceeded your current quota, please check your plan and billing details.",
      "insufficient_quota",
      "insufficient quota",
      "Insufficient credits remaining on this account."
    ]

    it("classifies every provider billing wording as quota exhaustion", () => {
      for (const stderr of wordings) {
        for (const patterns of [defaultPatterns, claudeCodePatterns, codexPatterns]) {
          const error = classify({ exitCode: 1, stderr, patterns })
          expect(error, stderr).toBeInstanceOf(AdapterError.QuotaExhausted)
        }
      }
    })

    it("suspends on a clean exit that printed only the credit-balance notice", () => {
      const error = classify({
        exitCode: 0,
        stderr: "Your credit balance is too low to access the Anthropic API.",
        patterns: defaultPatterns
      })
      expect(error).toBeInstanceOf(AdapterError.QuotaExhausted)
    })

    it("does not fire on a successful run whose prose merely mentions credits", () => {
      // The exit-0 ladder uses the anchored success-only list, so an assistant
      // discussing billing must not be mistaken for a billing failure.
      expect(classify({
        exitCode: 0,
        stderr: "",
        records: [{
          type: "settled",
          assistantText: "I checked the billing page; your credit balance is too low is the error users report."
        }],
        patterns: defaultPatterns
      })).toBeUndefined()
    })
  })

  describe("reset-time parsing edge cases", () => {
    const now = Date.UTC(2026, 7, 6, 12, 0, 0)

    it("keeps the quota failure when a wall-clock reset can never occur", () => {
      // Minute 99 matches the pattern but no instant in the eight-day search
      // window has it, so the scan must give up rather than loop or throw.
      const error = classify({
        exitCode: 1,
        stderr: "Rate limit exceeded. Resets 3:99pm (UTC).",
        patterns: defaultPatterns,
        now
      })
      expect(error).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect((error as AdapterError.QuotaExhausted).resetAt).toBeUndefined()
    })

    it("prefers the first retry-after spelling and ignores a later JSON duplicate", () => {
      const error = classify({
        exitCode: 1,
        stderr: "quota exceeded: retry-after 30 seconds. {\"retry_after\": 900}",
        patterns: defaultPatterns,
        now
      })
      expect(error).toMatchObject({ retryAfterSeconds: 30, resetAt: now + 30_000 })
    })

    it("ignores a negative or non-finite retry-after instead of moving the reset backwards", () => {
      const error = classify({
        exitCode: 1,
        stderr: "quota exceeded: retry_after: -5",
        patterns: defaultPatterns,
        now
      })
      expect(error).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect((error as AdapterError.QuotaExhausted).resetAt).toBeUndefined()
    })

    it("resolves each documented zone abbreviation to a future instant", () => {
      for (const zone of ["ET", "PT", "CT", "MT", "UTC", "GMT"]) {
        const error = classify({
          exitCode: 1,
          stderr: `Usage limit exceeded. Resets 9:30am ${zone}.`,
          patterns: defaultPatterns,
          now
        })
        const resetAt = (error as AdapterError.QuotaExhausted).resetAt
        expect(resetAt, zone).toBeGreaterThan(now)
        expect(resetAt, zone).toBeLessThanOrEqual(now + 8 * 86_400_000)
      }
    })

    it("defaults a bare hour with no minutes to the top of the hour", () => {
      const error = classify({
        exitCode: 1,
        stderr: "Usage limit exceeded. Resets 5pm (UTC).",
        patterns: defaultPatterns,
        now
      })
      const resetAt = (error as AdapterError.QuotaExhausted).resetAt
      expect(resetAt).toBeDefined()
      expect(new Date(resetAt!).getUTCHours()).toBe(17)
      expect(new Date(resetAt!).getUTCMinutes()).toBe(0)
    })

    it("maps a 12am reset onto hour zero rather than hour twelve", () => {
      const error = classify({
        exitCode: 1,
        stderr: "Usage limit exceeded. Resets 12am (UTC).",
        patterns: defaultPatterns,
        now
      })
      expect(new Date((error as AdapterError.QuotaExhausted).resetAt!).getUTCHours()).toBe(0)
    })
  })

  /**
   * On a zero exit the failure-record scan is what selects between the broad
   * quota list and the anchored success-only list, so a marker's effect is
   * observable as loose quota prose being honored rather than ignored.
   */
  describe("failure-record detection", () => {
    const stderr = "The request hit your usage limit."
    const gated = (record: unknown) => classify({ exitCode: 0, stderr, records: [record], patterns: defaultPatterns })

    it("ignores records which are not objects", () => {
      for (const record of ["error", 42, null, undefined, true]) {
        expect(gated(record), String(record)).toBeUndefined()
      }
    })

    it("treats each documented failure marker as a semantic failure", () => {
      expect(gated({ is_error: true })).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect(gated({ type: "error" })).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect(gated({ type: "turn.failed" })).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect(gated({ subtype: "error_during_execution" })).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect(gated({ status: "rejected" })).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect(gated({ type: "closed", outcome: "aborted" })).toBeInstanceOf(AdapterError.QuotaExhausted)
      // Case is normalized before comparison.
      expect(gated({ type: "ERROR" })).toBeInstanceOf(AdapterError.QuotaExhausted)
      expect(gated({ type: "Turn.Failed" })).toBeInstanceOf(AdapterError.QuotaExhausted)
    })

    it("does not treat a benign record as a failure", () => {
      expect(gated({ type: "closed", outcome: "resolved" })).toBeUndefined()
      expect(gated({ type: "delta", text: "working" })).toBeUndefined()
      expect(gated({ is_error: false })).toBeUndefined()
      // Non-string discriminators cannot match any marker.
      expect(gated({ type: 7 })).toBeUndefined()
      expect(gated({ status: 7 })).toBeUndefined()
      expect(gated({})).toBeUndefined()
    })

    it("surfaces a marked failure on a non-zero exit even with no stderr", () => {
      expect(classify({ exitCode: 1, stderr: "", records: [{ type: "error" }], patterns: defaultPatterns }))
        .toBeInstanceOf(AdapterError.ProtocolError)
    })
  })
})
