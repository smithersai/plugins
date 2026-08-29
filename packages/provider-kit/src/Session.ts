/**
 * The seam a vendor host implements.
 *
 * A cloud sandbox vendor gives you some version of three operations: put a
 * file, read a file, run a command. This is that shape, in Effect, and it is
 * all `@smthrs-plugins/provider-kit` needs to build the
 * `@smthrs/sandbox` provider a host package exports. Everything a host would
 * otherwise repeat — egress delivery, secret scrubbing, command rendering,
 * session lifetime — lives in {@link module:CommandProvider} instead.
 *
 * @since 1.0.0
 */
import type { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import type { Effect } from "effect"
import type { Scope } from "effect/Scope"
import type { Signal } from "effect/unstable/process/ChildProcess"

/**
 * A live remote session.
 *
 * `ping`, `kill`, and `destroy` are optional because a transport that can only
 * post a command line has none of them. A host that implements `ping` earns
 * supervision; one that implements `kill` can stop a command without tearing
 * down the session that runs it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Session {
  /** The vendor's own identifier, used in diagnostics and result filling. */
  readonly remoteId: string
  readonly writeFile: (
    path: string,
    content: string
  ) => Effect.Effect<void, RemoteChildProcessSpawner.ProviderError>
  readonly readFile: (
    path: string
  ) => Effect.Effect<string, RemoteChildProcessSpawner.ProviderError>
  readonly exec: (
    command: string,
    options: {
      readonly cwd?: string | undefined
      readonly env?: Readonly<Record<string, string | undefined>> | undefined
    }
  ) => Effect.Effect<
    RemoteChildProcessSpawner.RemoteProcess,
    RemoteChildProcessSpawner.ProviderError,
    Scope
  >
  readonly kill?:
    | ((
      process: RemoteChildProcessSpawner.RemoteProcess,
      signal: Signal
    ) => Effect.Effect<void, RemoteChildProcessSpawner.ProviderError>)
    | undefined
  readonly ping?: Effect.Effect<void, RemoteChildProcessSpawner.ProviderError> | undefined
  readonly destroy?: Effect.Effect<void, RemoteChildProcessSpawner.ProviderError> | undefined
}
