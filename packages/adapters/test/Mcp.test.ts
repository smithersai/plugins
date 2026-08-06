import { Effect, type Layer, Schema } from "effect"
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

  describe("transport stubs", () => {
    const runWithTransport = <A, E>(
      effect: (transport: Mcp.TransportService) => Effect.Effect<A, E>,
      layer: Layer.Layer<Mcp.TransportService>
    ) =>
      Effect.gen(function*() {
        const transport = yield* Mcp.Transport
        return yield* effect(transport)
      }).pipe(Effect.provide(layer))

    it("fails every protocol operation of the unavailable transport", () => {
      const transport = Mcp.makeNoop()
      for (
        const operation of [
          transport.initialize(),
          transport.listTools(),
          transport.callTool("anything", {})
        ]
      ) {
        const error = Effect.runSync(Effect.flip(operation))
        expect(error._tag).toBe("flows/adapters/McpError")
        expect(error.code).toBe("transport_failed")
        expect(error.message).toBe("MCP transport is unavailable")
      }
      expect(Effect.runSync(transport.notifications(() => Effect.void))).toBeUndefined()
      expect(Effect.runSync(transport.disconnect!())).toBeUndefined()
    })

    it("honors overrides supplied to the unavailable transport", () => {
      const transport = Mcp.makeNoop({ listTools: () => Effect.succeed([{ name: "tool" }]) })
      expect(Effect.runSync(transport.listTools())).toEqual([{ name: "tool" }])
      expect(Effect.runSync(Effect.flip(transport.initialize())).code).toBe("transport_failed")
    })

    it("rejects stdio explicitly instead of hiding a process spawner", () => {
      const error = Effect.runSync(Effect.flip(Mcp.makeUnsupportedStdio().initialize()))
      expect(error.code).toBe("transport_failed")
      expect(error.message).toBe("stdio MCP transport is unsupported")
    })

    it("provides a transport through both layer constructors", () => {
      const listed = Effect.runSync(
        runWithTransport(
          (transport) => transport.listTools(),
          Mcp.layer(Mcp.makeNoop({ listTools: () => Effect.succeed(["a"]) }))
        )
      )
      expect(listed).toEqual(["a"])

      const error = Effect.runSync(
        runWithTransport((transport) => Effect.flip(transport.initialize()), Mcp.layerNoop())
      )
      expect(error.code).toBe("transport_failed")
    })

    it("passes an initialize credential through to the implementation", () => {
      const credentials: Array<string | undefined> = []
      const transport = Mcp.make({
        ...Mcp.makeNoop(),
        initialize: (credential) =>
          Effect.sync(() => {
            credentials.push(credential)
          })
      })
      Effect.runSync(transport.initialize("token"))
      Effect.runSync(transport.initialize())
      expect(credentials).toEqual(["token", undefined])
    })
  })

  describe("artifact storage", () => {
    it("reports a missing artifact as a typed protocol failure", () => {
      const store = Mcp.makeArtifactStoreMemory()
      const error = Effect.runSync(Effect.flip(store.get("0".repeat(64))))
      expect(error.code).toBe("protocol_error")
      expect(error.message).toContain("was not found")
    })

    it("copies stored content so a caller cannot mutate the store", () => {
      const store = Mcp.makeArtifactStoreMemory()
      const content = new Uint8Array([1, 2, 3])
      Effect.runSync(store.put("digest", content, "application/octet-stream"))
      content[0] = 9
      const stored = Effect.runSync(store.get("digest"))
      expect(Array.from(stored)).toEqual([1, 2, 3])
      stored[0] = 8
      expect(Array.from(Effect.runSync(store.get("digest")))).toEqual([1, 2, 3])
    })

    it("provides artifact storage through both layer constructors", () => {
      const roundTrip = (layer: Layer.Layer<Mcp.ArtifactStore>) =>
        Effect.runSync(
          Effect.gen(function*() {
            const store = yield* Mcp.ArtifactStore
            yield* store.put("d", new Uint8Array([7]), "application/octet-stream")
            return yield* store.get("d")
          }).pipe(Effect.provide(layer))
        )
      expect(Array.from(roundTrip(Mcp.layerArtifactStoreMemory()))).toEqual([7])
      expect(Array.from(roundTrip(Mcp.layerArtifactStore(Mcp.makeArtifactStoreMemory())))).toEqual([7])
    })

    it("propagates an artifact store failure out of demultiplexing", () => {
      const failing = Mcp.makeArtifactStore({
        put: () => Effect.fail(new Mcp.McpError({ code: "transport_failed", message: "disk is full" })),
        get: () => Effect.fail(new Mcp.McpError({ code: "protocol_error", message: "unused" }))
      })
      const error = Effect.runSync(
        Effect.flip(
          Mcp.demuxResult({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }).pipe(
            Effect.provideService(Mcp.ArtifactStore, failing)
          )
        )
      )
      expect(error.code).toBe("transport_failed")
      expect(error.message).toBe("disk is full")
    })
  })

  describe("content demultiplexing failures", () => {
    const flipDemux = (result: Mcp.CallResult, options: Mcp.DemuxOptions = {}) =>
      Effect.runSync(Effect.flip(runDemux(result, options)))

    it("rejects an unsupported content type", () => {
      const error = flipDemux({ content: [{ type: "video" }] })
      expect(error.code).toBe("unsupported_content")
      expect(error.message).toBe("Unsupported MCP content type: video")
    })

    it("rejects an unsupported media type", () => {
      const error = flipDemux({
        content: [{ type: "resource", resource: { text: "x", mimeType: "application/x-shellscript" } }]
      })
      expect(error.code).toBe("unsupported_content")
      expect(error.message).toBe("Unsupported MCP media type: application/x-shellscript")
    })

    it("rejects binary content which is not base64 text", () => {
      const error = flipDemux({ content: [{ type: "image", data: { not: "text" } }] })
      expect(error.code).toBe("protocol_error")
      expect(error.message).toBe("MCP binary content is not base64 text")
    })

    it("rejects binary content which is not valid base64", () => {
      const error = flipDemux({ content: [{ type: "image", data: "not base64 !!" }] })
      expect(error.code).toBe("protocol_error")
      expect(error.message).toBe("MCP binary content is not valid base64")
    })

    it("normalizes an unexpected demultiplexing fault into a protocol error", () => {
      const hostile = {
        content: [{
          type: "text",
          get text(): string {
            throw new Error("hostile getter")
          }
        }]
      } as unknown as Mcp.CallResult
      const error = flipDemux(hostile)
      expect(error.code).toBe("protocol_error")
      expect(error.message).toBe("Malformed MCP tool result")
    })
  })

  describe("content demultiplexing", () => {
    it("stores every media shape with a default media type", () => {
      const demuxed = Effect.runSync(
        runDemux({
          content: [
            { type: "audio", data: "aGVsbG8=" },
            { type: "resource_link", uri: "https://example.test/doc" },
            { type: "blob", blob: "aGVsbG8=" },
            { type: "resource", resource: { text: "inline resource text" } }
          ]
        })
      )
      expect(demuxed.media.map((record) => record.mediaType)).toEqual([
        "application/octet-stream",
        "application/octet-stream",
        "application/octet-stream",
        "application/octet-stream"
      ])
      expect(demuxed.media.map((record) => record.sizeBytes)).toEqual([5, 24, 5, 20])
      expect(demuxed.media.every((record) => record.displayName === "mcp-content")).toBe(true)
    })

    it("defaults an image without a declared media type to image/*", () => {
      const demuxed = Effect.runSync(runDemux({ content: [{ type: "image", data: "aGVsbG8=" }] }))
      expect(demuxed.media[0]?.mediaType).toBe("image/*")
    })

    it("names media from its resource metadata", () => {
      const demuxed = Effect.runSync(
        runDemux({
          content: [{ type: "resource", resource: { text: "x", name: "report.txt", mimeType: "text/plain" } }]
        })
      )
      expect(demuxed.media[0]?.displayName).toBe("report.txt")
    })

    it("reports the server error flag", () => {
      expect(Effect.runSync(runDemux({ isError: true, content: [{ type: "text", text: "boom" }] })).isError).toBe(true)
      expect(Effect.runSync(runDemux({ content: [] })).isError).toBe(false)
    })

    it("drops all text at a zero byte cap", () => {
      const demuxed = Effect.runSync(runDemux({ content: [{ type: "text", text: "kept" }] }, { textByteCap: 0 }))
      expect(demuxed.text).toBe("")
    })

    it("ignores a non-string text part", () => {
      const demuxed = Effect.runSync(runDemux({ content: [{ type: "text", text: 42 }] }))
      expect(demuxed.text).toBe("")
    })

    it("redacts a configured secret from text, names, and structured content", () => {
      const demuxed = Effect.runSync(
        runDemux(
          {
            content: [
              { type: "text", text: "the token is s3cr3t" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "s3cr3t.png" }
            ],
            structuredContent: { token: "s3cr3t" }
          },
          { redact: "s3cr3t" }
        )
      )
      expect(demuxed.text).toBe("the token is <redacted>")
      expect(demuxed.media[0]?.displayName).toBe("<redacted>.png")
      expect(demuxed.structuredContent).toEqual({ token: "<redacted>" })
    })

    it("sanitizes structured content into journal-safe values", () => {
      const deep = (depth: number): unknown => depth === 0 ? "leaf" : { next: deep(depth - 1) }
      const demuxed = Effect.runSync(
        runDemux({
          structuredContent: {
            "unsafe key/name": "ok",
            infinite: Number.POSITIVE_INFINITY,
            finite: 3,
            flag: false,
            nothing: null,
            missing: undefined,
            fn: () => "ignored",
            list: Array.from({ length: 300 }, (_, index) => index),
            deep: deep(12)
          }
        })
      )
      const structured = demuxed.structuredContent as Record<string, unknown>
      expect(structured.unsafe_key_name).toBe("ok")
      expect(structured.infinite).toBe(null)
      expect(structured.finite).toBe(3)
      expect(structured.flag).toBe(false)
      expect(structured.nothing).toBe(null)
      expect(structured.missing).toBe(null)
      expect(structured.fn).toBe(null)
      expect(structured.list).toHaveLength(256)
      expect(JSON.stringify(structured.deep)).toContain("[truncated]")
    })

    it("keeps small structured content verbatim", () => {
      expect(Effect.runSync(runDemux({ structuredContent: { ok: true } })).structuredContent).toEqual({ ok: true })
    })
  })

  describe("sanitization utilities", () => {
    it("collapses control characters and whitespace", () => {
      expect(Mcp.sanitizeText("ab\n\tc  d")).toBe("a b c d")
    })

    it("renders non-string values and empty inputs", () => {
      expect(Mcp.sanitizeText(undefined)).toBe("")
      expect(Mcp.sanitizeText(null)).toBe("")
      expect(Mcp.sanitizeText(42)).toBe("42")
      expect(Mcp.sanitizeText(true)).toBe("true")
    })

    it("keeps the tail of an oversized value at a UTF-8 boundary", () => {
      const truncated = Mcp.sanitizeText(`${"a".repeat(20)}😀tail`, 8)
      expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(8)
      expect(truncated.endsWith("tail")).toBe(true)
      expect(truncated).not.toContain("�")
    })

    it("falls back to a stable name only for an empty value", () => {
      expect(Mcp.sanitizeName(undefined)).toBe("unnamed")
      expect(Mcp.sanitizeName("")).toBe("unnamed")
      expect(Mcp.sanitizeName("   ")).toBe("unnamed")
      // Unsafe characters are replaced rather than dropped, so a name made only
      // of them stays distinguishable from a name the server never sent.
      expect(Mcp.sanitizeName("///")).toBe("___")
      expect(Mcp.sanitizeToolName("Read File")).toBe("Read_File")
    })
  })

  describe("tool parsing", () => {
    it("normalizes an object schema and preserves its declared members", () => {
      expect(Mcp.parseInputSchema({ properties: { a: { type: "string" } } })).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: true
      })
      expect(Mcp.parseInputSchema({ type: "object", additionalProperties: false })).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false
      })
    })

    it("replaces a non-object schema with a permissive object schema", () => {
      const permissive = { type: "object", properties: {}, additionalProperties: true }
      expect(Mcp.parseInputSchema({ type: "string" })).toEqual(permissive)
      expect(Mcp.parseInputSchema(["not", "a", "schema"])).toEqual(permissive)
      expect(Mcp.parseInputSchema(undefined)).toEqual(permissive)
      expect(Mcp.parseToolSchema(null)).toEqual(permissive)
    })

    it("names an unnamed tool deterministically", () => {
      const tool = Mcp.parseTool({ description: "no name" })
      expect(tool.name).toBe("unnamed")
      expect(tool.safeName).toBe("unnamed")
      expect(tool.description).toBe("no name")
    })

    it("honors an explicitly supplied safe name", () => {
      expect(Mcp.parseTool({ name: "read file" }, "server_read_file").safeName).toBe("server_read_file")
    })

    it("recognizes every accepted tool-list-changed notification", () => {
      const notification = fixture("tool-list-changed.json") as unknown as Mcp.Notification
      expect(Mcp.isToolListChanged(notification)).toBe(true)
      expect(Mcp.isToolListChanged({ method: "tools/list_changed" })).toBe(true)
      expect(Mcp.isToolListChanged({ method: "ToolListChanged" })).toBe(true)
      expect(Mcp.isToolListChanged({ method: "notifications/message" })).toBe(false)
    })
  })
})
