/**
 * Declarative Codex CLI adapter.
 *
 * Governing contract: `docs/specs/Concepts/Agent Adapters.md`.
 *
 * Codex requires the `exec resume` form. Resume-incompatible convenience
 * flags are projected through `-c` when an equivalent exists; profiles are
 * rejected on resume because the CLI exposes no compatible profile flag.
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
  name: "codex",
  version: "1",
  resume: "subcommand",
  mcpBootstrap: "inline-config",
  skillsInstall: "home-dir",
  configDirIsolation: true,
  nativeStructuredOutput: false,
  steer: false,
  images: true,
  usage: true
})

const patterns: CliClassifier.Patterns = {
  quota: [
    ...CliClassifier.codexPatterns.quota,
    /\byou have reached your usage limit\b/i,
    /\bcredits? balance (?:is )?(?:exhausted|depleted)\b/i,
    /\binsufficient_quota\b/i
  ],
  quotaOnSuccess: [
    ...(CliClassifier.codexPatterns.quotaOnSuccess ?? [])
  ],
  sessionLost: [
    ...CliClassifier.codexPatterns.sessionLost,
    /\b(?:failed|unable) to resume (?:thread|rollout)\b[\s\S]{0,160}\b(?:not found|does not exist)\b/i,
    /\b(?:thread|rollout)[_\s-]*(?:not[_\s-]*found|missing|expired)\b/i
  ],
  auth: [
    ...CliClassifier.codexPatterns.auth,
    /\bmissing bearer or basic authentication\b/i,
    /\bincorrect API key provided\b/i,
    /\bnot logged in\b[\s\S]{0,80}\bcodex login\b/i
  ],
  config: [
    ...CliClassifier.codexPatterns.config,
    /\bfailed to load (?:codex )?config\b/i,
    /\binvalid value\b[\s\S]{0,100}\bfor ['"]?(?:--sandbox|--profile|-c)\b/i
  ],
  benign: [
    ...CliClassifier.codexPatterns.benign,
    /^.*state db missing rollout path.*$/i,
    /^.*codex_core::rollout::list.*$/i,
    /^.*failed to record rollout items: failed to queue rollout items: channel closed.*$/i,
    /^.*Failed to shutdown rollout recorder.*$/i
  ]
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

const isolatedConfigDirectory = (cwd: string | undefined): string => {
  if (cwd === undefined || cwd.length === 0) return ".flows/codex"
  const base = cwd === "/" ? "" : cwd.replace(/\/+$/, "")
  return `${base}/.flows/codex`
}

const outputFileFor = (options: Options): string => {
  const cwd = options.cwd
  if (cwd === undefined || cwd.length === 0) return ".flows/codex-output-last-message.txt"
  const base = cwd === "/" ? "" : cwd.replace(/\/+$/, "")
  return `${base}/.flows/codex-output-last-message.txt`
}

const execOptions = (
  options: Options,
  resume: ResumeState | undefined
): { readonly args: ReadonlyArray<string>; readonly outputFile: string } => {
  const outputFile = outputFileFor(options)
  const args: Array<string> = []
  if (resume !== undefined && options.profile !== undefined) {
    throw new Error("Codex profiles cannot be retained by exec resume")
  }
  if (options.model !== undefined) args.push("--model", options.model)
  if (options.sandbox !== undefined) args.push("-c", `sandbox_mode=${JSON.stringify(options.sandbox)}`)
  if (options.profile !== undefined) args.push("--profile", options.profile)
  if (options.addDirs !== undefined && options.addDirs.length > 0) {
    args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(options.addDirs)}`)
  }
  if (options.outputSchemaPath !== undefined) args.push("--output-schema", options.outputSchemaPath)
  if (options.jsonMode !== false) args.push("--json")
  args.push("--output-last-message", outputFile)
  if (resume !== undefined) {
    const unsupported = ["--profile", "-p", "--sandbox", "-s", "--cd", "-C", "--add-dir", "--color"]
    const incompatible = (options.extraArgs ?? []).find((argument) =>
      unsupported.some((flag) => argument === flag || argument.startsWith(`${flag}=`))
    )
    if (incompatible !== undefined) {
      throw new Error(`Codex resume does not accept ${incompatible}`)
    }
  }
  args.push(...(options.extraArgs ?? []))
  return { args, outputFile }
}

const buildCommand = (options: Options, resume?: ResumeState): CommandSpec => {
  const projected = execOptions(options, resume)
  const configDirectory = isolatedConfigDirectory(options.cwd)
  return {
    command: "codex",
    args: [
      "exec",
      ...(resume === undefined ? [] : ["resume"]),
      ...projected.args,
      ...(resume === undefined ? [] : [resume.sessionId]),
      "-"
    ],
    outputFile: projected.outputFile,
    cleanup: [projected.outputFile],
    env: {
      CODEX_HOME: configDirectory,
      OPENAI_API_KEY: ""
    }
  }
}

const usageRecord = (value: unknown): CliRecord | null => {
  if (!isRecord(value)) return null
  return {
    type: "usage",
    ...(typeof value.input_tokens === "number" ? { input_tokens: value.input_tokens } : {}),
    ...(typeof value.output_tokens === "number" ? { output_tokens: value.output_tokens } : {}),
    ...(typeof value.cached_input_tokens === "number" ? { cachedInputTokens: value.cached_input_tokens } : {}),
    ...(typeof value.cache_write_input_tokens === "number" ? { cacheWriteTokens: value.cache_write_input_tokens } : {}),
    ...(typeof value.reasoning_tokens === "number" ? { reasoning_tokens: value.reasoning_tokens } : {}),
    ...(typeof value.reasoning_output_tokens === "number" ? { reasoning_tokens: value.reasoning_output_tokens } : {}),
    ...(typeof value.total_tokens === "number" ? { total_tokens: value.total_tokens } : {})
  }
}

const encode = (value: unknown): string => JSON.stringify(value ?? {})

/**
 * Item variants below are derived from the exec `--json` wire schema in
 * `reference/codex/codex-rs/exec/src/exec_events.rs` (`ThreadItemDetails`,
 * serde-tagged on `type`, snake_case fields). Tool names follow Codex's own
 * tool surface (`shell_command`, `apply_patch`, `update_plan`) so rendered
 * cards match what the native TUI shows.
 */
