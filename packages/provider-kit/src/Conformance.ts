/**
 * The conformance suite every host package runs against its {@link Session}.
 *
 * `@smthrs/sandbox` already ships `ProviderConformance.check`, which asks
 * whether a built `Provider` streams output, reports a nonzero exit, answers a
 * ping, and honours a kill. That suite starts one level above the seam a host
 * actually implements, so it cannot see the two mistakes hosts make: handing
 * back a vendor object instead of file text, and reporting a session id the
 * vendor never issued. This module covers the seam itself, so a host package
 * runs both and hand-rolls neither.
 *
 * Deliberately framework-neutral. A check answers violations in the same
 * `{ check, expected, actual }` shape `ProviderConformance` uses, so a package
 * asserts `violations` is empty under vitest, bun test, or nothing at all.
 *
 * @since 1.0.0
 */
import type { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import { Effect, Exit, Stream } from "effect"
import type { Scope } from "effect/Scope"
import type { Session } from "./Session.ts"

/**
 * One conformance check that did not hold.
 *
 * The shape is `@smthrs/sandbox` `ProviderConformance.Violation`, so a host
 * concatenates the two reports.
 *
 * @category models
 * @since 1.0.0
 */
export interface Violation {
  readonly check: string
  readonly expected: string
  readonly actual: string
}

/**
 * What a host hands the suite.
 *
 * @category models
 * @since 1.0.0
 */
export interface Subject {
  /** Opens a session, exactly as the host's own `session(options)` does. */
  readonly open: (
    key: string
  ) => Effect.Effect<Session, RemoteChildProcessSpawner.ProviderError, Scope>
  /** An absolute guest path the suite may write a file to and delete nothing. */
  readonly probePath: string
  /** A command that writes {@link Subject.output} to stdout and exits 0. */
  readonly writes: string
  /** Exactly what `writes` puts on stdout, trailing newline included. */
  readonly output: string
  /** A command that writes {@link Subject.errorOutput} to stderr. */
  readonly writesToStderr: string
  /** Exactly what `writesToStderr` puts on stderr, trailing newline included. */
  readonly errorOutput: string
  /** A command that exits with {@link Subject.failureCode}. */
  readonly fails: string
  /** The nonzero status `fails` exits with. */
  readonly failureCode: number
}

const shown = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? JSON.stringify(exit.value) : `a failure: ${String(exit.cause)}`

const scoped = <A>(
  subject: Subject,
  use: (session: Session) => Effect.Effect<A, unknown, Scope>
): Effect.Effect<Exit.Exit<A, unknown>> =>
  Effect.exit(Effect.scoped(Effect.flatMap(subject.open("conformance"), use)))

const decode = (
  stream: Stream.Stream<Uint8Array, RemoteChildProcessSpawner.ProviderError>
): Effect.Effect<string, RemoteChildProcessSpawner.ProviderError> =>
  Effect.map(Stream.runCollect(stream), (chunks) => {
    const decoder = new TextDecoder()
    return chunks.map((chunk) => decoder.decode(chunk)).join("")
  })

const namesItsRemote = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    scoped(subject, (session) => Effect.succeed(session.remoteId)),
    (exit) =>
      Exit.isSuccess(exit) && typeof exit.value === "string" && exit.value.length > 0 ? undefined : {
        check: "names-its-remote",
        expected: "a non-empty remoteId issued by the vendor",
        actual: shown(exit)
      }
  )

const roundTripsAFile = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    scoped(subject, (session) =>
      Effect.flatMap(
        session.writeFile(subject.probePath, "conformance"),
        () => session.readFile(subject.probePath)
      )),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === "conformance" ? undefined : {
        check: "round-trips-a-file",
        // A host that hands the vendor's own object back reads
        // "[object Object]" here, which is the bug this check exists for.
        expected: 'readFile to answer the text writeFile sent, "conformance"',
        actual: shown(exit)
      }
  )

const streamsStandardOutput = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    scoped(subject, (session) => Effect.flatMap(session.exec(subject.writes, {}), (p) => decode(p.stdout))),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === subject.output ? undefined : {
        check: "streams-standard-output",
        expected: `stdout ${JSON.stringify(subject.output)}`,
        actual: shown(exit)
      }
  )

const streamsStandardError = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    scoped(
      subject,
      (session) => Effect.flatMap(session.exec(subject.writesToStderr, {}), (p) => decode(p.stderr))
    ),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === subject.errorOutput ? undefined : {
        check: "streams-standard-error",
        expected: `stderr ${JSON.stringify(subject.errorOutput)}`,
        actual: shown(exit)
      }
  )

const reportsANonzeroExit = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    scoped(subject, (session) => Effect.flatMap(session.exec(subject.fails, {}), (p) => p.exitCode)),
    (exit) =>
      Exit.isSuccess(exit) && exit.value === subject.failureCode ? undefined : {
        check: "reports-a-nonzero-exit",
        expected: `exit code ${subject.failureCode}`,
        actual: shown(exit)
      }
  )

const answersAPing = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    scoped(subject, (session) => session.ping ?? Effect.void),
    (exit) =>
      Exit.isSuccess(exit) ? undefined : {
        check: "answers-a-ping",
        expected: "a liveness probe that succeeds while the session is open",
        actual: shown(exit)
      }
  )

const releasesOnScopeClose = (subject: Subject): Effect.Effect<Violation | undefined> =>
  Effect.map(
    Effect.exit(Effect.gen(function*() {
      let destroyed = false
      yield* Effect.scoped(Effect.flatMap(subject.open("conformance"), (session) =>
        Effect.sync(() => {
          destroyed = session.destroy !== undefined
        })))
      return destroyed
    })),
    (exit) =>
      Exit.isSuccess(exit) ? undefined : {
        check: "releases-on-scope-close",
        expected: "opening and closing a session scope to succeed",
        actual: shown(exit)
      }
  )

/**
 * Runs the session conformance suite.
 *
 * Each check opens its own session, so a check that leaves a session unusable
 * cannot decide the next one. An empty answer means the host conforms.
 *
 * @category constructors
 * @since 1.0.0
 */
export const check = (subject: Subject): Effect.Effect<ReadonlyArray<Violation>> =>
  Effect.gen(function*() {
    const found: Array<Violation | undefined> = [
      yield* namesItsRemote(subject),
      yield* roundTripsAFile(subject),
      yield* streamsStandardOutput(subject),
      yield* streamsStandardError(subject),
      yield* reportsANonzeroExit(subject),
      yield* answersAPing(subject),
      yield* releasesOnScopeClose(subject)
    ]
    return found.filter((violation): violation is Violation => violation !== undefined)
  })

/**
 * Renders violations as one message.
 *
 * @category formatting
 * @since 1.0.0
 */
export const format = (violations: ReadonlyArray<Violation>): string =>
  violations.length === 0
    ? "session conforms"
    : violations
      .map((violation) => `${violation.check}: expected ${violation.expected}, got ${violation.actual}`)
      .join("\n")
