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
  /** Boot from a snapshot instead of an image. The two are exclusive. */
  readonly snapshot?: string | undefined
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
  /** vCPUs the microVM boots with. */
  readonly cpus?: number | undefined
  /** The ceiling `cpus` may be raised to. */
  readonly maxCpus?: number | undefined
  /** Memory in MiB the microVM boots with. */
  readonly memoryMib?: number | undefined
  /** The ceiling `memoryMib` may be raised to. */
  readonly maxMemoryMib?: number | undefined
  /** Wall-clock lifetime cap, in seconds. */
  readonly maxDurationSecs?: number | undefined
  /** Idle window before the microVM is reclaimed, in seconds. */
  readonly idleTimeoutSecs?: number | undefined
  /** The guest security profile. */
  readonly security?: "default" | "restricted" | undefined
  /** How the image is pulled, for example `if-missing`. */
  readonly pullPolicy?: string | undefined
  /** Labels the runtime records against the microVM. */
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** Named guest scripts planted at boot. */
  readonly scripts?: Readonly<Record<string, string>> | undefined
  /** Run the microVM detached from this process. A sticky workspace needs it. */
  readonly detached?: boolean | undefined
  /** Boot with no guest network at all. */
  readonly disableNetwork?: boolean | undefined
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
 * Applies every declared option to the SDK's builder.
 *
 * Resources and lifetimes are not cosmetic: a microVM that boots with the
 * default two vCPUs when a workspace asked for eight is a slow workspace, and
 * one with no `idleTimeout` is a bill. Each setter is called only when the
 * caller named the value, so the SDK's own defaults stand otherwise.
 *
 * `workdir` is deliberately not set on the builder. Microsandbox validates a
 * builder workdir against the unbooted image, and this host creates the
 * directory after boot, so the path travels with each command instead.
 *
 * @category constructors
 * @since 1.0.0
 */
export const configure = (
  builder: Sdk.SandboxBuilder,
  options: Options,
  sticky: boolean
): Sdk.SandboxBuilder => {
  let built = options.snapshot === undefined
    ? builder.image(options.image ?? defaultImage)
    : builder.fromSnapshot(options.snapshot)
  if (options.cpus !== undefined) built = built.cpus(options.cpus)
  if (options.maxCpus !== undefined) built = built.maxCpus(options.maxCpus)
  if (options.memoryMib !== undefined) built = built.memory(options.memoryMib)
  if (options.maxMemoryMib !== undefined) built = built.maxMemory(options.maxMemoryMib)
  if (options.security !== undefined) built = built.security(options.security)
  if (options.pullPolicy !== undefined) built = built.pullPolicy(options.pullPolicy)
  if (options.labels !== undefined) built = built.labels({ ...options.labels })
  if (options.scripts !== undefined) built = built.scripts({ ...options.scripts })
  if (options.maxDurationSecs !== undefined) built = built.maxDuration(options.maxDurationSecs)
  if (options.idleTimeoutSecs !== undefined) built = built.idleTimeout(options.idleTimeoutSecs)
  if (options.disableNetwork === true) built = built.disableNetwork()
  // A sticky workspace must outlive this process, so it is never ephemeral and
  // is detached unless the caller says otherwise.
  return built.ephemeral(!sticky).detached(options.detached ?? sticky)
}

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
    if (options.image !== undefined && options.snapshot !== undefined) {
      return yield* Effect.fail(failed("image and snapshot are exclusive; name one"))
    }
    const sandbox = yield* attempt(
      () => configure(options.sdk.Sandbox.builder(name), options, sticky).create(),
      "creation failed"
    )
    yield* Effect.ignore(attempt(() => sandbox.fs().mkdir(workdir), "guest directory"))
    return {
      remoteId: sandbox.name,
      writeFile: (path, content) => attempt(() => sandbox.fs().write(path, content), `write ${path}`),
      readFile: (path) => attempt(() => sandbox.fs().readToString(path), `read ${path}`),
      exec: (command, execOptions) =>
        Effect.map(
          // One `collect` drains standard output, standard error, and the exit
          // status together. The handle has no per-stream reader, so collecting
          // twice would wait on an already-consumed stream.
          attempt(
            async () => {
              const handle = await sandbox.execStreamWith(options.shell ?? defaultShell, (builder) =>
                builder
                  .args(["-lc", command])
                  .cwd(execOptions.cwd ?? workdir)
                  .envs(
                    Object.fromEntries(
                      Object.entries(execOptions.env ?? {}).filter(
                        (entry): entry is [string, string] => entry[1] !== undefined
                      )
                    )
                  ))
              return await handle.collect()
            },
            "exec failed"
          ),
          (output) => ({
            stdout: Stream.make(new TextEncoder().encode(output.stdout())),
            stderr: Stream.make(new TextEncoder().encode(output.stderr())),
            exitCode: Effect.succeed(output.code)
          })
        ),
      // A liveness probe that costs one guest read rather than a command.
      ping: Effect.asVoid(attempt(() => sandbox.fs().readToString("/etc/hostname"), "ping")),
      // A sticky workspace outlives the session on purpose: destroying it would
      // discard the state the next session is meant to reopen.
      ...(sticky ? {} : { destroy: Effect.ignore(attempt(() => sandbox.stop(), "stop")) })
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
