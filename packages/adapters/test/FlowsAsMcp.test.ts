import * as FileSystem from "@smithers/kernel/FileSystem"
import { Cause, Effect, Layer, Option, PlatformError, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowsAsMcp from "../src/FlowsAsMcp.ts"
import { type ChildRunInvoker, render } from "../src/FlowsAsMcp.ts"
import type { Selection } from "../src/Projection.ts"
import { ProjectionError } from "../src/Projection.ts"

const selection: Selection = {
  descriptors: [] as const,
  names: new Map([["inspect flow", "inspect"]]),
  flowNames: new Map([["inspect", "inspect flow"]]),
  digest: "selection",
  flows: [{
    descriptor: { name: "inspect flow", description: "Inspect", capabilities: [] },
    toolName: "inspect",
    inputSchema: { type: "object" }
  }] as Selection["flows"]
}

describe("FlowsAsMcp", () => {
  it("renders tools and re-enters through the child invoker", async () => {
    const surface = await Effect.runPromise(render(selection, { mcpBootstrap: "inline-config" }))
    const calls: Array<Parameters<ChildRunInvoker>[0]> = []
    const invoker: ChildRunInvoker = (call) =>
      Effect.sync(() => {
        calls.push(call)
        return { ok: true }
      })
    const result = await Effect.runPromise(
      surface.handler(invoker)({
        name: "inspect",
        arguments: { path: "/tmp" },
        requestId: 7,
        callerIdentity: "client-a"
      })
    )
    expect(surface.tools).toEqual([{ name: "inspect", description: "Inspect", inputSchema: { type: "object" } }])
    expect(calls).toEqual([{
      flowName: "inspect flow",
      input: { path: "/tmp" },
      callerIdentity: "client-a",
      idempotencyKey: expect.stringMatching(/^flows:mcp:[0-9a-f]{64}$/)
    }])
    expect(result.content[0]?.text).toBe("{\"ok\":true}")
  })

  it("keys child calls by flow, caller, request, selection, and input", async () => {
    const surface = await Effect.runPromise(render(selection, { mcpBootstrap: "inline-config" }))
    const keys: Array<string> = []
    const invoke: ChildRunInvoker = (call) =>
      Effect.sync(() => {
        keys.push(call.idempotencyKey)
        return null
      })
    await Effect.runPromise(
      surface.handler(invoke)({
        name: "inspect",
        arguments: { path: "/a" },
        requestId: 1,
        callerIdentity: "caller"
      })
    )
    await Effect.runPromise(
      surface.handler(invoke)({
        name: "inspect",
        arguments: { path: "/b" },
        requestId: 1,
        callerIdentity: "caller"
      })
    )
    expect(keys[0]).not.toBe(keys[1])
  })

  it("fails with a typed error when bootstrap is unavailable", async () => {
    await expect(Effect.runPromise(render(selection, { mcpBootstrap: "none" }))).rejects.toMatchObject({
      code: "unsupported"
    })
  })

  describe("handler failures", () => {
    const handle = (
      call: FlowsAsMcp.ToolCall,
      invoker: ChildRunInvoker = () => Effect.succeed(null)
    ) => Effect.runSyncExit(FlowsAsMcp.handler(selection, invoker)(call))

    it("rejects a tool name which is not in the selection", () => {
      const exit = handle({ name: "unknown", arguments: {}, requestId: 1, callerIdentity: "caller" })
      expect(exit._tag).toBe("Failure")
      expect(Effect.runSync(Effect.flip(
        FlowsAsMcp.handler(selection, () => Effect.succeed(null))({
          name: "unknown",
          arguments: {},
          requestId: 1,
          callerIdentity: "caller"
        })
      ))).toMatchObject({
        code: "invalid_request",
        message: "unknown MCP tool \"unknown\""
      })
    })

    it("substitutes an empty object for absent arguments", () => {
      const inputs: Array<unknown> = []
      Effect.runSync(
        FlowsAsMcp.handler(selection, (call) =>
          Effect.sync(() => {
            inputs.push(call.input)
            return null
          }))({ name: "inspect", arguments: undefined, requestId: 1, callerIdentity: "caller" })
      )
      expect(inputs).toEqual([{}])
    })

    it("rejects arguments which cannot be canonicalized into an idempotency key", () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const error = Effect.runSync(
        Effect.flip(
          FlowsAsMcp.handler(selection, () => Effect.succeed(null))({
            name: "inspect",
            arguments: circular,
            requestId: 1,
            callerIdentity: "caller"
          })
        )
      )
      expect(error).toMatchObject({
        code: "invalid_request",
        message: "MCP tool arguments must be serializable JSON"
      })
    })

    it("rejects a child result which cannot be serialized", () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const error = Effect.runSync(
        Effect.flip(
          FlowsAsMcp.handler(selection, () => Effect.succeed(circular))({
            name: "inspect",
            arguments: {},
            requestId: 1,
            callerIdentity: "caller"
          })
        )
      )
      expect(error).toMatchObject({
        code: "invalid_request",
        message: "child run returned a non-serializable result"
      })
    })

    it("propagates a child run failure unchanged", () => {
      const failure = new ProjectionError({ code: "invalid_request", message: "the child run was denied" })
      const error = Effect.runSync(
        Effect.flip(
          FlowsAsMcp.handler(selection, () => Effect.fail(failure))({
            name: "inspect",
            arguments: {},
            requestId: 1,
            callerIdentity: "caller"
          })
        )
      )
      expect(error).toBe(failure)
    })

    it("returns a string result verbatim and bounds an oversized one at a UTF-8 boundary", () => {
      const verbatim = Effect.runSync(
        FlowsAsMcp.handler(selection, () => Effect.succeed("plain text"))({
          name: "inspect",
          arguments: {},
          requestId: 1,
          callerIdentity: "caller"
        })
      )
      expect(verbatim.content).toEqual([{ type: "text", text: "plain text" }])

      const oversized = Effect.runSync(
        FlowsAsMcp.handler(selection, () => Effect.succeed(`${"a".repeat(16 * 1024 - 1)}😀tail`))({
          name: "inspect",
          arguments: {},
          requestId: 1,
          callerIdentity: "caller"
        })
      )
      const text = oversized.content[0]!.text
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(16 * 1024)
      expect(text).not.toContain("�")
      expect(text.startsWith("aaa")).toBe(true)
    })

    it("renders an undefined child result as null", () => {
      const result = Effect.runSync(
        FlowsAsMcp.handler(selection, () => Effect.succeed(undefined))({
          name: "inspect",
          arguments: {},
          requestId: 1,
          callerIdentity: "caller"
        })
      )
      expect(result.content[0]?.text).toBe("null")
    })

    it("exposes the same handler through the rendered surface", async () => {
      const surface = await Effect.runPromise(render(selection, { mcpBootstrap: "project-config" }))
      expect(surface.digest).toMatch(/^[0-9a-f]{64}$/)
      const exit = handle({ name: "inspect", arguments: {}, requestId: 1, callerIdentity: "caller" })
      expect(exit._tag).toBe("Success")
    })
  })

  describe("server hosts", () => {
    it("fails to serve without a configured host", () => {
      const error = Effect.runSync(
        Effect.flip(
          Effect.scoped(FlowsAsMcp.makeServerNoop().serve([], () => Effect.succeed({ content: [] })))
        )
      )
      expect(error).toMatchObject({
        code: "unsupported",
        message: "no MCP projection server host is configured"
      })
    })

    it("provides a host through both layer constructors", () => {
      const endpointFrom = (layer: Layer.Layer<FlowsAsMcp.Server>) =>
        Effect.runSync(
          Effect.scoped(
            Effect.gen(function*() {
              const server = yield* FlowsAsMcp.Server
              return yield* server.serve([], () => Effect.succeed({ content: [] }))
            })
          ).pipe(Effect.provide(layer))
        )
      expect(
        endpointFrom(
          FlowsAsMcp.layerServer({ serve: () => Effect.succeed({ transport: "http", url: "http://127.0.0.1/mcp" }) })
        )
      ).toEqual({ transport: "http", url: "http://127.0.0.1/mcp" })

      const error = Effect.runSync(
        Effect.flip(
          Effect.scoped(
            Effect.gen(function*() {
              const server = yield* FlowsAsMcp.Server
              return yield* server.serve([], () => Effect.succeed({ content: [] }))
            })
          ).pipe(Effect.provide(FlowsAsMcp.layerServerNoop))
        )
      )
      expect(error.code).toBe("unsupported")
    })
  })

  describe("mount", () => {
    const runMount = <A, E>(effect: Effect.Effect<A, E, FlowsAsMcp.Server | FileSystem.FileSystem | Scope.Scope>) =>
      Effect.runPromiseExit(
        Effect.scoped(effect).pipe(
          Effect.provide(
            Layer.merge(
              FlowsAsMcp.layerServer({
                serve: () => Effect.succeed({ transport: "http", url: "http://127.0.0.1:9417/mcp" })
              }),
              fileSystemLayer()
            )
          )
        )
      )

    let written: Array<{ path: string; content: string }> = []
    const fileSystemLayer = (
      overrides: Partial<Parameters<typeof FileSystem.layerNoop>[0]> = {}
    ) =>
      FileSystem.layerNoop({
        makeTempDirectoryScoped: ({ prefix }) => Effect.succeed(`/tmp/${prefix}mounted`),
        writeFileString: (path, content) =>
          Effect.sync(() => {
            written.push({ path, content })
          }),
        ...overrides
      })

    it("rejects a mount for a harness with no MCP bootstrap", async () => {
      const rendered = await Effect.runPromise(render(selection, { mcpBootstrap: "inline-config" }))
      const exit = await runMount(FlowsAsMcp.mount(rendered, { mcpBootstrap: "none" }, () => Effect.succeed(null)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({ code: "unsupported" })
    })

    it("mounts an http endpoint as inline configuration arguments", async () => {
      const rendered = await Effect.runPromise(render(selection, { mcpBootstrap: "inline-config" }))
      const exit = await runMount(
        FlowsAsMcp.mount(rendered, { mcpBootstrap: "inline-config" }, () => Effect.succeed(null))
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Failure") return
      expect(exit.value.config).toEqual({ mcpServers: { flows: { type: "http", url: "http://127.0.0.1:9417/mcp" } } })
      expect(exit.value.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(exit.value.harnessOptions.commandOptions?.({} as never)).toEqual({
        extraArgs: ["-c", "mcp_servers.flows.url=\"http://127.0.0.1:9417/mcp\""]
      })
    })

    it("mounts a stdio endpoint as inline command and argument configuration", async () => {
      const rendered = await Effect.runPromise(render(selection, { mcpBootstrap: "inline-config" }))
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          FlowsAsMcp.mount(rendered, { mcpBootstrap: "inline-config" }, () => Effect.succeed(null))
        ).pipe(
          Effect.provide(
            Layer.merge(
              FlowsAsMcp.layerServer({
                serve: () => Effect.succeed({ transport: "stdio", command: "flows-mcp", args: ["--serve"] })
              }),
              fileSystemLayer()
            )
          )
        )
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Failure") return
      expect(exit.value.config).toEqual({
        mcpServers: { flows: { command: "flows-mcp", args: ["--serve"] } }
      })
      expect(exit.value.harnessOptions.commandOptions?.({} as never)).toEqual({
        extraArgs: [
          "-c",
          "mcp_servers.flows.command=\"flows-mcp\"",
          "-c",
          "mcp_servers.flows.args=[\"--serve\"]"
        ]
      })
    })

    it("writes a project configuration file and points the harness at it", async () => {
      written = []
      const rendered = await Effect.runPromise(render(selection, { mcpBootstrap: "project-config" }))
      const exit = await runMount(
        FlowsAsMcp.mount(rendered, { mcpBootstrap: "project-config" }, () => Effect.succeed(null))
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Failure") return
      expect(written).toEqual([{
        path: "/tmp/flows-mcp-mounted/mcp.json",
        content: `${
          JSON.stringify({ mcpServers: { flows: { type: "http", url: "http://127.0.0.1:9417/mcp" } } }, null, 2)
        }\n`
      }])
      expect(exit.value.harnessOptions.commandOptions?.({} as never)).toEqual({
        extraArgs: ["--mcp-config", "/tmp/flows-mcp-mounted/mcp.json"]
      })
    })

    it("reports an unusable config directory as a typed projection failure", async () => {
      const rendered = await Effect.runPromise(render(selection, { mcpBootstrap: "project-config" }))
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          FlowsAsMcp.mount(rendered, { mcpBootstrap: "project-config" }, () => Effect.succeed(null))
        ).pipe(
          Effect.provide(
            Layer.merge(
              FlowsAsMcp.layerServer({
                serve: () => Effect.succeed({ transport: "http", url: "http://127.0.0.1:9417/mcp" })
              }),
              fileSystemLayer({
                makeTempDirectoryScoped: () =>
                  Effect.fail(
                    PlatformError.badArgument({
                      module: "FileSystem",
                      method: "makeTempDirectoryScoped",
                      description: "no writable temp root"
                    })
                  )
              })
            )
          )
        )
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "invalid_request",
        message: "could not create MCP config directory"
      })
    })

    it("reports an unwritable config file as a typed projection failure", async () => {
      const rendered = await Effect.runPromise(render(selection, { mcpBootstrap: "project-config" }))
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          FlowsAsMcp.mount(rendered, { mcpBootstrap: "project-config" }, () => Effect.succeed(null))
        ).pipe(
          Effect.provide(
            Layer.merge(
              FlowsAsMcp.layerServer({
                serve: () => Effect.succeed({ transport: "http", url: "http://127.0.0.1:9417/mcp" })
              }),
              fileSystemLayer({
                writeFileString: () =>
                  Effect.fail(
                    PlatformError.badArgument({
                      module: "FileSystem",
                      method: "writeFileString",
                      description: "read-only filesystem"
                    })
                  )
              })
            )
          )
        )
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "invalid_request",
        message: "could not write MCP config"
      })
    })
  })
})
