/**
 * Protocol-neutral MCP client primitives used by incoming adapters.
 *
 * The transport is deliberately an injected boundary.  In particular, this
 * module does not create processes or make unpermissioned network requests.
 *
 * Governing contract: `docs/specs/Concepts/Wrapping Adapters.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smithers/keys/Digest"
import { Context, Effect, Layer, Schema } from "effect"

/**
 * The lifecycle state of a foreign MCP server.
 *
 * @category models
 * @since 0.1.0
 */
export const Status = Schema.Literals(["disconnected", "connecting", "connected", "needs_auth", "error"])

/**
 * The lifecycle state of a foreign MCP server.
 *
 * @category models
 * @since 0.1.0
 */
export type Status = typeof Status.Type

/**
 * Stable failures emitted at the MCP boundary.
 *
 * Server-controlled strings are normalized before they are retained in this
 * error, so the value is safe to put in a journal or status record.
 *
 * @category errors
 * @since 0.1.0
 */
export const McpErrorCode = Schema.Literals([
  "transport_failed",
  "needs_auth",
  "timeout",
  "protocol_error",
  "unsupported_content",
  "oversized_content"
])

/**
 * Stable MCP failure-code union.
 *
 * @category models
 * @since 0.1.0
 */
export type McpErrorCode = typeof McpErrorCode.Type

/**
 * A sanitized, typed MCP boundary failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class McpError extends Schema.TaggedErrorClass<McpError>()("flows/adapters/McpError", {
  code: McpErrorCode,
  message: Schema.String
}) {}

/**
 * An MCP tool definition in the small subset needed by the adapter.
 *
 * `name` is the server's original name.  `safeName` is the stable name used
 * by registry-facing surfaces.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolDefinition {
  readonly name: string
  readonly safeName: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly schema: Schema.Schema<unknown>
}

/**
 * An MCP notification understood by the incoming wrapper.
 *
 * Unknown notifications are retained only as a method string and are ignored
 * by the tool-list refresh logic.
 *
 * @category models
 * @since 0.1.0
 */
export interface Notification {
  readonly method: string
  readonly params?: unknown
}

/**
 * An MCP call result, intentionally accepting extension fields.
 *
 * @category models
 * @since 0.1.0
 */
export interface CallResult {
  readonly content?: ReadonlyArray<ContentPart> | undefined
  readonly structuredContent?: unknown
  readonly isError?: boolean | undefined
}

/**
 * MCP content part accepted by the bounded result demultiplexer.
 *
 * @category models
 * @since 0.1.0
 */
export interface ContentPart {
  readonly type: string
  readonly text?: unknown
  readonly data?: unknown
  readonly mimeType?: unknown
  readonly mediaType?: unknown
  readonly name?: unknown
  readonly uri?: unknown
  readonly resource?: unknown
  readonly blob?: unknown
}

/**
 * Journal-safe metadata for binary or resource content.
 *
 * @category models
 * @since 0.1.0
 */
export interface MediaRecord {
  readonly digest: string
  readonly artifactUri: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly displayName: string
}

/**
 * The bounded, journal-safe projection of an MCP call result.
 *
 * @category models
 * @since 0.1.0
 */
export interface DemuxedResult {
  readonly text: string
  readonly media: ReadonlyArray<MediaRecord>
  readonly isError: boolean
  readonly structuredContent?: unknown
}

/**
 * Content-addressed artifact storage used by MCP result demultiplexing.
 *
 * @category services
 * @since 0.1.0
 */
export interface ArtifactStore {
  readonly put: (
    digest: string,
    content: Uint8Array,
    mediaType: string
  ) => Effect.Effect<void, McpError>
  readonly get: (digest: string) => Effect.Effect<Uint8Array, McpError>
}

/**
 * Artifact storage service for MCP media.
 *
 * @category services
 * @since 0.1.0
 */
export const ArtifactStore: Context.Service<ArtifactStore, ArtifactStore> = Context.Service(
  "@smithers/adapters/Mcp/ArtifactStore"
)

