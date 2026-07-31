/**
 * Dispatch-time registry for built-in CLI harnesses.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Agent Adapters.md`,
 * `docs/specs/Concepts/Plan.md`, and
 * `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import * as EngineLike from "@smithers/harness/EngineLike"
import * as Harness from "@smithers/harness/Harness"
import { Context, Effect, HashMap, Layer, Option } from "effect"
import * as AdapterError from "./AdapterError.ts"
import { spec as claudeCodeSpec } from "./ClaudeCode.ts"
import * as CliHarness from "./CliHarness.ts"
import { spec as codexSpec } from "./Codex.ts"
import * as HarnessCapabilities from "./HarnessCapabilities.ts"

/**
 * Built-in declarative CLI harness specifications keyed by capability name.
 *
 * @category registries
 * @since 0.1.0
 */
export const builtInSpecs: HashMap.HashMap<string, CliHarness.Spec> = HashMap.make(
  [claudeCodeSpec.capabilities.name, claudeCodeSpec],
  [codexSpec.capabilities.name, codexSpec]
)

/**
 * Built-in capability registry used by dispatch and plan-card projections.
 *
 * @category registries
 * @since 0.1.0
 */
export const builtInCapabilities = HarnessCapabilities.makeRegistry([
  claudeCodeSpec.capabilities,
  codexSpec.capabilities
])

/**
 * One resolved harness declaration and its plan-card material.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedHarness {
  readonly spec: CliHarness.Spec
  readonly capabilities: HarnessCapabilities.HarnessCapabilities
  readonly planCard: HarnessCapabilities.PlanCardMaterial
}

/**
 * Runtime adapter dispatch operations.
 *
 * @category services
 * @since 0.1.0
 */
export interface AdapterRuntime {
  readonly resolve: (
    name: string,
    options?: { readonly multiSeat?: boolean | undefined }
  ) => Effect.Effect<ResolvedHarness, AdapterError.Unsupported>
  readonly harness: (
    name: string,
    options?: CliHarness.MakeOptions
  ) => Effect.Effect<Harness.Harness, AdapterError.Unsupported, EngineLike.EngineLike>
}

/**
 * Runtime adapter dispatch service.
 *
 * @category services
 * @since 0.1.0
 */
export const AdapterRuntime: Context.Service<AdapterRuntime, AdapterRuntime> = Context.Service(
  "@smithers/adapters/AdapterRuntime"
)

/**
 * Constructs adapter dispatch over explicit spec and capability registries.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  specs: HashMap.HashMap<string, CliHarness.Spec> = builtInSpecs,
  capabilities: HarnessCapabilities.Registry = builtInCapabilities
): AdapterRuntime => {
  const resolve: AdapterRuntime["resolve"] = (name, options = {}) => {
    const record = options.multiSeat === true
      ? HarnessCapabilities.lookupForMultiSeatPool(capabilities, name)
      : HarnessCapabilities.lookup(capabilities, name)
    const spec = HashMap.get(specs, name)
    return Option.isSome(record) && Option.isSome(spec)
      ? Effect.succeed({
        spec: spec.value,
        capabilities: record.value,
        planCard: HarnessCapabilities.planCardMaterial(record.value)
      })
      : Effect.fail(
        new AdapterError.Unsupported({
          message: options.multiSeat === true
            ? `Harness ${name} is unavailable or lacks isolated multi-seat configuration`
            : `Harness ${name} is not registered`
        })
      )
  }
  return AdapterRuntime.of({
    resolve,
    harness: (name, options) =>
      resolve(name).pipe(
        Effect.flatMap((resolved) => CliHarness.make(resolved.spec, options))
      )
  })
}

/**
 * Provides the built-in adapter dispatch runtime.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<AdapterRuntime> = Layer.succeed(AdapterRuntime, make())

/**
 * Constructs an unavailable dispatch runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): AdapterRuntime =>
  AdapterRuntime.of({
    resolve: (name) =>
      Effect.fail(new AdapterError.Unsupported({ message: `Harness ${name} is not registered` })),
    harness: (name) =>
      Effect.fail(new AdapterError.Unsupported({ message: `Harness ${name} is not registered` }))
  })

/**
 * Provides an unavailable dispatch runtime.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<AdapterRuntime> = Layer.succeed(AdapterRuntime, makeNoop())
