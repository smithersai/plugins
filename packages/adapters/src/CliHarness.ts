/**
 * Shared runtime for declarative foreign CLI harness specifications.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Agent Adapters.md`,
 * `docs/specs/Concepts/Run Ownership.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Structured Output.md`.
 *
 * @since 0.1.0
 */
import * as AgentEvent from "@smithers/harness/AgentEvent"
import * as AgentStep from "@smithers/harness/AgentStep"
import * as EngineLike from "@smithers/harness/EngineLike"
import * as Harness from "@smithers/harness/Harness"
import { HarnessError } from "@smithers/harness/HarnessError"
import * as FileSystem from "@smithers/kernel/FileSystem"
import * as Shell from "@smithers/kernel/Shell"
import { CanonicalJson, ModelEvent, ModelRequest } from "@smithers/model"
import type { Registry } from "@smithers/registry/Registry"
import { Cause, Effect, Layer, Option, type Scope, Stream } from "effect"
import * as AdapterError from "./AdapterError.ts"
import * as CliClassifier from "./CliClassifier.ts"
import * as CliOutput from "./CliOutput.ts"
import * as CommandSpec from "./CommandSpec.ts"
import * as Env from "./Env.ts"
import * as FlowsAsMcp from "./FlowsAsMcp.ts"
import * as FlowsAsSkills from "./FlowsAsSkills.ts"
import * as HarnessCapabilities from "./HarnessCapabilities.ts"
import * as HarnessPrompt from "./HarnessPrompt.ts"
import * as Projection from "./Projection.ts"
import * as StructuredOutput from "./StructuredOutput.ts"

const maximumDiagnosticBytes = 1024 * 1024
const exitSentinel = "__FLOWS_CLI_EXIT__:"
const terminalRecordTypes = new Set<CliOutput.CliRecord["type"]>(["settled", "resolved", "closed"])

const eventType = {
  modelSettled: "flows.harness.model-settled.v1",
  resolved: "flows.harness.resolved.v1",
  resumeToken: "flows.harness.resume-token.v1",
  turnClosed: "flows.harness.turn-closed.v1",
  turnOpened: "flows.harness.turn-opened.v1"
} as const

/**
 * Declarative behavior supplied by one concrete CLI adapter.
 *
 * @category models
 * @since 0.1.0
 */
export interface Spec {
  readonly capabilities: HarnessCapabilities.HarnessCapabilities
  readonly patterns: CliClassifier.Patterns
  readonly buildCommand: (
    options: CommandSpec.Options,
    resume?: CommandSpec.ResumeState | undefined
  ) => CommandSpec.CommandSpec
  readonly interpret: (jsonLine: unknown) => CliOutput.CliRecord | null
  readonly prompt?: Partial<HarnessPrompt.Sections> | undefined
  readonly preflight?: (
    shell: Shell.Shell,
    environment: Readonly<Record<string, string>>
  ) => Effect.Effect<void, unknown> | undefined
}

