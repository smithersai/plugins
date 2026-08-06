import { describe, expect, it } from "vitest"
import * as AdapterError from "../src/AdapterError.ts"

describe("AdapterError", () => {
  const errors: ReadonlyArray<AdapterError.AdapterError> = [
    new AdapterError.SpawnFailed({ message: "spawn" }),
    new AdapterError.QuotaExhausted({ message: "quota" }),
    new AdapterError.SessionLost({ message: "session", discardResumeSession: true }),
    new AdapterError.ConfigInvalid({ message: "config" }),
    new AdapterError.AuthFailed({ message: "auth" }),
    new AdapterError.ProtocolError({ message: "protocol" }),
    new AdapterError.BinaryMissing({ message: "binary" }),
    new AdapterError.Unsupported({ message: "unsupported" }),
    new AdapterError.StructuredOutputFailure({
      message: "structured",
      schemaDigest: "d".repeat(64),
      correctionCount: 1,
      correctionLimit: 1,
      diagnostics: ["$: expected object"]
    })
  ]

  it("defaults every error code from its constructor", () => {
    expect(errors.map((error) => error.code)).toEqual([
      "spawn_failed",
      "quota_exhausted",
      "session_lost",
      "config_invalid",
      "auth_failed",
      "protocol_error",
      "binary_missing",
      "unsupported",
      "structured_output_failed"
    ])
  })

  it("maps every adapter code onto its adapter-prefixed harness code", () => {
    expect(errors.map((error) => AdapterError.toHarnessError(error).code)).toEqual([
      "adapter_spawn_failed",
      "adapter_quota_exhausted",
      "adapter_session_lost",
      "adapter_config_invalid",
      "adapter_auth_failed",
      "adapter_protocol_error",
      "adapter_binary_missing",
      "adapter_unsupported",
      "adapter_structured_output_failed"
    ])
  })

  it("covers every declared adapter error code with a distinct harness code", () => {
    const codes = new Set(errors.map((error) => error.code))
    expect(codes).toEqual(new Set(AdapterError.AdapterErrorCode.literals))
    const harnessCodes = errors.map((error) => AdapterError.toHarnessError(error).code)
    expect(new Set(harnessCodes).size).toBe(harnessCodes.length)
  })

  it("retains the typed adapter failure as the harness error cause", () => {
    const quota = new AdapterError.QuotaExhausted({
      message: "quota exhausted",
      resetAt: 1_750_000_000_000,
      retryAfterSeconds: 45
    })
    const harnessError = AdapterError.toHarnessError(quota)

    expect(harnessError.message).toBe("quota exhausted")
    expect(harnessError.cause).toBe(quota)
    expect((harnessError.cause as AdapterError.QuotaExhausted).resetAt).toBe(1_750_000_000_000)
    expect((harnessError.cause as AdapterError.QuotaExhausted).retryAfterSeconds).toBe(45)
  })

  it("keeps the tagged identity usable for instanceof narrowing", () => {
    const error: AdapterError.AdapterError = new AdapterError.SessionLost({
      message: "unknown session",
      discardResumeSession: true
    })
    expect(error instanceof AdapterError.SessionLost).toBe(true)
    expect(error instanceof AdapterError.QuotaExhausted).toBe(false)
    expect(error._tag).toBe("flows/adapters/SessionLost")
  })
})
