/**
 * Declarative Kimi CLI adapter.
 *
 * Kimi's isolation variable is `KIMI_SHARE_DIR`, which is what lets a seat pool
 * run two Kimi subscriptions from one binary. Its session flag is `--session`
 * on the same command as a fresh run rather than a separate resume verb, so the
 * builder takes resume as an input and every semantic flag survives a resume.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import * as AdapterError from "./AdapterError.ts"
import * as CliClassifier from "./CliClassifier.ts"
import type { CliRecord } from "./CliOutput.ts"
import type { CommandSpec, Options, ResumeState } from "./CommandSpec.ts"
import { HarnessCapabilities } from "./HarnessCapabilities.ts"
import type * as Spec from "./Spec.ts"

const capabilities = new HarnessCapabilities({
  name: "kimi",
  version: "1",
  resume: "flag",
  mcpBootstrap: "inline-config",
  skillsInstall: "home-dir",
  configDirIsolation: true,
  nativeStructuredOutput: false,
  steer: false,
  images: false,
  usage: true
})

const patterns: CliClassifier.Patterns = {
  ...CliClassifier.defaultPatterns,
  quota: [
    ...CliClassifier.defaultPatterns.quota,
    /\bexceeded (?:your )?(?:current )?quota\b/i,
    /\binsufficient balance\b/i,
    /\byour account balance is insufficient\b/i
  ],
  auth: [
    ...CliClassifier.defaultPatterns.auth,
    /\brun `?kimi login`?\b/i,
    /\bkimi[_\s-]?api[_\s-]?key\b[\s\S]{0,100}\b(?:invalid|missing|expired)\b/i
  ],
  sessionLost: [
    ...CliClassifier.defaultPatterns.sessionLost,
    /\bsession .{0,80}\bnot found\b/i
  ]
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content.length === 0 ? undefined : content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) =>
    isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []
  ).join("")
  return text.length === 0 ? undefined : text
}

const buildCommand = (options: Options, resume?: ResumeState): CommandSpec => {
  const args: Array<string> = ["--print", "--output-format", "stream-json"]
  if (options.cwd !== undefined) args.push("--work-dir", options.cwd)
  if (resume !== undefined) args.push("--session", resume.sessionId)
  for (const directory of options.addDirs ?? []) args.push("--add-dir", directory)
  if (options.model !== undefined) args.push("--model", options.model)
  if (options.profile !== undefined) args.push("--agent", options.profile)
  args.push(...(options.extraArgs ?? []))
  if (options.prompt !== undefined) args.push("--prompt", options.prompt)
  return {
    command: "kimi",
    args,
    cleanup: [],
    // The share directory is the account identity. It is written by the seat
    // that selected this adapter, never inherited from the ambient shell.
    env: { KIMI_SHARE_DIR: options.configDir ?? `${options.cwd ?? "."}/.flows/kimi` }
  }
}

const interpret = (jsonLine: unknown): CliRecord | null => {
  if (!isRecord(jsonLine)) return null
  const type = asString(jsonLine["type"])
  const sessionId = asString(jsonLine["session_id"]) ?? asString(jsonLine["sessionId"])
  if (type === "session" || (type === "system" && sessionId !== undefined)) {
    return sessionId === undefined ? null : { type: "resumeToken", sessionId }
  }
  if (type === "assistant" || type === "message") {
    const message = isRecord(jsonLine["message"]) ? jsonLine["message"] : jsonLine
    const text = textOf(message["content"])
    return text === undefined ? null : { type: "delta", text }
  }
  if (type === "result" || type === "final") {
    const assistantText = asString(jsonLine["result"]) ?? textOf(jsonLine["content"])
    if (assistantText === undefined) return null
    const usage = isRecord(jsonLine["usage"]) ? jsonLine["usage"] : undefined
    return {
      type: "settled",
      assistantText,
      ...(usage === undefined ? {} : { usage }),
      ...(sessionId === undefined ? {} : { responseId: sessionId })
    }
  }
  return null
}

const preflight = (
  probe: Spec.Probe,
  environment: Readonly<Record<string, string>>
): Effect.Effect<void, AdapterError.AdapterError> =>
  probe.exec("kimi --version", { env: environment }).pipe(
    Effect.flatMap((result): Effect.Effect<void, AdapterError.AdapterError> => {
      if (result.exitCode === 0) return Effect.void
      return result.exitCode === 126 || result.exitCode === 127
        ? Effect.fail(new AdapterError.BinaryMissing({ message: "Kimi is not available on the selected host" }))
        : Effect.fail(new AdapterError.ConfigInvalid({ message: "Kimi failed its version preflight" }))
    })
  )

/**
 * Kimi's declarative CLI adapter specification.
 *
 * @category adapters
 * @since 1.0.0
 */
export const spec: Spec.Spec = { capabilities, patterns, buildCommand, interpret, preflight }
