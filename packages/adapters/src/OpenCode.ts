/**
 * Declarative OpenCode CLI adapter.
 *
 * Wire schema derived from the OpenCode source (read-only reference clone):
 * - `reference/opencode/packages/opencode/src/cli/cmd/run.ts` — `opencode run
 *   --format json` prints one NDJSON line per event:
 *   `{ type, timestamp, sessionID, part | error }` with line types `tool_use`,
 *   `step_start`, `step_finish`, `text`, `reasoning`, and `error`; a piped
 *   stdin prompt is supported (`Bun.stdin.text()` when not a TTY) and
 *   `--session <id>` resumes a prior session.
 * - `reference/opencode/packages/schema/src/v1/session.ts` — the `Part` union
 *   embedded in those lines: `TextPart`, `ReasoningPart`, `ToolPart` (with the
 *   `ToolState` discriminator `status`: pending/running/completed/error), and
 *   `StepFinishPart` (token usage under `tokens.cache.{read,write}`).
 *
 * Edit-tool diffs surface in `ToolStateCompleted.metadata.diff` (unified diff)
 * and `title` (repo-relative path) per `reference/opencode/packages/opencode/src/tool/edit.ts`;
 * the result output JSON preserves both so the UI can render diff hunks.
 *
 * @since 0.1.0
 */
import { Effect } from "effect"
import * as AdapterError from "./AdapterError.ts"
import * as CliClassifier from "./CliClassifier.ts"
import type * as CliHarness from "./CliHarness.ts"
import type { CliRecord } from "./CliOutput.ts"
import type { CommandSpec, Options, ResumeState } from "./CommandSpec.ts"
import { HarnessCapabilities } from "./HarnessCapabilities.ts"

const capabilities = new HarnessCapabilities({
  name: "opencode",
  version: "1",
  resume: "flag",
  mcpBootstrap: "project-config",
  skillsInstall: "plugin-dir",
  configDirIsolation: false,
  nativeStructuredOutput: false,
  steer: false,
  images: false,
  usage: true
})

