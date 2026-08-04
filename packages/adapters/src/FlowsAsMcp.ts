/**
 * Renders and mounts selected flows as an MCP discovery surface.
 *
 * Governing contract: `docs/specs/Concepts/Wrapping Adapters.md`.
 *
 * @since 0.1.0
 */
import * as FileSystem from "@smithers/kernel/FileSystem"
import * as Digest from "@smithers/keys/Digest"
import { CanonicalJson } from "@smithers/model"
import { Context, Effect, Layer, type Scope } from "effect"
import type * as CliHarness from "./CliHarness.ts"
import type { JsonSchema, Selection } from "./Projection.ts"
import { ProjectionError } from "./Projection.ts"

/**
 * The capability subset used to choose MCP bootstrap configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface McpCapabilities {
  readonly mcpBootstrap: "inline-config" | "project-config" | "none"
}

/**
 * One tool exposed by the pure MCP projection.
 *
 * @category models
 * @since 0.1.0
 */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
}

/**
 * Child execution seam. Implementations must enter durable child-run execution
 * rather than invoking flow bodies directly.
 *
 * @category models
 * @since 0.1.0
 */
export type ChildRunInvoker = (call: {
  readonly flowName: string
  readonly input: unknown
  readonly callerIdentity: string
  readonly idempotencyKey: string
}) => Effect.Effect<unknown, ProjectionError>

/**
 * A tools/call request accepted by a projected handler.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolCall {
  readonly name: string
  readonly arguments: unknown
  readonly requestId: string | number
  readonly callerIdentity: string
}

/**
 * Bounded MCP-compatible result content.
 *
 * @category models
 * @since 0.1.0
 */
export interface McpCallResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
}

/**
 * Pure MCP surface; a future host mounts these tools and handlers on transport.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderedMcp {
  readonly tools: ReadonlyArray<McpTool>
  readonly handler: (invoker: ChildRunInvoker) => (call: ToolCall) => Effect.Effect<McpCallResult, ProjectionError>
  readonly digest: string
}

/**
 * A concrete run-scoped MCP endpoint created beside a wrapped harness.
 *
 * @category models
 * @since 0.1.0
 */
export type ServerEndpoint =
  | {
    readonly transport: "stdio"
    readonly command: string
    readonly args: ReadonlyArray<string>
  }
  | {
    readonly transport: "http"
    readonly url: string
  }

/**
 * Host operation which exposes the rendered handler over a real MCP transport.
 *
 * @category services
 * @since 0.1.0
 */
export interface Server {
  readonly serve: (
    tools: ReadonlyArray<McpTool>,
    call: (call: ToolCall) => Effect.Effect<McpCallResult, ProjectionError>
  ) => Effect.Effect<ServerEndpoint, ProjectionError, Scope.Scope>
}

/**
 * Run-scoped MCP server host.
 *
 * @category services
 * @since 0.1.0
 */
export const Server: Context.Service<Server, Server> = Context.Service("@smithers/adapters/FlowsAsMcp/Server")

/**
 * Constructs an MCP projection server host.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeServer = (implementation: Server): Server => Server.of(implementation)

/**
 * Provides an MCP projection server host.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServer = (implementation: Server): Layer.Layer<Server> =>
  Layer.succeed(Server)(makeServer(implementation))

/**
 * Constructs an unavailable MCP projection server.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeServerNoop = (): Server =>
  makeServer({
    serve: () =>
      Effect.fail(
        new ProjectionError({
          code: "unsupported",
          message: "no MCP projection server host is configured"
        })
      )
  })

/**
 * Provides an unavailable MCP projection server.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerNoop: Layer.Layer<Server> = Layer.succeed(Server)(makeServerNoop())

/**
 * An active MCP projection and the options which mount it into CliHarness.
 *
 * @category models
 * @since 0.1.0
 */
export interface MountedMcp {
  readonly endpoint: ServerEndpoint
  readonly config: Readonly<Record<string, unknown>>
  readonly digest: string
  readonly harnessOptions: CliHarness.MakeOptions
}

const bounded = (value: unknown): Effect.Effect<string, ProjectionError> =>
  Effect.try({
    try: () => {
      const encoded = typeof value === "string" ? value : JSON.stringify(value) ?? "null"
      const bytes = new TextEncoder().encode(encoded)
      if (bytes.byteLength <= 16 * 1024) return encoded
      let end = 16 * 1024
      while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
      return new TextDecoder().decode(bytes.slice(0, end))
    },
    catch: () =>
      new ProjectionError({
        code: "invalid_request",
        message: "child run returned a non-serializable result"
      })
  })

const idempotencyKey = (
  selectionDigest: string,
  call: ToolCall,
  flowName: string,
  input: unknown
): Effect.Effect<string, ProjectionError> =>
  Effect.try({
    try: () =>
      `flows:mcp:${
        Digest.digest(
          `${call.callerIdentity}\u0000${call.requestId}\u0000${flowName}\u0000${selectionDigest}\u0000${
            CanonicalJson.stringify(input)
          }`
        )
      }`,
    catch: () =>
      new ProjectionError({
        code: "invalid_request",
        message: "MCP tool arguments must be serializable JSON"
      })
  })

