/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/host-microsandbox` — local Microsandbox microVMs as a
 * Smithers sandbox host.
 *
 * ```ts
 * import { Microsandbox } from "@smthrs-plugins/host-microsandbox"
 *
 * const provider = Microsandbox.make({ sdk, session: "run-1" })
 * ```
 */

/** The provider and its session mapping. */
export * as Microsandbox from "./Microsandbox.ts"

/** The structural slice of the vendor SDK the host uses. */
export * as Sdk from "./Sdk.ts"