const patterns: CliClassifier.Patterns = {
  quota: [
    ...CliClassifier.defaultPatterns.quota,
    /\b(?:rate.?limit|quota)\b[\s\S]{0,120}\b(?:exceeded|reached|exhausted)\b/i
  ],
  quotaOnSuccess: [...(CliClassifier.defaultPatterns.quotaOnSuccess ?? [])],
  sessionLost: [
    ...CliClassifier.defaultPatterns.sessionLost,
    /\bsession\b[\s\S]{0,80}\bnot found\b/i
  ],
  auth: [
    ...CliClassifier.defaultPatterns.auth,
    /\bProviderAuthError\b/i,
    /\b(?:invalid|missing|expired)\b[\s\S]{0,60}\bapi[\s_-]?key\b/i
  ],
  config: [
    ...CliClassifier.defaultPatterns.config,
    /\binvalid\b[\s\S]{0,60}\bopencode\.json\b/i
  ],
  benign: [...CliClassifier.defaultPatterns.benign]
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (isRecord(value)) return value
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const asNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

const encode = (value: unknown): string => JSON.stringify(value ?? {})

const buildCommand = (options: Options, resume?: ResumeState): CommandSpec => {
  const args: Array<string> = ["run", "--format", "json"]
  if (options.model !== undefined) args.push("--model", options.model)
  args.push(...(options.extraArgs ?? []))
  if (resume !== undefined) args.push("--session", resume.sessionId)
  return {
    command: "opencode",
    args,
    cleanup: [],
    env: {}
  }
}

const toolUseRecord = (part: Readonly<Record<string, unknown>>): CliRecord | null => {
  const state = asRecord(part.state)
  if (state === undefined) return null
  const tool = asString(part.tool)
  if (tool === undefined) return null
  const callId = asString(part.callID)
  const status = asString(state.status)
  const args = encode(state.input)
  if (status === "completed") {
    return {
      type: "toolResult",
      name: tool,
      ...(callId === undefined ? {} : { id: callId }),
      arguments: args,
      status: "completed",
      output: JSON.stringify({
        title: asString(state.title) ?? "",
        output: asString(state.output) ?? "",
        metadata: state.metadata ?? {}
      })
    }
  }
  if (status === "error") {
    return {
      type: "toolResult",
      name: tool,
      ...(callId === undefined ? {} : { id: callId }),
      arguments: args,
      status: "error",
      output: asString(state.error) ?? "OpenCode tool call failed"
    }
  }
  return {
    type: "delta",
    toolCall: {
      name: tool,
      ...(callId === undefined ? {} : { id: callId }),
      arguments: args
    }
  }
}

const stepFinishUsage = (part: Readonly<Record<string, unknown>>): CliRecord | null => {
  const tokens = asRecord(part.tokens)
  if (tokens === undefined) return null
  const cache = asRecord(tokens.cache)
  return {
    type: "usage",
    ...(asNumber(tokens.input) === undefined ? {} : { input_tokens: asNumber(tokens.input) }),
    ...(asNumber(tokens.output) === undefined ? {} : { output_tokens: asNumber(tokens.output) }),
    ...(asNumber(tokens.reasoning) === undefined ? {} : { reasoning_tokens: asNumber(tokens.reasoning) }),
    ...(cache === undefined || asNumber(cache.read) === undefined ? {} : { cachedInputTokens: asNumber(cache.read) }),
    ...(cache === undefined || asNumber(cache.write) === undefined ? {} : { cacheWriteTokens: asNumber(cache.write) })
  }
}

const interpret = (jsonLine: unknown): CliRecord | null => {
  const payload = asRecord(jsonLine)
  if (payload === undefined) return null
  const type = asString(payload.type)
  const sessionId = asString(payload.sessionID)
  if (type === "step_start") {
    return {
      type: "turnOpened",
      seat: "opencode",
      ...(sessionId === undefined ? {} : { sessionId })
    }
  }
  if (type === "text") {
    // `opencode run --format json` only prints a text line once the part has
    // `time.end` set (run.ts), so each line is a complete assistant block and
    // the last one is the semantic answer.
    const part = asRecord(payload.part)
    const text = asString(part?.text)
    if (text === undefined || text.length === 0) return null
    return {
      type: "settled",
      assistantText: text,
      ...(asString(part?.id) === undefined ? {} : { responseId: asString(part?.id) })
    }
  }
  if (type === "reasoning") {
    const thinking = asString(asRecord(payload.part)?.text)
    return thinking === undefined || thinking.length === 0 ? null : { type: "delta", thinking }
  }
  if (type === "tool_use") {
    const part = asRecord(payload.part)
    return part === undefined ? null : toolUseRecord(part)
  }
  if (type === "step_finish") {
    const part = asRecord(payload.part)
    return part === undefined ? null : stepFinishUsage(part)
  }
  if (type === "error") {
    const error = asRecord(payload.error)
    const record = {
      type: "closed" as const,
      stopReason: "error" as const,
      outcome: "aborted" as const,
      message: asString(error?.message) ?? asString(asRecord(error?.data)?.message) ?? "OpenCode run failed"
    }
    return record
  }
  return null
}

const preflight = (
  shell: Parameters<NonNullable<CliHarness.Spec["preflight"]>>[0],
  environment: Readonly<Record<string, string>>
): Effect.Effect<void, AdapterError.AdapterError> =>
  shell.exec("opencode --version", { env: environment }).pipe(
    Effect.mapError(() =>
      new AdapterError.SpawnFailed({
        message: "OpenCode preflight could not run on the selected host"
      })
    ),
    Effect.flatMap((result): Effect.Effect<void, AdapterError.AdapterError> => {
      if (result.exitCode === 0) return Effect.void
      return result.exitCode === 126 || result.exitCode === 127
        ? Effect.fail(
          new AdapterError.BinaryMissing({
            message: "OpenCode is not available on the selected host"
          })
        )
        : Effect.fail(
          new AdapterError.ConfigInvalid({
            message: "OpenCode failed its version preflight"
          })
        )
    })
  )

/**
 * OpenCode's declarative CLI harness specification.
 *
 * @category adapters
 * @since 0.1.0
 */
export const spec: CliHarness.Spec = {
  capabilities,
  patterns,
  buildCommand,
  interpret,
  preflight
}
