/**
 * @since 1.0.0
 *
 * `@smthrs-plugins/seat-resolver` — a `@smthrs/agent` `SeatResolver` over the
 * registered account pool.
 *
 * Bind it from outside, in place of the environment resolver core installs:
 *
 * ```ts
 * import { SeatPool } from "@smthrs-plugins/seat-resolver"
 * import { Layer } from "effect"
 *
 * const seats = SeatPool.layer({ seed: "run-1" })
 * ```
 */

/** The pool ordering policy. */
export * as Pool from "./Pool.ts"

/** The `SeatResolver` implementation. */
export * as SeatPool from "./SeatPool.ts"