/**
 * Constructs content-addressed MCP artifact storage.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeArtifactStore = (implementation: ArtifactStore): ArtifactStore => ArtifactStore.of(implementation)

/**
 * Provides content-addressed MCP artifact storage.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerArtifactStore = (implementation: ArtifactStore): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStore)(makeArtifactStore(implementation))

/**
 * Constructs process-local content-addressed storage for tests and ephemeral
 * application compositions.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeArtifactStoreMemory = (): ArtifactStore => {
  const artifacts = new Map<string, Uint8Array>()
  return makeArtifactStore({
    put: (artifactDigest, content) =>
      Effect.sync(() => {
        artifacts.set(artifactDigest, content.slice())
      }),
    get: (artifactDigest) => {
      const content = artifacts.get(artifactDigest)
      return content === undefined
        ? Effect.fail(error("protocol_error", `MCP artifact ${artifactDigest} was not found`))
        : Effect.succeed(content.slice())
    }
  })
}

/**
 * Provides process-local content-addressed MCP artifact storage.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerArtifactStoreMemory = (): Layer.Layer<ArtifactStore> => layerArtifactStore(makeArtifactStoreMemory())

/**
 * A transport notification callback.
 *
 * @category models
 * @since 0.1.0
 */
export type NotificationListener = (notification: Notification) => Effect.Effect<void, McpError>

/**
 * Transport operations required by the incoming MCP wrapper.
 *
 * Implementations may use any protocol client, but process spawning and raw
 * HTTP must remain outside this package behind an injected implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface TransportService {
  readonly initialize: (credential?: string) => Effect.Effect<void, McpError>
  readonly listTools: () => Effect.Effect<ReadonlyArray<unknown>, McpError>
  readonly callTool: (name: string, input: unknown) => Effect.Effect<CallResult, McpError>
  readonly notifications: (listener: NotificationListener) => Effect.Effect<void, McpError>
  readonly disconnect?: (() => Effect.Effect<void, McpError>) | undefined
}

/**
 * Alias for the injected transport contract.
 *
 * @category models
 * @since 0.1.0
 */
export type Transport = TransportService

/**
 * Injected MCP transport service.
 *
 * @category services
 * @since 0.1.0
 */
export const Transport: Context.Service<TransportService, TransportService> = Context.Service(
  "@smithers/adapters/Mcp/Transport"
)

/**
 * Constructs a transport from its protocol operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: TransportService): TransportService => Transport.of(implementation)

/**
 * Provides an injected MCP transport implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: TransportService): Layer.Layer<TransportService> =>
  Layer.succeed(Transport, make(implementation))

/**
 * Constructs an unavailable transport stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<TransportService> = {}): TransportService =>
  make({
    initialize: () => Effect.fail(error("transport_failed", "MCP transport is unavailable")),
    listTools: () => Effect.fail(error("transport_failed", "MCP transport is unavailable")),
    callTool: () => Effect.fail(error("transport_failed", "MCP transport is unavailable")),
    notifications: () => Effect.void,
    disconnect: () => Effect.void,
    ...overrides
  })

/**
 * Provides an unavailable transport stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<TransportService> = {}): Layer.Layer<TransportService> =>
  Layer.succeed(Transport, makeNoop(overrides))

/**
 * Constructs a typed transport which explicitly rejects stdio.
 *
 * No child-process spawner is hidden behind the MCP abstraction.  Applications
 * that support stdio must supply their own transport implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnsupportedStdio = (): TransportService =>
  makeNoop({
    initialize: () => Effect.fail(error("transport_failed", "stdio MCP transport is unsupported"))
  })

/**
 * Removes control characters and bounds server-provided display text.
 *
 * @category utilities
 * @since 0.1.0
 */
export const sanitizeText = (value: unknown, maxBytes = 4096): string => {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)
  const clean = Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127 ? " " : character
  }).join("").replace(/\s+/g, " ").trim()
  return truncateUtf8(clean, maxBytes)
}

/**
 * Sanitizes a server-controlled name or URI into a stable identifier.
 *
 * @category utilities
 * @since 0.1.0
 */
export const sanitizeName = (value: unknown): string => {
  const clean = sanitizeText(value, 256).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  return clean.length === 0 ? "unnamed" : clean
}

/**
 * Alias for sanitizing one MCP tool or server name.
 *
 * @category utilities
 * @since 0.1.0
 */
export const sanitizeToolName = sanitizeName

/**
 * Sanitizes names while disambiguating collisions deterministically.
 *
 * @category utilities
 * @since 0.1.0
 */
export const sanitizeNames = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const counts = new Map<string, number>()
  return values.map((value) => {
    const base = sanitizeName(value)
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    if (count === 1) return base
    const suffix = `_${count}`
    return `${base.slice(0, 64 - suffix.length)}${suffix}`
  })
}

/**
 * Alias for collision-safe tool-name sanitization.
 *
 * @category utilities
 * @since 0.1.0
 */
export const sanitizeToolNames = sanitizeNames