/**
 * Builds a tools/call handler that re-enters selected flows as durable child
 * runs through the injected invoker.
 *
 * @category operations
 * @since 0.1.0
 */
export const handler = (
  selection: Selection,
  invoker: ChildRunInvoker
): (call: ToolCall) => Effect.Effect<McpCallResult, ProjectionError> => {
  const names = new Map(selection.flows.map((flow) => [flow.toolName, flow.descriptor.name]))
  return (call) => {
    const flowName = names.get(call.name)
    if (flowName === undefined) {
      return Effect.fail(new ProjectionError({ code: "invalid_request", message: `unknown MCP tool "${call.name}"` }))
    }
    const input = call.arguments === undefined ? {} : call.arguments
    return idempotencyKey(selection.digest, call, flowName, input).pipe(
      Effect.flatMap((key) =>
        invoker({
          flowName,
          input,
          callerIdentity: call.callerIdentity,
          idempotencyKey: key
        })
      ),
      Effect.flatMap(bounded),
      Effect.map((text) => ({ content: [{ type: "text" as const, text }] }))
    )
  }
}

/**
 * Renders one MCP tool per selected flow and its harness bootstrap value.
 *
 * @category conversions
 * @since 0.1.0
 */
export const render = (
  selection: Selection,
  capabilities: McpCapabilities
): Effect.Effect<RenderedMcp, ProjectionError> => {
  if (capabilities.mcpBootstrap === "none") {
    return Effect.fail(
      new ProjectionError({ code: "unsupported", message: "the harness does not support MCP bootstrap" })
    )
  }
  const tools = Object.freeze(selection.flows.map((flow) => ({
    name: flow.toolName,
    description: flow.descriptor.description,
    inputSchema: flow.inputSchema
  })))
  const renderedDigest = Digest.digest(CanonicalJson.stringify({
    selection: selection.digest,
    tools
  }))
  return Effect.succeed({
    tools,
    handler: (invoker) => handler(selection, invoker),
    digest: renderedDigest
  })
}

const endpointConfig = (endpoint: ServerEndpoint): Readonly<Record<string, unknown>> =>
  endpoint.transport === "stdio"
    ? { command: endpoint.command, args: endpoint.args }
    : { type: "http", url: endpoint.url }

const inlineArgs = (endpoint: ServerEndpoint): ReadonlyArray<string> => {
  if (endpoint.transport === "http") {
    return ["-c", `mcp_servers.flows.url=${JSON.stringify(endpoint.url)}`]
  }
  return [
    "-c",
    `mcp_servers.flows.command=${JSON.stringify(endpoint.command)}`,
    "-c",
    `mcp_servers.flows.args=${JSON.stringify(endpoint.args)}`
  ]
}

/**
 * Starts the projected MCP server, writes concrete bootstrap configuration,
 * and returns the direct CliHarness mount.
 *
 * @category operations
 * @since 0.1.0
 */
export const mount = (
  rendered: RenderedMcp,
  capabilities: McpCapabilities,
  invoker: ChildRunInvoker
): Effect.Effect<
  MountedMcp,
  ProjectionError,
  FileSystem.FileSystem | Server | Scope.Scope
> =>
  Effect.gen(function*() {
    if (capabilities.mcpBootstrap === "none") {
      return yield* Effect.fail(
        new ProjectionError({ code: "unsupported", message: "the harness does not support MCP bootstrap" })
      )
    }
    const server = yield* Server
    const endpoint = yield* server.serve(rendered.tools, rendered.handler(invoker))
    const serverConfig = endpointConfig(endpoint)
    const config = { mcpServers: { flows: serverConfig } } as const
    const mountedDigest = Digest.digest(CanonicalJson.stringify({
      rendered: rendered.digest,
      mode: capabilities.mcpBootstrap,
      endpoint: serverConfig
    }))
    if (capabilities.mcpBootstrap === "inline-config") {
      return {
        endpoint,
        config,
        digest: mountedDigest,
        harnessOptions: {
          commandOptions: () => ({ extraArgs: inlineArgs(endpoint) })
        }
      }
    }

    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "flows-mcp-" }).pipe(
      Effect.mapError((cause) =>
        new ProjectionError({ code: "invalid_request", message: "could not create MCP config directory", cause })
      )
    )
    const path = `${root}/mcp.json`
    yield* fileSystem.writeFileString(path, `${JSON.stringify(config, null, 2)}\n`).pipe(
      Effect.mapError((cause) =>
        new ProjectionError({ code: "invalid_request", message: "could not write MCP config", cause })
      )
    )
    return {
      endpoint,
      config,
      digest: mountedDigest,
      harnessOptions: {
        commandOptions: () => ({ extraArgs: ["--mcp-config", path] })
      }
    }
  })
