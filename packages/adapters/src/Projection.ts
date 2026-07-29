/**
 * Selects registry entries for a harness discovery surface.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Wrapping Adapters.md` and
 * `docs/specs/Concepts/Injection And Decoration.md`.
 *
 * @since 0.1.0
 */
import * as Visibility from "@flows/harness/Visibility"
import * as Capability from "@flows/kernel/Capability"
import * as Digest from "@flows/keys/Digest"
import { CanonicalJson } from "@flows/model"
import type { FlowDescriptor, SchemaRef } from "@flows/registry/Descriptor"
import type { Registry } from "@flows/registry/Registry"
import { Context, Effect, Layer, Schema } from "effect"

/**
 * A JSON Schema document suitable for an external discovery surface.
 *
 * @category models
 * @since 0.1.0
 */
export type JsonSchema = Readonly<Record<string, unknown>>

/**
 * Stable errors raised while producing a discovery projection.
 *
 * @category errors
 * @since 0.1.0
 */
export class ProjectionError extends Schema.TaggedErrorClass<ProjectionError>()("flows/adapters/ProjectionError", {
  code: Schema.Literals(["name_collision", "registry_unavailable", "unsupported", "invalid_request"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Resolves a registry schema reference without loading a flow body.
 *
 * @category services
 * @since 0.1.0
 */
export interface SchemaResolver {
  readonly resolve: (reference: SchemaRef) => Effect.Effect<JsonSchema, ProjectionError>
}

/**
 * Service tag for schema projection.
 *
 * @category services
 * @since 0.1.0
 */
export const SchemaResolver: Context.Service<SchemaResolver, SchemaResolver> = Context.Service(
  "flows/adapters/SchemaResolver"
)

/**
 * Constructs a schema resolver service.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeSchemaResolver = (resolve: SchemaResolver["resolve"]): SchemaResolver => SchemaResolver.of({ resolve })

/**
 * Provides a schema resolver service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSchemaResolver = (resolve: SchemaResolver["resolve"]): Layer.Layer<SchemaResolver> =>
  Layer.succeed(SchemaResolver)(makeSchemaResolver(resolve))

/**
 * The capability envelope available to a projection seat.
 *
 * A harness capability record may carry this as either `envelope` or
 * `capabilities`; accepting both keeps the projection independent from the
 * concrete harness declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type SeatCapabilities =
  | ReadonlySet<string>
  | ReadonlyArray<string>
  | {
    readonly capabilities?: ReadonlySet<string> | ReadonlyArray<string>
    readonly envelope?: ReadonlySet<string> | ReadonlyArray<string>
    readonly capabilityEnvelope?: ReadonlyArray<Capability.CapabilityPattern>
    readonly visibility?: Visibility.Seat | Visibility.Ruleset
  }

/**
 * One selected flow and its surface-safe name and input schema.
 *
 * @category models
 * @since 0.1.0
 */
export interface SelectedFlow {
  readonly descriptor: FlowDescriptor
  readonly toolName: string
  readonly inputSchema: JsonSchema
}

/**
 * The deterministic registry projection shared by skills and MCP rendering.
 *
 * @category models
 * @since 0.1.0
 */
export interface Selection {
  readonly descriptors: ReadonlyArray<FlowDescriptor>
  readonly flows: ReadonlyArray<SelectedFlow>
  /** Maps each registry flow name to its surface-safe tool name. */
  readonly names: ReadonlyMap<string, string>
  /** Maps each surface-safe tool name back to its registry flow name. */
  readonly flowNames: ReadonlyMap<string, string>
  readonly digest: string
}

const permissiveObjectSchema: JsonSchema = Object.freeze({ type: "object", additionalProperties: true })

const digest = (value: unknown): Effect.Effect<string, ProjectionError> =>
  Effect.try({
    try: () => {
      const plain = JSON.parse(JSON.stringify(value)) as unknown
      return Digest.digest(CanonicalJson.stringify(plain))
    },
    catch: () =>
      new ProjectionError({
        code: "invalid_request",
        message: "registry projection contains non-serializable key material"
      })
  })

const sanitizeName = (name: string): string => {
  const normalized = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized.length === 0 ? "flow" : normalized
}

interface ResolvedSeat {
  readonly strings: ReadonlySet<string>
  readonly patterns: ReadonlyArray<Capability.CapabilityPattern>
  readonly visibility?: Visibility.Seat | Visibility.Ruleset | undefined
}

const isStructuredSeat = (
  seat: SeatCapabilities
): seat is Exclude<SeatCapabilities, ReadonlySet<string> | ReadonlyArray<string>> =>
  !(seat instanceof Set) && !Array.isArray(seat)

const envelope = (seat: SeatCapabilities): ResolvedSeat => {
  if (seat instanceof Set) return { strings: seat, patterns: [] }
  if (isStructuredSeat(seat)) {
    return {
    strings: new Set(seat.envelope ?? seat.capabilities ?? []),
    patterns: seat.capabilityEnvelope ?? [],
    visibility: seat.visibility
    }
  }
  return { strings: new Set(seat), patterns: [] }
}

const actionOf = (capability: string): string => capability.split(":").slice(0, 2).join(":")

const permits = (available: ResolvedSeat, required: string): boolean => {
  if (available.strings.has(required) || available.strings.has("*")) return true
  const action = actionOf(required)
  if (available.strings.has(action) || available.strings.has(`${action.split(":")[0]}:*`)) return true
  const exact = Capability.parse(required)
  return exact._tag === "Some" && available.patterns.some((pattern) => Capability.matches(pattern, exact.value))
}

/**
 * Selects visible flow descriptors whose declared capabilities fit the seat,
 * resolving input schemas with a permissive fallback for unavailable schemas.
 *
 * @category conversions
 * @since 0.1.0
 */
export const select = (
  registry: Registry,
  seatCapabilities: SeatCapabilities
): Effect.Effect<Selection, ProjectionError, SchemaResolver> =>
  Effect.gen(function*() {
    const resolver = yield* SchemaResolver
    const registryVisible = yield* registry.visible().pipe(
      Effect.mapError((cause) =>
        new ProjectionError({
          code: "registry_unavailable",
          message: "could not read visible registry descriptors",
          cause
        })
      )
    )
    const available = envelope(seatCapabilities)
    const visible = available.visibility === undefined
      ? registryVisible
      : Visibility.filter(registryVisible, available.visibility)
    const names = new Map<string, string>()
    const flowNames = new Map<string, string>()
    const selected: Array<SelectedFlow> = []
    for (const descriptor of visible) {
      if (!descriptor.capabilities.every((capability) => permits(available, capability))) continue
      const toolName = sanitizeName(descriptor.name)
      const prior = flowNames.get(toolName)
      if (prior !== undefined && prior !== descriptor.name) {
        return yield* Effect.fail(
          new ProjectionError({
            code: "name_collision",
            message: `flows "${prior}" and "${descriptor.name}" both project as "${toolName}"`
          })
        )
      }
      names.set(descriptor.name, toolName)
      flowNames.set(toolName, descriptor.name)
      const inputSchema = yield* resolver.resolve(descriptor.input).pipe(
        Effect.catch(() => Effect.succeed(permissiveObjectSchema))
      )
      selected.push({ descriptor, toolName, inputSchema })
    }
    const flows = Object.freeze(
      selected.sort((left, right) =>
        left.descriptor.name.localeCompare(right.descriptor.name) || left.toolName.localeCompare(right.toolName)
      )
    )
    const selectionDigest = yield* digest(flows.map(({ descriptor, toolName, inputSchema }) => ({
      name: descriptor.name,
      toolName,
      description: descriptor.description,
      capabilities: [...descriptor.capabilities].sort(),
      input: inputSchema,
      body: descriptor.body,
      output: descriptor.output
    })))
    return {
      descriptors: Object.freeze(flows.map((flow) => flow.descriptor)),
      flows,
      names,
      flowNames,
      digest: selectionDigest
    }
  })

/**
 * Returns the surface-safe tool name for a registry flow name.
 *
 * @category formatting
 * @since 0.1.0
 */
export const toToolName = sanitizeName
