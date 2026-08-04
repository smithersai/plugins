/**
 * Normalizes structured command-line model output into the harness protocol.
 *
 * The decoder deliberately has no knowledge of a vendor wire format. An
 * adapter interprets each JSON value as a {@link CliRecord}; this module then
 * performs the shared UTF-8, answer, usage, and harness-event work.
 *
 * @since 0.1.0
 */
import * as AgentEvent from "@smithers/harness/AgentEvent"
import * as ModelEvent from "@smithers/model/ModelEvent"
import * as ModelRequest from "@smithers/model/ModelRequest"
import { Stream } from "effect"

const eventType = {
  modelDelta: "flows.harness.model-delta.v1",
  modelSettled: "flows.harness.model-settled.v1",
  resolved: "flows.harness.resolved.v1",
  resumeToken: "flows.harness.resume-token.v1",
  turnClosed: "flows.harness.turn-closed.v1",
  turnOpened: "flows.harness.turn-opened.v1"
} as const

/** A provider-neutral tool call in a CLI record.
 * @category models
 * @since 0.1.0
 */
export interface CliToolCall {
  readonly id?: string | undefined
  readonly name: string
  readonly arguments?: string | undefined
}

/** A CLI record which announces the beginning of a turn.
 * @category models
 * @since 0.1.0
 */
export interface CliTurnOpened {
  readonly type: "turnOpened"
  readonly seat?: string | undefined
  readonly modelParams?: ModelRequest.GenerationParams | undefined
  readonly activeToolNames?: ReadonlyArray<string> | undefined
  readonly contextDigest?: string | undefined
  readonly sessionId?: string | undefined
}

/** A streamed text, reasoning, or tool-call delta.
 * @category models
 * @since 0.1.0
 */
export interface CliDelta {
  readonly type: "delta"
  readonly text?: string | undefined
  readonly thinking?: string | undefined
  readonly toolCall?: CliToolCall | undefined
}

/** Token accounting reported by a CLI.
 * @category models
 * @since 0.1.0
 */
export interface CliUsage {
  readonly type: "usage"
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
  readonly cachedInputTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly totalTokens?: number | undefined
  readonly input_tokens?: number | undefined
  readonly output_tokens?: number | undefined
  readonly reasoning_tokens?: number | undefined
  readonly cache_read_tokens?: number | undefined
  readonly cache_read_input_tokens?: number | undefined
  readonly cache_write_tokens?: number | undefined
  readonly cache_creation_input_tokens?: number | undefined
  readonly total_tokens?: number | undefined
}

/** An opaque session token which can be used by a later harness invocation.
 * @category models
 * @since 0.1.0
 */
export interface CliResumeToken {
  readonly type: "resumeToken"
  readonly sessionId: string
}

/** The semantic assistant answer emitted by a CLI.
 * @category models
 * @since 0.1.0
 */
export interface CliSettled {
  readonly type: "settled"
  readonly assistantText: string
  readonly usage?: CliUsage | Readonly<Record<string, unknown>> | undefined
  readonly responseId?: string | undefined
}

/** A structured result which has completed semantic parsing.
 * @category models
 * @since 0.1.0
 */
export interface CliResolved {
  readonly type: "resolved"
  readonly structured?: unknown
  readonly assistantText?: string | undefined
}

/** The terminal status of a CLI process.
 * @category models
 * @since 0.1.0
 */
export interface CliClosed {
  readonly type: "closed"
  readonly stopReason?: ModelRequest.StopReason | undefined
  readonly outcome?: "continue" | "resolved" | "aborted" | "suspended" | undefined
}

/**
 * A completed tool execution reported by a CLI. Unlike {@link CliDelta} tool
 * calls, which only stream invocation arguments, this record carries the
 * tool's result so the UI can render output cards and diffs. Records carry
 * complete (non-incremental) `arguments` JSON, so normalization re-states the
 * call before emitting the result.
 *
 * @category models
 * @since 0.1.0
 */
