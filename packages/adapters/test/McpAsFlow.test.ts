import * as Credential from "@smithers/control/Credential"
import * as Capability from "@smithers/kernel/Capability"
import { Effect, Layer, Redacted } from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Mcp from "../src/Mcp.ts"
import * as McpAsFlow from "../src/McpAsFlow.ts"

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/mcp/${name}`, import.meta.url)), "utf8")) as Record<
    string,
    unknown
  >

const scripted = () => {
  let listener: Mcp.NotificationListener | undefined
  let requiresAuth = false
  let disconnects = 0
  let initializes = 0
  let lists = 0
  let receivedCredential = ""
  const currentTools: Array<unknown> = [...(fixture("list-tools.json").tools as ReadonlyArray<unknown>)]
  const transport = Mcp.make({
    initialize: (credential) => {
      initializes += 1
      receivedCredential = credential ?? ""
      return requiresAuth
        ? Effect.fail(new Mcp.McpError({ code: "needs_auth", message: "authorization required" }))
        : Effect.void
    },
    listTools: () => {
      lists += 1
      return Effect.succeed(currentTools)
    },
    callTool: () => Effect.succeed(fixture("mixed-result-parts.json") as Mcp.CallResult),
    notifications: (next) =>
      Effect.sync(() => {
        listener = next
      }),
    disconnect: () =>
      Effect.sync(() => {
        disconnects += 1
      })
  })
  return {
    transport,
    requiresAuth: (value: boolean) => {
      requiresAuth = value
    },
    notify: () => listener?.(fixture("tool-list-changed.json") as Mcp.Notification) ?? Effect.void,
    notifyOther: () => listener?.({ method: "notifications/message" }) ?? Effect.void,
    addTool: (tool: unknown) => currentTools.push(tool),
    get disconnects() {
      return disconnects
    },
    get receivedCredential() {
      return receivedCredential
    },
    get initializes() {
      return initializes
    },
    get lists() {
      return lists
    }
  }
}

const credentialLayer = Credential.Credential.of({
  list: () => Effect.succeed([]),
  get: () => Effect.fail(new Error("unused")),
  resolve: () => Effect.succeed(Redacted.make("credential-secret"))
})

describe("McpAsFlow", () => {
  const capabilities = [Capability.make("fs:read", "/workspace/**")]

  it("connects lazily, refreshes on ToolListChanged, and scopes disconnect", async () => {
    const script = scripted()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const wrapper = yield* McpAsFlow.make({
            name: "foreign server",
            transport: script.transport,
            capabilities
          })
          expect(yield* wrapper.status()).toBe("disconnected")
          expect((yield* wrapper.descriptors()).map((entry) => entry.name)).toEqual([
            "foreign_server_read-file",
            "foreign_server_read_file"
          ])
          expect((yield* wrapper.descriptors())[0]).toMatchObject({
            capabilities: ["fs:read:/workspace/**"],
            input: { _tag: "Module", field: "input" },
            effects: {
              reads: ["/workspace/**"],
              writes: [],
              tier: "irreversible"
            }
          })
          expect(yield* wrapper.status()).toBe("connected")
          script.addTool({ name: "new-tool", description: "new", inputSchema: {} })
          yield* script.notify()
          expect((yield* wrapper.list()).map((entry) => entry.name)).toContain("foreign_server_new-tool")
          return wrapper
        })
      )
    )
    expect(result.name).toBe("foreign server")
    expect(script.disconnects).toBe(1)
  })

  it("publishes needs_auth as a registry-visible descriptor without leaking credentials", async () => {
    const script = scripted()
    script.requiresAuth(true)
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const wrapper = yield* McpAsFlow.make({
            name: "auth server",
            transport: script.transport,
            capabilities,
            credential: { id: "named-id", name: "named credential" }
          })
          const descriptors = yield* wrapper.descriptors()
          return `${JSON.stringify(descriptors)} ${JSON.stringify(yield* wrapper.status())}`
        })
      ).pipe(Effect.provide(Layer.succeed(Credential.Credential, credentialLayer)))
    )
    expect(output).not.toContain("credential-secret")
    expect(output).toContain("needs_auth")
    expect(script.receivedCredential).toBe("credential-secret")
  })

  it("serializes concurrent lazy initialization and republishes tool-list changes", async () => {
    const script = scripted()
    const published: Array<ReadonlyArray<string>> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const wrapper = yield* McpAsFlow.make({
            name: "concurrent",
            transport: script.transport,
            capabilities,
            publish: (descriptors) =>
              Effect.sync(() => {
                published.push(descriptors.map((descriptor) => descriptor.name))
              })
          })
          yield* Effect.all(
            [wrapper.descriptors(), wrapper.flows(), wrapper.list()],
            { concurrency: "unbounded" }
          )
          expect(script.initializes).toBe(1)
          expect(script.lists).toBe(1)
          script.addTool({ name: "new-tool", inputSchema: {} })
          yield* script.notify()
          expect(script.lists).toBe(2)
          expect(published.at(-1)).toContain("concurrent_new-tool")
        })
      )
    )
  })

  it("disconnects when the owning scoped fiber is interrupted", async () => {
    const script = scripted()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* McpAsFlow.make({ name: "interrupt", transport: script.transport, capabilities })
          yield* Effect.never
        })
      ).pipe(Effect.timeout(10))
    ).catch(() => undefined)
    expect(script.disconnects).toBe(1)
  })

  const withWrapper = <A, E>(
    config: McpAsFlow.Config,
    use: (wrapper: McpAsFlow.Service) => Effect.Effect<A, E>
  ): Promise<A | Mcp.McpError> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const wrapper = yield* McpAsFlow.make(config)
          return yield* use(wrapper)
        })
      ) as Effect.Effect<A | Mcp.McpError, never, never>
    )

  describe("invocation", () => {
    it("demultiplexes a tool result through the wrapper's own artifact store", async () => {
      const script = scripted()
      const result = await withWrapper(
        { name: "invoke server", transport: script.transport, capabilities },
        (wrapper) =>
          Effect.gen(function*() {
            const demuxed = yield* wrapper.invoke("invoke_server_read-file", { path: "/workspace/a" })
            const stored = yield* wrapper.artifacts.get(demuxed.media[0]!.digest)
            return { demuxed, storedLength: stored.length }
          })
      )
      expect(result).toMatchObject({ storedLength: 5 })
      expect((result as { demuxed: Mcp.DemuxedResult }).demuxed.text).toContain("tail")
    })

    it("reports an unknown tool name as a typed protocol failure", async () => {
      const script = scripted()
      const error = await withWrapper(
        { name: "invoke server", transport: script.transport, capabilities },
        (wrapper) => Effect.flip(wrapper.invokeTool("does not exist", {}))
      )
      expect(error).toMatchObject({
        code: "protocol_error",
        message: "MCP tool \"does_not_exist\" was not found"
      })
    })

    it("redacts the resolved credential from a transport failure message", async () => {
      const transport = Mcp.make({
        initialize: () => Effect.void,
        listTools: () => Effect.succeed(fixture("list-tools.json").tools as ReadonlyArray<unknown>),
        callTool: () =>
          Effect.fail(
            new Mcp.McpError({ code: "transport_failed", message: "rejected token credential-secret" })
          ),
        notifications: () => Effect.void,
        disconnect: () => Effect.void
      })
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const wrapper = yield* McpAsFlow.make({
              name: "redacting",
              transport,
              capabilities,
              credential: { id: "named-id", name: "named credential" }
            })
            return yield* Effect.flip(wrapper.invoke("redacting_read-file", {}))
          })
        ).pipe(Effect.provide(Layer.succeed(Credential.Credential, credentialLayer)))
      )
      expect(error.code).toBe("transport_failed")
      expect(error.message).not.toContain("credential-secret")
      expect(error.message).toContain("<redacted>")
    })

    it("normalizes a foreign transport fault into a typed failure", async () => {
      const transport = Mcp.make({
        initialize: () => Effect.void,
        listTools: () => Effect.succeed(fixture("list-tools.json").tools as ReadonlyArray<unknown>),
        callTool: () => Effect.fail("a bare string" as unknown as Mcp.McpError),
        notifications: () => Effect.void,
        disconnect: () => Effect.void
      })
      const error = await withWrapper(
        { name: "foreign", transport, capabilities },
        (wrapper) => Effect.flip(wrapper.invoke("foreign_read-file", {}))
      )
      expect(error).toMatchObject({ code: "transport_failed", message: "MCP operation failed" })
    })

    it("fails the published needs_auth entry with a typed authentication failure", async () => {
      const script = scripted()
      script.requiresAuth(true)
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const wrapper = yield* McpAsFlow.make({
              name: "auth server",
              transport: script.transport,
              capabilities,
              credential: { id: "named-id", name: "named credential" }
            })
            const [entry] = yield* wrapper.flows()
            return yield* Effect.flip(entry!.invoke({}))
          })
        ).pipe(Effect.provide(Layer.succeed(Credential.Credential, credentialLayer)))
      )
      expect(error).toMatchObject({
        code: "needs_auth",
        message: "MCP server auth_server requires authentication"
      })
    })
  })

  describe("credential resolution", () => {
    const authTransport = Mcp.make({
      initialize: () => Effect.void,
      listTools: () => Effect.succeed([]),
      callTool: () => Effect.fail(new Mcp.McpError({ code: "transport_failed", message: "unused" })),
      notifications: () => Effect.void,
      disconnect: () => Effect.void
    })

    it("rejects an unnamed credential reference before contacting the server", async () => {
      const outcome = await withWrapper(
        {
          name: "unnamed credential",
          transport: authTransport,
          capabilities,
          credential: { id: " ", name: "named" }
        },
        (wrapper) =>
          Effect.gen(function*() {
            const error = yield* Effect.flip(wrapper.refresh())
            // The same failure is projected as a registry-visible auth entry.
            const descriptors = yield* wrapper.descriptors()
            return { error, names: descriptors.map((descriptor) => descriptor.name) }
          })
      )
      expect(outcome).toMatchObject({
        error: { code: "needs_auth", message: "MCP credential reference must be named" },
        names: ["unnamed_credential_needs_auth"]
      })
    })

    it("reports unavailable credential storage as needing authentication", async () => {
      const error = await withWrapper(
        {
          name: "no storage",
          transport: authTransport,
          capabilities,
          credential: { id: "id", name: "name" }
        },
        (wrapper) => Effect.flip(wrapper.refresh())
      )
      expect(error).toMatchObject({ code: "needs_auth", message: "MCP credential storage is unavailable" })
    })

    it("reports an unresolvable credential without echoing the storage failure", async () => {
      const failing = Credential.Credential.of({
        list: () => Effect.succeed([]),
        get: () => Effect.fail(new Error("unused")),
        resolve: () => Effect.fail(new Error("vault is sealed at /secrets/vault"))
      })
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const wrapper = yield* McpAsFlow.make({
              name: "unresolvable",
              transport: authTransport,
              capabilities,
              credential: { id: "id", name: "name" }
            })
            return yield* Effect.flip(wrapper.refresh())
          })
        ).pipe(Effect.provide(Layer.succeed(Credential.Credential, failing)))
      )
      expect(error).toMatchObject({ code: "needs_auth", message: "MCP credential could not be resolved" })
      expect(error.message).not.toContain("/secrets/vault")
    })
  })

  describe("lifecycle", () => {
    it("records an error status and propagates a non-authentication connection failure", async () => {
      const transport = Mcp.make({
        initialize: () => Effect.fail(new Mcp.McpError({ code: "timeout", message: "handshake timed out" })),
        listTools: () => Effect.succeed([]),
        callTool: () => Effect.fail(new Mcp.McpError({ code: "transport_failed", message: "unused" })),
        notifications: () => Effect.void,
        disconnect: () => Effect.void
      })
      const outcome = await withWrapper(
        { name: "unreachable", transport, capabilities },
        (wrapper) =>
          Effect.gen(function*() {
            const error = yield* Effect.flip(wrapper.descriptors())
            return { error, status: yield* wrapper.status() }
          })
      )
      expect(outcome).toMatchObject({
        error: { code: "timeout", message: "handshake timed out" },
        status: "error"
      })
    })

    it("refuses every operation once the wrapper is closed", async () => {
      const script = scripted()
      const outcome = await withWrapper(
        { name: "closing", transport: script.transport, capabilities },
        (wrapper) =>
          Effect.gen(function*() {
            yield* wrapper.descriptors()
            yield* wrapper.close()
            return {
              status: yield* wrapper.status(),
              error: yield* Effect.flip(wrapper.descriptors())
            }
          })
      )
      expect(outcome).toMatchObject({
        status: "disconnected",
        error: { code: "transport_failed", message: "MCP wrapper is closed" }
      })
      // Closing explicitly and then releasing the scope disconnects exactly once.
      expect(script.disconnects).toBe(1)
    })

    it("closes a transport which has no disconnect operation", async () => {
      const transport = Mcp.make({
        initialize: () => Effect.void,
        listTools: () => Effect.succeed([]),
        callTool: () => Effect.fail(new Mcp.McpError({ code: "transport_failed", message: "unused" })),
        notifications: () => Effect.void,
        disconnect: undefined
      })
      const outcome = await withWrapper(
        { name: "no disconnect", transport, capabilities },
        (wrapper) =>
          Effect.gen(function*() {
            yield* wrapper.close()
            yield* wrapper.close()
            return yield* wrapper.status()
          })
      )
      expect(outcome).toBe("disconnected")
    })

    it("reports a failing disconnect as a typed failure", async () => {
      const transport = Mcp.make({
        initialize: () => Effect.void,
        listTools: () => Effect.succeed([]),
        callTool: () => Effect.fail(new Mcp.McpError({ code: "transport_failed", message: "unused" })),
        notifications: () => Effect.void,
        disconnect: () => Effect.fail(new Mcp.McpError({ code: "timeout", message: "disconnect timed out" }))
      })
      const error = await withWrapper(
        { name: "bad disconnect", transport, capabilities },
        (wrapper) => Effect.flip(wrapper.close())
      )
      expect(error).toMatchObject({ code: "timeout", message: "disconnect timed out" })
    })

    it("re-lists tools on an explicit refresh and ignores unrelated notifications", async () => {
      const script = scripted()
      const outcome = await withWrapper(
        { name: "refreshing", transport: script.transport, capabilities },
        (wrapper) =>
          Effect.gen(function*() {
            yield* wrapper.descriptors()
            const afterConnect = script.lists
            yield* wrapper.refresh()
            const afterRefresh = script.lists
            yield* script.notifyOther()
            return { afterConnect, afterRefresh, afterUnrelated: script.lists }
          })
      )
      expect(outcome).toEqual({ afterConnect: 1, afterRefresh: 2, afterUnrelated: 2 })
    })

    it("stays connected when the server refuses a notification subscription", async () => {
      let subscriptions = 0
      const transport = Mcp.make({
        initialize: () => Effect.void,
        listTools: () => Effect.succeed(fixture("list-tools.json").tools as ReadonlyArray<unknown>),
        callTool: () => Effect.fail(new Mcp.McpError({ code: "transport_failed", message: "unused" })),
        notifications: () => {
          subscriptions += 1
          return Effect.fail(new Mcp.McpError({ code: "unsupported_content", message: "no notifications" }))
        },
        disconnect: () => Effect.void
      })
      const outcome = await withWrapper(
        { name: "quiet", transport, capabilities },
        (wrapper) =>
          Effect.gen(function*() {
            const descriptors = yield* wrapper.descriptors()
            return { count: descriptors.length, status: yield* wrapper.status() }
          })
      )
      expect(outcome).toEqual({ count: 2, status: "connected" })
      expect(subscriptions).toBe(1)
    })

    it("uses an injected artifact store when the application provides one", async () => {
      const script = scripted()
      const shared = Mcp.makeArtifactStoreMemory()
      const digest = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const wrapper = yield* McpAsFlow.make({
              name: "shared store",
              transport: script.transport,
              capabilities
            })
            const demuxed = yield* wrapper.invoke("shared_store_read-file", {})
            return demuxed.media[0]!.digest
          })
        ).pipe(Effect.provideService(Mcp.ArtifactStore, shared))
      )
      expect(Effect.runSync(shared.get(digest))).toHaveLength(5)
    })
  })

  describe("stubs", () => {
    it("returns an empty registry projection and fails every invocation", async () => {
      const stub = McpAsFlow.makeNoop()
      expect(await Effect.runPromise(stub.status())).toBe("disconnected")
      expect(await Effect.runPromise(stub.descriptors())).toEqual([])
      expect(await Effect.runPromise(stub.list())).toEqual([])
      expect(await Effect.runPromise(stub.flows())).toEqual([])
      expect(await Effect.runPromise(stub.refresh())).toBeUndefined()
      expect(await Effect.runPromise(stub.close())).toBeUndefined()
      for (const operation of [stub.get("x"), stub.invoke("x", {}), stub.invokeTool("x", {})]) {
        expect(await Effect.runPromise(Effect.flip(operation))).toMatchObject({
          code: "transport_failed",
          message: "MCP flow wrapper is unavailable"
        })
      }
    })

    it("honors overrides and provides the stub as a layer", async () => {
      const named = await Effect.runPromise(
        Effect.gen(function*() {
          const wrapper = yield* McpAsFlow.McpAsFlow
          return wrapper.name
        }).pipe(Effect.provide(McpAsFlow.layerNoop({ name: "overridden" })))
      )
      expect(named).toBe("overridden")
    })

    it("provides a live wrapper as a layer", async () => {
      const script = scripted()
      const names = await Effect.runPromise(
        Effect.gen(function*() {
          const wrapper = yield* McpAsFlow.McpAsFlow
          const descriptors = yield* wrapper.descriptors()
          return descriptors.map((descriptor) => descriptor.name)
        }).pipe(
          Effect.provide(McpAsFlow.layer({ name: "layered", transport: script.transport, capabilities }))
        )
      )
      expect(names).toEqual(["layered_read-file", "layered_read_file"])
    })
  })
})