/**
 * Normalizes an MCP input schema to an object-shaped JSON Schema document.
 *
 * Invalid or non-object documents become permissive object schemas.
 *
 * @category utilities
 * @since 0.1.0
 */
export const parseInputSchema = (value: unknown): Record<string, unknown> => {
  const schema = asRecord(value)
  return isObjectSchema(schema) ? normalizeObjectSchema(schema) : permissiveObjectSchema()
}

/**
 * Alias for tolerant MCP tool-schema parsing.
 *
 * @category utilities
 * @since 0.1.0
 */
export const parseToolSchema = parseInputSchema

/**
 * Parses a foreign tool definition without allowing malformed schemas to
 * break discovery.
 *
 * @category utilities
 * @since 0.1.0
 */
export const parseTool = (value: unknown, safeName = ""): ToolDefinition => {
  const record = asRecord(value)
  const name = typeof record.name === "string" ? record.name : "unnamed"
  const inputSchema = parseInputSchema(record.inputSchema)
  return {
    name,
    safeName: safeName || sanitizeName(name),
    description: sanitizeText(record.description),
    inputSchema,
    schema: Schema.Record(Schema.String, Schema.Unknown)
  }
}

/**
 * Parses and sanitizes a complete tools/list response.
 *
 * @category utilities
 * @since 0.1.0
 */
export const parseTools = (values: ReadonlyArray<unknown>, prefix?: string): ReadonlyArray<ToolDefinition> => {
  const safeNames = new Map<number, string>()
  const ordered = values.map((value, index) => ({
    index,
    name: (() => {
      const record = asRecord(value)
      const raw = typeof record.name === "string" ? record.name : "unnamed"
      return prefix === undefined ? raw : `${prefix}_${raw}`
    })()
  })).sort((left, right) => left.name.localeCompare(right.name) || left.index - right.index)
  const names = sanitizeNames(ordered.map((entry) => entry.name))
  ordered.forEach((entry, index) => safeNames.set(entry.index, names[index]!))
  return values.map((value, index) => parseTool(value, safeNames.get(index)))
}

/**
 * Returns true for the standard MCP tools/list-changed notification.
 *
 * @category utilities
 * @since 0.1.0
 */
export const isToolListChanged = (notification: Notification): boolean =>
  notification.method === "notifications/tools/list_changed" ||
  notification.method === "tools/list_changed" ||
  notification.method === "ToolListChanged"

/**
 * Bounded limits for result demultiplexing.
 *
 * @category models
 * @since 0.1.0
 */
export interface DemuxOptions {
  readonly textByteCap?: number
  readonly binaryByteCap?: number
  readonly structuredByteCap?: number
  readonly redact?: string | undefined
}

/**
 * Demultiplexes text and non-text MCP content into bounded journal metadata and
 * a content-addressed artifact store.
 *
 * Text is kept from the tail at a UTF-8 boundary. Images, resources, and blobs
 * become retrievable artifact references. A binary item over the cap fails
 * explicitly.
 *
 * @category utilities
 * @since 0.1.0
 */
export const demuxResult = (
  result: CallResult,
  options: DemuxOptions = {}
): Effect.Effect<DemuxedResult, McpError, ArtifactStore> =>
  Effect.gen(function*() {
    const store = yield* ArtifactStore
    const parsed = yield* Effect.try({
      try: () => {
        const textParts: Array<string> = []
        const media: Array<MediaRecord> = []
        const artifacts: Array<{
          readonly digest: string
          readonly payload: Uint8Array
          readonly mediaType: string
        }> = []
        const textCap = options.textByteCap ?? 16 * 1024
        const binaryCap = options.binaryByteCap ?? 10 * 1024 * 1024
        const structuredCap = options.structuredByteCap ?? 64 * 1024
        for (const part of result.content ?? []) {
          const type = sanitizeName(part.type)
          if (type === "text") {
            if (typeof part.text === "string") textParts.push(redactText(part.text, options.redact))
            continue
          }
          if (!isMediaPart(type)) throw error("unsupported_content", `Unsupported MCP content type: ${type}`)
          const payload = mediaPayload(part)
          const sizeBytes = payload.byteLength
          if (sizeBytes > binaryCap) throw error("oversized_content", "MCP binary content exceeds the configured cap")
          const resource = asRecord(part.resource)
          const mediaType = sanitizeText(
            part.mimeType ?? part.mediaType ?? resource.mimeType ?? mediaTypeFor(type),
            128
          ) || mediaTypeFor(type)
          if (!isAllowedMediaType(mediaType)) {
            throw error("unsupported_content", `Unsupported MCP media type: ${mediaType}`)
          }
          const displayName = redactText(sanitizeText(part.name ?? mediaName(part), 256), options.redact) ||
            "mcp-content"
          const payloadDigest = digest(payload)
          artifacts.push({ digest: payloadDigest, payload, mediaType })
          media.push({
            digest: payloadDigest,
            artifactUri: `flows-artifact://sha256/${payloadDigest}`,
            mediaType,
            sizeBytes,
            displayName
          })
        }
        const structuredContent = result.structuredContent === undefined
          ? undefined
          : boundedStructured(result.structuredContent, structuredCap, options.redact)
        return {
          artifacts,
          result: {
            text: truncateUtf8(textParts.join("\n\n"), textCap),
            media,
            isError: result.isError === true,
            ...(structuredContent === undefined ? {} : { structuredContent })
          }
        }
      },
      catch: (cause) => cause instanceof McpError ? cause : error("protocol_error", "Malformed MCP tool result")
    })
    for (const artifact of parsed.artifacts) {
      yield* store.put(artifact.digest, artifact.payload, artifact.mediaType)
    }
    return parsed.result
  })