/**
 * Runtime projections supplied by the adapter composition root.
 *
 * The harness contract carries only serializable step material. These
 * callbacks add host-local command options and credential-resolved
 * environment values without putting secrets in the step or journal.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly commandOptions?: ((step: AgentStep.AgentStep) => CommandSpec.Options) | undefined
  readonly environment?:
    | ((step: AgentStep.AgentStep) => {
      readonly runIdentity?: Env.RunIdentity | Env.Environment | undefined
      readonly credentials?: Env.Environment | undefined
      readonly userOverrides?: Env.Environment | undefined
    })
    | undefined
  readonly outputSchema?: ((step: AgentStep.AgentStep) => StructuredOutput.JsonSchema | undefined) | undefined
  readonly projection?: ProjectionOptions | undefined
}

/**
 * Runtime-only dependencies for reverse-projecting the registry into a CLI.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProjectionOptions {
  readonly registry: Registry
  readonly schemaResolver: Projection.SchemaResolver
  readonly seatCapabilities: (
    step: AgentStep.AgentStep
  ) => Projection.SeatCapabilities
  readonly childRunInvoker: FlowsAsMcp.ChildRunInvoker
  readonly server: FlowsAsMcp.Server
}

interface AttemptState {
  readonly records: Array<CliOutput.CliRecord>
  readonly diagnostics: Array<unknown>
  readonly emitted: Set<AgentEvent.AgentEvent["_tag"]>
  readonly stdoutDecoder: CliOutput.LineDecoder
  readonly stderrDecoder: CliOutput.LineDecoder
  recordIndex: number
  exitCode: number | undefined
  stdoutTail: string
  stderrTail: string
}

interface InterpretedText {
  readonly diagnostics: ReadonlyArray<unknown>
  readonly records: ReadonlyArray<CliOutput.CliRecord>
}

interface SystemProjection {
  readonly command: CommandSpec.CommandSpec
  readonly inArgv: boolean
}

interface PreparedProjection {
  readonly options: MakeOptions
  readonly digest: string
  readonly disclosure: string
}

class ClassifiedAttempt {
  readonly _tag = "ClassifiedAttempt"
  readonly error: AdapterError.AdapterError
  readonly sessionId: string | undefined

  constructor(
    error: AdapterError.AdapterError,
    sessionId: string | undefined
  ) {
    this.error = error
    this.sessionId = sessionId
  }
}

class CorrectionRequired {
  readonly _tag = "CorrectionRequired"
  readonly prompt: string
  readonly resume: CommandSpec.ResumeState | undefined

  constructor(
    prompt: string,
    resume: CommandSpec.ResumeState | undefined
  ) {
    this.prompt = prompt
    this.resume = resume
  }
}

type AttemptError = AdapterError.AdapterError | ClassifiedAttempt | CorrectionRequired

const harnessFailure = (
  code: HarnessError["code"],
  message: string,
  cause?: unknown
): HarnessError => new HarnessError({ code, message, cause })

const modelFromSeat = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

const resumePayload = (
  value: unknown
): {
  readonly agentEngine: string
  readonly agentResume: string
  readonly discardResumeSession: boolean
} | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const payload = value as Record<string, unknown>
  return typeof payload.agentEngine === "string"
      && typeof payload.agentResume === "string"
      && typeof payload.discardResumeSession === "boolean"
    ? {
      agentEngine: payload.agentEngine,
      agentResume: payload.agentResume,
      discardResumeSession: payload.discardResumeSession
    }
    : undefined
}

const resumeFromStep = (
  step: AgentStep.AgentStep,
  engine: string
): CommandSpec.ResumeState | undefined => {
  for (let index = step.journal.length - 1; index >= 0; index--) {
    const entry = step.journal[index]
    if (entry?.eventType !== eventType.resumeToken) continue
    const payload = resumePayload(entry.payload)
    if (payload === undefined || payload.agentEngine !== engine) continue
    return payload.discardResumeSession
      ? undefined
      : { sessionId: payload.agentResume }
  }
  return undefined
}

const registryDisclosure = (step: AgentStep.AgentStep): string => {
  const declared = CanonicalJson.stringify({
    activeToolNames: [...step.activeToolNames],
    tools: step.toolDefinitions
  })
  return [
    step.system.text.trim(),
    ...step.instructions.map((instruction) => instruction.text.trim()),
    `The only callable tools are the following declared registry projection:\n${declared}`
  ].filter((part) => part.length > 0).join("\n\n")
}

const promptSections = (
  step: AgentStep.AgentStep,
  spec: Spec,
  projectionDisclosure = ""
): HarnessPrompt.Sections => {
  const defaults: HarnessPrompt.Sections = {
    worktreeIsolationNotice:
      "Work only inside the host-provided isolated worktree. Do not read or modify sibling worktrees or ambient host paths.",
    registryToolDisclosure: [registryDisclosure(step), projectionDisclosure].filter((part) => part.length > 0).join(
      "\n\n"
    ),
    outputRowJsonContract:
      "Return exactly one UTF-8 JSON object on one line. The object must satisfy the declared output schema; do not wrap it in markdown.",
    schemaCorrectionPrompt:
      "If validation rejects the output row, issue exactly one correction prompt: \"Return one corrected JSON row matching the declared schema.\"",
    resumeWarning: spec.capabilities.resume === "none"
      ? "This harness has no resume mechanism. Never infer or synthesize a session identifier."
      : "Resume only the session identifier supplied by the owning engine. If that session is missing or corrupt, emit a discard-resume report and return the typed failure to Run Ownership."
  }
  return { ...defaults, ...spec.prompt }
}

const taskPrompt = (
  step: AgentStep.AgentStep,
  assembled: HarnessPrompt.Assembled,
  commandStdin: string | undefined,
  systemInArgv: boolean,
  correctionPrompt?: string | undefined
): string =>
  [
    systemInArgv ? "" : assembled.system,
    "## Task",
    step.prompt.text.trim(),
    `Input:\n${CanonicalJson.stringify(step.input)}`,
    commandStdin?.trim() ?? "",
    correctionPrompt === undefined ? "" : `## Structured output correction\n\n${correctionPrompt}`
  ].filter((part) => part.length > 0).join("\n\n")

const projectSystemChannel = (
  command: CommandSpec.CommandSpec,
  system: string
): SystemProjection => {
  const args = [...command.args]
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--system-prompt" && args[index + 1] !== undefined) {
      args[index + 1] = system
      return { command: { ...command, args }, inArgv: true }
    }
    if (argument?.startsWith("--system-prompt=")) {
      args[index] = `--system-prompt=${system}`
      return { command: { ...command, args }, inArgv: true }
    }
  }
  return { command, inArgv: false }
}

const cleanupTargets = (
  command: CommandSpec.CommandSpec
): ReadonlyArray<string> => [
  ...command.cleanup,
  ...(command.outputFile === undefined ? [] : [command.outputFile])
]

const registerCleanup = (
  fileSystem: FileSystem.FileSystem,
  command: CommandSpec.CommandSpec,
  registered: Set<string>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    for (const target of cleanupTargets(command)) {
      if (registered.has(target)) continue
      registered.add(target)
      yield* Effect.acquireRelease(
        Effect.succeed(target),
        (path) => fileSystem.remove(path, { force: true, recursive: true }).pipe(Effect.ignore)
      )
    }
  })

const interpretText = (
  spec: Spec,
  text: string
): Effect.Effect<InterpretedText, AdapterError.ProtocolError> =>
  Effect.try({
    try: () => {
      const decoder = CliOutput.makeLineDecoder()
      const lines = [...decoder.push(text), ...decoder.finish()]
      const diagnostics: Array<unknown> = []
      const records: Array<CliOutput.CliRecord> = []
      for (const line of lines) {
        const value = CliOutput.parseNdjsonLine(line)
        if (value === undefined) continue
        diagnostics.push(value)
        const record = spec.interpret(value)
        if (record !== null) records.push(record)
      }
      return { diagnostics, records }
    },
    catch: () =>
      new AdapterError.ProtocolError({
        message: `${spec.capabilities.name} emitted an invalid structured record`
      })
  })

const outputFileText = (
  fileSystem: FileSystem.FileSystem,
  outputFile: string | undefined
): Effect.Effect<string | undefined> =>
  outputFile === undefined
    ? Effect.succeed(undefined)
    : fileSystem.readFileString(outputFile).pipe(
      Effect.map((text) => text as string | undefined),
      Effect.catch(() => Effect.succeed(undefined))
    )

const replaceResumeEngine = (
  event: AgentEvent.AgentEvent,
  engine: string
): AgentEvent.AgentEvent =>
  event._tag !== "resume-token"
    ? event
    : new AgentEvent.ResumeToken({
      eventType: eventType.resumeToken,
      agentEngine: engine,
      agentResume: event.agentResume,
      discardResumeSession: event.discardResumeSession
    })

const terminalEvents = (
  step: AgentStep.AgentStep,
  assembled: HarnessPrompt.Assembled,
  emitted: ReadonlySet<AgentEvent.AgentEvent["_tag"]>,
  records: ReadonlyArray<CliOutput.CliRecord>,
  answer: CliOutput.AnswerResolution
): ReadonlyArray<AgentEvent.AgentEvent> => {
  const events: Array<AgentEvent.AgentEvent> = []
  if (!emitted.has("turn-opened")) {
    events.push(
      new AgentEvent.TurnOpened({
        eventType: eventType.turnOpened,
        seat: step.seat,
        modelParams: ModelRequest.GenerationParams.make({
          reasoningEffort: step.thinkingLevel
        }),
        activeToolNames: step.activeToolNames,
        contextDigest: assembled.digest
      })
    )
  }

  const assistant = ModelRequest.Message.assistant(answer.text, { stopReason: "stop" })
  const settled = [...records].reverse().find((record): record is CliOutput.CliSettled => record.type === "settled")
  if (answer.text.length > 0) {
    events.push(
      new AgentEvent.ModelSettled({
        eventType: eventType.modelSettled,
        message: assistant,
        usage: settled?.usage === undefined ? ModelEvent.Usage.make({}) : CliOutput.normalizeUsage(settled.usage)
      })
    )
  }
  events.push(
    new AgentEvent.TurnClosed({
      eventType: eventType.turnClosed,
      stopReason: "stop",
      outcome: "resolved"
    })
  )
  if (answer.text.length > 0) {
    events.push(
      new AgentEvent.Resolved({
        eventType: eventType.resolved,
        message: assistant
      })
    )
  }
  return events
}

const lastSessionId = (
  records: ReadonlyArray<CliOutput.CliRecord>,
  resume: CommandSpec.ResumeState | undefined
): string | undefined => {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record?.type === "resumeToken") return record.sessionId
    if (record?.type === "turnOpened" && record.sessionId !== undefined) {
      return record.sessionId
    }
  }
  return resume?.sessionId
}

const commandOptions = (
  step: AgentStep.AgentStep,
  options: MakeOptions
): CommandSpec.Options => {
  const projected = options.commandOptions?.(step) ?? {}
  return {
    ...projected,
    model: projected.model ?? modelFromSeat(step.seat),
    jsonMode: projected.jsonMode ?? true
  }
}

const journalRunIdentity = (step: AgentStep.AgentStep): Env.RunIdentity => {
  const latest = step.journal.at(-1)
  const meta = latest !== undefined && typeof latest.meta === "object" && latest.meta !== null
    ? latest.meta as Readonly<Record<string, unknown>>
    : {}
  const iteration = typeof meta.iteration === "number" || typeof meta.iteration === "string"
    ? meta.iteration
    : 0
  const attempt = typeof meta.attempt === "number" || typeof meta.attempt === "string"
    ? meta.attempt
    : 0
  return latest === undefined
    ? { iteration, attempt }
    : {
      runId: latest.runId,
      nodeId: latest.sourceId,
      iteration,
      attempt
    }
}

const makeCommand = (
  spec: Spec,
  options: CommandSpec.Options,
  resume: CommandSpec.ResumeState | undefined
): Effect.Effect<CommandSpec.CommandSpec, AdapterError.ConfigInvalid> =>
  Effect.try({
    try: () => spec.buildCommand(options, resume),
    catch: () =>
      new AdapterError.ConfigInvalid({
        message: `Unable to construct the ${spec.capabilities.name} command`
      })
  })

const commandWithExitStatus = (command: CommandSpec.CommandSpec): string => {
  const rendered = CommandSpec.renderArgv(command)
  return `{ ${rendered}; flows_cli_exit=$?; printf '\\n${exitSentinel}%s\\n' "$flows_cli_exit"; }`
}

const exitCodeFromLine = (line: string): number | undefined => {
  if (!line.startsWith(exitSentinel)) return undefined
  const value = Number(line.slice(exitSentinel.length))
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const appendTail = (current: string, line: string): string =>
  CliOutput.truncateTailKeep(`${current}${line}\n`, maximumDiagnosticBytes)

const consumeStdoutLine = (
  state: AttemptState,
  spec: Spec,
  assembled: HarnessPrompt.Assembled,
  line: string
): Effect.Effect<ReadonlyArray<AgentEvent.AgentEvent>, AdapterError.ProtocolError> =>
  Effect.try({
    try: () => {
      if (line.startsWith(exitSentinel)) {
        state.exitCode = exitCodeFromLine(line)
        return []
      }
      state.stdoutTail = appendTail(state.stdoutTail, line)
      const value = CliOutput.parseNdjsonLine(line)
      if (value === undefined) return []
      state.diagnostics.push(value)
      const record = spec.interpret(value)
      if (record === null) return []
      state.records.push(record)
      const index = state.recordIndex++
      if (terminalRecordTypes.has(record.type)) return []
      const events = CliOutput.normalizeRecord(record, assembled.digest, index)
        .map((event) => replaceResumeEngine(event, spec.capabilities.name))
      for (const event of events) state.emitted.add(event._tag)
      return events
    },
    catch: () =>
      new AdapterError.ProtocolError({
        message: `${spec.capabilities.name} emitted an invalid structured record`
      })
  })

const consumeStderrLine = (state: AttemptState, line: string): void => {
  state.stderrTail = appendTail(state.stderrTail, line)
  const value = CliOutput.parseNdjsonLine(line)
  if (value !== undefined) state.diagnostics.push(value)
}

const consumeChunk = (
  state: AttemptState,
  spec: Spec,
  assembled: HarnessPrompt.Assembled,
  chunk: { readonly kind: "stdout" | "stderr"; readonly chunk: Uint8Array }
): Effect.Effect<ReadonlyArray<AgentEvent.AgentEvent>, AdapterError.ProtocolError> => {
  if (chunk.kind === "stderr") {
    for (const line of state.stderrDecoder.push(chunk.chunk)) consumeStderrLine(state, line)
    return Effect.succeed([])
  }
  return Effect.forEach(
    state.stdoutDecoder.push(chunk.chunk),
    (line) => consumeStdoutLine(state, spec, assembled, line),
    { concurrency: 1 }
  ).pipe(Effect.map((events) => events.flat()))
}

const answerFromOutputFile = (
  text: string,
  records: ReadonlyArray<CliOutput.CliRecord>
): CliOutput.AnswerResolution => {
  const semantic = CliOutput.resolveAnswer(records)
  if (semantic.source !== "empty") return semantic
  const trimmed = text.trim()
  try {
    const structured = JSON.parse(trimmed) as unknown
    return {
      text: CanonicalJson.stringify(structured),
      source: "structured",
      structured
    }
  } catch {
    return {
      text: trimmed,
      source: trimmed.length === 0 ? "empty" : "assistant"
    }
  }
}

const validateAnswer = (
  answer: CliOutput.AnswerResolution,
  contract: StructuredOutput.Contract | undefined,
  correctionCount: number,
  records: ReadonlyArray<CliOutput.CliRecord>,
  resume: CommandSpec.ResumeState | undefined
): Effect.Effect<CliOutput.AnswerResolution, AdapterError.StructuredOutputFailure | CorrectionRequired> => {
  if (contract === undefined) return Effect.succeed(answer)
  const validation = StructuredOutput.validate(answer.structured ?? answer.text, contract)
  if (validation._tag === "Valid") {
    return Effect.succeed({
      text: CanonicalJson.stringify(validation.value),
      source: "structured",
      structured: validation.value
    })
  }
  if (correctionCount < contract.correctionLimit) {
    const sessionId = lastSessionId(records, resume)
    return Effect.fail(
      new CorrectionRequired(
        StructuredOutput.correctionPrompt(contract, validation),
        sessionId === undefined ? undefined : { sessionId }
      )
    )
  }
  return Effect.fail(StructuredOutput.failure(contract, validation, correctionCount))
}

const runAttempt = (
  step: AgentStep.AgentStep,
  spec: Spec,
  assembled: HarnessPrompt.Assembled,
  shell: Shell.Shell,
  fileSystem: FileSystem.FileSystem,
  registeredCleanup: Set<string>,
  resume: CommandSpec.ResumeState | undefined,
  makeOptions: MakeOptions,
  contract: StructuredOutput.Contract | undefined,
  correctionCount: number,
  correctionPrompt?: string | undefined
): Stream.Stream<AgentEvent.AgentEvent, AttemptError, Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const options = commandOptions(step, makeOptions)
      const builtCommand = yield* makeCommand(spec, options, resume)
      const systemProjection = projectSystemChannel(builtCommand, assembled.system)
      const command = systemProjection.command
      yield* registerCleanup(fileSystem, command, registeredCleanup)
      if (command.outputFile !== undefined) {
        yield* fileSystem.remove(command.outputFile, { force: true }).pipe(Effect.ignore)
      }
      const projectedEnvironment = makeOptions.environment?.(step)
      const environment = Env.merge({
        processEnv: typeof process === "undefined" ? {} : process.env,
        adapterDefaults: command.env,
        runIdentity: projectedEnvironment?.runIdentity ?? journalRunIdentity(step),
        credentials: projectedEnvironment?.credentials,
        userOverrides: projectedEnvironment?.userOverrides
      })
      const stdin = taskPrompt(
        step,
        assembled,
        command.stdin,
        systemProjection.inArgv,
        correctionPrompt
      )
      const state: AttemptState = {
        records: [],
        diagnostics: [],
        emitted: new Set(),
        stdoutDecoder: CliOutput.makeLineDecoder(),
        stderrDecoder: CliOutput.makeLineDecoder(),
        recordIndex: 0,
        exitCode: undefined,
        stdoutTail: "",
        stderrTail: ""
      }
      const processStream = shell.stream(
        commandWithExitStatus(command),
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: environment,
          stdin
        }
      ).pipe(
        Stream.mapError(() =>
          new AdapterError.SpawnFailed({
            message: `Unable to run ${spec.capabilities.name}`
          })
        ),
        Stream.mapEffect((chunk) => consumeChunk(state, spec, assembled, chunk)),
        Stream.flatMap(Stream.fromArray)
      )
      const finish = Effect.gen(function*() {
        for (const line of state.stderrDecoder.finish()) consumeStderrLine(state, line)
        for (const line of state.stdoutDecoder.finish()) {
          yield* consumeStdoutLine(state, spec, assembled, line)
        }
        if (state.exitCode === undefined) {
          return yield* Effect.fail(
            new AdapterError.ProtocolError({
              message: `${spec.capabilities.name} did not report a process exit status`
            })
          )
        }
        const fileText = yield* outputFileText(fileSystem, command.outputFile)
        const fileOutput = fileText === undefined
          ? { diagnostics: [], records: [] }
          : yield* interpretText(spec, fileText)
        state.diagnostics.push(...fileOutput.diagnostics)
        state.records.push(...fileOutput.records)
        const classified = CliClassifier.classify(
          state.exitCode,
          state.stderrTail,
          state.diagnostics,
          spec.patterns
        )
        if (classified !== undefined) {
          return yield* Effect.fail(
            new ClassifiedAttempt(classified, lastSessionId(state.records, resume))
          )
        }
        const answer = fileText !== undefined && fileText.trim().length > 0
          ? answerFromOutputFile(fileText, fileOutput.records)
          : CliOutput.resolveAnswer(state.records, state.stdoutTail)
        const validated = yield* validateAnswer(answer, contract, correctionCount, state.records, resume)
        return terminalEvents(step, assembled, state.emitted, state.records, validated)
      })
      return processStream.pipe(
        Stream.concat(
          Stream.fromEffect(finish).pipe(Stream.flatMap(Stream.fromArray))
        )
      )
    })
  )

const preflight = (
  spec: Spec,
  shell: Shell.Shell,
  step: AgentStep.AgentStep,
  makeOptions: MakeOptions
): Effect.Effect<void, AdapterError.AdapterError> =>
  spec.preflight === undefined
    ? Effect.void
    : Effect.gen(function*() {
      const command = yield* makeCommand(spec, commandOptions(step, makeOptions), undefined)
      const projectedEnvironment = makeOptions.environment?.(step)
      const environment = Env.merge({
        processEnv: typeof process === "undefined" ? {} : process.env,
        adapterDefaults: command.env,
        runIdentity: projectedEnvironment?.runIdentity ?? journalRunIdentity(step),
        credentials: projectedEnvironment?.credentials,
        userOverrides: projectedEnvironment?.userOverrides
      })
      yield* Effect.suspend(() => spec.preflight?.(shell, environment) ?? Effect.void).pipe(
        Effect.mapError((error) =>
          typeof error === "object"
            && error !== null
            && "_tag" in error
            && typeof error._tag === "string"
            && error._tag.startsWith("flows/adapters/")
            ? error as AdapterError.AdapterError
            : new AdapterError.SpawnFailed({
              message: `Preflight failed for ${spec.capabilities.name}`
            })
        )
      )
    })

const outputContract = (
  step: AgentStep.AgentStep,
  fileSystem: FileSystem.FileSystem,
  makeOptions: MakeOptions
): Effect.Effect<StructuredOutput.Contract | undefined, AdapterError.ConfigInvalid> => {
  const declared = makeOptions.outputSchema?.(step)
  if (declared !== undefined) return Effect.succeed(StructuredOutput.make(declared))
  const path = commandOptions(step, makeOptions).outputSchemaPath
  if (path === undefined) return Effect.succeed(undefined)
  return fileSystem.readFileString(path).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => StructuredOutput.make(JSON.parse(text) as StructuredOutput.JsonSchema),
        catch: () =>
          new AdapterError.ConfigInvalid({
            message: "The configured CLI output schema is not valid JSON"
          })
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof AdapterError.ConfigInvalid
        ? cause
        : new AdapterError.ConfigInvalid({
          message: "The configured CLI output schema could not be read"
        })
    )
  )
}

const mergeMakeOptions = (
  base: MakeOptions,
  additions: ReadonlyArray<MakeOptions>
): MakeOptions => {
  const all = [base, ...additions]
  const commandOptions = all.some((options) => options.commandOptions !== undefined)
    ? (step: AgentStep.AgentStep): CommandSpec.Options => {
      let merged: CommandSpec.Options = {}
      const extraArgs: Array<string> = []
      for (const options of all) {
        const projected = options.commandOptions?.(step)
        if (projected === undefined) continue
        merged = { ...merged, ...projected }
        extraArgs.push(...(projected.extraArgs ?? []))
      }
      return extraArgs.length === 0 ? merged : { ...merged, extraArgs }
    }
    : undefined
  const environment = all.some((options) => options.environment !== undefined)
    ? (step: AgentStep.AgentStep) => {
      let runIdentity: Env.RunIdentity | Env.Environment | undefined
      const credentials: Record<string, string | undefined> = {}
      const userOverrides: Record<string, string | undefined> = {}
      for (const options of all) {
        const projected = options.environment?.(step)
        if (projected === undefined) continue
        if (projected.runIdentity !== undefined) runIdentity = projected.runIdentity
        Object.assign(credentials, projected.credentials)
        Object.assign(userOverrides, projected.userOverrides)
      }
      return {
        ...(runIdentity === undefined ? {} : { runIdentity }),
        ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
        ...(Object.keys(userOverrides).length === 0 ? {} : { userOverrides })
      }
    }
    : undefined
  return {
    ...base,
    ...(commandOptions === undefined ? {} : { commandOptions }),
    ...(environment === undefined ? {} : { environment })
  }
}

const prepareProjection = (
  spec: Spec,
  step: AgentStep.AgentStep,
  makeOptions: MakeOptions
): Effect.Effect<PreparedProjection, Projection.ProjectionError, FileSystem.FileSystem | Scope.Scope> => {
  const config = makeOptions.projection
  if (config === undefined) {
    return Effect.succeed({
      options: makeOptions,
      digest: HarnessCapabilities.digest({ projection: "none" }),
      disclosure: CanonicalJson.stringify({
        harness: HarnessCapabilities.planCardMaterial(spec.capabilities),
        projection: "none"
      })
    })
  }
  return Effect.gen(function*() {
    const selection = yield* Projection.select(config.registry, config.seatCapabilities(step)).pipe(
      Effect.provideService(Projection.SchemaResolver, config.schemaResolver)
    )
    const additions: Array<MakeOptions> = []
    let skillsDigest: string | undefined
    let mcpDigest: string | undefined
    if (spec.capabilities.mcpBootstrap !== "none") {
      const rendered = yield* FlowsAsMcp.render(selection, spec.capabilities)
      const mounted = yield* FlowsAsMcp.mount(
        rendered,
        spec.capabilities,
        config.childRunInvoker
      ).pipe(Effect.provideService(FlowsAsMcp.Server, config.server))
      additions.push(mounted.harnessOptions)
      mcpDigest = mounted.digest
    }
    if (spec.capabilities.skillsInstall !== "none") {
      const rendered = yield* FlowsAsSkills.render(selection, spec.capabilities)
      const mounted = yield* FlowsAsSkills.mount(rendered, spec.capabilities)
      additions.push(mounted.harnessOptions)
      skillsDigest = rendered.digest
    }
    const projectionDigest = HarnessCapabilities.digest({
      selection: selection.digest,
      ...(mcpDigest === undefined ? {} : { mcp: mcpDigest }),
      ...(skillsDigest === undefined ? {} : { skills: skillsDigest })
    })
    return {
      options: mergeMakeOptions(makeOptions, additions),
      digest: projectionDigest,
      disclosure: [
        "Wrapped harness plan-card and reverse-projection material:",
        CanonicalJson.stringify({
          harness: HarnessCapabilities.planCardMaterial(spec.capabilities),
          projectionDigest,
          flows: selection.flows.map((flow) => ({
            name: flow.descriptor.name,
            toolName: flow.toolName
          }))
        })
      ].join("\n")
    }
  })
}

/**
 * Adds stable harness, capability, prompt, and projection identities to an
 * AgentStep before the caller computes its step key.
 *
 * @category conversions
 * @since 0.1.0
 */
