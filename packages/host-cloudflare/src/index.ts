/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/host-cloudflare` — Cloudflare Sandbox containers and
 * Cloudflare SQLite storage as Smithers hosts.
 *
 * ```ts
 * import { CloudflareSandbox } from "@smthrs-plugins/host-cloudflare"
 *
 * const provider = CloudflareSandbox.make({ getSandbox, binding, session: "run-1" })
 * ```
 */

/** The sandbox provider. */
export * as CloudflareSandbox from "./CloudflareSandbox.ts"

/** SQLite descriptors over Durable Object storage and D1. */
export * as D1 from "./D1.ts"

/** The structural slice of the vendor SDK the host uses. */
export * as Sdk from "./Sdk.ts"
