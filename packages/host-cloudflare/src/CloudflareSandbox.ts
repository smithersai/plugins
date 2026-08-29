/**
 * A Smithers sandbox provider backed by Cloudflare Sandbox containers.
 *
 * Two execution modes, and the difference is not cosmetic. `exec` runs a
 * command and answers when it finishes. `process` starts a detached process
 * and answers immediately with a pid — which is why this host waits for the
 * exit and reconciles the outcome exactly as `exec` mode does. Returning a
 * bare pid as a finished result is a silent success: the caller gets nothing
 * back and never learns the command failed.
 *
 * `sleepAfter` is the idle-hibernation window and the main container cost
 * lever; it is passed straight through, and the SDK default applies when the
 * caller names none.
 *
 * @since 1.0.0
 */
import { CommandProvider, type ProviderKitError, type Session } from "@smthrs-plugins/provider-kit"
import { RemoteChildProcessSpawner, type SandboxHealth } from "@smthrs/sandbox"
import { Effect, type Result, Stream } from "effect"
import type * as Sdk from "./Sdk.ts"

/** The provider id every diagnostic carries. @since 1.0.0 */
export const providerId = "cloudflare-sandbox"

const defaultWorkdir = "/workspace"

/**
 * How the host is configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The SDK's sandbox resolver, supplied by the caller. */
  readonly getSandbox: Sdk.GetSandbox
  /** The Durable Object binding the sandbox lives behind. */
  readonly binding: unknown
  /** The provider-neutral session key; the remote sandbox id is derived from it. */
  readonly session: string
  /**
   * `exec` waits for the command; `process` starts it detached and this host
   * still waits for its exit before reporting.
   */
  readonly execution?: "exec" | "process" | undefined
  readonly workdir?: string | undefined
  /** Idle-hibernation window. The container cost lever. */
  readonly sleepAfter?: string | number | undefined
  readonly keepAlive?: boolean | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly egress?: unknown
}

const failed = (message: string): RemoteChildProcessSpawner.ProviderError =>
  new RemoteChildProcessSpawner.ProviderError({
    code: "spawn_error",
    message: `cloudflare-sandbox: ${message}`
  })

const attempt = <A>(
  thunk: () => Promise<A>,
  what: string
): Effect.Effect<A, RemoteChildProcessSpawner.ProviderError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => failed(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

const textOf = (value: string | { readonly content: string }): string =>
  typeof value === "string" ? value : value.content

const definedEnv = (
  env: Readonly<Record<string, string | undefined>> | undefined
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )

/**
 * Opens the container for a session and adapts it to the kit's seam.
 *
 * @category constructors
 * @since 1.0.0
 */
export const session = (
  options: Options
): (session: string) => Effect.Effect<Session.Session, RemoteChildProcessSpawner.ProviderError> =>
(key) =>
  Effect.gen(function*() {
    const workdir = options.workdir ?? defaultWorkdir
    const sandbox = yield* Effect.try({
      try: () =>
        options.getSandbox(options.binding, key, {
          enableDefaultSession: false,
          ...(options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive }),
          ...(options.sleepAfter === undefined ? {} : { sleepAfter: options.sleepAfter })
        }),
      catch: (cause) => failed(`binding: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    if (sandbox.mkdir !== undefined) {
      yield* Effect.ignore(attempt(() => sandbox.mkdir?.(workdir) ?? Promise.resolve(), "mkdir"))
    }

    const execMode = (
      command: string,
      cwd: string,
      env: Readonly<Record<string, string>>
    ) =>
      Effect.map(
        attempt(() => sandbox.exec(command, { cwd, env }), "exec failed"),
        (result) => ({
          stdout: Stream.make(new TextEncoder().encode(result.stdout ?? "")),
          stderr: Stream.make(new TextEncoder().encode(result.stderr ?? "")),
          exitCode: Effect.succeed(result.exitCode ?? 0)
        })
      )

    const processMode = (
      command: string,
      cwd: string,
      env: Readonly<Record<string, string>>
    ) =>
      Effect.map(
        attempt(
          () =>
            sandbox.startProcess === undefined
              ? Promise.reject(new Error("the SDK exposes no startProcess"))
              : sandbox.startProcess(command, { cwd, env }),
          "startProcess failed"
        ),
        (started) => ({
          stdout: Stream.empty as Stream.Stream<Uint8Array, RemoteChildProcessSpawner.ProviderError>,
          stderr: Stream.empty as Stream.Stream<Uint8Array, RemoteChildProcessSpawner.ProviderError>,
          // A detached start answers with a pid, not an outcome. Waiting here
          // is what keeps process mode from reporting success for a command
          // that failed.
          exitCode: attempt(
            async () => {
              const exit = started.waitForExit === undefined ? undefined : await started.waitForExit()
              return exit?.exitCode ?? started.exitCode ?? 1
            },
            "waitForExit failed"
          )
        })
      )

    return {
      remoteId: key,
      writeFile: (path, content) =>
        attempt(() => sandbox.writeFile(path, content, { encoding: "utf-8" }), `write ${path}`),
      readFile: (path) => Effect.map(attempt(() => sandbox.readFile(path), `read ${path}`), textOf),
      exec: (command, execOptions) => {
        const cwd = execOptions.cwd ?? workdir
        const env = definedEnv(execOptions.env)
        return options.execution === "process" ? processMode(command, cwd, env) : execMode(command, cwd, env)
      },
      // A container that answers a directory listing is alive; nothing cheaper
      // crosses the Durable Object boundary.
      ping: Effect.asVoid(attempt(() => sandbox.exec("true", { cwd: workdir }), "ping"))
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
    ...(options.env === undefined ? {} : { env: options.env }),
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
