/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/provider-kit` — what every cloud sandbox host would
 * otherwise write twice.
 *
 * A host package supplies a {@link module:Session} over its vendor SDK. This
 * package turns it into a `@smthrs/sandbox` `RemoteChildProcessSpawner.Provider`
 * with the egress policy delivered to the command, secrets scrubbed out of
 * diagnostics, and a liveness probe wired to `SandboxHealth`.
 *
 * ```ts
 * import { CommandProvider } from "@smthrs-plugins/provider-kit"
 *
 * const provider = CommandProvider.make({ id: "vendor", session: "run-1", open })
 * ```
 */

/** The egress policy and its delivery. */
export * as Egress from "./Egress.ts"

/** The vendor session seam. */
export * as Session from "./Session.ts"

/** Session to provider. */
export * as CommandProvider from "./CommandProvider.ts"

/** The conformance suite every host runs against its session. */
export * as Conformance from "./Conformance.ts"

/** Sandbox path containment. */
export * as SandboxPath from "./SandboxPath.ts"

/** The kit's typed failure. */
export * as ProviderKitError from "./ProviderKitError.ts"
