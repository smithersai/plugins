/**
 * The adapters as flow bindings, executed.
 *
 * A cell's only authority is `ctx.call(flow, input)`, so what matters here is
 * not that `CliRun.run` works — `CliRun.test.ts` proves that — but that a
 * binding composed into a `FlowBinding.catalog` dispatches to it and answers a
 * `CallResult` the cell can read. The "binary" is `node` running a script this
 * file supplies, so the whole path is real: a real spawner, a real subprocess,
 * a real catalog.
 *
 * Two of the cases drive the shipped `ClaudeCode.spec` and `Codex.spec`
 * themselves rather than a synthetic one. `node` stands in for the vendor
 * binary — a stub named `claude` or `codex`, first on the caller's `PATH`,
 * that records the argv it was given and replays a captured transcript from
 * `test/fixtures` — so the shipped builder's flags, the shipped reader, and the
 * flow's own decoding are all exercised without a credential.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Call, CallIdentity } from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Layer, Option } from "effect"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import * as AdapterFlows from "../src/AdapterFlows.ts"
import * as ClaudeCode from "../src/ClaudeCode.ts"
import * as Codex from "../src/Codex.ts"
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

/**
 * A stub vendor binary, first on `PATH`.
 *
 * It records the argv the adapter built and replays a captured transcript, so
 * a shipped spec can be dispatched end to end with no credential and no
 * vendor CLI installed.
 */
const stubBinary = (name: string, fixture: string): { readonly directory: string; readonly argvFile: string } => {
  const directory = mkdtempSync(join(tmpdir(), `${name}-stub-`))
  const argvFile = join(directory, "argv.json")
  const fixturePath = fileURLToPath(new URL(`fixtures/${fixture}`, import.meta.url))
  const stub = join(directory, name)
  writeFileSync(
    stub,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs")\n` +
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))\n` +
      `process.stdout.write(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"))\n`
  )
  chmodSync(stub, 0o755)
  return { directory, argvFile }
}

const originalPath = process.env["PATH"] ?? ""

afterAll(() => {
  process.env["PATH"] = originalPath
})

const withStubOnPath = <A>(directory: string, body: () => Promise<A>): Promise<A> => {
  process.env["PATH"] = `${directory}:${originalPath}`
  return body().finally(() => {
    process.env["PATH"] = originalPath
  })
}

const dispatchNamed = (spec: Spec.Spec, name: string, input: unknown) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function*() {
        const catalog = yield* catalogOf(spec)
        const binding = catalog.bindings.get(name)
        if (binding === undefined) return yield* Effect.die(`the catalog disclosed no ${name} binding`)
        return yield* binding.run(call(binding, input))
      })
    ).pipe(Effect.provide(spawner))
  )

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

  it("reaches Claude Code through the shipped spec, with node standing in for the binary", async () => {
    const stub = stubBinary("claude", "claude-code/success.ndjson")

    const outcome = await withStubOnPath(
      stub.directory,
      () => dispatchNamed(ClaudeCode.spec, "agents.claude-code", { prompt: "check the seam", cwd: stub.directory })
    )

    expect(outcome._tag).toBe("Success")
    expect(outcome._tag === "Success" ? outcome.success.outcome : "").toBe("success")
    expect(outcome._tag === "Success" ? outcome.success.value : null).toMatchObject({
      answer: "The adapter seam is valid.",
      exitCode: 0,
      sessionId: "8f167e9f-15c7-4cb0-9bb7-6d8e29a72572"
    })
    // The shipped builder's argv is what the binary actually received.
    const argv = JSON.parse(readFileSync(stub.argvFile, "utf8")) as ReadonlyArray<string>
    expect(argv.slice(0, 4)).toEqual(["--print", "--output-format", "stream-json", "--verbose"])
    expect(argv.at(-1)).toBe("check the seam")
  }, 30_000)

  it("reaches Codex through the shipped spec, with node standing in for the binary", async () => {
    const stub = stubBinary("codex", "codex/success.jsonl")

    const outcome = await withStubOnPath(
      stub.directory,
      () => dispatchNamed(Codex.spec, "agents.codex", { prompt: "check the seam", cwd: stub.directory })
    )

    expect(outcome._tag).toBe("Success")
    expect(outcome._tag === "Success" ? outcome.success.outcome : "").toBe("success")
    expect(outcome._tag === "Success" ? outcome.success.value : null).toMatchObject({
      answer: "The Codex adapter retained every exec option.",
      exitCode: 0,
      sessionId: "0198a9cf-246c-76a2-8f32-1af472c04bee"
    })
    const argv = JSON.parse(readFileSync(stub.argvFile, "utf8")) as ReadonlyArray<string>
    expect(argv[0]).toBe("exec")
    expect(argv).toContain("--json")
    expect(argv.at(-1)).toBe("check the seam")
  }, 30_000)

  it("names the binary the run spawns as the capability it needs", () => {
    const declared = AdapterFlows.flow(scripted(emit([])))

    expect(declared.capabilities).toEqual(["proc:spawn:node"])
  })
})
