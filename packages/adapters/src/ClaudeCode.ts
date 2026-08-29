/**
 * Declarative Claude Code CLI adapter.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import * as AdapterError from "./AdapterError.ts"
import * as CliClassifier from "./CliClassifier.ts"
import type * as Spec from "./Spec.ts"
import type { CliRecord, CliToolCall } from "./CliOutput.ts"
import type { CommandSpec, Options, ResumeState } from "./CommandSpec.ts"
import { HarnessCapabilities } from "./HarnessCapabilities.ts"

const capabilities = new HarnessCapabilities({
  name: "claude-code",
  version: "1",
  resume: "flag",
  mcpBootstrap: "project-config",
  skillsInstall: "plugin-dir",
  configDirIsolation: true,
  nativeStructuredOutput: true,
  steer: false,
  images: true,
  usage: true
})

const patterns: CliClassifier.Patterns = {
  quota: [
    ...CliClassifier.claudeCodePatterns.quota,
    /\brate_limit_event\b[\s\S]{0,300}\bstatus\b[\s\S]{0,40}\brejected\b/i,
    /^You've hit your session limit\s+·\s+resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s+\([^)]+\)\.?$/i,
    /^You're out of usage credits\. Run \/usage-credits to keep using .+$/i,
    /^Claude usage limit reached\. Your limit will reset at \d{1,2}(?::\d{2})?\s*(?:am|pm)\s+\([^)]+\)\.?$/i
  ],
  quotaOnSuccess: [
    ...(CliClassifier.claudeCodePatterns.quotaOnSuccess ?? []),
    /^You've hit your session limit\s+·\s+resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s+(?:\([^)]+\)|[A-Z]{2,5})\.?$/i,
    /^You're out of usage credits\. Run \/usage-credits to keep using .+$/i,
    /^Claude usage limit reached\. Your limit will reset at \d{1,2}(?::\d{2})?\s*(?:am|pm)\s+(?:\([^)]+\)|[A-Z]{2,5})\.?$/i
  ],
  sessionLost: [
    ...CliClassifier.claudeCodePatterns.sessionLost,
    /\bno conversation found with session ID\b/i
  ],
  auth: [
    ...CliClassifier.claudeCodePatterns.auth,
    /\bnot logged in\b/i,
    /\bplease run \/login\b/i,
    /\banthropic[_\s-]?api[_\s-]?key\b[\s\S]{0,100}\b(?:invalid|missing|expired)\b/i
  ],
  config: [
    ...CliClassifier.claudeCodePatterns.config,
    /\binvalid settings\b/i,
    /\bmcp config\b[\s\S]{0,120}\b(?:could not be parsed|invalid|unreadable)\b/i
  ],
  benign: [
    ...CliClassifier.claudeCodePatterns.benign,
    /^\s*Claude Code update available\b.*$/i,
    // The vendor's own advice for a closed stdin. It is a notice about input
    // the adapter deliberately does not send, not an authentication failure.
    /^\s*Warning: no stdin data received in \d+s, proceeding without it\.[\s\S]*$/i
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

const usage = (value: unknown): Readonly<Record<string, unknown>> | undefined => isRecord(value) ? value : undefined

const textFromContent = (content: unknown): string | undefined => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text") return []
    const value = asString(block.text)
    return value === undefined ? [] : [value]
  }).join("")
  return text.length === 0 ? undefined : text
}

const toolCallFromContent = (content: unknown): CliToolCall | undefined => {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue
    const name = asString(block.name)
    if (name === undefined) continue
    const encoded = JSON.stringify(block.input ?? {})
    return {
      name,
      ...(asString(block.id) === undefined ? {} : { id: asString(block.id) }),
      ...(encoded === undefined ? {} : { arguments: encoded })
    }
  }
  return undefined
}

/**
 * Thinking blocks on assistant messages and tool_result blocks on user
 * messages follow the stream-json message shapes captured in real session
 * transcripts (`~/.claude/projects/<slug>/<session>.jsonl`); see
 * test/fixtures/claude-code/transcript.ndjson.
 */
const thinkingFromContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "thinking") return []
    const value = asString(block.thinking)
    return value === undefined ? [] : [value]
  }).join("")
  return text.length === 0 ? undefined : text
}

const toolResultFromContent = (content: unknown): CliRecord | undefined => {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") continue
    const output = textFromContent(block.content) ?? asString(block.content)
    return {
      type: "toolResult",
      ...(asString(block.tool_use_id) === undefined ? {} : { id: asString(block.tool_use_id) }),
      status: block.is_error === true ? "error" : "completed",
      ...(output === undefined ? {} : { output })
    }
  }
  return undefined
}

const isolatedConfigDirectory = (cwd: string | undefined): string => {
  if (cwd === undefined || cwd.length === 0) return ".flows/claude-code"
  const base = cwd === "/" ? "" : cwd.replace(/\/+$/, "")
  return `${base}/.flows/claude-code`
}

const claudePermissionArgs = (sandbox: string | undefined): ReadonlyArray<string> => {
  switch (sandbox) {
    case "danger-full-access":
      return [
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions"
      ]
    case "read-only":
      return ["--permission-mode", "plan"]
    case "workspace-write":
      return ["--permission-mode", "acceptEdits"]
    default:
      return sandbox === undefined ? [] : ["--permission-mode", sandbox]
  }
}

