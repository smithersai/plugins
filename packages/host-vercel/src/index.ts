/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/host-vercel` — Vercel Sandbox as a Smithers host.
 *
 * ```ts
 * import { VercelSandbox } from "@smthrs-plugins/host-vercel"
 *
 * const provider = VercelSandbox.make({ sdk, session: "run-1", timeoutMs: 900_000 })
 * ```
 */

/** The sandbox provider. */
export * as VercelSandbox from "./VercelSandbox.ts"

/** Credential precedence. */
export * as Credentials from "./Credentials.ts"

/** The structural slice of the vendor SDK the host uses. */
export * as Sdk from "./Sdk.ts"
