/**
 * The normalized usage report.
 *
 * Every source — a subscription utilization endpoint, rate-limit response
 * headers, a local estimate — produces this one shape, so the CLI, the
 * gateway, and the seat resolver read one model instead of three.
 *
 * @since 1.0.0
 */
import type { AccountProvider } from "@smthrs-plugins/accounts/AccountProvider"

/**
 * Where a report's numbers came from.
 *
 * - `oauth` — an authenticated subscription usage endpoint.
 * - `headers` — live rate-limit headers from an API-key request.
 * - `local` — estimated from local token logs.
 * - `none` — the provider exposes no usage surface, or the probe failed.
 *
 * @category models
 * @since 1.0.0
 */
export type UsageSource = "oauth" | "headers" | "local" | "none"

/**
 * One quota window: a five-hour session, a weekly cap, a per-minute bucket.
 *
 * `unit` decides which fields carry meaning. `percent` and `estimated` report
 * `usedPercent`; `count` reports `limit`, `used`, and `remaining`. An
 * `estimated` window is a lower bound and never authoritative.
 *
 * @category models
 * @since 1.0.0
 */
export interface UsageWindow {
  /** Stable id, for example `5h`, `weekly`, `weekly-fable`. */
  readonly id: string
  /** Human label, for example `5-hour session`. */
  readonly label: string
  readonly unit: "percent" | "count" | "estimated"
  /** 0 to 100. */
  readonly usedPercent?: number | undefined
  readonly used?: number | undefined
  readonly limit?: number | undefined
  readonly remaining?: number | undefined
  /** ISO-8601 timestamp of the rollover. */
  readonly resetsAt?: string | undefined
  /** Share of the plan this model-specific window may take. */
  readonly capPercent?: number | undefined
  /**
   * The lowercased model family this window caps, for providers that limit one
   * model separately from the all-models window. Unset means account-wide, and
   * that difference is what separates a blocked account from a degraded one.
   */
  readonly modelScope?: string | undefined
}

/**
 * Pay-as-you-go credit, for providers that report one.
 *
 * @category models
 * @since 1.0.0
 */
export interface UsageCredits {
  readonly hasCredits: boolean
  readonly unlimited: boolean
  readonly balance?: string | undefined
}

/**
 * Normalized usage for one registered account.
 *
 * @category models
 * @since 1.0.0
 */
export interface UsageReport {
  readonly accountLabel: string
  readonly provider: AccountProvider
  readonly authMode: "subscription" | "api-key"
  readonly source: UsageSource
  /** Possibly empty when `source` is `none`. */
  readonly windows: ReadonlyArray<UsageWindow>
  /** Plan or tier label the provider reports, for example `max`. */
  readonly planType?: string | undefined
  readonly credits?: UsageCredits | undefined
  /** ISO-8601 timestamp of production. */
  readonly fetchedAt: string
  /** Served from cache past its soft time to live. */
  readonly stale: boolean
  /** The windows are locally estimated, not provider-authoritative. */
  readonly estimate: boolean
  /** Why `source` is `none`, or why a probe failed. */
  readonly error?: string | undefined
  /** Non-secret signed-in subscription identity. */
  readonly signedInAs?: string | undefined
  /** Other registered labels resolving to the same subscription. */
  readonly duplicateOf?: ReadonlyArray<string> | undefined
}

/**
 * A report for an account whose provider exposes no usage surface.
 *
 * @category constructors
 * @since 1.0.0
 */
export const none = (input: {
  readonly accountLabel: string
  readonly provider: AccountProvider
  readonly authMode: "subscription" | "api-key"
  readonly fetchedAt: string
  readonly error?: string | undefined
}): UsageReport => ({
  accountLabel: input.accountLabel,
  provider: input.provider,
  authMode: input.authMode,
  source: "none",
  windows: [],
  fetchedAt: input.fetchedAt,
  stale: false,
  estimate: false,
  ...(input.error === undefined ? {} : { error: input.error })
})
