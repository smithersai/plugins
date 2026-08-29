/**
 * The shipped adapters as executable flows.
 *
 * {@link module:CliRun} is a runner: a caller that already holds a
 * {@link module:Spec} and a `ChildProcessSpawner` can drive Claude Code or
 * Codex with it. Nothing in a cell or a flow holds either. A cell's only
 * authority is `ctx.call(flow, input)`, so an adapter that is not projected as
 * a flow binding is an adapter no agent can reach.
 *
 * This module is that projection. Each shipped spec becomes one
 * `@smthrs/harness` `FlowBinding` named `agents.<adapter>`, and
 * {@link source} composes them into the `FlowBinding.Source` a host hands
 * `FlowBinding.catalog`. The runner is unchanged: a binding decodes the call's
 * input, calls `CliRun.run`, and maps an `AdapterError` through
 * `AdapterError.toHarnessError` so a quota refusal or a lapsed login reaches
 * the controller rather than being swallowed into a call result.
 *
 * The vendor's own records do not cross the boundary. They are vendor-shaped
 * and change with the vendor, so the flow answers their count and the decoded
 * answer, which is the part the contract can keep.
 *
 * @since 1.0.0
 */
import * as Effects from "@smthrs/core/Effects"
import * as Flow from "@smthrs/core/Flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import { Context, Effect, Schema } from "effect"
import * as AdapterError from "./AdapterError.ts"
import * as AdapterRuntime from "./AdapterRuntime.ts"
import * as CliRun from "./CliRun.ts"
import type * as Spec from "./Spec.ts"

/**
 * The flow name one adapter is disclosed under.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const flowName = (adapter: string): string => `agents.${adapter}`

/**
 * What a call to an adapter flow carries.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The task the agent is given" }),
  cwd: Schema.optional(
    Schema.String.annotate({ description: "Working directory the agent runs in" })
  ),
  resume: Schema.optional(
    Schema.String.annotate({ description: "Vendor session id to resume rather than starting fresh" })
  ),
  configDir: Schema.optional(
    Schema.String.annotate({ description: "Isolated configuration directory naming the seat to run on" })
  )
})

/**
 * What an adapter flow answers.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  answer: Schema.String,
  exitCode: Schema.Number,
  sessionId: Schema.optional(Schema.String),
  recordCount: Schema.Number
})

/**
 * The effect declaration every adapter flow carries.
 *
 * An agent subprocess reads and writes whatever its task reaches, so the
 * declaration is `expected` rather than hermetic and `irreversible` rather than
 * sealed. Serializing on conflict is the conservative reading: two vendor CLIs
 * editing one tree concurrently is not a thing this package can reason about.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects: Effects.Declaration = Effects.make({
  reads: ["**"],
  writes: ["**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
})

/**
 * The declaration one adapter is disclosed as.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = (spec: Spec.Spec): Flow.Flow<typeof Input, typeof Output, never> =>
  Flow.make({
    name: flowName(spec.capabilities.name),
    description: `Run the ${spec.capabilities.name} agent CLI on a prompt and answer what it produced.`,
    input: Input,
    output: Output,
    // The binary is not a field on a spec; it is whatever the spec's own
    // builder puts in the command position, which is the thing a grant has to
    // name.
    capabilities: [`proc:spawn:${spec.buildCommand({ prompt: "" }).command}`],
    effects
  })

/**
 * Runs one adapter for a decoded call.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = (
  spec: Spec.Spec,
  input: typeof Input.Type
): Effect.Effect<typeof Output.Type, AdapterError.AdapterError, ChildProcessSpawner> =>
  Effect.map(
    CliRun.run(spec, {
      prompt: input.prompt,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
      ...(input.resume === undefined ? {} : { resume: { sessionId: input.resume } })
    }),
    (outcome) => ({
      answer: outcome.answer,
      exitCode: outcome.exitCode,
      ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      recordCount: outcome.records.length
    })
  )

/**
 * Binds one adapter spec to its runner.
 *
 * The failure channel is the point. `AdapterError.toHarnessError` keeps a quota
 * refusal, a lapsed login, and a lost session typed, so the controller can move
 * the work to another seat. A binding that let those decay into an ordinary
 * call failure would hand the cell a refusal it would cheerfully retry on the
 * same dead account.
 *
 * @category constructors
 * @since 1.0.0
 */
export const binding = (spec: Spec.Spec): FlowBinding.Binding<ChildProcessSpawner> =>
  FlowBinding.make({
    flow: flow(spec),
    handler: (input) =>
      Effect.mapError(run(spec, input), (error) => AdapterError.toHarnessError(error))
  })

/**
 * The shipped adapters as one flow source.
 *
 * The spawner is supplied by the host rather than required by the source,
 * because `FlowBinding.Source` resolves its bindings with no environment.
 *
 * @category constructors
 * @since 1.0.0
 */
export const source = (
  services: Context.Context<ChildProcessSpawner>,
  specs: ReadonlyArray<Spec.Spec> = AdapterRuntime.specs
): FlowBinding.Source =>
  FlowBinding.source(
    "agents/cli",
    specs.map((spec) => FlowBinding.provide(binding(spec), services))
  )

/**
 * The shipped adapters as a flow source, over the ambient spawner.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sourceEffect: Effect.Effect<FlowBinding.Source, never, ChildProcessSpawner> = Effect.map(
  Effect.context<ChildProcessSpawner>(),
  (services) => source(services)
)
