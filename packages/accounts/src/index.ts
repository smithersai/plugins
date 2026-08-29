/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/accounts` — the on-disk provider account registry.
 *
 * The registry is what turns "I have five Claude subscriptions" into something
 * a run can resolve a seat from. It holds one row per account: a label, a
 * provider, and either the configuration directory that vendor's CLI reads or
 * an API key. `@smthrs-plugins/seat-resolver` consumes it through the
 * `@smthrs/agent` `SeatResolver` seam.
 *
 * ```ts
 * import { Accounts } from "@smthrs-plugins/accounts"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const accounts = yield* Accounts.Accounts
 *   return yield* accounts.list
 * })
 * ```
 */

/** The registry service. */
export * as Accounts from "./Accounts.ts"

/** Account and registry-file models. */
export * as Account from "./Account.ts"

/** Provider names and their two authentication styles. */
export * as AccountProvider from "./AccountProvider.ts"

/** Typed registry failures. */
export * as AccountsError from "./AccountsError.ts"

/** The advisory lock around a read-modify-write. */
export * as AccountsLock from "./AccountsLock.ts"

/** Registry-file parsing and serialization. */
export * as parse from "./parse.ts"

/** The account-to-environment mapping. */
export * as ProviderEnv from "./ProviderEnv.ts"

/** Account-backed agent ids. */
export * as AgentId from "./AgentId.ts"