export interface CliToolResult {
  readonly type: "toolResult"
  readonly id?: string | undefined
  /** When omitted (e.g. Claude tool_result blocks carry only tool_use_id) no fresh tool-call-start is emitted. */
  readonly name?: string | undefined
  readonly arguments?: string | undefined
  readonly status: "completed" | "error"
  readonly output?: string | undefined
}

/** The vendor-neutral output record understood by this package.
 * @category models
 * @since 0.1.0
 */
export type CliRecord =
  | CliTurnOpened
  | CliDelta
  | CliResumeToken
  | CliUsage
  | CliSettled
  | CliResolved
  | CliToolResult
  | CliClosed

/** An incremental decoder for UTF-8 text and CR/LF-delimited lines.
 * @category models
 * @since 0.1.0
 */
export interface LineDecoder {
  readonly push: (chunk: Uint8Array | string) => ReadonlyArray<string>
  readonly finish: () => ReadonlyArray<string>
}

/** Creates an incremental UTF-8 line decoder suitable for NDJSON streams.
 * @category constructors
 * @since 0.1.0
 */
export const makeLineDecoder = (): LineDecoder => {
  const decoder = new TextDecoder()
  let pending = ""
  let ended = false

  const drain = (): ReadonlyArray<string> => {
    const lines: Array<string> = []
    while (pending.length > 0) {
      const newline = pending.search(/[\r\n]/)
      if (newline < 0) break
      const delimiter = pending[newline]
      if (delimiter === "\r" && newline === pending.length - 1) break
      const width = delimiter === "\r" && pending[newline + 1] === "\n" ? 2 : 1
      lines.push(pending.slice(0, newline))
      pending = pending.slice(newline + width)
    }
    return lines
  }

  return {
    push: (chunk) => {
      if (ended) return []
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
      return drain()
    },
    finish: () => {
      if (ended) return []
      ended = true
      pending += decoder.decode()
      const lines = drain()
      if (pending.endsWith("\r")) pending = pending.slice(0, -1)
      return pending.length > 0 ? [...lines, pending] : lines
    }
  }
}

/**
 * Applies the Effect stream decoding idiom used by the reference repository:
 * decode UTF-8 chunks, then split CR/LF-delimited lines.
 *
 * @category destructors
 * @since 0.1.0
 */
export const decodeNdjsonStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<string, E, R> => stream.pipe(Stream.decodeText(), Stream.splitLines)

/** Parses one line, returning `undefined` for blank, banner, or malformed lines.
 * @category destructors
 * @since 0.1.0
 */
export const parseNdjsonLine = (line: string): unknown | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Parses NDJSON lines while tolerating non-JSON banners and diagnostics.
 * @category destructors
 * @since 0.1.0
 */
export const parseNdjsonLines = (lines: Iterable<string>): ReadonlyArray<unknown> => {
  const values: Array<unknown> = []
  for (const line of lines) {
    const value = parseNdjsonLine(line)
    if (value !== undefined) values.push(value)
  }
  return values
}

/** Decodes byte/string chunks into JSON values, ignoring non-JSON banner lines.
 * @category destructors
 * @since 0.1.0
 */
export const decodeNdjsonChunks = (chunks: Iterable<Uint8Array | string>): ReadonlyArray<unknown> => {
  const decoder = makeLineDecoder()
  const lines: Array<string> = []
  for (const chunk of chunks) lines.push(...decoder.push(chunk))
  lines.push(...decoder.finish())
  return parseNdjsonLines(lines)
}

/** Returns the stable identifier assigned to a record-derived model part.
 * @category constructors
 * @since 0.1.0
 */
export const stableRecordId = (stepDigest: string, recordIndex: number, part = "record"): string =>
  `${stepDigest}:${recordIndex}:${part}`

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const recordValue = (value: unknown, ...keys: ReadonlyArray<string>): unknown => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

/** Normalizes common snake-case and camel-case CLI usage fields.
 * @category destructors
 * @since 0.1.0
 */
