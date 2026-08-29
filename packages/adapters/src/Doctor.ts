/**
 * Whether the adapters this package ships are actually usable here.
 *
 * The report answers one operational question — why did my run not use the
 * agent I asked for — and it answers it before a run spends anything. Each
 * entry names the adapter, whether its binary answered a version probe, and
 * what it can do; a caller renders that or fails on it.
 *
 * Only the adapters this package ships are reported. The 0.x doctor also
 * covered Hermes, OpenClaw, and herdr, which the migration ledger deletes; a
 * doctor that still listed them would report on binaries nothing can drive.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import * as AdapterRuntime from "./AdapterRuntime.ts"
import type * as HarnessCapabilities from "./HarnessCapabilities.ts"
import type * as Spec from "./Spec.ts"

/**
 * One adapter's readiness.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  readonly name: string
  readonly available: boolean
  /** Why the adapter is unavailable. Absent when it is. */
  readonly reason?: string | undefined
  /** Whether the adapter may join a multi-account seat pool. */
  readonly multiSeat: boolean
  readonly capabilities: HarnessCapabilities.HarnessCapabilities
}

/**
 * The whole report.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly entries: ReadonlyArray<Entry>
  /** True when at least one adapter answered its probe. */
  readonly anyAvailable: boolean
}

/**
 * Probes one adapter.
 *
 * An adapter with no preflight is reported available: it declared no way to be
 * checked, and inventing a failure for it would be worse than saying nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const check = (
  spec: Spec.Spec,
  probe: Spec.Probe,
  environment: Readonly<Record<string, string>> = {}
): Effect.Effect<Entry> =>
  Effect.map(
    spec.preflight === undefined
      ? Effect.succeed(undefined)
      : Effect.match(spec.preflight(probe, environment), {
        onFailure: (error) => error,
        onSuccess: () => undefined
      }),
    (failure) => ({
      name: spec.capabilities.name,
      available: failure === undefined,
      ...(failure === undefined ? {} : { reason: failure.message }),
      multiSeat: spec.capabilities.configDirIsolation,
      capabilities: spec.capabilities
    })
  )

/**
 * Probes every shipped adapter, in registration order.
 *
 * @category constructors
 * @since 1.0.0
 */
export const report = (
  probe: Spec.Probe,
  environment: Readonly<Record<string, string>> = {}
): Effect.Effect<Report> =>
  Effect.map(
    Effect.forEach(AdapterRuntime.specs, (spec) => check(spec, probe, environment), { concurrency: 4 }),
    (entries) => ({ entries, anyAvailable: entries.some((entry) => entry.available) })
  )

/**
 * Renders a report as plain lines.
 *
 * @category conversions
 * @since 1.0.0
 */
export const format = (value: Report): string =>
  value.entries
    .map((entry) =>
      entry.available
        ? `${entry.name}: ready${entry.multiSeat ? " (poolable)" : ""}`
        : `${entry.name}: unavailable — ${entry.reason ?? "no reason reported"}`
    )
    .join("\n")
