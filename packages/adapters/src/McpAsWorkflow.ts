/**
 * Projects an incoming MCP server into registry-compatible flow entries.
 *
 * The server is connected lazily.  The returned service is scoped: its
 * transport is disconnected when the owning scope closes, including when the
 * scope is closed by fiber interruption.
 *
 * Governing contract: `docs/specs/Concepts/Wrapping Adapters.md`.
 *
 * @since 0.1.0
 */
import * as Credential from "@flows/control/Credential"
import * as Capability from "@flows/kernel/Capability"
import {
  BodyRefModule,
  FlowDescriptor,
  Provenance,
  SchemaRefModule,
  SchemaRefNone
} from "@flows/registry/Descriptor"
import { Context, Effect, Layer, Option, Redacted, Schema, Semaphore, type Scope } from "effect"
import * as Mcp from "./Mcp.ts"

/**
 * Configuration for one incoming MCP wrapper.
 *
 * Only a named credential reference is accepted.  Raw secret values are not a
 * configuration type and therefore cannot enter a descriptor or status.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  readonly name: string
  readonly transport: Mcp.TransportService
  readonly capabilities: ReadonlyArray<Capability.Capability>
  readonly credential?: Credential.CredentialRef | undefined
  readonly publish?: ((descriptors: ReadonlyArray<FlowDescriptor>) => Effect.Effect<void, Mcp.McpError>) | undefined
}

/**
 * One registry entry and its live MCP invocation seam.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workflow {
  readonly descriptor: FlowDescriptor
  readonly inputSchema: Schema.Schema<unknown>
  readonly invoke: (input: unknown) => Effect.Effect<Mcp.DemuxedResult, Mcp.McpError>
}

/**
 * The incoming MCP wrapper service.
 *
 * `descriptors` and `workflows` are both stable snapshots.  `list` is an alias
 * for `descriptors`; `invoke` accepts the sanitized descriptor name.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly name: string
  readonly status: () => Effect.Effect<Mcp.Status>
  readonly descriptors: () => Effect.Effect<ReadonlyArray<FlowDescriptor>, Mcp.McpError>
  readonly list: () => Effect.Effect<ReadonlyArray<FlowDescriptor>, Mcp.McpError>
  readonly workflows: () => Effect.Effect<ReadonlyArray<Workflow>, Mcp.McpError>
  readonly get: (name: string) => Effect.Effect<Workflow, Mcp.McpError>
  readonly invoke: (name: string, input: unknown) => Effect.Effect<Mcp.DemuxedResult, Mcp.McpError>
  readonly invokeTool: (name: string, input: unknown) => Effect.Effect<Mcp.DemuxedResult, Mcp.McpError>
  readonly artifacts: Mcp.ArtifactStore
  readonly refresh: () => Effect.Effect<void, Mcp.McpError>
  readonly close: () => Effect.Effect<void, Mcp.McpError>
}

/**
 * Service tag for an incoming MCP wrapper.
 *
 * @category services
 * @since 0.1.0
 */
export const McpAsWorkflow: Context.Service<Service, Service> = Context.Service("@flows/adapters/McpAsWorkflow")

const descriptorFor = (
  server: string,
  tool: Mcp.ToolDefinition,
  capabilities: ReadonlyArray<Capability.Capability>
): FlowDescriptor =>
  new FlowDescriptor({
    name: tool.safeName,
    description: tool.description,
    body: new BodyRefModule({ path: `mcp://${Mcp.sanitizeName(server)}/${tool.safeName}` }),
    input: new SchemaRefModule({ path: `mcp://${Mcp.sanitizeName(server)}/${tool.safeName}`, field: "input" }),
    output: new SchemaRefNone({}),
    model: Option.none(),
    flows: [],
    capabilities: capabilities.map(Capability.format),
    effects: {
      reads: capabilities
        .filter((capability) => capability.action === "fs:read")
        .map((capability) => capability.resource),
      writes: capabilities
        .filter((capability) => capability.action === "fs:write")
        .map((capability) => capability.resource),
      mode: "expected",
      onConflict: "serialize",
      tier: "irreversible"
    },
    placement: Option.none(),
    modelInvocable: true,
    path: `mcp://${Mcp.sanitizeName(server)}/${tool.safeName}`,
    frontmatter: {
      mcpServer: Mcp.sanitizeName(server),
      mcpTool: tool.safeName
    },
    provenance: new Provenance({ source: "mcp", root: Mcp.sanitizeName(server) })
  })

