/**
 * Adapter lookup.
 *
 * The registry is the one place that knows which adapters this package ships.
 * A pool that needs isolated per-account configuration asks for the multi-seat
 * view instead, and an adapter without configuration-directory isolation is
 * absent from it by construction rather than filtered out at each call site —
 * which is how a pool cannot accidentally admit one by forgetting a predicate.
 *
 * @since 1.0.0
 */
import { HashMap, Option, Result } from "effect"
import * as AdapterError from "./AdapterError.ts"
import { spec as antigravitySpec } from "./Antigravity.ts"
import { spec as claudeCodeSpec } from "./ClaudeCode.ts"
import { spec as codexSpec } from "./Codex.ts"
import * as HarnessCapabilities from "./HarnessCapabilities.ts"
import { spec as kimiSpec } from "./Kimi.ts"
import type * as Spec from "./Spec.ts"

/**
 * Every adapter this package ships, in registration order.
 *
 * The 0.x Hermes, OpenClaw, herdr, AWS, GCP, Daytona, and pi adapters are not
 * here and are not coming back: the migration ledger deletes them.
 *
 * @category registries
 * @since 1.0.0
 */
export const specs: ReadonlyArray<Spec.Spec> = Object.freeze([
  claudeCodeSpec,
  codexSpec,
  kimiSpec,
  antigravitySpec
])

/**
 * The specs keyed by adapter name.
 *
 * @category registries
 * @since 1.0.0
 */
export const byName: HashMap.HashMap<string, Spec.Spec> = HashMap.fromIterable(
  specs.map((spec) => [spec.capabilities.name, spec] as const)
)

/**
 * The capability registry over the shipped adapters.
 *
 * @category registries
 * @since 1.0.0
 */
export const capabilities: HarnessCapabilities.Registry = HarnessCapabilities.makeRegistry(
  specs.map((spec) => spec.capabilities)
)

/**
 * One resolved adapter and its plan-card material.
 *
 * @category models
 * @since 1.0.0
 */
export interface Resolved {
  readonly spec: Spec.Spec
  readonly capabilities: HarnessCapabilities.HarnessCapabilities
  readonly planCard: HarnessCapabilities.PlanCardMaterial
}

/**
 * Looks one adapter up by name.
 *
 * @category getters
 * @since 1.0.0
 */
export const lookup = (
  name: string,
  options: { readonly multiSeat?: boolean | undefined } = {}
): Result.Result<Resolved, AdapterError.Unsupported> => {
  const record = options.multiSeat === true
    ? HarnessCapabilities.lookupForMultiSeatPool(capabilities, name)
    : HarnessCapabilities.lookup(capabilities, name)
  const spec = HashMap.get(byName, name)
  if (Option.isNone(record) || Option.isNone(spec)) {
    return Result.fail(
      new AdapterError.Unsupported({
        message: options.multiSeat === true
          ? `Adapter ${name} is unavailable or lacks isolated multi-seat configuration`
          : `Adapter ${name} is not registered`
      })
    )
  }
  return Result.succeed({
    spec: spec.value,
    capabilities: record.value,
    planCard: HarnessCapabilities.planCardMaterial(record.value)
  })
}

/**
 * The names of every shipped adapter.
 *
 * @category getters
 * @since 1.0.0
 */
export const names = (): ReadonlyArray<string> => specs.map((spec) => spec.capabilities.name)