/**
 * Alias for {@link demuxResult} using the long-form spelling.
 *
 * @category utilities
 * @since 0.1.0
 */
export const demultiplex = demuxResult

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const isObjectSchema = (value: Record<string, unknown>): boolean =>
  value.type === "object" || value.properties !== undefined || value.additionalProperties !== undefined

const normalizeObjectSchema = (value: Record<string, unknown>): Record<string, unknown> => ({
  ...value,
  type: "object",
  properties: asRecord(value.properties),
  additionalProperties: value.additionalProperties ?? true
})

const permissiveObjectSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: {},
  additionalProperties: true
})

const isMediaPart = (type: string): boolean =>
  type === "image" || type === "resource" || type === "resource_link" || type === "blob" || type === "audio"

const mediaTypeFor = (type: string): string => type === "image" ? "image/*" : "application/octet-stream"

const mediaName = (part: ContentPart): string => {
  const resource = asRecord(part.resource)
  return sanitizeText(resource.name ?? resource.title, 256)
}

const decodeBase64 = (value: string): Uint8Array | undefined => {
  try {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

const mediaPayload = (part: ContentPart): Uint8Array => {
  const resource = asRecord(part.resource)
  const encoded = part.data ?? part.blob ?? resource.blob
  if (encoded !== undefined) {
    if (typeof encoded !== "string") {
      throw error("protocol_error", "MCP binary content is not base64 text")
    }
    const decoded = decodeBase64(encoded)
    if (decoded === undefined) {
      throw error("protocol_error", "MCP binary content is not valid base64")
    }
    return decoded
  }
  const payload = resource.text ?? resource.uri ?? part.uri ?? ""
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  return new TextEncoder().encode(text)
}

const isAllowedMediaType = (mediaType: string): boolean =>
  mediaType === "application/octet-stream"
  || mediaType === "application/json"
  || mediaType === "application/pdf"
  || mediaType === "text/plain"
  || mediaType === "image/*"
  || mediaType.startsWith("image/")
  || mediaType.startsWith("audio/")

const digest = (value: Uint8Array): string => Digest.digest(value)

const truncateUtf8 = (value: string, cap: number): string => {
  if (cap <= 0) return ""
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= cap) return value
  let start = bytes.byteLength - cap
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1
  return new TextDecoder().decode(bytes.slice(start))
}

const redactText = (value: string, secret: string | undefined): string =>
  secret === undefined || secret.length === 0 ? value : value.replaceAll(secret, "<redacted>")

const sanitizeStructured = (value: unknown, secret: string | undefined, depth = 0): unknown => {
  if (depth > 8) return "[truncated]"
  if (typeof value === "string") return redactText(sanitizeText(value, 16 * 1024), secret)
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeStructured(item, secret, depth + 1))
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 256)) {
      output[sanitizeName(key)] = sanitizeStructured(item, secret, depth + 1)
    }
    return output
  }
  return null
}

const boundedStructured = (value: unknown, cap: number, secret: string | undefined): unknown => {
  const sanitized = sanitizeStructured(value, secret)
  const encoded = new TextEncoder().encode(JSON.stringify(sanitized))
  return encoded.byteLength <= cap
    ? sanitized
    : {
      truncated: true,
      digest: digest(encoded),
      sizeBytes: encoded.byteLength
    }
}

const error = (code: McpErrorCode, message: string): McpError => new McpError({ code, message: sanitizeText(message) })