const statusWorkflow = (server: string): Workflow => {
  const serverName = Mcp.sanitizeName(server)
  const descriptor = new FlowDescriptor({
    name: `${serverName}_needs_auth`,
    description: `MCP server ${serverName} requires authentication before its tools can be discovered.`,
    body: new BodyRefModule({ path: `mcp://${serverName}/needs_auth` }),
    input: new SchemaRefNone({}),
    output: new SchemaRefNone({}),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: "compensable"
    },
    placement: Option.none(),
    modelInvocable: false,
    path: `mcp://${serverName}/needs_auth`,
    frontmatter: { mcpServer: serverName, mcpStatus: "needs_auth" },
    provenance: new Provenance({ source: "mcp", root: serverName })
  })
  return {
    descriptor,
    inputSchema: Schema.Struct({}),
    invoke: () => Effect.fail(failure("needs_auth", `MCP server ${serverName} requires authentication`))
  }
}

const failure = (code: Mcp.McpErrorCode, message: string): Mcp.McpError =>
  new Mcp.McpError({ code, message: Mcp.sanitizeText(message) })

const normalizeFailure = (cause: unknown, fallback: Mcp.McpErrorCode, secret?: string): Mcp.McpError => {
  if (cause instanceof Mcp.McpError) {
    return failure(cause.code, secret === undefined ? cause.message : cause.message.replaceAll(secret, "<redacted>"))
  }
  return failure(fallback, "MCP operation failed")
}

