/**
 * Turning a vendor {@link module:Session} into a Smithers sandbox provider.
 *
 * Every cloud host repeats the same four things around its SDK: deliver the
 * egress policy to the command, scrub its own secrets out of any message it
 * raises, keep the session open for the provider's lifetime, and answer a
 * liveness probe. This module does all four once, so a host package is only
 * its vendor SDK plus a `Session`.
 *
 * The egress rule is the one case 23 pinned: the policy is merged into the
 * *spawned command's* environment. Nothing here writes `process.env`, so a
 * harness that launches a proxied sandbox keeps its own network path.
 *
 * @since 1.0.0
 */
import { RemoteChildProcessSpawner, type SandboxHealth } from "@smthrs/sandbox"
import { Effect, Layer, Result, Stream } from "effect"
import type { Signal } from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Scope } from "effect/Scope"
import * as Egress from "./Egress.ts"
import { ProviderKitError } from "./ProviderKitError.ts"
import type { Session } from "./Session.ts"

/**
 * How a host configures the kit.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The host's id, used in every diagnostic the kit raises. */
  readonly id: string
  /** The provider-neutral session key. */
  readonly session: string
  /** Opens the vendor session; its scope is the provider's lifetime. */
  readonly open: (session: string) => Effect.Effect<Session, RemoteChildProcessSpawner.ProviderError, Scope>
  /** The working directory a command runs in when the caller names none. */
  readonly workdir?: string | undefined
  /** Static environment the host contributes, for example an API token. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** The declared egress policy, still unvalidated. */
  readonly egress?: unknown
  /** Where the CA bundle lands inside the sandbox. */
  readonly caCertPath?: string | undefined
  /**
   * Which optional session operations this host implements.
   *
   * The built provider declares `kill` and `ping` only when they are named
   * here. `Provider` makes both optional so a caller can tell "cannot" from
   * "tried and failed", and `@smthrs/sandbox` `ProviderConformance` fails a
   * provider that declares a kill it then refuses. Declaring them
   * unconditionally would make every transport that can only post a command
   * line a conformance violation, so the default is neither.
   */
  readonly provides?: { readonly kill?: boolean | undefined; readonly ping?: boolean | undefined } | undefined
}

const providerError = (
  id: string,
  message: string,
  code: RemoteChildProcessSpawner.ProviderErrorCode = "unavailable"
): RemoteChildProcessSpawner.ProviderError =>
  new RemoteChildProcessSpawner.ProviderError({ code, message: `${id}: ${message}` })

const scrubbed = (
  id: string,
  secrets: ReadonlyArray<string>,
  error: RemoteChildProcessSpawner.ProviderError
): RemoteChildProcessSpawner.ProviderError =>
  new RemoteChildProcessSpawner.ProviderError({
    code: error.code,
    message: Egress.scrub(`${id}: ${error.message}`, secrets)
  })

/**
 * Builds the provider a host package exports.
 *
 * The returned value satisfies both `RemoteChildProcessSpawner.Provider` and
 * `SandboxHealth.PingProvider` when the session implements `ping`, which is
 * what lets one object drive execution and supervision.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options
): Result.Result<RemoteChildProcessSpawner.Provider, ProviderKitError> => {
  const id = options.id.trim()
  if (id === "") {
    return Result.fail(
      new ProviderKitError({ code: "invalid_options", message: "A sandbox provider requires a non-empty id." })
    )
  }
  const normalized = Egress.normalize(options.egress)
  if (normalized._tag === "Failure") return Result.fail(normalized.failure)
  const egress = normalized.success
  const secrets = Egress.secrets(egress, options.env ?? {})
  const egressEnv = Egress.environment(
    egress,
    options.caCertPath === undefined ? {} : { caCertPath: options.caCertPath }
  )

  // One session per provider. `open` registers the vendor teardown as a scope
  // finalizer, so a provider that goes out of scope never leaks a remote VM.
  let live: Session | undefined

  // Suspended, not eager: `ping` is a value on the provider, so building it at
  // construction time would capture the not-yet-open session forever.
  const opened = (): Effect.Effect<Session, RemoteChildProcessSpawner.ProviderError> =>
    Effect.suspend(() =>
      live === undefined
        ? Effect.fail(providerError(id, `The ${id} session is not open`))
        : Effect.succeed(live)
    )

  return Result.succeed({
    session: options.session,
    open: (session) =>
      Effect.gen(function*() {
        const value = yield* options.open(session)
        live = value
        yield* Effect.addFinalizer(() =>
          Effect.andThen(
            value.destroy === undefined ? Effect.void : Effect.ignore(value.destroy),
            Effect.sync(() => {
              live = undefined
            })
          )
        )
      }),
    spawn: (command, spawnOptions) =>
      Effect.gen(function*() {
        const session = yield* opened()
        const env = {
          ...options.env,
          ...spawnOptions.env,
          // The policy wins over a caller's own value: a sandbox that could
          // unset its proxy by naming HTTPS_PROXY would not be sandboxed.
          ...egressEnv
        }
        const started = yield* session.exec(command, {
          ...(spawnOptions.cwd === undefined
            ? (options.workdir === undefined ? {} : { cwd: options.workdir })
            : { cwd: spawnOptions.cwd }),
          env
        }).pipe(Effect.mapError((error) => scrubbed(id, secrets, error)))
        return {
          stdout: Stream.mapError(started.stdout, (error) => scrubbed(id, secrets, error)),
          stderr: Stream.mapError(started.stderr, (error) => scrubbed(id, secrets, error)),
          exitCode: Effect.mapError(started.exitCode, (error) => scrubbed(id, secrets, error))
        }
      }),
    ...(options.provides?.kill === true
      ? {
        kill: (process: RemoteChildProcessSpawner.RemoteProcess, signal: Signal) =>
          Effect.flatMap(opened(), (session) =>
            session.kill === undefined
              ? Effect.fail(providerError(id, `The ${id} provider cannot signal a running command`))
              : session.kill(process, signal))
      }
      : {}),
    ...(options.provides?.ping === true
      ? {
        ping: Effect.flatMap(opened(), (session) =>
          session.ping === undefined
            ? Effect.fail(providerError(id, `The ${id} provider has no liveness probe`))
            : session.ping)
      }
      : {})
  })
}

/**
 * The liveness half of a built provider, for `SandboxHealth`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const pingProvider = (
  provider: RemoteChildProcessSpawner.Provider
): SandboxHealth.PingProvider => ({
  // A provider that declares no probe is reported healthy rather than failed:
  // "this host cannot be probed" is not "this host is down".
  ping: provider.ping ?? Effect.void
})

/**
 * Provides `RemoteChildProcessSpawner` over a built provider.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<ChildProcessSpawner, ProviderKitError> =>
  Layer.unwrap(
    Effect.map(
      Effect.fromResult(make(options)),
      (provider) => RemoteChildProcessSpawner.layer(provider)
    )
  )
