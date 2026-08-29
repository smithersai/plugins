/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/usage` — provider usage reports and account quota state.
 *
 * Two halves. {@link module:UsageReport} is the normalized shape every usage
 * source produces, and {@link module:QuotaState} is the durable record of which
 * accounts a provider has already refused. {@link module:Selection} combines
 * them into the ordering a seat pool picks from.
 *
 * ```ts
 * import { QuotaState, Selection } from "@smthrs-plugins/usage"
 * import { Effect } from "effect"
 *
 * const order = Effect.gen(function*() {
 *   const quota = yield* QuotaState.QuotaStore
 *   const state = yield* quota.read()
 *   return Selection.orderAccountsByUsage([], { quota: state.entries })
 * })
 * ```
 */

/** The normalized usage report. */
export * as UsageReport from "./UsageReport.ts"

/** Traffic-light availability from usage windows. */
export * as Availability from "./Availability.ts"

/** Durable provider quota blocks. */
export * as QuotaState from "./QuotaState.ts"

/** Ordering accounts by headroom. */
export * as Selection from "./Selection.ts"

/** Model families a provider caps separately. */
export * as ModelFamily from "./ModelFamily.ts"
