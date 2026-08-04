import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Mcp from "../src/Mcp.ts"

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/mcp/${name}`, import.meta.url)), "utf8")) as Record<
    string,
    unknown
  >

describe("Mcp", () => {
  const runDemux = (
    result: Mcp.CallResult,
    options: Mcp.DemuxOptions = {}
  ) =>
    Mcp.demuxResult(result, options).pipe(
      Effect.provideService(Mcp.ArtifactStore, Mcp.makeArtifactStoreMemory())
    )

  it("uses a permissive object schema for malformed inputSchema values", () => {
    const tools = Mcp.parseTools(fixture("malformed-schema.json").tools as ReadonlyArray<unknown>)
    expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true })
    expect(tools[0]?.description).toBe("A tool description with unsafe whitespace")
    expect(Schema.decodeUnknownSync(tools[0]!.schema)({ arbitrary: true })).toEqual({ arbitrary: true })
  })

  it("sanitizes names and disambiguates collisions", () => {
    expect(Mcp.sanitizeName("server name/with unsafe.uri")).toBe("server_name_with_unsafe_uri")
    expect(Mcp.sanitizeNames(["a/b", "a b", "a_b"])).toEqual(["a_b", "a_b_2", "a_b_3"])
    const tools = Mcp.parseTools(fixture("list-tools.json").tools as ReadonlyArray<unknown>, "server")
    expect(tools.map((tool) => tool.safeName)).toEqual(["server_read-file", "server_read_file"])
    expect(Mcp.sanitizeNames(["x".repeat(80), "x".repeat(80)]).every((name) => name.length <= 64)).toBe(true)
  })

  it("demultiplexes mixed content with a UTF-8-safe text cap and retrievable artifacts", () => {
    const result = fixture("mixed-result-parts.json") as Mcp.CallResult
    const store = Mcp.makeArtifactStoreMemory()
    const demuxed = Effect.runSync(
      Mcp.demuxResult(result, { textByteCap: 10, binaryByteCap: 1024 }).pipe(
        Effect.provideService(Mcp.ArtifactStore, store)
      )
    )
    expect(demuxed.text).toBe("😀\n\ntail")
    expect(demuxed.media).toHaveLength(2)
    expect(demuxed.media[0]?.displayName).toBe("preview unsafe")
    expect(demuxed.media[0]?.sizeBytes).toBe(5)
    expect(demuxed.media[1]?.sizeBytes).toBe(8)
    expect(JSON.stringify(demuxed.media)).not.toContain("/tmp/secret")
    expect(demuxed.media[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(demuxed.media[0]?.artifactUri).toBe(`flows-artifact://sha256/${demuxed.media[0]?.digest}`)
    expect(Effect.runSync(store.get(demuxed.media[0]!.digest))).toHaveLength(5)
  })

  it("fails oversized binary content with a typed error", () => {
    const result = fixture("mixed-result-parts.json") as Mcp.CallResult
    const error = Effect.runSync(Effect.flip(runDemux(result, { binaryByteCap: 2 })))
    expect(error.code).toBe("oversized_content")
  })

  it("bounds structured content into digest-only metadata", () => {
    const demuxed = Effect.runSync(
      runDemux({ structuredContent: { text: "x".repeat(100) } }, { structuredByteCap: 16 })
    )
    expect(demuxed.structuredContent).toMatchObject({
      truncated: true,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      sizeBytes: expect.any(Number)
    })
  })
})
