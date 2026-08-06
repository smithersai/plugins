import * as AgentEvent from "@smithers/harness/AgentEvent"
import * as AgentStep from "@smithers/harness/AgentStep"
import * as EngineLike from "@smithers/harness/EngineLike"
import * as Harness from "@smithers/harness/Harness"
import { HarnessError } from "@smithers/harness/HarnessError"
import * as JournalEvent from "@smithers/journal/JournalEvent"
import * as Capability from "@smithers/kernel/Capability"
import { ModelRequest } from "@smithers/model"
import type { FlowDescriptor } from "@smithers/registry/Descriptor"
import type { Registry } from "@smithers/registry/Registry"
import { Cause, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AdapterError from "../src/AdapterError.ts"
import * as CliClassifier from "../src/CliClassifier.ts"
import * as CliHarness from "../src/CliHarness.ts"
import type * as CliOutput from "../src/CliOutput.ts"
import type * as CommandSpec from "../src/CommandSpec.ts"
import * as FlowsAsMcp from "../src/FlowsAsMcp.ts"
import * as HarnessCapabilities from "../src/HarnessCapabilities.ts"
import * as Projection from "../src/Projection.ts"
import { make as makeScriptedShell } from "./fixtures/scriptedShell.ts"

const capabilities = new HarnessCapabilities.HarnessCapabilities({
  name: "test-cli",
  version: "1",
  resume: "flag",
  mcpBootstrap: "none",
  skillsInstall: "none",
  configDirIsolation: true,
  nativeStructuredOutput: false,
  steer: false,
  images: false,
  usage: true
})

const resumeEntry = () =>
  Schema.decodeUnknownSync(JournalEvent.Entry)({
    runId: "run-1",
    seq: 0,
    eventId: "event-1",
    sourceId: "test",
    sourceSeq: 0,
    emittedAtMs: 0,
    eventType: "flows.harness.resume-token.v1",
    payload: {
      eventType: "flows.harness.resume-token.v1",
      agentEngine: "test-cli",
      agentResume: "lost-session",
      discardResumeSession: false
    },
    meta: {}
  })

const step = (
  journal: ReadonlyArray<JournalEvent.Entry> = []
): AgentStep.AgentStep =>
  new AgentStep.AgentStep({
    seat: "test-cli:model",
    thinkingLevel: "low",
    layers: ["host:test"],
    capabilityEnvelope: [
      new Capability.CapabilityPattern({ action: "*", resource: "*" })
    ],
    placement: Option.none(),
    input: { task: "verify" },
    system: new AgentStep.TextDeclaration({
      text: "Follow the adapter contract.",
      digest: "system"
    }),
    instructions: [],
    prompt: new AgentStep.TextDeclaration({
      text: "Complete the scripted task.",
      digest: "prompt"
    }),
    journal,
    activeToolNames: [],
    toolDefinitions: []
  })

const interpret = (value: unknown): CliOutput.CliRecord | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Readonly<Record<string, unknown>>
  switch (record.type) {
    case "turnOpened":
      return { type: "turnOpened", seat: "test-cli:model" }
    case "delta":
      return typeof record.text === "string"
        ? { type: "delta", text: record.text }
        : null
    case "resumeToken":
      return typeof record.sessionId === "string"
        ? { type: "resumeToken", sessionId: record.sessionId }
        : null
    case "settled":
      return typeof record.assistantText === "string"
        ? { type: "settled", assistantText: record.assistantText }
        : null
    case "closed":
      return { type: "closed" }
    default:
      return null
  }
}

const command = (
  cleanup: ReadonlyArray<string> = []
): CommandSpec.CommandSpec => ({
  command: "test-cli",
  args: ["--json"],
  cleanup,
  env: { TEST_ADAPTER: "1" }
})

const makeSpec = (
  buildCommand: CliHarness.Spec["buildCommand"] = () => command(),
  preflight?: CliHarness.Spec["preflight"]
): CliHarness.Spec => ({
  capabilities,
  patterns: CliClassifier.defaultPatterns,
  buildCommand,
  interpret,
  ...(preflight === undefined ? {} : { preflight })
})