export const normalizeUsage = (
  value: CliUsage | Readonly<Record<string, unknown>>
): ModelEvent.Usage => {
  const get = (...keys: ReadonlyArray<string>): number | undefined => {
    for (const key of keys) {
      const result = numberValue(recordValue(value, key))
      if (result !== undefined) return result
    }
    return undefined
  }
  const inputTokens = get("inputTokens", "input_tokens", "prompt_tokens")
  const outputTokens = get("outputTokens", "output_tokens", "completion_tokens")
  const reasoningTokens = get("reasoningTokens", "reasoning_tokens")
  const cachedInputTokens = get(
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadTokens",
    "cache_read_tokens",
    "cache_read_input_tokens"
  )
  const cacheWriteTokens = get(
    "cacheWriteTokens",
    "cache_write_tokens",
    "cache_creation_input_tokens"
  )
  const totalTokens = get("totalTokens", "total_tokens")
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  }
}

const modelDelta = (delta: ModelEvent.ModelEvent): AgentEvent.ModelDelta =>
  new AgentEvent.ModelDelta({ eventType: eventType.modelDelta, delta })

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

const settledMessage = (text: string, responseId?: string): ModelRequest.AssistantMessage =>
  ModelRequest.Message.assistant(text, { stopReason: "stop", responseId })

/**
 * Normalizes one vendor-neutral CLI record into existing harness events.
 * IDs are derived only from the step digest and record index, making replay
 * and transcript comparison independent of process-local randomness.
 *
 * @category destructors
 * @since 0.1.0
 */
export const normalizeRecord = (
  record: CliRecord,
  stepDigest: string,
  recordIndex: number
): ReadonlyArray<AgentEvent.AgentEvent> => {
  const id = stableRecordId(stepDigest, recordIndex)
  switch (record.type) {
    case "turnOpened":
      return [
        new AgentEvent.TurnOpened({
          eventType: eventType.turnOpened,
          seat: record.seat ?? "cli:unknown",
          modelParams: record.modelParams ?? ModelRequest.GenerationParams.make(),
          activeToolNames: record.activeToolNames ?? [],
          contextDigest: record.contextDigest ?? stepDigest
        })
      ]
    case "delta": {
      const events: Array<AgentEvent.AgentEvent> = []
      if (record.text !== undefined) {
        events.push(
          modelDelta(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: `${id}:text`, text: record.text }))
        )
      }
      if (record.thinking !== undefined) {
        events.push(
          modelDelta(
            ModelEvent.ModelEvent.ThinkingDelta({ type: "thinking-delta", id: `${id}:thinking`, text: record.thinking })
          )
        )
      }
      if (record.toolCall !== undefined) {
        const toolId = record.toolCall.id ?? `${id}:tool`
        events.push(modelDelta(ModelEvent.ModelEvent.ToolCallStart({
          type: "tool-call-start",
          id: toolId,
          name: record.toolCall.name
        })))
        if (record.toolCall.arguments !== undefined) {
          events.push(modelDelta(ModelEvent.ModelEvent.ToolCallDelta({
            type: "tool-call-delta",
            id: toolId,
            arguments: record.toolCall.arguments
          })))
        }
      }
      return events
    }
    case "resumeToken":
      return [
        new AgentEvent.ResumeToken({
          eventType: eventType.resumeToken,
          agentEngine: "cli",
          agentResume: record.sessionId,
          discardResumeSession: false
        })
      ]
    case "usage":
      return [modelDelta(ModelEvent.ModelEvent.Usage(normalizeUsage(record)))]
    case "settled":
      return [
        new AgentEvent.ModelSettled({
          eventType: eventType.modelSettled,
          message: settledMessage(record.assistantText, record.responseId),
          usage: record.usage === undefined ? {} : normalizeUsage(record.usage)
        })
      ]
    case "resolved":
      return [
        new AgentEvent.Resolved({
          eventType: eventType.resolved,
          message: settledMessage(record.assistantText ?? textOf(record.structured))
        })
      ]
    case "toolResult": {
      const toolId = record.id ?? `${id}:tool`
      const events: Array<AgentEvent.AgentEvent> = []
      if (record.name !== undefined) {
        events.push(modelDelta(ModelEvent.ModelEvent.ToolCallStart({
          type: "tool-call-start",
          id: toolId,
          name: record.name
        })))
      }
      if (record.arguments !== undefined) {
        events.push(modelDelta(ModelEvent.ModelEvent.ToolCallDelta({
          type: "tool-call-delta",
          id: toolId,
          arguments: record.arguments
        })))
      }
      events.push(modelDelta(ModelEvent.ModelEvent.ToolResult({
        type: "tool-result",
        id: toolId,
        output: record.output ?? "",
        ...(record.status === "error" ? { isError: true } : {})
      })))
      return events
    }
    case "closed":
      return [
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: record.stopReason ?? "stop",
          outcome: record.outcome ?? "resolved"
        })
      ]
  }
}

