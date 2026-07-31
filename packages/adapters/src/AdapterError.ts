/**
 * Typed failures reported by CLI adapters.
 *
 * Adapter messages must describe the failure without copying credentials,
 * authorization headers, or raw environment values into the error.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Agent Adapters.md`,
 * `docs/specs/Concepts/Run Ownership.md`, and
 * `docs/specs/Concepts/Structured Output.md`.
 *
 * @since 0.1.0
 */
import * as HarnessError from "@smithers/harness/HarnessError"
import { Effect, Schema } from "effect"

/**
 * Stable public adapter failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export const AdapterErrorCode = Schema.Literals([
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

/**
 * Stable public adapter failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type AdapterErrorCode = typeof AdapterErrorCode.Type

const code = <const Code extends AdapterErrorCode>(value: Code) =>
  Schema.Literal(value).pipe(Schema.withConstructorDefault(Effect.succeed(value)))

/**
 * A CLI process could not be started or completed its launch protocol.
 *
 * @category errors
 * @since 0.1.0
 */
export class SpawnFailed extends Schema.TaggedErrorClass<SpawnFailed>()("flows/adapters/SpawnFailed", {
  code: code("spawn_failed"),
  message: Schema.String
}) {}

/**
 * A provider rejected a request because its usage quota is exhausted.
 *
 * `resetAt` is an epoch-millisecond instant when the provider supplied one.
 *
 * @category errors
 * @since 0.1.0
 */
export class QuotaExhausted extends Schema.TaggedErrorClass<QuotaExhausted>()(
  "flows/adapters/QuotaExhausted",
  {
    code: code("quota_exhausted"),
    message: Schema.String,
    resetAt: Schema.optional(Schema.Number),
    retryAfterSeconds: Schema.optional(Schema.Number)
  }
) {}

/**
 * A persisted CLI conversation cannot be resumed.
 *
 * @category errors
 * @since 0.1.0
 */
export class SessionLost extends Schema.TaggedErrorClass<SessionLost>()("flows/adapters/SessionLost", {
  code: code("session_lost"),
  message: Schema.String,
  discardResumeSession: Schema.Literal(true)
}) {}

/**
 * Adapter configuration is invalid and cannot be retried unchanged.
 *
 * @category errors
 * @since 0.1.0
 */
export class ConfigInvalid extends Schema.TaggedErrorClass<ConfigInvalid>()("flows/adapters/ConfigInvalid", {
  code: code("config_invalid"),
  message: Schema.String
}) {}

/**
 * The CLI could not authenticate with its provider.
 *
 * @category errors
 * @since 0.1.0
 */
export class AuthFailed extends Schema.TaggedErrorClass<AuthFailed>()("flows/adapters/AuthFailed", {
  code: code("auth_failed"),
  message: Schema.String
}) {}

/**
 * The CLI emitted output that violates its adapter protocol.
 *
 * @category errors
 * @since 0.1.0
 */
export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("flows/adapters/ProtocolError", {
  code: code("protocol_error"),
  message: Schema.String
}) {}

/**
 * The requested CLI executable is unavailable.
 *
 * @category errors
 * @since 0.1.0
 */
export class BinaryMissing extends Schema.TaggedErrorClass<BinaryMissing>()("flows/adapters/BinaryMissing", {
  code: code("binary_missing"),
  message: Schema.String
}) {}

/**
 * The requested operation is not supported by this adapter.
 *
 * @category errors
 * @since 0.1.0
 */
export class Unsupported extends Schema.TaggedErrorClass<Unsupported>()("flows/adapters/Unsupported", {
  code: code("unsupported"),
  message: Schema.String
}) {}

/**
 * A CLI response exhausted its declared structured-output correction budget.
 *
 * @category errors
 * @since 0.1.0
 */
export class StructuredOutputFailure
  extends Schema.TaggedErrorClass<StructuredOutputFailure>()(
    "flows/adapters/StructuredOutputFailure",
    {
      code: code("structured_output_failed"),
      message: Schema.String,
      schemaDigest: Schema.String,
      correctionCount: Schema.Int,
      correctionLimit: Schema.Int,
      candidateDigest: Schema.optional(Schema.String),
      diagnostics: Schema.Array(Schema.String)
    }
  )
{}

/**
 * Every typed failure a CLI adapter may return.
 *
 * @category errors
 * @since 0.1.0
 */
export type AdapterError =
  | SpawnFailed
  | QuotaExhausted
  | SessionLost
  | ConfigInvalid
  | AuthFailed
  | ProtocolError
  | BinaryMissing
  | Unsupported
  | StructuredOutputFailure

/**
 * Converts an adapter failure at the harness boundary while retaining the
 * typed adapter failure as its cause.
 *
 * @category constructors
 * @since 0.1.0
 */
export const toHarnessError = (error: AdapterError): HarnessError.HarnessError =>
  new HarnessError.HarnessError({
    code: harnessCode(error.code),
    message: error.message,
    cause: error
  })

const harnessCode = (errorCode: AdapterErrorCode): HarnessError.HarnessErrorCode => {
  switch (errorCode) {
    case "spawn_failed":
      return "adapter_spawn_failed"
    case "quota_exhausted":
      return "adapter_quota_exhausted"
    case "session_lost":
      return "adapter_session_lost"
    case "config_invalid":
      return "adapter_config_invalid"
    case "auth_failed":
      return "adapter_auth_failed"
    case "protocol_error":
      return "adapter_protocol_error"
    case "binary_missing":
      return "adapter_binary_missing"
    case "unsupported":
      return "adapter_unsupported"
    case "structured_output_failed":
      return "adapter_structured_output_failed"
  }
}
