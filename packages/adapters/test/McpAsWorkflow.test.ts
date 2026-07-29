import * as Credential from "@flows/control/Credential"
import * as Capability from "@flows/kernel/Capability"
import { Effect, Layer, Redacted } from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Mcp from "../src/Mcp.ts"
import * as McpAsWorkflow from "../src/McpAsWorkflow.ts"

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

describe("McpAsWorkflow", () => {
  const capabilities = [Capability.make("fs:read", "/workspace/**")]

  it("connects lazily, refreshes on ToolListChanged, and scopes disconnect", async () => {
    const script = scripted()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const wrapper = yield* McpAsWorkflow.make({
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
          const wrapper = yield* McpAsWorkflow.make({
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
          const wrapper = yield* McpAsWorkflow.make({
            name: "concurrent",
            transport: script.transport,
            capabilities,
            publish: (descriptors) =>
              Effect.sync(() => {
                published.push(descriptors.map((descriptor) => descriptor.name))
              })
          })
          yield* Effect.all(
            [wrapper.descriptors(), wrapper.workflows(), wrapper.list()],
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
          yield* McpAsWorkflow.make({ name: "interrupt", transport: script.transport, capabilities })
          yield* Effect.never
        })
      ).pipe(Effect.timeout(10))
    ).catch(() => undefined)
    expect(script.disconnects).toBe(1)
  })
})