/**
 * Normalizes a complete record sequence into harness events in source order.
 *
 * @category destructors
 * @since 0.1.0
 */
export const normalizeRecords = (
  records: Iterable<CliRecord>,
  stepDigest: string
): ReadonlyArray<AgentEvent.AgentEvent> => {
  const events: Array<AgentEvent.AgentEvent> = []
  let index = 0
  for (const record of records) events.push(...normalizeRecord(record, stepDigest, index++))
  return events
}

/** The source selected by the answer-resolution priority ladder.
 * @category models
 * @since 0.1.0
 */
export type AnswerSource = "structured" | "assistant" | "stdout-tail" | "empty"

/** The resolved answer and the source from which it was selected.
 * @category models
 * @since 0.1.0
 */
export interface AnswerResolution {
  readonly text: string
  readonly source: AnswerSource
  readonly structured?: unknown | undefined
}

/**
 * Resolves an answer in semantic priority order: structured result, last
 * assistant message, then stdout tail. Stderr is intentionally not accepted.
 *
 * @category destructors
 * @since 0.1.0
 */
export const resolveAnswer = (
  records: Iterable<CliRecord>,
  stdoutTail = ""
): AnswerResolution => {
  let structured: unknown | undefined
  let assistant: string | undefined
  for (const record of records) {
    if (record.type === "resolved" && record.structured !== undefined) structured = record.structured
    if (record.type === "settled") assistant = record.assistantText
    if (record.type === "resolved" && record.assistantText !== undefined) assistant = record.assistantText
  }
  if (structured !== undefined) return { text: textOf(structured), source: "structured", structured }
  if (assistant !== undefined && assistant.length > 0) return { text: assistant, source: "assistant" }
  if (stdoutTail.length > 0) return { text: stdoutTail, source: "stdout-tail" }
  return { text: "", source: "empty" }
}

/** Resolves an answer as text, retaining the same semantic priority ladder.
 * @category destructors
 * @since 0.1.0
 */
export const resolveAnswerText = (records: Iterable<CliRecord>, stdoutTail = ""): string =>
  resolveAnswer(records, stdoutTail).text

const takeUtf8Suffix = (text: string, byteBudget: number): string => {
  if (byteBudget <= 0) return ""
  const encoder = new TextEncoder()
  let result = ""
  let used = 0
  for (const character of Array.from(text).reverse()) {
    const bytes = encoder.encode(character).byteLength
    if (used + bytes > byteBudget) break
    result = character + result
    used += bytes
  }
  return result
}

/**
 * Keeps a UTF-8-safe tail under a byte budget and prefixes a truncation notice.
 * This must be applied after semantic parsing: terminal completion records are
 * emitted last and must survive even when raw CLI output is truncated.
 *
 * @category destructors
 * @since 0.1.0
 */
export const truncateTailKeep = (text: string, byteBudget: number): string => {
  const encoder = new TextEncoder()
  if (byteBudget <= 0) return ""
  if (encoder.encode(text).byteLength <= byteBudget) return text
  const notice = "[...truncated...]\n"
  const noticeBytes = encoder.encode(notice).byteLength
  if (noticeBytes >= byteBudget) return takeUtf8Suffix(notice, byteBudget)
  return notice + takeUtf8Suffix(text, byteBudget - noticeBytes)
}

/** Backwards-friendly name for the Effect-style NDJSON stream decoder.
 * @category destructors
 * @since 0.1.0
 */
export const decodeLines = decodeNdjsonStream
