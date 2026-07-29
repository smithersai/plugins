/**
 * Pure command descriptions shared by CLI adapters.
 *
 * @since 0.1.0
 */

/**
 * A logical process invocation description.
 *
 * `command` and `args` remain separate until the protected host-shell boundary.
 * Hosts with a string-only shell API execute the POSIX-quoted rendering.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSpec {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin?: string | undefined
  readonly outputFile?: string | undefined
  readonly cleanup: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

/**
 * A durable CLI conversation identifier supplied to a command builder.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResumeState {
  readonly sessionId: string
}

/**
 * Semantic options common to CLI adapter command builders.
 *
 * Adapters project these vendor-neutral values into their own argv format.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly model?: string | undefined
  readonly cwd?: string | undefined
  readonly addDirs?: ReadonlyArray<string> | undefined
  readonly sandbox?: string | undefined
  readonly profile?: string | undefined
  readonly outputSchemaPath?: string | undefined
  readonly jsonMode?: boolean | undefined
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

/**
 * The single command-builder shape used by every CLI adapter.
 *
 * Resume is an input to the same builder as a fresh command. Adapters must not
 * implement a second resume-only argv path, so semantic flags remain present
 * when a session is resumed.
 *
 * @category models
 * @since 0.1.0
 */
export type Builder = (options: Options, resume?: ResumeState | undefined) => CommandSpec

/**
 * Invokes the same builder with durable resume state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const withResume = (builder: Builder, options: Options, resume: ResumeState): CommandSpec =>
  builder(options, resume)

/**
 * Quotes one value for a POSIX-shell command line.
 *
 * @category utilities
 * @since 0.1.0
 */
export const quoteArg = (value: string): string => {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/**
 * Renders an argv vector for protected POSIX-shell execution or diagnostics.
 *
 * @category utilities
 * @since 0.1.0
 */
export const renderArgv = (spec: Pick<CommandSpec, "command" | "args">): string =>
  [spec.command, ...spec.args].map(quoteArg).join(" ")

/**
 * Returns fresh-command flags missing from a resumed command.
 *
 * This compares only tokens beginning with `-`; positional prompt and session
 * values are deliberately excluded. An empty result demonstrates the resume
 * invariant for a particular adapter command pair.
 *
 * @category utilities
 * @since 0.1.0
 */
export const flagDiff = (fresh: CommandSpec, resumed: CommandSpec): ReadonlyArray<string> => {
  const resumedFlags = new Set(resumed.args.filter((argument) => argument.startsWith("-")))
  return fresh.args.filter((argument) => argument.startsWith("-") && !resumedFlags.has(argument))
}

/**
 * Throws when a resumed command has lost a flag from the corresponding fresh
 * command.
 *
 * @category assertions
 * @since 0.1.0
 */
export const assertResumePreservesFlags = (fresh: CommandSpec, resumed: CommandSpec): void => {
  const missing = flagDiff(fresh, resumed)
  if (missing.length > 0) {
    throw new Error(`resumed command is missing fresh flags: ${missing.join(", ")}`)
  }
}