export const withDispatchKeyLayers = (
  step: AgentStep.AgentStep,
  capabilities: HarnessCapabilities.HarnessCapabilities,
  promptDigest: string,
  projectionDigest: string
): AgentStep.AgentStep => {
  const layers = [
    ...step.layers,
    ...HarnessCapabilities.keyLayers(capabilities, promptDigest, projectionDigest)
  ]
  return new AgentStep.AgentStep({
    ...step,
    layers: [...new Set(layers)]
  })
}

const failClassification = (
  engine: EngineLike.EngineLike,
  error: AdapterError.AdapterError
): Effect.Effect<never, HarnessError> =>
  error._tag === "flows/adapters/QuotaExhausted"
    ? engine.suspend(
      new EngineLike.SuspendReason({
        code: "waiting-quota",
        message: error.message,
        details: {
          adapterError: error._tag,
          ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
          ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds })
        }
      })
    )
    : Effect.fail(AdapterError.toHarnessError(error))

const run = (
  spec: Spec,
  engine: EngineLike.EngineLike,
  makeOptions: MakeOptions,
  step: AgentStep.AgentStep,
  host: AgentStep.HostLike
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> => {
  const program = Stream.unwrap(
    Effect.gen(function*() {
      const shell = yield* Shell.Shell
      const fileSystem = yield* FileSystem.FileSystem
      const preparedProjection = yield* prepareProjection(spec, step, makeOptions)
      const effectiveOptions = preparedProjection.options
      yield* preflight(spec, shell, step, effectiveOptions)
      const contract = yield* outputContract(step, fileSystem, effectiveOptions)
      const assembled = HarnessPrompt.assemble(
        spec.capabilities,
        promptSections(step, spec, preparedProjection.disclosure),
        contract
      )
      const dispatchedStep = withDispatchKeyLayers(
        step,
        spec.capabilities,
        assembled.digest,
        preparedProjection.digest
      )
      const registeredCleanup = new Set<string>()
      const resume = resumeFromStep(dispatchedStep, spec.capabilities.name)

      const execute = (
        nextResume: CommandSpec.ResumeState | undefined,
        correctionCount: number,
        correctionPrompt?: string | undefined
      ): Stream.Stream<AgentEvent.AgentEvent, HarnessError, Scope.Scope> =>
        runAttempt(
          dispatchedStep,
          spec,
          assembled,
          shell,
          fileSystem,
          registeredCleanup,
          nextResume,
          effectiveOptions,
          contract,
          correctionCount,
          correctionPrompt
        ).pipe(
          Stream.catchCause((cause): Stream.Stream<AgentEvent.AgentEvent, HarnessError, Scope.Scope> => {
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            if (error === undefined) {
              return Stream.failCause(
                Cause.map(cause, () => harnessFailure("model_failed", "CLI harness failed"))
              )
            }
            if (error instanceof CorrectionRequired) {
              return execute(error.resume, correctionCount + 1, error.prompt)
            }
            if (error instanceof ClassifiedAttempt) {
              const failure: Stream.Stream<AgentEvent.AgentEvent, HarnessError> = Stream.fromEffect(
                failClassification(engine, error.error)
              )
              if (error.error instanceof AdapterError.SessionLost) {
                const poisonedSession = error.sessionId ?? nextResume?.sessionId ?? "unavailable-session"
                return Stream.concat(
                  Stream.succeed(
                    new AgentEvent.ResumeToken({
                      eventType: eventType.resumeToken,
                      agentEngine: spec.capabilities.name,
                      agentResume: poisonedSession,
                      discardResumeSession: true
                    })
                  ),
                  failure
                )
              }
              return failure
            }
            return Stream.fail(AdapterError.toHarnessError(error))
          })
        )
      return execute(resume, 0)
    })
  ).pipe(
    Stream.scoped,
    Stream.provide(host),
    Stream.mapError((error) =>
      error instanceof HarnessError
        ? error
        : harnessFailure("model_failed", "CLI harness failed", error)
    )
  )
  return program
}

/**
 * Constructs a working harness from a declarative CLI adapter specification.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  spec: Spec,
  options: MakeOptions = {}
): Effect.Effect<Harness.Harness, never, EngineLike.EngineLike> =>
  Effect.map(EngineLike.EngineLike, (engine) =>
    Harness.Harness.of({
      run: (step, host) => run(spec, engine, options, step, host)
    }))

/**
 * Constructs an unavailable CLI harness stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (
  overrides: Partial<Harness.Harness> = {}
): Harness.Harness =>
  Harness.Harness.of({
    run: () =>
      Stream.fail(
        harnessFailure(
          "invalid_step",
          "No CLI harness implementation is configured"
        )
      ),
    ...overrides
  })

/**
 * Provides a declarative CLI harness.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  spec: Spec,
  options: MakeOptions = {}
): Layer.Layer<Harness.Harness, never, EngineLike.EngineLike> => Layer.effect(Harness.Harness)(make(spec, options))

/**
 * Provides an unavailable CLI harness stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (
  overrides: Partial<Harness.Harness> = {}
): Layer.Layer<Harness.Harness> => Layer.succeed(Harness.Harness)(makeNoop(overrides))