const claudeExtraArgs = (
  extraArgs: ReadonlyArray<string>
): { readonly args: ReadonlyArray<string>; readonly systemPrompt: string } => {
  const args: Array<string> = []
  let systemPrompt = ""
  for (let index = 0; index < extraArgs.length; index++) {
    const argument = extraArgs[index]
    if (argument === undefined) continue
    if (argument === "--system-prompt") {
      const value = extraArgs[index + 1]
      if (systemPrompt.length === 0 && value !== undefined) systemPrompt = value
      index += 1
      continue
    }
    if (argument.startsWith("--system-prompt=")) {
      if (systemPrompt.length === 0) systemPrompt = argument.slice("--system-prompt=".length)
      continue
    }
    if (argument === "--append-system-prompt") {
      index += 1
      continue
    }
    if (argument.startsWith("--append-system-prompt=")) continue
    args.push(argument)
  }
  return { args, systemPrompt }
}

const buildCommand = (options: Options, resume?: ResumeState): CommandSpec => {
  const extra = claudeExtraArgs(options.extraArgs ?? [])
  const configDirectory = options.configDir ?? isolatedConfigDirectory(options.cwd)
  const args: Array<string> = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose"
  ]
  for (const directory of options.addDirs ?? []) args.push("--add-dir", directory)
  if (options.model !== undefined) args.push("--model", options.model)
  args.push(...claudePermissionArgs(options.sandbox))
  if (options.outputSchemaPath !== undefined) args.push("--json-schema", options.outputSchemaPath)
  args.push(...extra.args, "--system-prompt", extra.systemPrompt)
  if (resume !== undefined) args.push("--resume", resume.sessionId)
  if (options.prompt !== undefined) args.push(options.prompt)
  return {
    command: "claude",
    args,
    // The prompt is the positional, so nothing is coming on standard input.
    // Saying so closes it: `claude --print` otherwise waits three seconds for
    // input that never arrives, on every single run, and then warns about it.
    stdin: "",
    cleanup: [],
    env: {
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: configDirectory
    }
  }
}

const interpret = (jsonLine: unknown): CliRecord | null => {
  const payload = asRecord(jsonLine)
  if (payload === undefined) return null
  const type = asString(payload.type)
  if (type === "system" && payload.subtype === "init") {
    const sessionId = asString(payload.session_id)
    return sessionId === undefined ? null : { type: "resumeToken", sessionId }
  }
  if (type === "assistant" || type === "user") {
    const message = asRecord(payload.message)
    if (message === undefined) return null
    const toolResult = toolResultFromContent(message.content)
    if (toolResult !== undefined) return toolResult
    const text = textFromContent(message.content)
    const toolCall = toolCallFromContent(message.content)
    const thinking = thinkingFromContent(message.content)
    return text === undefined && toolCall === undefined && thinking === undefined
      ? null
      : {
        type: "delta",
        ...(text === undefined ? {} : { text }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(toolCall === undefined ? {} : { toolCall })
      }
  }
  if (type === "stream_event") {
    const event = asRecord(payload.event)
    const delta = asRecord(event?.delta)
    if (event?.type !== "content_block_delta" || delta === undefined) return null
    const text = asString(delta.text)
    const thinking = asString(delta.thinking)
    return text === undefined && thinking === undefined
      ? null
      : {
        type: "delta",
        ...(text === undefined ? {} : { text }),
        ...(thinking === undefined ? {} : { thinking })
      }
  }
  if (type === "rate_limit_event") {
    const info = asRecord(payload.rate_limit_info)
    const status = asString(info?.status)
    const overageStatus = asString(info?.overageStatus)
    const rejected = status === "rejected" || (status === undefined && overageStatus === "rejected")
    if (!rejected) return null
    const record = {
      type: "closed" as const,
      stopReason: "error" as const,
      outcome: "suspended" as const,
      message: JSON.stringify(payload)
    }
    return record
  }
  if (type !== "result") return null
  if (payload.is_error === true || asString(payload.subtype)?.startsWith("error") === true) {
    const record = {
      type: "closed" as const,
      stopReason: "error" as const,
      outcome: "aborted" as const,
      message: asString(payload.error) ?? asString(payload.result) ?? "Claude run failed"
    }
    return record
  }
  const assistantText = asString(payload.result)
  if (assistantText === undefined) return null
  const resultUsage = usage(payload.usage)
  return {
    type: "settled",
    assistantText,
    ...(resultUsage === undefined ? {} : { usage: resultUsage }),
    ...(asString(payload.session_id) === undefined ? {} : { responseId: asString(payload.session_id) })
  }
}

const preflight = (
  probe: Spec.Probe,
  environment: Readonly<Record<string, string>>
): Effect.Effect<void, AdapterError.AdapterError> =>
  probe.exec("claude --version", { env: environment }).pipe(
    Effect.mapError(() =>
      new AdapterError.SpawnFailed({
        message: "Claude Code preflight could not run on the selected host"
      })
    ),
    Effect.flatMap((result): Effect.Effect<void, AdapterError.AdapterError> => {
      if (result.exitCode === 0) return Effect.void
      return result.exitCode === 126 || result.exitCode === 127
        ? Effect.fail(
          new AdapterError.BinaryMissing({
            message: "Claude Code is not available on the selected host"
          })
        )
        : Effect.fail(
          new AdapterError.ConfigInvalid({
            message: "Claude Code failed its version preflight"
          })
        )
    })
  )

/**
 * Claude Code's declarative CLI harness specification.
 *
 * @category adapters
 * @since 1.0.0
 */
export const spec: Spec.Spec = {
  capabilities,
  patterns,
  buildCommand,
  interpret,
  preflight
}
