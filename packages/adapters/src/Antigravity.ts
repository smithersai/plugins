/**
 * Declarative Antigravity CLI adapter.
 *
 * Antigravity resumes by `--conversation` rather than a session flag, and its
 * isolation variable is `GEMINI_DIR`. It emits no structured stream, so its
 * output is read as text and its final answer is the whole transcript — which
 * is why `nativeStructuredOutput` is false and the declared schema is carried
 * in the prompt.
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
  name: "antigravity",
  version: "1",
  resume: "flag",
  mcpBootstrap: "none",
  skillsInstall: "none",
  configDirIsolation: true,
  nativeStructuredOutput: false,
  steer: false,
  images: false,
  usage: false
})

const patterns: CliClassifier.Patterns = {
  ...CliClassifier.defaultPatterns,
  quota: [
    ...CliClassifier.defaultPatterns.quota,
    /\bresource[_\s-]?exhausted\b/i,
    /\bquota exceeded for quota metric\b/i
  ],
  auth: [
    ...CliClassifier.defaultPatterns.auth,
    /\bgemini[_\s-]?api[_\s-]?key\b[\s\S]{0,100}\b(?:invalid|missing|expired)\b/i,
    /\breauthenticate\b/i
  ]
}

/**
 * Options this adapter cannot express.
 *
 * Refusing is the point: the 0.x agent accepted these and dropped them, so a
 * caller believed it had configured something the binary never saw.
 *
 * @category constants
 * @since 1.0.0
 */
export const unsupportedOptions: ReadonlyArray<string> = Object.freeze([
  "outputFormat",
  "listSessions",
  "deleteSession",
  "extensions",
  "listExtensions",
  "screenReader",
  "debug"
])

const buildCommand = (options: Options, resume?: ResumeState): CommandSpec => {
  const args: Array<string> = []
  if (options.cwd !== undefined) args.push("--cwd", options.cwd)
  if (options.model !== undefined) args.push("--model", options.model)
  if (options.sandbox !== undefined) args.push("--sandbox")
  for (const directory of options.addDirs ?? []) args.push("--add-dir", directory)
  if (resume !== undefined) args.push("--conversation", resume.sessionId)
  args.push(...(options.extraArgs ?? []))
  if (options.prompt !== undefined) args.push("-p", options.prompt)
  return {
    command: "antigravity",
    args,
    cleanup: [],
    env: { GEMINI_DIR: options.configDir ?? `${options.cwd ?? "."}/.flows/antigravity` }
  }
}

// Antigravity streams no JSON. Every line is prose, and the runner accumulates
// it; a line that happens to parse as JSON is still prose to this adapter.
const interpret = (jsonLine: unknown): CliRecord | null =>
  typeof jsonLine === "string" && jsonLine.length > 0 ? { type: "delta", text: jsonLine } : null

const preflight = (
  probe: Spec.Probe,
  environment: Readonly<Record<string, string>>
): Effect.Effect<void, AdapterError.AdapterError> =>
  probe.exec("antigravity --version", { env: environment }).pipe(
    Effect.flatMap((result): Effect.Effect<void, AdapterError.AdapterError> => {
      if (result.exitCode === 0) return Effect.void
      return result.exitCode === 126 || result.exitCode === 127
        ? Effect.fail(
          new AdapterError.BinaryMissing({ message: "Antigravity is not available on the selected host" })
        )
        : Effect.fail(new AdapterError.ConfigInvalid({ message: "Antigravity failed its version preflight" }))
    })
  )

/**
 * Antigravity's declarative CLI adapter specification.
 *
 * @category adapters
 * @since 1.0.0
 */
export const spec: Spec.Spec = { capabilities, patterns, buildCommand, interpret, preflight }
