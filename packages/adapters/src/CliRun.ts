/**
 * Running one CLI adapter.
 *
 * This is the only module in the package that starts a process, which is what
 * lets every adapter be data. It renders the spec's command, spawns it through
 * the kernel's permission-checked spawner, decodes the vendor's output line by
 * line through the spec's own reader, and turns a non-zero exit into the typed
 * failure the spec's patterns say it is — a quota refusal, a lost session, a
 * missing binary — rather than a generic error every caller re-classifies.
 *
 * @since 1.0.0
 */
import { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as AdapterError from "./AdapterError.ts"
import * as CliClassifier from "./CliClassifier.ts"
import * as CliOutput from "./CliOutput.ts"
import type * as CommandSpec from "./CommandSpec.ts"
import type * as Spec from "./Spec.ts"

/**
 * What one run of an adapter needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends CommandSpec.Options {
  /** The task the agent is given. Each adapter places it where its binary wants it. */
  readonly prompt: string
  /** Resumes a durable vendor session rather than starting a fresh one. */
  readonly resume?: CommandSpec.ResumeState | undefined
  /**
   * The environment the process runs under, in full.
   *
   * Nothing here reads `process.env`: an adapter that inherited the launching
   * process's environment would inherit its account too, and a seat pool's
   * isolation variable would be whatever the ambient shell happened to carry.
   * A caller that wants the binary found on `PATH` passes `PATH`.
   *
   * The spec's own `env` is applied over this, so an account's isolation
   * variable cannot be overridden by the caller either.
   */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Caps the diagnostic text a failure carries, in bytes. */
  readonly maxDiagnosticBytes?: number | undefined
}

/**
 * What one run produced.
 *
 * @category models
 * @since 1.0.0
 */
export interface Outcome {
  readonly exitCode: number
  /** The answer, resolved from the records or the stdout tail. */
  readonly answer: string
  /** Every neutral record the vendor's output decoded into. */
  readonly records: ReadonlyArray<CliOutput.CliRecord>
  /** The vendor session id, when the adapter reported one. */
  readonly sessionId?: string | undefined
  readonly stderr: string
}

/** The default diagnostic cap. @since 1.0.0 */
export const defaultDiagnosticBytes = 1024 * 1024

const environmentFor = (
  spec: CommandSpec.CommandSpec,
  options: Options
): Record<string, string> => ({
  ...options.env,
  // The spec's own entries win. A blank value clears a variable that would
  // otherwise leak the launching agent's identity into the child.
  ...spec.env
})

/**
 * Renders the command an adapter would run, without running it.
 *
 * Exposed because argv is the part of an adapter worth reviewing, and a caller
 * that wants to log or approve a command should not have to spawn one first.
 *
 * @category constructors
 * @since 1.0.0
 */
export const render = (spec: Spec.Spec, options: Options): CommandSpec.CommandSpec =>
  spec.buildCommand(options, options.resume)

const commandFor = (spec: Spec.Spec, options: Options): ChildProcess.StandardCommand => {
  const rendered = render(spec, options)
  return ChildProcess.make(rendered.command, [...rendered.args], {
    env: environmentFor(rendered, options),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // A spec that sends nothing gets a closed standard input, never the
    // default open pipe. Codex reads stdin even when the prompt is its
    // positional argument and waits on it before starting the turn, so a child
    // holding a pipe nobody writes to never settles.
    stdin: rendered.stdin === undefined
      ? "ignore"
      : Stream.make(new TextEncoder().encode(rendered.stdin))
  })
}

const recordsOf = (spec: Spec.Spec, lines: Iterable<string>): Array<CliOutput.CliRecord> => {
  const records: Array<CliOutput.CliRecord> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const parsed = CliOutput.parseNdjsonLine(trimmed)
    const record = spec.interpret(parsed === undefined ? trimmed : parsed)
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * Runs one adapter to completion.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = (
  spec: Spec.Spec,
  options: Options
): Effect.Effect<Outcome, AdapterError.AdapterError, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const budget = options.maxDiagnosticBytes ?? defaultDiagnosticBytes
    const command = commandFor(spec, options)
    const collected = yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(command)
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: 3 })
        return { stdout, stderr, exitCode: exitCode as number }
      })
    ).pipe(
      Effect.mapError((cause) =>
        new AdapterError.SpawnFailed({
          message: `${command.command} could not be started: ${String(cause)}`
        })
      )
    )

    const records = recordsOf(spec, collected.stdout.split("\n"))
    const stderr = CliOutput.truncateTailKeep(collected.stderr, budget)
    const classified = CliClassifier.classify({
      exitCode: collected.exitCode,
      stderr,
      records,
      patterns: spec.patterns
    })
    if (classified !== undefined) return yield* Effect.fail(classified)

    const sessionId = records.flatMap((record) =>
      record.type === "resumeToken" ? [record.sessionId] : []
    ).at(-1)
    return {
      exitCode: collected.exitCode,
      answer: CliOutput.resolveAnswerText(records, CliOutput.truncateTailKeep(collected.stdout, budget)),
      records,
      ...(sessionId === undefined ? {} : { sessionId }),
      stderr
    }
  })

/**
 * A {@link Spec.Probe} over the kernel spawner, for preflights.
 *
 * @category constructors
 * @since 1.0.0
 */
export const probe: Effect.Effect<Spec.Probe, never, ChildProcessSpawner> = Effect.map(
  ChildProcessSpawner,
  (spawner) => ({
    exec: (line: string, execOptions?: { readonly env?: Readonly<Record<string, string>> | undefined }) => {
      const [head, ...rest] = line.split(" ")
      const command = ChildProcess.make(head ?? line, rest, {
        ...(execOptions?.env === undefined ? {} : { env: { ...execOptions.env } })
      })
      return Effect.scoped(
        Effect.gen(function*() {
          const handle = yield* spawner.spawn(command)
          const [stdout, exitCode] = yield* Effect.all([
            Stream.mkString(Stream.decodeText(handle.stdout)),
            handle.exitCode
          ], { concurrency: 2 })
          return { exitCode: exitCode as number, stdout }
        })
      ).pipe(
        Effect.mapError(() =>
          new AdapterError.SpawnFailed({ message: `${line} could not run on the selected host` })
        )
      )
    }
  })
)

/**
 * Streams the vendor's stdout as decoded records, for a caller that renders
 * progress rather than waiting for an answer.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stream = (
  spec: Spec.Spec,
  options: Options
): Stream.Stream<CliOutput.CliRecord, AdapterError.AdapterError, ChildProcessSpawner> =>
  Stream.unwrap(
    Effect.map(ChildProcessSpawner, (spawner) =>
      spawner.streamLines(commandFor(spec, options)).pipe(
        Stream.mapError((cause) =>
          new AdapterError.SpawnFailed({ message: `adapter stream failed: ${String(cause)}` })
        ),
        Stream.flatMap((line) => Stream.fromArray(recordsOf(spec, [line])))
      ))
  )
