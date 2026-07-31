# @smithers/adapters

Declarative CLI harness adapters and bidirectional flow projections for Smithers. The package sits between the harness, registry, and host seams: it adapts Claude Code and Codex to the common harness protocol and projects flows to or from Skills and MCP.

```sh
npm install @smithers/adapters
```

The root exports the namespaces below; each is also available from its named subpath, for example `@smithers/adapters/Mcp`. Package metadata is exported from `@smithers/adapters/package.json`.

## Public API

### Built-ins

- `builtInSpecs` — immutable map of the built-in `claude-code` and `codex` harness specifications.
- `builtInCapabilities` — capability registry for the built-in specifications.
- `ClaudeCode.spec` — declarative Claude Code stream-JSON harness specification.
- `Codex.spec` — declarative Codex JSONL harness specification.

### `AdapterRuntime`

Resolves registered harness specifications and constructs their runtime harnesses.

- `ResolvedHarness` — resolved specification, capabilities, and plan-card material.
- `AdapterRuntime` — dispatch service interface and Effect service tag.
- `make` — constructs dispatch over explicit spec and capability registries; defaults to the built-ins.
- `layer` — provides built-in adapter dispatch.
- `makeNoop` — constructs an unavailable dispatch service.
- `layerNoop` — provides the unavailable dispatch service.
- `builtInSpecs`, `builtInCapabilities` — the same built-in registries exported at the package root.

```ts
import { AdapterRuntime } from "@smithers/adapters"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const adapters = yield* AdapterRuntime.AdapterRuntime
  return yield* adapters.resolve("codex")
})

Effect.runPromise(program.pipe(Effect.provide(AdapterRuntime.layer)))
```

### `CliHarness`

Implements the shared process lifecycle around a declarative CLI specification.

- `Spec` — declarative capabilities, command builder, output interpreter, classifier patterns, prompt fragments, and optional preflight for one CLI.
- `MakeOptions` — runtime command, environment, output-schema, and projection callbacks.
- `ProjectionOptions` — registry, schema, child-run, and MCP server dependencies for reverse projection.
- `withDispatchKeyLayers` — adds stable harness, capability, prompt, and projection identities to an agent step.
- `make` — constructs a harness from a `Spec` and requires `EngineLike`.
- `makeNoop` — constructs an unavailable harness with optional overrides.
- `layer` — provides a constructed harness and requires `EngineLike`.
- `layerNoop` — provides the unavailable harness.

```ts
import { CliHarness, Codex } from "@smithers/adapters"
import * as EngineLike from "@smithers/harness/EngineLike"
import { Effect } from "effect"

const harness = CliHarness.make(Codex.spec).pipe(
  Effect.provideService(EngineLike.EngineLike, EngineLike.makeNoop())
)
```

### `AdapterError`

Defines the closed typed failure surface for CLI adapters.

- `AdapterErrorCode` — schema and inferred type for all stable adapter failure codes.
- `SpawnFailed` — CLI launch failure.
- `QuotaExhausted` — provider quota failure, optionally carrying reset timing.
- `SessionLost` — non-resumable persisted conversation failure.
- `ConfigInvalid` — non-retryable adapter configuration failure.
- `AuthFailed` — provider authentication failure.
- `ProtocolError` — malformed or otherwise invalid CLI protocol output.
- `BinaryMissing` — unavailable CLI executable.
- `Unsupported` — operation unsupported by the adapter.
- `StructuredOutputFailure` — exhausted structured-output correction budget.
- `AdapterError` — union of every adapter error class.
- `toHarnessError` — converts an adapter error to the common harness error while preserving its cause.

### `CommandSpec`

Builds and validates pure CLI command descriptions.

- `CommandSpec` — logical process invocation with separate argv, stdin, cleanup paths, and environment.
- `ResumeState` — durable CLI session identifier.
- `Options` — vendor-neutral command-builder options.
- `Builder` — common fresh-or-resumed command-builder function type.
- `withResume` — invokes a builder with resume state.
- `quoteArg` — POSIX-quotes one argument.
- `renderArgv` — renders a protected POSIX command line.
- `flagDiff` — returns flags present in a fresh command but missing from its resumed form.
- `assertResumePreservesFlags` — throws when resume drops a fresh-command flag.

### `Env`

Constructs hygienic child-process environments and safe diagnostics.

- `Environment` — readonly string-valued environment map.
- `RunIdentity` — run, node, iteration, and attempt identifiers propagated to child CLIs.
- `Layers` — inputs and precedence for hygienic environment construction.
- `scrubRecursionMarkers` — blanks inherited CLI recursion markers.
- `blankConflictingKeys` — blanks inherited provider keys unless supplied as resolved credentials.
- `merge` — builds a hygienic environment with stable precedence.
- `redactForDiagnostics` — redacts secret-like values before recording diagnostics.

### `CliClassifier`

Classifies CLI termination data into typed adapter failures.