const errorFrom = (
  cause: Cause.Cause<HarnessError>
): HarnessError | undefined => Option.getOrUndefined(Cause.findErrorOption(cause))

const makeHarness = (
  spec: CliHarness.Spec,
  engine: EngineLike.EngineLike = EngineLike.makeNoop(),
  options: CliHarness.MakeOptions = {}
) =>
  Effect.runSync(
    CliHarness.make(spec, options).pipe(Effect.provideService(EngineLike.EngineLike, engine))
  )

describe("CliHarness", () => {
  it("runs preflight and normalizes a successful scripted CLI stream", async () => {
    const stdout = [
      { type: "turnOpened" },
      { type: "delta", text: "working" },
      { type: "settled", assistantText: "done" },
      { type: "closed" }
    ].map((record) => JSON.stringify(record)).join("\n")
    const fixture = makeScriptedShell([
      { stdout: "test-cli 1.0.0" },
      { stdout }
    ])
    const harness = makeHarness(
      makeSpec(
        () => ({
          ...command(),
          args: ["--json", "--system-prompt", "ignored"]
        }),
        (shell, environment) => shell.exec("test-cli --version", { env: environment }).pipe(Effect.asVoid)
      )
    )
    const events = await Effect.runPromise(
      harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
        Stream.runCollect,
        Effect.map(Array.from)
      )
    )

    expect(fixture.recorder.commands[0]).toBe("test-cli --version")
    expect(fixture.recorder.environments[0]).toMatchObject({
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      TEST_ADAPTER: "1"
    })
    expect(fixture.recorder.commands[1]).toContain("test-cli --json --system-prompt")
    expect(fixture.recorder.commands[1]).toContain("## Worktree isolation")
    expect(fixture.recorder.stdin[1]).not.toContain("## Worktree isolation")
    expect(fixture.recorder.stdin[1]).toContain("Complete the scripted task.")
    expect(events.map((event) => event._tag)).toEqual([
      "turn-opened",
      "model-delta",
      "model-settled",
      "turn-closed",
      "resolved"
    ])
    expect(events[0]).toMatchObject({ contextDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it("maps quota exhaustion to a suspended HarnessError retaining resetAt", async () => {
    const suspensions: Array<EngineLike.SuspendReason> = []
    const fixture = makeScriptedShell([
      {
        stderr: "rate limit exceeded; retry after 45 seconds",
        exitCode: 1
      }
    ])
    const engine = EngineLike.makeNoop({
      suspend: (reason) =>
        Effect.sync(() => {
          suspensions.push(reason)
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new HarnessError({
                code: "suspended",
                message: reason.message,
                cause: reason.details
              })
            )
          )
        )
    })
    const harness = makeHarness(makeSpec(), engine)
    const exit = await Effect.runPromiseExit(
      harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Success") return
    const error = errorFrom(exit.cause)
    expect(error?.code).toBe("suspended")
    expect(suspensions).toHaveLength(1)
    expect(suspensions[0]).toMatchObject({
      code: "waiting-quota",
      details: {
        adapterError: "flows/adapters/QuotaExhausted",
        resetAt: expect.any(Number)
      }
    })
  })

  it("emits a poison pill before a typed session-loss failure without retrying inside the harness", async () => {
    const resumed: Array<string | undefined> = []
    const buildCommand: CliHarness.Spec["buildCommand"] = (_options, resume) => {
      resumed.push(resume?.sessionId)
      return command()
    }
    const fixture = makeScriptedShell([
      {
        stdout: JSON.stringify({
          type: "resumeToken",
          sessionId: "lost-session"
        }),
        stderr: "unknown session id: lost-session",
        exitCode: 1
      }
    ])
    const harness = makeHarness(makeSpec(buildCommand))
    const events: Array<AgentEvent.AgentEvent> = []
    const exit = await Effect.runPromiseExit(
      harness.run(step([resumeEntry()]), fixture.layer as AgentStep.HostLike).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            events.push(event)
          })
        ),
        Stream.runDrain
      )
    )

    expect(resumed).toEqual(["lost-session"])
    expect(fixture.recorder.commands).toHaveLength(1)
    expect(fixture.recorder.environments[0]).toMatchObject({
      FLOWS_RUN_ID: "run-1",
      FLOWS_NODE_ID: "test",
      FLOWS_ITERATION: "0",
      FLOWS_ATTEMPT: "0"
    })
    expect(events.at(-1)).toMatchObject({
      _tag: "resume-token",
      agentEngine: "test-cli",
      agentResume: "lost-session",
      discardResumeSession: true
    })
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(errorFrom(exit.cause)?.code).toBe("adapter_session_lost")
    }
  })

  it("emits normalized progress before the CLI process exits", async () => {
    const fixture = makeScriptedShell([
      {
        stdoutChunks: [
          `${JSON.stringify({ type: "turnOpened" })}\n`,
          `${JSON.stringify({ type: "delta", text: "already visible" })}\n`
        ],
        hangAfterOutput: true
      }
    ])
    const harness = makeHarness(makeSpec())
    const emitted: Array<AgentEvent.AgentEvent> = []

    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              emitted.push(event)
            })
          ),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(emitted.map((event) => event._tag)).toEqual(["turn-opened", "model-delta"])
        yield* Fiber.interrupt(fiber)
      })
    )
    expect(fixture.recorder.interrupted).toBe(1)
  })

  it("treats an explicit output file as authoritative over streamed assistant records", async () => {
    const outputFile = "/tmp/adapter-authoritative-output"
    const fixture = makeScriptedShell(
      [{
        stdout: [
          { type: "settled", assistantText: "streamed answer" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }],
      { [outputFile]: "authoritative answer" }
    )
    const harness = makeHarness(
      makeSpec(() => ({ ...command(), outputFile }))
    )
    const events = await Effect.runPromise(
      harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
        Stream.runCollect,
        Effect.map(Array.from)
      )
    )
    expect(JSON.stringify(events.at(-1))).toContain("authoritative answer")
    expect(JSON.stringify(events.at(-1))).not.toContain("streamed answer")
  })

  it("runs exactly one schema correction and validates the corrected row locally", async () => {
    const fixture = makeScriptedShell([
      {
        stdout: [
          { type: "settled", assistantText: "not json" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      },
      {
        stdout: [
          { type: "settled", assistantText: "{\"ok\":true}" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }
    ])
    const harness = makeHarness(
      makeSpec(),
      EngineLike.makeNoop(),
      {
        outputSchema: () => ({
          type: "object",
          required: ["ok"],
          properties: { ok: { const: true } },
          additionalProperties: false
        })
      }
    )
    const events = await Effect.runPromise(
      harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
        Stream.runCollect,
        Effect.map(Array.from)
      )
    )
    expect(fixture.recorder.commands).toHaveLength(2)
    expect(fixture.recorder.stdin[0]).toContain("\"required\": [")
    expect(fixture.recorder.stdin[1]).toContain("Validation diagnostics:")
    expect(JSON.stringify(events.at(-1))).toContain("{\\\"ok\\\":true}")
  })

  it("selects and mounts registry projections in the wrapped CLI discovery surface", async () => {
    const descriptor = {
      name: "inspect",
      description: "Inspect the workspace",
      capabilities: [],
      modelInvocable: true,
      input: { _tag: "None" },
      output: { _tag: "None" },
      body: { _tag: "Module", path: "/flows/inspect.ts" },
      flows: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      path: "/flows/inspect.ts",
      frontmatter: {},
      provenance: { source: "test", root: "/flows" }
    } as FlowDescriptor
    const registry = {
      list: () => Effect.succeed([descriptor]),
      visible: () => Effect.succeed([descriptor]),
      get: () => Effect.die("unused"),
      getOption: () => Effect.die("unused"),
      loadBody: () => Effect.die("unused"),
      runPrompt: () => Effect.die("unused"),
      refresh: () => Effect.void,
      warnings: () => Effect.succeed([])
    } as Registry
    let selections = 0
    let dispatchLayers: ReadonlyArray<string> = []
    const served: Array<ReadonlyArray<string>> = []
    const server = FlowsAsMcp.makeServer({
      serve: (tools) =>
        Effect.sync(() => {
          served.push(tools.map((tool) => tool.name))
          return { transport: "http" as const, url: "http://127.0.0.1:9417/mcp" }
        })
    })
    const fixture = makeScriptedShell([{
      stdout: [
        { type: "settled", assistantText: "projection mounted" },
        { type: "closed" }
      ].map((record) => JSON.stringify(record)).join("\n")
    }])
    const projectionSpec: CliHarness.Spec = {
      ...makeSpec((options) => ({
        ...command(),
        args: ["--json", ...(options.extraArgs ?? [])]
      })),
      capabilities: new HarnessCapabilities.HarnessCapabilities({
        ...capabilities,
        mcpBootstrap: "inline-config",
        skillsInstall: "plugin-dir"
      })
    }
    const harness = makeHarness(
      projectionSpec,
      EngineLike.makeNoop(),
      {
        commandOptions: (projectedStep) => {
          dispatchLayers = projectedStep.layers
          return {}
        },
        projection: {
          registry,
          schemaResolver: Projection.makeSchemaResolver(() =>
            Effect.succeed({ type: "object", properties: { path: { type: "string" } } })
          ),
          seatCapabilities: () => {
            selections += 1
            return []
          },
          childRunInvoker: () => Effect.succeed({ ok: true }),
          server
        }
      }
    )
    await Effect.runPromise(
      harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
    )
    expect(selections).toBe(1)
    expect(served).toEqual([["inspect"]])
    expect(fixture.recorder.commands[0]).toContain("mcp_servers.flows.url")
    expect(fixture.recorder.commands[0]).toContain("--plugin-dir")
    expect(fixture.recorder.stdin[0]).toContain("\"name\":\"inspect\"")
    expect(fixture.recorder.stdin[0]).toContain("\"fingerprint\":")
    expect(fixture.recorder.writes.some(({ path }) => path.endsWith("/skills/inspect/SKILL.md"))).toBe(true)
    expect(dispatchLayers).toEqual(expect.arrayContaining([
      "harness:test-cli@1",
      expect.stringMatching(/^harness-capabilities:/),
      expect.stringMatching(/^harness-prompt:/),
      expect.stringMatching(/^harness-projection:/)
    ]))
  })

  it("interrupts the scoped process and runs every cleanup finalizer", async () => {
    const fixture = makeScriptedShell([{ hang: true }])
    const harness = makeHarness(
      makeSpec(() => ({
        ...command(["/tmp/adapter-temp"]),
        outputFile: "/tmp/adapter-output"
      }))
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* harness.run(
          step(),
          fixture.layer as AgentStep.HostLike
        ).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      })
    )

    expect(fixture.recorder.commands).toHaveLength(1)
    expect(fixture.recorder.interrupted).toBe(1)
    expect([...new Set(fixture.recorder.cleanups)].sort()).toEqual([
      "/tmp/adapter-output",
      "/tmp/adapter-temp"
    ])
  })

  describe("process failure paths", () => {
    const failureFrom = async (
      spec: CliHarness.Spec,
      fixture: ReturnType<typeof makeScriptedShell>,
      options: CliHarness.MakeOptions = {},
      journal: ReadonlyArray<JournalEvent.Entry> = []
    ): Promise<HarnessError | undefined> => {
      const harness = makeHarness(spec, EngineLike.makeNoop(), options)
      const exit = await Effect.runPromiseExit(
        harness.run(step(journal), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return undefined
      return errorFrom(exit.cause)
    }

    it("reports a rejected command construction as a typed configuration failure", async () => {
      const fixture = makeScriptedShell([])
      const error = await failureFrom(
        makeSpec(() => {
          throw new Error("unsupported option combination")
        }),
        fixture
      )
      expect(error?.code).toBe("adapter_config_invalid")
      expect(error?.message).toBe("Unable to construct the test-cli command")
      // The process is never started when the command cannot be built.
      expect(fixture.recorder.commands).toHaveLength(0)
    })

    it("reports a host spawn failure as a typed spawn failure", async () => {
      const fixture = makeScriptedShell([{ spawnError: "test-cli: command not found" }])
      const error = await failureFrom(makeSpec(), fixture)
      expect(error?.code).toBe("adapter_spawn_failed")
      expect(error?.message).toBe("Unable to run test-cli")
    })

    it("fails when the process stream ends without reporting an exit status", async () => {
      const fixture = makeScriptedShell([{
        stdout: JSON.stringify({ type: "settled", assistantText: "done" }),
        omitExit: true
      }])
      const error = await failureFrom(makeSpec(), fixture)
      expect(error?.code).toBe("adapter_protocol_error")
      expect(error?.message).toBe("test-cli did not report a process exit status")
    })

    it("fails when the adapter rejects a structured record it cannot interpret", async () => {
      const fixture = makeScriptedShell([{ stdout: JSON.stringify({ type: "explode" }) }])
      const error = await failureFrom({
        ...makeSpec(),
        interpret: (value) => {
          if ((value as { type?: string }).type === "explode") throw new Error("bad record")
          return interpret(value)
        }
      }, fixture)
      expect(error?.code).toBe("adapter_protocol_error")
      expect(error?.message).toBe("test-cli emitted an invalid structured record")
    })

    it("fails when the output file holds a record the adapter cannot interpret", async () => {
      const outputFile = "/tmp/adapter-bad-output"
      const fixture = makeScriptedShell(
        [{ stdout: JSON.stringify({ type: "closed" }) }],
        { [outputFile]: JSON.stringify({ type: "explode" }) }
      )
      const error = await failureFrom({
        ...makeSpec(() => ({ ...command(), outputFile })),
        interpret: (value) => {
          if ((value as { type?: string }).type === "explode") throw new Error("bad record")
          return interpret(value)
        }
      }, fixture)
      expect(error?.code).toBe("adapter_protocol_error")
      expect(error?.message).toBe("test-cli emitted an invalid structured record")
    })

    it("spends exactly one correction slot before failing structured output", async () => {
      const attempt = () => ({
        stdout: [
          { type: "settled", assistantText: "still not json" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      })
      const fixture = makeScriptedShell([attempt(), attempt(), attempt()])
      const error = await failureFrom(makeSpec(), fixture, {
        outputSchema: () => ({ type: "object", required: ["ok"] })
      })
      expect(error?.code).toBe("adapter_structured_output_failed")
      // One original attempt plus exactly one correction: the third script is unused.
      expect(fixture.recorder.commands).toHaveLength(2)
      const cause = error?.cause as { correctionCount?: number; correctionLimit?: number; diagnostics?: unknown }
      expect(cause.correctionCount).toBe(1)
      expect(cause.correctionLimit).toBe(1)
      expect(cause.diagnostics).toEqual(["$: response did not contain valid JSON"])
    })

    it("reports an unreadable configured output schema as a configuration failure", async () => {
      const schemaPath = "/tmp/adapter-schema.json"
      const fixture = makeScriptedShell([], {}, [schemaPath])
      const error = await failureFrom(makeSpec(), fixture, {
        commandOptions: () => ({ outputSchemaPath: schemaPath })
      })
      expect(error?.code).toBe("adapter_config_invalid")
      expect(error?.message).toBe("The configured CLI output schema could not be read")
      expect(fixture.recorder.commands).toHaveLength(0)
    })

    it("reports a malformed configured output schema as a configuration failure", async () => {
      const schemaPath = "/tmp/adapter-schema.json"
      const fixture = makeScriptedShell([], { [schemaPath]: "{not json" })
      const error = await failureFrom(makeSpec(), fixture, {
        commandOptions: () => ({ outputSchemaPath: schemaPath })
      })
      expect(error?.code).toBe("adapter_config_invalid")
      expect(error?.message).toBe("The configured CLI output schema is not valid JSON")
    })

    it("loads a configured output schema from the host filesystem", async () => {
      const schemaPath = "/tmp/adapter-schema.json"
      const fixture = makeScriptedShell(
        [{
          stdout: [
            { type: "settled", assistantText: "{\"ok\":true}" },
            { type: "closed" }
          ].map((record) => JSON.stringify(record)).join("\n")
        }],
        { [schemaPath]: JSON.stringify({ type: "object", required: ["ok"] }) }
      )
      const harness = makeHarness(makeSpec(), EngineLike.makeNoop(), {
        commandOptions: () => ({ outputSchemaPath: schemaPath })
      })
      const events = await Effect.runPromise(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runCollect, Effect.map(Array.from))
      )
      expect(fixture.recorder.commands).toHaveLength(1)
      expect(fixture.recorder.stdin[0]).toContain("\"required\": [")
      expect(JSON.stringify(events.at(-1))).toContain("{\\\"ok\\\":true}")
    })

    it("passes a typed adapter failure out of preflight unchanged", async () => {
      const fixture = makeScriptedShell([])
      const error = await failureFrom(
        makeSpec(
          () => command(),
          () => Effect.fail(new AdapterError.BinaryMissing({ message: "test-cli is not installed" }))
        ),
        fixture
      )
      expect(error?.code).toBe("adapter_binary_missing")
      expect(error?.message).toBe("test-cli is not installed")
    })

    it("converts a foreign preflight failure into a typed spawn failure", async () => {
      const fixture = makeScriptedShell([])
      const error = await failureFrom(
        makeSpec(() => command(), () => Effect.fail("something else went wrong")),
        fixture
      )
      expect(error?.code).toBe("adapter_spawn_failed")
      expect(error?.message).toBe("Preflight failed for test-cli")
    })

    it("does not convert an unexpected defect into a resolved turn", async () => {
      // The scripted shell dies when a command has no script left, which models
      // an unexpected host defect rather than a typed failure.
      const fixture = makeScriptedShell([])
      const harness = makeHarness(makeSpec())
      const exit = await Effect.runPromiseExit(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      // A defect stays a defect: it is neither swallowed nor rewritten into a
      // typed harness failure that a caller might retry as if it were expected.
      expect(errorFrom(exit.cause)).toBeUndefined()
      expect(String(Cause.squash(exit.cause))).toContain("No scripted result")
    })
  })

  describe("resume state", () => {
    it("ignores a resume token recorded by a different harness", async () => {
      const resumed: Array<string | undefined> = []
      const foreign = Schema.decodeUnknownSync(JournalEvent.Entry)({
        runId: "run-1",
        seq: 0,
        eventId: "event-1",
        sourceId: "test",
        sourceSeq: 0,
        emittedAtMs: 0,
        eventType: "flows.harness.resume-token.v1",
        payload: {
          eventType: "flows.harness.resume-token.v1",
          agentEngine: "other-cli",
          agentResume: "foreign-session",
          discardResumeSession: false
        },
        meta: {}
      })
      const fixture = makeScriptedShell([{
        stdout: [
          { type: "settled", assistantText: "done" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }])
      const harness = makeHarness(
        makeSpec((_options, resume) => {
          resumed.push(resume?.sessionId)
          return command()
        })
      )
      await Effect.runPromise(
        harness.run(step([foreign]), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(resumed).toEqual([undefined])
    })

    it("ignores a journal entry which is not a resume token", async () => {
      const unrelated = Schema.decodeUnknownSync(JournalEvent.Entry)({
        runId: "run-1",
        seq: 0,
        eventId: "event-2",
        sourceId: "test",
        sourceSeq: 0,
        emittedAtMs: 0,
        eventType: "flows.harness.turn-closed.v1",
        payload: { eventType: "flows.harness.turn-closed.v1", stopReason: "stop", outcome: "resolved" },
        meta: {}
      })
      const resumed: Array<string | undefined> = []
      const fixture = makeScriptedShell([{
        stdout: [
          { type: "settled", assistantText: "done" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }])
      const harness = makeHarness(
        makeSpec((_options, resume) => {
          resumed.push(resume?.sessionId)
          return command()
        })
      )
      await Effect.runPromise(
        harness.run(step([unrelated]), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(resumed).toEqual([undefined])
    })

    it("poisons the session reported by a turn-opened record when no resume token was emitted", async () => {
      const fixture = makeScriptedShell([{
        stdout: JSON.stringify({ type: "turnOpened", sessionId: "opened-session" }),
        stderr: "unknown session id: opened-session",
        exitCode: 1
      }])
      const harness = makeHarness({
        ...makeSpec(),
        interpret: (value) => {
          const record = value as Readonly<Record<string, unknown>>
          return record.type === "turnOpened"
            ? { type: "turnOpened", seat: "test-cli:model", sessionId: record.sessionId as string }
            : interpret(value)
        }
      })
      const events: Array<AgentEvent.AgentEvent> = []
      await Effect.runPromiseExit(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              events.push(event)
            })
          ),
          Stream.runDrain
        )
      )
      expect(events.at(-1)).toMatchObject({
        _tag: "resume-token",
        agentResume: "opened-session",
        discardResumeSession: true
      })
    })

    it("poisons a placeholder session when the CLI never reported one", async () => {
      const fixture = makeScriptedShell([{ stderr: "no such session", exitCode: 1 }])
      const harness = makeHarness(makeSpec())
      const events: Array<AgentEvent.AgentEvent> = []
      await Effect.runPromiseExit(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              events.push(event)
            })
          ),
          Stream.runDrain
        )
      )
      expect(events.at(-1)).toMatchObject({
        _tag: "resume-token",
        agentResume: "unavailable-session",
        discardResumeSession: true
      })
    })
  })

  describe("process output handling", () => {
    it("classifies a failure the CLI reported only on stderr as newline-delimited JSON", async () => {
      const fixture = makeScriptedShell([{
        stderr: `${JSON.stringify({ type: "error", detail: "usage limit exceeded" })}\n`,
        exitCode: 1
      }])
      const suspensions: Array<EngineLike.SuspendReason> = []
      const engine = EngineLike.makeNoop({
        suspend: (reason) =>
          Effect.sync(() => {
            suspensions.push(reason)
          }).pipe(Effect.andThen(Effect.fail(new HarnessError({ code: "suspended", message: reason.message }))))
      })
      const harness = makeHarness(makeSpec(), engine)
      const exit = await Effect.runPromiseExit(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(exit._tag).toBe("Failure")
      expect(suspensions[0]?.code).toBe("waiting-quota")
    })

    it("reads an answer from an output file holding adapter records", async () => {
      const outputFile = "/tmp/adapter-record-output"
      const fixture = makeScriptedShell(
        [{ stdout: JSON.stringify({ type: "closed" }) }],
        {
          [outputFile]: [
            { type: "settled", assistantText: "answer from the output file" },
            { type: "closed" }
          ].map((record) => JSON.stringify(record)).join("\n")
        }
      )
      const harness = makeHarness(makeSpec(() => ({ ...command(), outputFile })))
      const events = await Effect.runPromise(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runCollect, Effect.map(Array.from))
      )
      expect(JSON.stringify(events.at(-1))).toContain("answer from the output file")
    })

    it("falls back to streamed records when the declared output file is absent", async () => {
      const fixture = makeScriptedShell(
        [{
          stdout: [
            { type: "settled", assistantText: "streamed answer" },
            { type: "closed" }
          ].map((record) => JSON.stringify(record)).join("\n")
        }],
        {},
        ["/tmp/adapter-missing-output"]
      )
      const harness = makeHarness(makeSpec(() => ({ ...command(), outputFile: "/tmp/adapter-missing-output" })))
      const events = await Effect.runPromise(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runCollect, Effect.map(Array.from))
      )
      expect(JSON.stringify(events.at(-1))).toContain("streamed answer")
    })

    it("registers each cleanup target once even when it is declared twice", async () => {
      const fixture = makeScriptedShell(
        [{ stdout: JSON.stringify({ type: "closed" }) }],
        {},
        ["/tmp/adapter-dup"]
      )
      const harness = makeHarness(
        makeSpec(() => ({
          ...command(["/tmp/adapter-dup", "/tmp/adapter-dup"]),
          outputFile: "/tmp/adapter-dup"
        }))
      )
      await Effect.runPromise(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      // One pre-run truncation of the output file plus exactly one registered
      // finalizer: without deduplication the same path would be removed four
      // times (two cleanup entries, the output file, and the pre-run removal).
      expect(fixture.recorder.cleanups).toEqual(["/tmp/adapter-dup", "/tmp/adapter-dup"])
    })

    it("projects the assembled system prompt into an inline --system-prompt= argument", async () => {
      const fixture = makeScriptedShell([{
        stdout: [
          { type: "settled", assistantText: "done" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }])
      const harness = makeHarness(
        makeSpec(() => ({ ...command(), args: ["--json", "--system-prompt=placeholder"] }))
      )
      await Effect.runPromise(
        harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(fixture.recorder.commands[0]).toContain("--system-prompt=")
      expect(fixture.recorder.commands[0]).not.toContain("placeholder")
      expect(fixture.recorder.commands[0]).toContain("## Worktree isolation")
      expect(fixture.recorder.stdin[0]).not.toContain("## Worktree isolation")
    })

    it("carries declared instructions into the disclosed system prompt", async () => {
      const fixture = makeScriptedShell([{
        stdout: [
          { type: "settled", assistantText: "done" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }])
      const withInstructions = new AgentStep.AgentStep({
        ...step(),
        instructions: [new AgentStep.TextDeclaration({ text: "Prefer the smallest diff.", digest: "instruction" })]
      })
      const harness = makeHarness(makeSpec())
      await Effect.runPromise(
        harness.run(withInstructions, fixture.layer as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(fixture.recorder.stdin[0]).toContain("Prefer the smallest diff.")
    })
  })

  describe("stubs", () => {
    it("fails every run of the unavailable harness stub", async () => {
      const exit = await Effect.runPromiseExit(
        CliHarness.makeNoop().run(step(), Layer.empty as AgentStep.HostLike).pipe(Stream.runDrain)
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      expect(errorFrom(exit.cause)).toMatchObject({
        code: "invalid_step",
        message: "No CLI harness implementation is configured"
      })
    })

    it("honors an override supplied to the unavailable harness stub", async () => {
      const stub = CliHarness.makeNoop({ run: () => Stream.empty })
      const events = await Effect.runPromise(
        stub.run(step(), Layer.empty as AgentStep.HostLike).pipe(Stream.runCollect, Effect.map(Array.from))
      )
      expect(events).toEqual([])
    })

    it("provides the harness through both layer constructors", async () => {
      const fixture = makeScriptedShell([{
        stdout: [
          { type: "settled", assistantText: "layered" },
          { type: "closed" }
        ].map((record) => JSON.stringify(record)).join("\n")
      }])
      const events = await Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* Harness.Harness
          return yield* harness.run(step(), fixture.layer as AgentStep.HostLike).pipe(
            Stream.runCollect,
            Effect.map(Array.from)
          )
        }).pipe(
          Effect.provide(
            CliHarness.layer(makeSpec()).pipe(
              Layer.provide(Layer.succeed(EngineLike.EngineLike)(EngineLike.makeNoop()))
            )
          )
        )
      )
      expect(JSON.stringify(events.at(-1))).toContain("layered")

      const noopExit = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const harness = yield* Harness.Harness
          return yield* harness.run(step(), Layer.empty as AgentStep.HostLike).pipe(Stream.runDrain)
        }).pipe(Effect.provide(CliHarness.layerNoop()))
      )
      expect(noopExit._tag).toBe("Failure")
    })
  })
})
