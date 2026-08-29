/**
 * A Smithers sandbox provider backed by Cloudflare Sandbox containers.
 *
 * Two execution modes, and the difference is not cosmetic. `exec` runs a
 * command and answers when it finishes. `process` starts a detached process
 * and answers immediately with a handle, which is why this host waits for the
 * exit and then fetches the process log, so both modes answer the same three
 * things: standard output, standard error, and an exit code. Returning a bare
 * handle as a finished result is a silent success: the caller gets nothing back
 * and never learns the command failed.
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
export interface Options<Binding = unknown> {
  /** The SDK's sandbox resolver, supplied by the caller. */
  readonly getSandbox: Sdk.GetSandbox<Binding>
  /** The Durable Object binding the sandbox lives behind. */
  readonly binding: Binding
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
export const session = <Binding>(
  options: Options<Binding>
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
    yield* Effect.ignore(attempt(() => sandbox.mkdir(workdir, { recursive: true }), "mkdir"))

    const execMode = (
      command: string,
      cwd: string,
      env: Readonly<Record<string, string>>
    ) =>
      Effect.map(
        attempt(() => sandbox.exec(command, { cwd, env }), "exec failed"),
        (result) => ({
          stdout: Stream.make(new TextEncoder().encode(result.stdout)),
          stderr: Stream.make(new TextEncoder().encode(result.stderr)),
          exitCode: Effect.succeed(result.exitCode)
        })
      )

    const processMode = (
      command: string,
      cwd: string,
      env: Readonly<Record<string, string>>
    ) =>
      // A detached start answers a handle, not an outcome. Waiting for the exit
      // and then reading the process log is what makes process mode report the
      // same three things exec mode does; answering an exit code with two empty
      // streams would lose everything the command wrote.
      Effect.map(
        attempt(
          async () => {
            const started = await sandbox.startProcess(command, { cwd, env })
            const exit = await started.waitForExit()
            const logs = await started.getLogs()
            return { exitCode: exit.exitCode ?? started.exitCode ?? 1, ...logs }
          },
          "process failed"
        ),
        (result) => ({
          stdout: Stream.make(new TextEncoder().encode(result.stdout)),
          stderr: Stream.make(new TextEncoder().encode(result.stderr)),
          exitCode: Effect.succeed(result.exitCode)
        })
      )

    return {
      remoteId: key,
      writeFile: (path, content) =>
        attempt(() => sandbox.writeFile(path, content, { encoding: "utf-8" }), `write ${path}`),
      readFile: (path) =>
        Effect.map(attempt(() => sandbox.readFile(path), `read ${path}`), (result) => result.content),
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
export const make = <Binding>(
  options: Options<Binding>
): Result.Result<RemoteChildProcessSpawner.Provider, ProviderKitError.ProviderKitError> =>
  CommandProvider.make({
    id: providerId,
    session: options.session,
    open: session(options),
    workdir: options.workdir ?? defaultWorkdir,
    // The session answers a liveness probe and cannot signal one command
    // without tearing down the whole sandbox.
    provides: { ping: true },
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