/**
 * Constructs a lazy, scoped MCP-to-workflow wrapper.
 *
 * A credential is resolved only at the first connection and is passed to the
 * injected transport as an ephemeral string.  It is never copied into the
 * returned service, descriptors, status, or typed errors.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  config: Config
): Effect.Effect<Service, Mcp.McpError, Scope.Scope> =>
  Effect.gen(function*() {
    let closed = false
    const transport = yield* Effect.acquireRelease(
      Effect.succeed(config.transport),
      (ownedTransport) => {
        if (closed || ownedTransport.disconnect === undefined) return Effect.void
        closed = true
        return ownedTransport.disconnect().pipe(Effect.catch(() => Effect.void))
      }
    )
    const credentialOption = yield* Effect.serviceOption(Credential.Credential)
    const artifactStoreOption = yield* Effect.serviceOption(Mcp.ArtifactStore)
    const artifactStore = Option.getOrElse(artifactStoreOption, Mcp.makeArtifactStoreMemory)
    const lifecycleGate = yield* Semaphore.make(1)
    const serverName = Mcp.sanitizeName(config.name)
    let lifecycle: Mcp.Status = "disconnected"
    let dirty = false
    let subscribed = false
    let credentialSecret: string | undefined
    let tools: ReadonlyArray<Mcp.ToolDefinition> = []
    let entries: ReadonlyArray<Workflow> = []
    const authEntry = statusWorkflow(config.name)

    const publish = (next: ReadonlyArray<Workflow>): Effect.Effect<void, Mcp.McpError> =>
      config.publish?.(next.map((entry) => entry.descriptor)) ?? Effect.void

    const resolveCredential = (): Effect.Effect<string | undefined, Mcp.McpError> => {
      if (config.credential === undefined) return Effect.succeed(undefined)
      if (config.credential.id.trim() === "" || config.credential.name.trim() === "") {
        return Effect.fail(failure("needs_auth", "MCP credential reference must be named"))
      }
      return Option.match(credentialOption, {
        onNone: () => Effect.fail(failure("needs_auth", "MCP credential storage is unavailable")),
        onSome: (credential) =>
          credential.resolve(config.credential!).pipe(
            Effect.map(Redacted.value),
            Effect.tap((secret) =>
              Effect.sync(() => {
                credentialSecret = secret
              })
            ),
            Effect.mapError(() => failure("needs_auth", "MCP credential could not be resolved"))
          )
      })
    }

    const refreshTools = (): Effect.Effect<void, Mcp.McpError> =>
      transport.listTools().pipe(
        Effect.mapError((cause) => normalizeFailure(cause, "transport_failed", credentialSecret)),
        Effect.map((rawTools) => {
          tools = Mcp.parseTools(rawTools, serverName)
          entries = Object.freeze(tools.map((tool) => ({
            descriptor: descriptorFor(config.name, tool, config.capabilities),
            inputSchema: tool.schema,
            invoke: (input: unknown) =>
              transport.callTool(tool.name, input).pipe(
                Effect.mapError((cause) => normalizeFailure(cause, "transport_failed", credentialSecret)),
                Effect.flatMap((result) =>
                  Mcp.demuxResult(result, { redact: credentialSecret }).pipe(
                    Effect.provideService(Mcp.ArtifactStore, artifactStore)
                  )
                )
              )
          })))
          dirty = false
        }),
        Effect.andThen(Effect.suspend(() => publish(entries)))
      )

    const ensureConnectedUnsafe = (): Effect.Effect<void, Mcp.McpError> =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(failure("transport_failed", "MCP wrapper is closed"))
        if (lifecycle === "connected") return dirty ? refreshTools() : Effect.void
        lifecycle = "connecting"
        return resolveCredential().pipe(
          Effect.flatMap((secret) => transport.initialize(secret)),
          Effect.flatMap(() => refreshTools()),
          Effect.flatMap(() => {
            if (subscribed) return Effect.void
            subscribed = true
            return transport.notifications((notification) =>
              Mcp.isToolListChanged(notification)
                ? Effect.sync(() => {
                  dirty = true
                }).pipe(Effect.andThen(lifecycleGate.withPermits(1)(refreshTools())))
                : Effect.void
            ).pipe(Effect.catch(() => Effect.void))
          }),
          Effect.tap(() =>
            Effect.sync(() => {
              lifecycle = "connected"
            })
          ),
          Effect.tapError((cause) =>
            Effect.sync(() => {
              lifecycle = cause.code === "needs_auth" ? "needs_auth" : "error"
            })
          ),
          Effect.mapError((cause) => normalizeFailure(cause, "transport_failed", credentialSecret))
        )
      })

    const ensureConnected = (): Effect.Effect<void, Mcp.McpError> =>
      lifecycleGate.withPermits(1)(ensureConnectedUnsafe())

    const visibleAfterConnect = (): Effect.Effect<ReadonlyArray<Workflow>, Mcp.McpError> =>
      ensureConnected().pipe(
        Effect.map(() => entries),
        Effect.catchTag("flows/adapters/McpError", (cause) =>
          cause.code === "needs_auth"
            ? publish([authEntry]).pipe(Effect.as([authEntry]))
            : Effect.fail(cause)
        )
      )
    const descriptors = (): Effect.Effect<ReadonlyArray<FlowDescriptor>, Mcp.McpError> =>
      visibleAfterConnect().pipe(Effect.map((available) => available.map((entry) => entry.descriptor)))
    const workflows = (): Effect.Effect<ReadonlyArray<Workflow>, Mcp.McpError> =>
      visibleAfterConnect()
    const get = (name: string): Effect.Effect<Workflow, Mcp.McpError> =>
      workflows().pipe(
        Effect.flatMap((available) => {
          const workflow = available.find((entry) => entry.descriptor.name === name)
          return workflow === undefined
            ? Effect.fail(failure("protocol_error", `MCP tool "${Mcp.sanitizeName(name)}" was not found`))
            : Effect.succeed(workflow)
        })
      )
    const invoke = (name: string, input: unknown): Effect.Effect<Mcp.DemuxedResult, Mcp.McpError> =>
      get(name).pipe(Effect.flatMap((workflow) => workflow.invoke(input)))
    const close = (): Effect.Effect<void, Mcp.McpError> =>
      Effect.suspend(() => {
        if (closed) return Effect.void
        closed = true
        lifecycle = "disconnected"
        return (transport.disconnect === undefined ? Effect.void : transport.disconnect()).pipe(
          Effect.mapError((cause) => normalizeFailure(cause, "transport_failed", credentialSecret))
        )
      })

    const service = McpAsWorkflow.of({
      name: config.name,
      status: () => Effect.succeed(lifecycle),
      descriptors,
      list: descriptors,
      workflows,
      get,
      invoke,
      invokeTool: invoke,
      artifacts: artifactStore,
      refresh: () =>
        Effect.sync(() => {
          dirty = true
        }).pipe(Effect.andThen(ensureConnected())),
      close
    })
    return service
  })

/**
 * Provides a scoped MCP-to-workflow wrapper.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (config: Config): Layer.Layer<Service, Mcp.McpError> => Layer.effect(McpAsWorkflow, make(config))

/**
 * Constructs an empty wrapper service with optional operation overrides.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = () => Effect.fail(failure("transport_failed", "MCP workflow wrapper is unavailable"))
  const descriptors = () => Effect.succeed<ReadonlyArray<FlowDescriptor>>([])
  const workflows = () => Effect.succeed<ReadonlyArray<Workflow>>([])
  return McpAsWorkflow.of({
    name: "noop",
    status: () => Effect.succeed("disconnected" as const),
    descriptors,
    list: descriptors,
    workflows,
    get: unavailable,
    invoke: unavailable,
    invokeTool: unavailable,
    artifacts: Mcp.makeArtifactStoreMemory(),
    refresh: () => Effect.void,
    close: () => Effect.void,
    ...overrides
  })
}

/**
 * Provides an empty wrapper service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Service> =>
  Layer.succeed(McpAsWorkflow, makeNoop(overrides))
