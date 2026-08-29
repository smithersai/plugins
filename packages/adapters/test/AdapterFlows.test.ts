/**
 * The adapters as flow bindings, executed.
 *
 * A cell's only authority is `ctx.call(flow, input)`, so what matters here is
 * not that `CliRun.run` works — `CliRun.test.ts` proves that — but that a
 * binding composed into a `FlowBinding.catalog` dispatches to it and answers a
 * `CallResult` the cell can read. The "binary" is `node` running a script this
 * file supplies, so the whole path is real: a real spawner, a real subprocess,
 * a real catalog.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Call, CallIdentity } from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AdapterFlows from "../src/AdapterFlows.ts"
import * as AdapterRuntime from "../src/AdapterRuntime.ts"
import * as CliClassifier from "../src/CliClassifier.ts"
import type { CliRecord } from "../src/CliOutput.ts"
import { HarnessCapabilities } from "../src/HarnessCapabilities.ts"
import type * as Spec from "../src/Spec.ts"

const spawner = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const path = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "" })

const scripted = (script: string): Spec.Spec => ({
  capabilities: new HarnessCapabilities({
    name: "scripted",
    version: "1",
    resume: "flag",
    mcpBootstrap: "none",
    skillsInstall: "none",
    configDirIsolation: true,
    nativeStructuredOutput: false,
    steer: false,
    images: false,
    usage: false
  }),
  patterns: CliClassifier.defaultPatterns,
  buildCommand: (options, resume) => ({
    command: "node",
    args: [
      "-e",
      script,
      ...(resume === undefined ? [] : ["--session", resume.sessionId]),
      ...(options.prompt === undefined ? [] : [options.prompt])
    ],
    cleanup: [],
    env: path()
  }),
  interpret: (line): CliRecord | null => {
    if (typeof line !== "object" || line === null) return null
    const value = line as Record<string, unknown>
    if (value["type"] === "session" && typeof value["id"] === "string") {
      return { type: "resumeToken", sessionId: value["id"] }
    }
    if (value["type"] === "result" && typeof value["text"] === "string") {
      return { type: "settled", assistantText: value["text"] }
    }
    return null
  }
})

const emit = (records: ReadonlyArray<unknown>, exitCode = 0, stderr = "") =>
  `${records.map((record) => `console.log(${JSON.stringify(JSON.stringify(record))})`).join(";")};` +
  (stderr === "" ? "" : `console.error(${JSON.stringify(stderr)});`) +
  `process.exit(${exitCode})`

const call = (binding: FlowBinding.Binding, input: unknown) =>
  new Call({
    flowName: binding.descriptor.name,
    input: input as never,
    capabilities: binding.descriptor.capabilities,
    effects: binding.descriptor.effects,
    placement: Option.none(),
    identity: new CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-1",
      ordinal: 0,
      declaration: "declaration-1",
      layers: []
    })
  })

const catalogOf = (spec: Spec.Spec) =>
  Effect.gen(function*() {
    const services = yield* Effect.context<never>()
    return yield* FlowBinding.catalog([AdapterFlows.source(services as never, [spec])])
  })

const dispatch = (spec: Spec.Spec, input: unknown) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function*() {
        const catalog = yield* catalogOf(spec)
        const binding = catalog.bindings.get("agents.scripted")
        if (binding === undefined) return yield* Effect.die("the catalog disclosed no binding")
        return yield* binding.run(call(binding, input))
      })
    ).pipe(Effect.provide(spawner))
  )

describe("AdapterFlows", () => {
  it("discloses every shipped adapter under agents.<name>", async () => {
    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const catalog = yield* catalogOf(AdapterRuntime.specs[0]!)
        return catalog.descriptors.map((descriptor) => descriptor.name)
      }).pipe(Effect.provide(spawner))
    )

    expect(names).toEqual([`agents.${AdapterRuntime.specs[0]!.capabilities.name}`])
    expect(AdapterRuntime.names().map(AdapterFlows.flowName)).toEqual([
      "agents.claude-code",
      "agents.codex",
      "agents.kimi",
      "agents.antigravity"
    ])
  })

  it("runs the adapter and answers the decoded turn", async () => {
    const outcome = await dispatch(
      scripted(emit([{ type: "session", id: "s-9" }, { type: "result", text: "the answer" }])),
      { prompt: "do the thing" }
    )

    expect(outcome._tag).toBe("Success")
    expect(outcome._tag === "Success" ? outcome.success.outcome : "").toBe("success")
    expect(outcome._tag === "Success" ? outcome.success.value : null).toEqual({
      answer: "the answer",
      exitCode: 0,
      sessionId: "s-9",
      recordCount: 2
    })
  })

  it("refuses input the flow's own schema rejects, catchably", async () => {
    const outcome = await dispatch(scripted(emit([])), { prompt: 7 })

    expect(outcome._tag).toBe("Success")
    expect(outcome._tag === "Success" ? outcome.success.outcome : "").toBe("failure")
  })

  it("escalates a spent quota instead of handing the cell a retryable refusal", async () => {
    // A quota refusal is not the cell's business: a cell that caught it would
    // retry on the same dead seat. It has to reach the controller as a typed
    // harness failure so a pool can move the work.
    const outcome = await dispatch(
      scripted(emit([], 1, "Claude usage limit exceeded")),
      { prompt: "do the thing" }
    )

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.code : "").toBe("adapter_quota_exhausted")
  })

  it("names the binary the run spawns as the capability it needs", () => {
    const declared = AdapterFlows.flow(scripted(emit([])))

    expect(declared.capabilities).toEqual(["proc:spawn:node"])
  })
})
