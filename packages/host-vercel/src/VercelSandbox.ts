/**
 * A Smithers sandbox provider backed by Vercel Sandbox.
 *
 * Vercel caps the lifetime a single `create` may request, so a longer session
 * is reached incrementally: create at the ceiling, then extend by the
 * remainder. `extendTimeout` extends *by* its argument rather than *to* it,
 * which is why the loop sends the difference and not the target.
 *
 * @since 1.0.0
 */
import { CommandProvider, type ProviderKitError, type Session } from "@smthrs-plugins/provider-kit"
import { RemoteChildProcessSpawner, type SandboxHealth } from "@smthrs/sandbox"
import { Effect, type Result, Stream } from "effect"
import * as Credentials from "./Credentials.ts"
import type * as Sdk from "./Sdk.ts"

/** The provider id every diagnostic carries. @since 1.0.0 */
export const providerId = "vercel-sandbox"

/** The longest lifetime one `create` may request. @since 1.0.0 */
export const createCeilingMillis = 5 * 60_000

const defaultWorkdir = "/vercel/sandbox"

/**
 * How the host is configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Credentials.Input {
  readonly sdk: Sdk.Sdk
  readonly session: string
  /** The environment credentials are discovered from. Never `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** The lifetime the session should reach, in milliseconds. */
  readonly timeoutMs?: number | undefined
  /** The plan's own cap; a longer request is refused before it is sent. */
  readonly maxDurationMs?: number | undefined
  readonly workdir?: string | undefined
  readonly runtime?: string | undefined
  /** Static environment contributed to every command. */
  readonly commandEnv?: Readonly<Record<string, string>> | undefined
  readonly egress?: unknown
}

const failed = (message: string): RemoteChildProcessSpawner.ProviderError =>
  new RemoteChildProcessSpawner.ProviderError({
    code: "spawn_error",
    message: `vercel-sandbox: ${message}`
  })

const attempt = <A>(
  thunk: () => Promise<A>,
  what: string
): Effect.Effect<A, RemoteChildProcessSpawner.ProviderError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => failed(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

const streamOf = (
  value: (() => Promise<string>) | string | undefined
): Stream.Stream<Uint8Array, RemoteChildProcessSpawner.ProviderError> =>
  value === undefined
    ? Stream.empty
    : typeof value === "string"
    ? Stream.make(new TextEncoder().encode(value))
    : Stream.fromEffect(
      Effect.map(attempt(value, "output"), (text) => new TextEncoder().encode(text))
    )

/**
 * The lifetime one `create` may ask for, given the target.
 *
 * @category getters
 * @since 1.0.0
 */
export const createTimeout = (desiredMs: number): number => Math.min(desiredMs, createCeilingMillis)

/**
 * Opens a sandbox for a session and adapts it to the kit's seam.
 *
 * @category constructors
 * @since 1.0.0
 */
export const session = (
  options: Options
): (session: string) => Effect.Effect<Session.Session, RemoteChildProcessSpawner.ProviderError> =>
() =>
  Effect.gen(function*() {
    const workdir = options.workdir ?? defaultWorkdir
    const desiredMs = options.timeoutMs ?? createCeilingMillis
    if (!Number.isFinite(desiredMs) || desiredMs <= 0) {
      return yield* Effect.fail(failed("timeoutMs must be a positive number of milliseconds"))
    }
    if (options.maxDurationMs !== undefined && desiredMs > options.maxDurationMs) {
      return yield* Effect.fail(
        failed(
          `requested duration ${desiredMs}ms exceeds the plan cap of ${options.maxDurationMs}ms; lower timeoutMs or raise maxDurationMs`
        )
      )
    }
    const credentials = Credentials.resolve(options, options.env ?? {})
    const createMs = createTimeout(desiredMs)
    const sandbox = yield* attempt(
      () =>
        options.sdk.Sandbox.create({
          ...credentials,
          timeout: createMs,
          ...(options.runtime === undefined ? {} : { runtime: options.runtime })
        }),
      "creation failed"
    )
    if (desiredMs > createMs && sandbox.extendTimeout !== undefined) {
      // extendTimeout extends BY its argument, so the remainder is what goes
      // on the wire — sending the target would double the lifetime.
      yield* attempt(() => sandbox.extendTimeout?.(desiredMs - createMs) ?? Promise.resolve(), "extend failed")
    }

    return {
      remoteId: sandbox.sandboxId ?? providerId,
      writeFile: (path, content) =>
        attempt(() => sandbox.writeFiles([{ path, content }]), `write ${path}`),
      readFile: (path) => attempt(() => sandbox.readFile({ path }), `read ${path}`),
      exec: (command, execOptions) =>
        Effect.map(
          attempt(
            () =>
              sandbox.runCommand({
                cmd: "sh",
                args: ["-lc", command],
                cwd: execOptions.cwd ?? workdir,
                env: Object.fromEntries(
                  Object.entries(execOptions.env ?? {}).filter(
                    (entry): entry is [string, string] => entry[1] !== undefined
                  )
                )
              }),
            "runCommand failed"
          ),
          (result) => ({
            stdout: streamOf(result.stdout),
            stderr: streamOf(result.stderr),
            exitCode: Effect.succeed(result.exitCode ?? 0)
          })
        ),
      ping: Effect.asVoid(
        attempt(() => sandbox.runCommand({ cmd: "true", cwd: workdir }), "ping")
      ),
      ...(sandbox.stop === undefined
        ? {}
        : { destroy: Effect.ignore(attempt(() => sandbox.stop?.() ?? Promise.resolve(), "stop")) })
    }
  })

/**
 * Builds the provider.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options
): Result.Result<RemoteChildProcessSpawner.Provider, ProviderKitError.ProviderKitError> =>
  CommandProvider.make({
    id: providerId,
    session: options.session,
    open: session(options),
    workdir: options.workdir ?? defaultWorkdir,
    ...(options.commandEnv === undefined ? {} : { env: options.commandEnv }),
    ...(options.egress === undefined ? {} : { egress: options.egress })
  })

/**
 * The liveness half of a built provider.
 *
 * @category conversions
 * @since 1.0.0
 */
export const pingProvider = (
  provider: RemoteChildProcessSpawner.Provider
): SandboxHealth.PingProvider => CommandProvider.pingProvider(provider)
