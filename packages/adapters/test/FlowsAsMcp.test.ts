import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { type ChildRunInvoker, render } from "../src/FlowsAsMcp.ts"
import type { Selection } from "../src/Projection.ts"

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
})
