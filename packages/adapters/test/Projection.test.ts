import type { FlowDescriptor, SchemaRef } from "@flows/registry/Descriptor"
import type { Registry } from "@flows/registry/Registry"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeSchemaResolver, ProjectionError, SchemaResolver, select } from "../src/Projection.ts"

const descriptor = (name: string, capabilities: ReadonlyArray<string> = []): FlowDescriptor =>
  ({
    name,
    description: `${name} description`,
    capabilities,
    modelInvocable: true,
    input: { _tag: "None" },
    output: { _tag: "None" },
    body: { _tag: "Module", path: `/flows/${name}.ts` },
    model: undefined,
    flows: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: undefined,
    path: `/flows/${name}.ts`,
    frontmatter: {},
    provenance: { source: "test", root: "/flows" }
  }) as FlowDescriptor

const registry = (entries: ReadonlyArray<FlowDescriptor>): Registry =>
  ({
    visible: () => Effect.succeed(entries),
    list: () => Effect.succeed(entries),
    get: () => Effect.die("unused"),
    getOption: () => Effect.die("unused"),
    loadBody: () => Effect.die("unused"),
    runPrompt: () => Effect.die("unused"),
    refresh: () => Effect.void,
    warnings: () => Effect.succeed([])
  }) as Registry

const run = (
  entries: ReadonlyArray<FlowDescriptor>,
  capabilities: ReadonlyArray<string>,
  resolve: (reference: SchemaRef) => Effect.Effect<Readonly<Record<string, unknown>>, ProjectionError> = () =>
    Effect.succeed({ type: "object" })
) =>
  Effect.runPromise(
    select(registry(entries), capabilities).pipe(Effect.provideService(SchemaResolver, makeSchemaResolver(resolve)))
  )

describe("Projection", () => {
  it("filters flows outside the capability envelope", async () => {
    const result = await run([descriptor("read", ["fs:read"]), descriptor("write", ["fs:write"])], ["fs:read"])
    expect(result.descriptors.map((entry) => entry.name)).toEqual(["read"])
  })

  it("sanitizes names and rejects reversible-map collisions", async () => {
    const result = await run([descriptor("Read Files")], [])
    expect(result.flows[0]?.toolName).toBe("read-files")
    await expect(run([descriptor("a b"), descriptor("a-b")], [])).rejects.toMatchObject({ code: "name_collision" })
  })

  it("keeps the digest stable and falls back when a schema cannot resolve", async () => {
    const resolve = () => Effect.fail(new ProjectionError({ code: "unsupported", message: "unavailable" }))
    const first = await run([descriptor("stable")], [], resolve)
    const second = await run([descriptor("stable")], [], resolve)
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.flows[0]?.inputSchema).toEqual({ type: "object", additionalProperties: true })
  })

  it("keeps surface ordering independent of registry source order", async () => {
    const first = await run([descriptor("zeta"), descriptor("alpha")], [])
    const second = await run([descriptor("alpha"), descriptor("zeta")], [])
    expect(first.flows.map((flow) => flow.descriptor.name)).toEqual(["alpha", "zeta"])
    expect(first.digest).toBe(second.digest)
  })
})