- `Patterns` — vendor-supplied regular-expression groups for pure failure classification.
- `ClassificationInput` — exit code, stderr, records, pattern, and clock inputs to `classify`.
- `defaultPatterns` — provider-neutral default pattern set.
- `claudeCodePatterns` — Claude Code pattern set.
- `codexPatterns` — Codex pattern set.
- `isBenignStderr` — tests whether stderr contains only allowlisted notices.
- `classify` — returns a typed adapter failure for CLI termination output or `undefined` for success.
- `classifyCliOutput` — alias of `classify` emphasizing combined records and stderr.
- `classifyTermination` — alias of `classify` used by adapter specs.

### `CliOutput`

Decodes vendor-neutral CLI records and normalizes them into harness events.

- `CliToolCall` — provider-neutral tool-call record.
- `CliTurnOpened` — turn-start record and optional session metadata.
- `CliDelta` — streamed text, reasoning, or tool-call delta.
- `CliUsage` — camel-case and snake-case token accounting accepted from CLIs.
- `CliResumeToken` — opaque resumable session record.
- `CliSettled` — semantic assistant answer record.
- `CliResolved` — completed structured result record.
- `CliClosed` — terminal process status record.
- `CliRecord` — union of all normalized CLI records.
- `LineDecoder` — incremental UTF-8 CR/LF line decoder interface.
- `makeLineDecoder` — constructs an incremental decoder.
- `decodeNdjsonStream` — decodes an Effect byte stream into lines.
- `parseNdjsonLine` — parses one JSON line and ignores blanks, banners, and malformed input.
- `parseNdjsonLines` — parses an iterable of tolerant NDJSON lines.
- `decodeNdjsonChunks` — decodes byte or string chunks into JSON values.
- `stableRecordId` — derives a replay-stable model-part identifier.
- `normalizeUsage` — normalizes common CLI usage field spellings.
- `normalizeRecord` — converts one CLI record into harness events.
- `normalizeRecords` — converts a record sequence into ordered harness events.
- `AnswerSource` — structured, assistant, stdout-tail, or empty answer source.
- `AnswerResolution` — resolved answer text, source, and optional structured value.
- `resolveAnswer` — selects an answer by semantic priority.
- `resolveAnswerText` — text-only form of `resolveAnswer`.
- `truncateTailKeep` — keeps a UTF-8-safe tail under a byte budget.
- `decodeLines` — alias of `decodeNdjsonStream`.

### `HarnessCapabilities`

Declares, fingerprints, and indexes foreign harness capabilities.

- `ResumeMode` — schema and inferred type for supported resume mechanisms.
- `McpBootstrapMode` — schema and inferred type for MCP bootstrap mechanisms.
- `SkillsInstallMode` — schema and inferred type for skill installation layouts.
- `HarnessCapabilities` — schema class describing one foreign harness version.
- `Registry` — immutable capability records and isolated multi-seat subset.
- `PlanCardMaterial` — stable capability data exposed on plan and run cards.
- `digest` — computes a SHA-256 digest over canonical JSON.
- `fingerprint` — computes a stable capability-record fingerprint.
- `eligibleForMultiSeatPool` — tests whether config isolation permits multi-seat use.
- `makeRegistry` — constructs a capability registry.
- `register` — returns a registry containing an added or replaced record.
- `lookup` — looks up a capability record by harness name.
- `lookupForMultiSeatPool` — looks up only multi-seat-eligible records.
- `keyLayers` — returns stable step-key layer identities for a dispatch.
- `planCardMaterial` — projects a capability record to plan-card data.

### `HarnessPrompt`

Assembles deterministic system-channel content for foreign harnesses.

- `Sections` — adapter-owned deterministic system-prompt sections.
- `Assembled` — assembled system channel and stable digest.
- `assemble` — renders one system channel, omitting the output-row contract when native structured output is available.

### `StructuredOutput`

Defines local JSON Schema validation and the one-correction contract.

- `JsonSchema` — boolean or object JSON Schema accepted by adapters.
- `Contract` — canonical schema, digest, and one-correction policy.
- `Validation` — valid value or bounded diagnostics for an invalid candidate.
- `make` — constructs a structured-output contract.
- `renderSchema` — renders the exact local-validation schema.
- `validate` — extracts balanced JSON and validates it locally.
- `correctionPrompt` — renders the single bounded correction prompt.
- `failure` — constructs the terminal typed failure after correction is spent.
- `decode` — returns the validated value or fails with `StructuredOutputFailure`.

### `Projection`

Selects registry flows for external discovery surfaces.

- `JsonSchema` — object-shaped schema used by external discovery surfaces.
- `ProjectionError` — typed projection failure.
- `SchemaResolver` — schema-resolution interface and Effect service tag.
- `makeSchemaResolver` — constructs a schema resolver.
- `layerSchemaResolver` — provides a schema resolver.
- `SeatCapabilities` — accepted capability and visibility envelope for a projection seat.
- `SelectedFlow` — selected descriptor with surface-safe tool name and input schema.
- `Selection` — deterministic selected descriptors, names, schemas, and digest.
- `select` — selects visible, capability-compatible flows and resolves their schemas.
- `toToolName` — converts a registry flow name to a surface-safe tool name.

### `FlowsAsSkills`