const interpretItem = (eventType: string, item: Readonly<Record<string, unknown>>): CliRecord | null => {
  const itemType = asString(item.type)
  const itemId = asString(item.id)
  if (itemType === "agent_message") {
    const text = asString(item.text)
    if (text === undefined || text.length === 0) return null
    return eventType === "item.completed"
      ? { type: "settled", assistantText: text, responseId: itemId }
      : { type: "delta", text }
  }
  if (itemType === "reasoning") {
    const thinking = asString(item.text)
    return thinking === undefined || thinking.length === 0 ? null : { type: "delta", thinking }
  }
  if (itemType === "mcp_tool_call") {
    const server = asString(item.server)
    const tool = asString(item.tool)
    if (tool === undefined) return null
    return {
      type: "delta",
      toolCall: {
        name: server === undefined ? tool : `${server}.${tool}`,
        ...(itemId === undefined ? {} : { id: itemId }),
        arguments: encode(item.arguments)
      }
    }
  }
  if (itemType === "web_search") {
    const query = asString(item.query)
    return query === undefined ? null : { type: "delta", toolCall: { name: "web_search", arguments: query } }
  }
  if (itemType === "command_execution") {
    const command = asString(item.command)
    if (command === undefined) return null
    const status = asString(item.status)
    if (eventType !== "item.completed" || status === "in_progress") {
      return {
        type: "delta",
        toolCall: {
          name: "shell_command",
          ...(itemId === undefined ? {} : { id: itemId }),
          arguments: encode({ command })
        }
      }
    }
    return {
      type: "toolResult",
      name: "shell_command",
      ...(itemId === undefined ? {} : { id: itemId }),
      arguments: encode({ command }),
      status: status === "failed" || status === "declined" ? "error" : "completed",
      output: JSON.stringify({
        output: asString(item.aggregated_output) ?? "",
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
        status: status ?? "completed"
      })
    }
  }
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const status = asString(item.status)
    return {
      type: "toolResult",
      name: "apply_patch",
      ...(itemId === undefined ? {} : { id: itemId }),
      arguments: JSON.stringify({ changes }),
      status: status === "failed" ? "error" : "completed",
      output: JSON.stringify({ changes, status: status ?? "completed" })
    }
  }
  if (itemType === "todo_list") {
    const items = (Array.isArray(item.items) ? item.items : []).flatMap((entry) => {
      if (!isRecord(entry)) return []
      const text = asString(entry.text)
      return text === undefined ? [] : [{ text, status: entry.completed === true ? "completed" : "pending" }]
    })
    return {
      type: "delta",
      toolCall: {
        name: "update_plan",
        ...(itemId === undefined ? {} : { id: itemId }),
        arguments: JSON.stringify({ items })
      }
    }
  }
  if (itemType === "collab_tool_call") {
    const tool = asString(item.tool)
    if (tool === undefined) return null
    return {
      type: "delta",
      toolCall: {
        name: `collab.${tool}`,
        ...(itemId === undefined ? {} : { id: itemId }),
        arguments: encode({ prompt: asString(item.prompt) })
      }
    }
  }
  return null
}

const interpret = (jsonLine: unknown): CliRecord | null => {
  const payload = asRecord(jsonLine)
  if (payload === undefined) return null
  const type = asString(payload.type)
  if (type === "thread.started") {
    const sessionId = asString(payload.thread_id)
    return sessionId === undefined ? null : { type: "resumeToken", sessionId }
  }
  if (type === "turn.started") return { type: "turnOpened", seat: "codex" }
  if (type === "turn.completed") return usageRecord(payload.usage)
  if (type === "turn.failed" || type === "error") {
    const error = asRecord(payload.error)
    const record = {
      type: "closed" as const,
      stopReason: "error" as const,
      outcome: "aborted" as const,
      message: asString(payload.message) ?? asString(error?.message) ?? "Codex run failed"
    }
    return record
  }
  if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return null
  const item = asRecord(payload.item)
  if (item === undefined) return null
  return interpretItem(type, item)
}

const preflight = (
  shell: Parameters<NonNullable<CliHarness.Spec["preflight"]>>[0],
  environment: Readonly<Record<string, string>>
): Effect.Effect<void, AdapterError.AdapterError> =>
  shell.exec("codex --version", { env: environment }).pipe(
    Effect.mapError(() =>
      new AdapterError.SpawnFailed({
        message: "Codex preflight could not run on the selected host"
      })
    ),
    Effect.flatMap((result): Effect.Effect<void, AdapterError.AdapterError> => {
      if (result.exitCode === 0) return Effect.void
      return result.exitCode === 126 || result.exitCode === 127
        ? Effect.fail(
          new AdapterError.BinaryMissing({
            message: "Codex is not available on the selected host"
          })
        )
        : Effect.fail(
          new AdapterError.ConfigInvalid({
            message: "Codex failed its version preflight"
          })
        )
    })
  )

/**
 * Codex's declarative CLI harness specification.
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
