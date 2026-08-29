/**
 * What one CLI adapter declares.
 *
 * An adapter is data, not a class. It says which flags its binary takes, how to
 * read a line of its JSON output, which of its messages mean "rate limited"
 * rather than "broken", and what it can do. Everything that runs a process
 * lives in {@link module:CliRun} instead, so adding a vendor is a value rather
 * than a subclass, and every adapter's argv, resume behaviour, and
 * classification are testable without spawning anything.
 *
 * @since 1.0.0
 */
import type { Effect } from "effect"
import type * as AdapterError from "./AdapterError.ts"
import type * as CliClassifier from "./CliClassifier.ts"
import type { CliRecord } from "./CliOutput.ts"
import type { CommandSpec, Options, ResumeState } from "./CommandSpec.ts"
import type { HarnessCapabilities } from "./HarnessCapabilities.ts"

/**
 * The one host operation a preflight needs: run a short command and report how
 * it exited.
 *
 * Narrow on purpose. A preflight that could stream, signal, or open files would
 * be a second execution path beside {@link module:CliRun}, and the two would
 * drift.
 *
 * @category models
 * @since 1.0.0
 */
export interface Probe {
  readonly exec: (
    command: string,
    options?: { readonly env?: Readonly<Record<string, string>> | undefined } | undefined
  ) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, AdapterError.AdapterError>
}

/**
 * One adapter's declaration.
 *
 * @category models
 * @since 1.0.0
 */
export interface Spec {
  readonly capabilities: HarnessCapabilities
  readonly patterns: CliClassifier.Patterns
  readonly buildCommand: (options: Options, resume?: ResumeState | undefined) => CommandSpec
  /** Turns one decoded JSON line of vendor output into a neutral record. */
  readonly interpret: (jsonLine: unknown) => CliRecord | null
  /** Proves the binary is present and usable before a run spends anything. */
  readonly preflight?:
    | ((probe: Probe, environment: Readonly<Record<string, string>>) => Effect.Effect<void, AdapterError.AdapterError>)
    | undefined
}
