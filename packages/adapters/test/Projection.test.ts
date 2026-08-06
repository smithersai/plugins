import * as Visibility from "@smithers/harness/Visibility"
import * as Capability from "@smithers/kernel/Capability"
import type { FlowDescriptor, SchemaRef } from "@smithers/registry/Descriptor"
import type { Registry } from "@smithers/registry/Registry"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { SeatCapabilities } from "../src/Projection.ts"
import {
  layerSchemaResolver,
  makeSchemaResolver,
  ProjectionError,
  SchemaResolver,
  select,
  toToolName
} from "../src/Projection.ts"

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
  capabilities: SeatCapabilities,
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

  describe("seat envelopes", () => {
    const entries = [descriptor("read", ["fs:read:/a"]), descriptor("write", ["fs:write:/a"])]
    const visibleNames = async (seat: SeatCapabilities) =>
      (await run(entries, seat)).descriptors.map((entry) => entry.name)

    it("accepts a Set, an array, and a structured record as the same envelope", async () => {
      expect(await visibleNames(new Set(["fs:read:/a"]))).toEqual(["read"])
      expect(await visibleNames(["fs:read:/a"])).toEqual(["read"])
      expect(await visibleNames({ capabilities: ["fs:read:/a"] })).toEqual(["read"])
      expect(await visibleNames({ envelope: new Set(["fs:read:/a"]) })).toEqual(["read"])
      // `envelope` wins when a record carries both spellings.
      expect(await visibleNames({ envelope: ["fs:read:/a"], capabilities: ["fs:write:/a"] })).toEqual(["read"])
      // A structured record with neither field grants nothing.
      expect(await visibleNames({})).toEqual([])
    })

    it("admits a capability by exact grant, wildcard, action, or namespace wildcard", async () => {
      expect(await visibleNames(["*"])).toEqual(["read", "write"])
      expect(await visibleNames(["fs:read"])).toEqual(["read"])
      expect(await visibleNames(["fs:*"])).toEqual(["read", "write"])
      // A different action's wildcard grants nothing here.
      expect(await visibleNames(["net:*"])).toEqual([])
    })

    it("admits a capability matched by a structured capability pattern", async () => {
      const patterns = [new Capability.CapabilityPattern({ action: "fs:read", resource: "/a*" })]
      expect(await visibleNames({ capabilityEnvelope: patterns })).toEqual(["read"])
      // A pattern whose resource does not match leaves the flow out.
      expect(await visibleNames({
        capabilityEnvelope: [new Capability.CapabilityPattern({ action: "fs:read", resource: "/other" })]
      })).toEqual([])
      // An unparseable requirement can never be admitted by a pattern.
      expect(
        (await run([descriptor("odd", ["not-a-capability"])], { capabilityEnvelope: patterns })).descriptors
      ).toEqual([])
    })

    it("applies a seat visibility ruleset on top of the capability envelope", async () => {
      const ruleset = [new Visibility.Rule({ effect: "allow", pattern: "re*" })]
      expect(await visibleNames({ envelope: ["fs:*"], visibility: ruleset })).toEqual(["read"])
      // A fail-closed empty ruleset hides everything even with a full envelope.
      expect(await visibleNames({ envelope: ["*"], visibility: [] })).toEqual([])
      const seat = Visibility.make({ name: "seat", ruleset })
      expect(await visibleNames({ envelope: ["*"], visibility: seat })).toEqual(["read"])
    })
  })

  it("reports an unreadable registry as registry_unavailable", async () => {
    const failing = { ...registry([]), visible: () => Effect.fail(new Error("registry offline")) } as unknown as Registry
    await expect(
      Effect.runPromise(
        select(failing, []).pipe(
          Effect.provideService(SchemaResolver, makeSchemaResolver(() => Effect.succeed({ type: "object" })))
        )
      )
    ).rejects.toMatchObject({ code: "registry_unavailable", message: "could not read visible registry descriptors" })
  })

  it("does not treat a repeated descriptor name as a collision", async () => {
    // Two entries that sanitize to the same tool name are only a collision when
    // the underlying registry names differ.
    const result = await run([descriptor("same"), descriptor("same")], [])
    expect(result.flows.map((flow) => flow.toolName)).toEqual(["same", "same"])
    expect(result.names.get("same")).toBe("same")
    expect(result.flowNames.get("same")).toBe("same")
  })

  it("treats the empty-name fallback as collidable rather than silently merging flows", async () => {
    // Both sanitize to the "flow" fallback, so the reversible map cannot hold
    // them both and the projection must fail loudly.
    await expect(run([descriptor("!!!"), descriptor("???")], [])).rejects.toMatchObject({
      code: "name_collision",
      message: "flows \"!!!\" and \"???\" both project as \"flow\""
    })
    // A single unnameable flow still projects under the fallback.
    expect((await run([descriptor("!!!")], [])).flows[0]?.toolName).toBe("flow")
  })

  describe("toToolName", () => {
    it("normalizes unicode, case, and separators, and never yields an empty name", () => {
      expect(toToolName("Read Files")).toBe("read-files")
      expect(toToolName("a／b")).toBe("a-b")
      expect(toToolName("--leading-and-trailing--")).toBe("leading-and-trailing")
      expect(toToolName("a...b")).toBe("a-b")
      expect(toToolName("keep_underscores-and-dashes")).toBe("keep_underscores-and-dashes")
      expect(toToolName("!!!")).toBe("flow")
      expect(toToolName("")).toBe("flow")
      // NFKC folds the compatibility ligature before the character class runs.
      expect(toToolName("ﬁle")).toBe("file")
    })
  })

  it("provides a resolver through its layer", async () => {
    const selection = await Effect.runPromise(
      select(registry([descriptor("layered")]), []).pipe(
        Effect.provide(layerSchemaResolver(() => Effect.succeed({ type: "object", title: "from-layer" })))
      )
    )
    expect(selection.flows[0]?.inputSchema).toEqual({ type: "object", title: "from-layer" })
  })
})