Renders and mounts selected flows as deterministic skill trees.

- `SkillsInstall` — supported `plugin-dir`, `home-dir`, or `none` layout.
- `SkillsCapabilities` — capability input used to choose the layout.
- `SkillFile` — one in-memory file in a rendered skill tree.
- `RenderedSkills` — deterministic files and content digest.
- `MountedSkills` — scoped installation root and direct harness options.
- `render` — renders one `SKILL.md` per selected flow without host writes.
- `install` — installs a rendered tree in a scope-owned temporary directory.
- `mount` — installs the tree and returns its `CliHarness.make` bridge.

```ts
import { FlowsAsSkills } from "@smithers/adapters"
import { Effect } from "effect"

const mounted = Effect.scoped(FlowsAsSkills.mount(rendered, {
  skillsInstall: "plugin-dir"
}))
```

### `FlowsAsMcp`

Renders and serves selected flows as run-scoped MCP tools.

- `McpCapabilities` — capability input used to choose MCP bootstrap configuration.
- `McpTool` — one tool in the pure MCP projection.
- `ChildRunInvoker` — durable child-run invocation seam.
- `ToolCall` — projected `tools/call` request.
- `McpCallResult` — bounded text-only MCP-compatible result.
- `RenderedMcp` — projected tools, handler factory, and digest.
- `ServerEndpoint` — concrete stdio or HTTP endpoint.
- `Server` — run-scoped server interface and Effect service tag.
- `makeServer` — constructs a server service from an implementation.
- `layerServer` — provides a server implementation.
- `makeServerNoop` — constructs an unavailable server.
- `layerServerNoop` — provides the unavailable server.
- `MountedMcp` — active endpoint, bootstrap config, digest, and harness options.
- `handler` — builds a handler that invokes selected flows as durable child runs.
- `render` — renders selected flows as MCP tools.
- `mount` — serves the projection, writes bootstrap configuration, and returns harness options.

### `Mcp`

Defines provider-neutral MCP transport, parsing, artifact, and result utilities.

- `Status` — schema and inferred lifecycle-state type.
- `McpErrorCode` — schema and inferred stable failure-code type.
- `McpError` — sanitized typed MCP boundary failure.
- `ToolDefinition` — parsed server tool with original and surface-safe names.
- `Notification` — MCP notification shape used for refresh handling.
- `CallResult` — extension-tolerant MCP call result.
- `ContentPart` — content accepted by the bounded demultiplexer.
- `MediaRecord` — journal-safe artifact metadata.
- `DemuxedResult` — bounded text, media, structured data, and error flag.
- `ArtifactStore` — content-addressed store interface and Effect service tag.
- `makeArtifactStore` — constructs an artifact store from an implementation.
- `layerArtifactStore` — provides an artifact store.
- `makeArtifactStoreMemory` — constructs process-local artifact storage.
- `layerArtifactStoreMemory` — provides process-local artifact storage.
- `NotificationListener` — transport notification callback type.
- `TransportService` — injected MCP protocol operations.
- `Transport` — alias for `TransportService` and the Effect service tag of the same name.
- `make` — constructs a transport service.
- `layer` — provides a transport service.
- `makeNoop` — constructs an unavailable transport with optional overrides.
- `layerNoop` — provides the unavailable transport.
- `makeUnsupportedStdio` — constructs a transport that explicitly rejects stdio.
- `sanitizeText` — removes control characters and bounds display text.
- `sanitizeName` — converts a server-controlled name or URI to a stable identifier.
- `sanitizeToolName` — alias of `sanitizeName`.
- `sanitizeNames` — sanitizes names and deterministically resolves collisions.
- `sanitizeToolNames` — alias of `sanitizeNames`.
- `parseInputSchema` — normalizes input to object-shaped JSON Schema.
- `parseToolSchema` — alias of `parseInputSchema`.
- `parseTool` — tolerantly parses one foreign tool definition.
- `parseTools` — parses and sanitizes a full tool list.
- `isToolListChanged` — recognizes the standard tool-list-changed notification.
- `DemuxOptions` — byte caps and optional redaction for result demultiplexing.
- `demuxResult` — stores non-text content and returns bounded journal-safe output.
- `demultiplex` — alias of `demuxResult`.

### `McpAsFlow`

Wraps a foreign MCP server as registry-compatible Smithers flows.

- `Config` — name, transport, capabilities, optional credential reference, and publish callback for one wrapper.
- `Flow` — registry descriptor, input schema, and live MCP invocation seam.
- `Service` — scoped incoming MCP wrapper operations and artifact store.
- `McpAsFlow` — Effect service tag for `Service`.
- `make` — constructs a lazy scoped MCP-to-flow wrapper.
- `layer` — provides a scoped wrapper.
- `makeNoop` — constructs an empty wrapper with optional overrides.
- `layerNoop` — provides an empty wrapper.

```ts
import { Mcp, McpAsFlow } from "@smithers/adapters"
import { Effect } from "effect"

const wrapper = Effect.scoped(McpAsFlow.make({
  name: "tools",
  transport: Mcp.makeNoop(),
  capabilities: []
}))
```
