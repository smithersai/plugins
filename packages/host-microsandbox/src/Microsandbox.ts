/**
 * A Smithers sandbox provider backed by local Microsandbox microVMs.
 *
 * The kit owns everything generic — egress delivery, secret scrubbing, session
 * lifetime — so this module is only the mapping from
 * `@smthrs-plugins/provider-kit`'s `Session` onto the Microsandbox SDK.
 *
 * A sandbox name is derived from the session key rather than generated, which
 * is what makes a sticky workspace reachable across processes: the same session
 * opens the same microVM instead of starting a second one beside it.
 *
 * @since 1.0.0
 */
import { CommandProvider, ProviderKitError, type Session } from "@smthrs-plugins/provider-kit"
import { RemoteChildProcessSpawner, type SandboxHealth } from "@smthrs/sandbox"
import { Effect, Result, Stream } from "effect"
import { createHash } from "node:crypto"
import type * as Sdk from "./Sdk.ts"

/** The provider id every diagnostic and conformance report carries. @since 1.0.0 */
export const providerId = "microsandbox"

const defaultImage = "oven/bun:1"
const defaultWorkdir = "/workspace"
const defaultShell = "/bin/sh"
const maxNameBytes = 128

/**
 * How the host is configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The SDK, supplied by the caller so the package needs no hard dependency. */
  readonly sdk: Sdk.Sdk
  /** The provider-neutral session key; the microVM name is derived from it. */
  readonly session: string
  readonly image?: string | undefined
  readonly workdir?: string | undefined
  readonly shell?: string | undefined
  /** Static environment, for example a registry token. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** The egress policy delivered to every command. */
  readonly egress?: unknown
  /**
   * Keep the microVM after the scope closes. A sticky workspace sets this so a
   * later session reopens the same machine.
   */
  readonly persistence?: "ephemeral" | "sticky" | undefined
}

/**
 * The microVM name for a session key.
 *
 * Names are bounded and vendor-safe, so a long session key is hashed rather
 * than truncated: truncation would collide two sessions onto one machine.
 *
 * @category conversions
 * @since 1.0.0
 */
export const sandboxName = (session: string): string => {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "-")
  const candidate = `smithers-${safe}`
  if (Buffer.byteLength(candidate, "utf8") <= maxNameBytes) return candidate
  return `smithers-${createHash("sha256").update(session).digest("hex").slice(0, 32)}`
}

const failed = (message: string): RemoteChildProcessSpawner.ProviderError =>
  new RemoteChildProcessSpawner.ProviderError({ code: "spawn_error", message: `microsandbox: ${message}` })

const attempt = <A>(
  thunk: () => Promise<A>,
  what: string
): Effect.Effect<A, RemoteChildProcessSpawner.ProviderError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => failed(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

/**
 * Opens the microVM for a session and adapts it to the kit's seam.
 *
 * @category constructors
 * @since 1.0.0
 */
export const session = (
  options: Options
): (session: string) => Effect.Effect<Session.Session, RemoteChildProcessSpawner.ProviderError> =>
(key) =>
  Effect.gen(function*() {
    const name = sandboxName(key)
    const sticky = options.persistence === "sticky"
    const workdir = options.workdir ?? defaultWorkdir
    const sandbox = yield* attempt(
      () =>
        options.sdk.Sandbox.builder(name)
          .image(options.image ?? defaultImage)
          .ephemeral(!sticky)
          .create(),
      "creation failed"
    )
    yield* Effect.ignore(attempt(() => sandbox.fs().mkdir(workdir), "guest directory"))
    return {
      remoteId: name,
      writeFile: (path, content) => attempt(() => sandbox.fs().write(path, content), `write ${path}`),
      readFile: (path) => attempt(() => sandbox.fs().readToString(path), `read ${path}`),
      exec: (command, execOptions) =>
        Effect.map(
          attempt(
            () =>
              sandbox.execStreamWith(options.shell ?? defaultShell, (builder) =>
                builder
                  .args(["-lc", command])
                  .cwd(execOptions.cwd ?? workdir)
                  .envs(
                    Object.fromEntries(
                      Object.entries(execOptions.env ?? {}).filter(
                        (entry): entry is [string, string] => entry[1] !== undefined
                      )
                    )
                  )),
            "exec failed"
          ),
          (handle) => ({
            stdout: Stream.fromEffect(
              Effect.map(attempt(() => handle.output(), "stdout"), (text) => new TextEncoder().encode(text))
            ),
            stderr: Stream.fromEffect(
              Effect.map(attempt(() => handle.error(), "stderr"), (text) => new TextEncoder().encode(text))
            ),
            exitCode: attempt(() => handle.exitCode(), "exit code")
          })
        ),
      // A liveness probe that costs one guest read rather than a command.
      ping: Effect.asVoid(attempt(() => sandbox.fs().readToString("/etc/hostname"), "ping")),
      // A sticky workspace outlives the session on purpose: destroying it would
      // discard the state the next session is meant to reopen.
      ...(sticky || sandbox.stop === undefined
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
