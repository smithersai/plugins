import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodeLines,
  decodeNdjsonChunks,
  decodeNdjsonStream,
  makeLineDecoder,
  normalizeRecord,
  normalizeRecords,
  normalizeUsage,
  parseNdjsonLine,
  parseNdjsonLines,
  resolveAnswer,
  resolveAnswerText,
  stableRecordId,
  truncateTailKeep
} from "../src/CliOutput.ts"

describe("CliOutput", () => {
  it("splits UTF-8 and line delimiters across chunk boundaries", () => {
    const decoder = makeLineDecoder()
    const bytes = new TextEncoder().encode("{\"text\":\"café\"}\r\n{\"text\":\"last\"}")
    const lines = [
      ...decoder.push(bytes.slice(0, 7)),
      ...decoder.push(bytes.slice(7, 12)),
      ...decoder.push(bytes.slice(12)),
      ...decoder.finish()
    ]
    expect(lines).toEqual(["{\"text\":\"café\"}", "{\"text\":\"last\"}"])
    expect(decodeNdjsonChunks(["banner\n{\"ok\":", "true}\n"])).toEqual([{ ok: true }])
  })

  it("normalizes records into existing harness/model events", () => {
    const events = normalizeRecords([
      { type: "turnOpened", seat: "claude:model", contextDigest: "ctx" },
      { type: "delta", text: "hello" },
      { type: "delta", thinking: "plan" },
      { type: "usage", input_tokens: 7, output_tokens: 3, cache_read_tokens: 2 },
      { type: "resumeToken", sessionId: "session-1" },
      { type: "settled", assistantText: "hello", usage: { inputTokens: 7, outputTokens: 3 } },
      { type: "closed", stopReason: "stop" }
    ], "step")
    expect(events.map((event) => event._tag)).toEqual([
      "turn-opened",
      "model-delta",
      "model-delta",
      "model-delta",
      "resume-token",
      "model-settled",
      "turn-closed"
    ])
    const deltas = events.filter((event) => event._tag === "model-delta")
    expect(deltas[0]).toMatchObject({ delta: { type: "text-delta", id: "step:1:record:text", text: "hello" } })
    expect(deltas[1]).toMatchObject({ delta: { type: "thinking-delta", id: "step:2:record:thinking", text: "plan" } })
    expect(deltas[2]).toMatchObject({ delta: { type: "usage", inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } })
  })

  it("normalizes tool results into call and result deltas", () => {
    const events = normalizeRecords([
      {
        type: "toolResult",
        id: "call-1",
        name: "shell_command",
        arguments: "{\"command\":\"ls\"}",
        status: "completed",
        output: "{\"output\":\"file.ts\",\"exitCode\":0}"
      },
      { type: "toolResult", id: "call-2", status: "error", output: "boom" }
    ], "step")
    expect(events.map((event) => event._tag)).toEqual([
      "model-delta",
      "model-delta",
      "model-delta",
      "model-delta"
    ])
    expect(events[0]).toMatchObject({ delta: { type: "tool-call-start", id: "call-1", name: "shell_command" } })
    expect(events[1]).toMatchObject({
      delta: { type: "tool-call-delta", id: "call-1", arguments: "{\"command\":\"ls\"}" }
    })
    expect(events[2]).toMatchObject({
      delta: { type: "tool-result", id: "call-1", output: "{\"output\":\"file.ts\",\"exitCode\":0}" }
    })
    expect(events[3]).toMatchObject({ delta: { type: "tool-result", id: "call-2", output: "boom", isError: true } })
  })

  it("normalizes usage into the model usage shape", () => {
    expect(
      normalizeUsage({
        input_tokens: 11,
        output_tokens: 4,
        reasoning_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1
      })
    ).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      reasoningTokens: 2,
      cachedInputTokens: 3,
      cacheWriteTokens: 1
    })
  })

  it("uses structured, assistant, then stdout tail answers", () => {
    expect(resolveAnswer([
      { type: "settled", assistantText: "assistant" },
      { type: "resolved", structured: { answer: 42 } }
    ], "tail")).toMatchObject({ source: "structured", text: "{\"answer\":42}" })
    expect(resolveAnswer([{ type: "settled", assistantText: "assistant" }], "tail")).toEqual({
      source: "assistant",
      text: "assistant"
    })
    expect(resolveAnswer([], "tail")).toEqual({ source: "stdout-tail", text: "tail" })
  })

  it("keeps the tail within a byte budget and on UTF-8 boundaries", () => {
    const result = truncateTailKeep("頭部頭部 data 你好世界 tail", 29)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(29)
    expect(result.startsWith("[...truncated...]\n")).toBe(true)
    expect(result.endsWith("世界 tail")).toBe(true)
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(result))).not.toThrow()
  })

  describe("makeLineDecoder", () => {
    it("holds back a trailing CR until the next chunk decides CRLF or bare CR", () => {
      const decoder = makeLineDecoder()
      // A lone trailing CR cannot be emitted yet: the LF may be in the next chunk.
      expect(decoder.push("first\r")).toEqual([])
      expect(decoder.push("\nsecond\n")).toEqual(["first", "second"])
      // A bare CR followed by a non-LF character is its own delimiter.
      const bare = makeLineDecoder()
      expect(bare.push("a\rb\n")).toEqual(["a", "b"])
    })

    it("emits an unterminated remainder on finish and strips a dangling CR", () => {
      const decoder = makeLineDecoder()
      expect(decoder.push("done\nleftover")).toEqual(["done"])
      expect(decoder.finish()).toEqual(["leftover"])

      const dangling = makeLineDecoder()
      dangling.push("tail\r")
      expect(dangling.finish()).toEqual(["tail"])

      // Finishing with nothing pending yields no phantom empty line.
      const clean = makeLineDecoder()
      clean.push("x\n")
      expect(clean.finish()).toEqual([])
    })

    it("ignores every push and finish after the stream has ended", () => {
      const decoder = makeLineDecoder()
      expect(decoder.finish()).toEqual([])
      expect(decoder.push("ignored\n")).toEqual([])
      expect(decoder.finish()).toEqual([])
    })

    it("reassembles a multi-byte character split across byte chunks", () => {
      const decoder = makeLineDecoder()
      const bytes = new TextEncoder().encode("你好\n")
      expect(decoder.push(bytes.slice(0, 2))).toEqual([])
      expect([...decoder.push(bytes.slice(2)), ...decoder.finish()]).toEqual(["你好"])
    })
  })

  describe("decodeNdjsonStream", () => {
    const collect = (chunks: ReadonlyArray<Uint8Array>) =>
      Effect.runPromise(
        decodeNdjsonStream(Stream.fromArray(chunks)).pipe(Stream.runCollect, Effect.map(Array.from))
      )

    it("splits lines across byte-chunk boundaries in the Effect stream form", async () => {
      const bytes = new TextEncoder().encode("{\"a\":1}\n{\"b\":2}\n")
      expect(await collect([bytes.slice(0, 4), bytes.slice(4, 11), bytes.slice(11)])).toEqual([
        "{\"a\":1}",
        "{\"b\":2}"
      ])
    })

    it("reassembles a multi-byte character split across chunks", async () => {
      const bytes = new TextEncoder().encode("café\nnext\n")
      expect(await collect([bytes.slice(0, 4), bytes.slice(4)])).toEqual(["café", "next"])
    })

    it("is re-exported under the decodeLines alias", () => {
      expect(decodeLines).toBe(decodeNdjsonStream)
    })
  })

  describe("parseNdjsonLine", () => {
    it("skips blank and malformed lines but keeps falsy JSON values", () => {
      expect(parseNdjsonLine("  ")).toBeUndefined()
      expect(parseNdjsonLine("")).toBeUndefined()
      expect(parseNdjsonLine("Warning: update available")).toBeUndefined()
      expect(parseNdjsonLine("  {\"a\":1}  ")).toEqual({ a: 1 })
      expect(parseNdjsonLine("null")).toBeNull()
      expect(parseNdjsonLine("false")).toBe(false)
      expect(parseNdjsonLine("0")).toBe(0)
      // `undefined` is the only skip signal, so a JSON null still reaches the adapter.
      expect(parseNdjsonLines(["null", "bad", "{\"a\":1}"])).toEqual([null, { a: 1 }])
    })
  })

  describe("normalizeRecord", () => {
    it("fills turnOpened defaults from the step digest", () => {
      const [event] = normalizeRecord({ type: "turnOpened" }, "digest-1", 0)
      expect(event).toMatchObject({
        _tag: "turn-opened",
        seat: "cli:unknown",
        activeToolNames: [],
        contextDigest: "digest-1"
      })
    })

    it("derives a deterministic tool id when the record supplies none", () => {
      const events = normalizeRecord({ type: "delta", toolCall: { name: "Read" } }, "digest-1", 4)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ delta: { type: "tool-call-start", id: "digest-1:4:record:tool" } })
      // With no arguments there is no tool-call-delta at all.
      expect(events.map((event) => (event as { delta: { type: string } }).delta.type)).toEqual(["tool-call-start"])
      expect(stableRecordId("digest-1", 4)).toBe("digest-1:4:record")
    })

    it("emits nothing for a delta carrying no text, thinking, or tool call", () => {
      expect(normalizeRecord({ type: "delta" }, "digest-1", 0)).toEqual([])
    })

    it("renders a resolved record from structured output or explicit assistant text", () => {
      const [structured] = normalizeRecord({ type: "resolved", structured: { ok: true } }, "digest-1", 0)
      expect(structured).toMatchObject({ _tag: "resolved", message: { content: [{ text: "{\"ok\":true}" }] } })
      const [explicit] = normalizeRecord(
        { type: "resolved", structured: { ok: true }, assistantText: "prose wins" },
        "digest-1",
        0
      )
      expect(explicit).toMatchObject({ message: { content: [{ text: "prose wins" }] } })
      // JSON.stringify returns undefined for a bare undefined structure; the
      // String() fallback must keep the event renderable rather than crash.
      const [fallback] = normalizeRecord({ type: "resolved" }, "digest-1", 0)
      expect(fallback).toMatchObject({ message: { content: [{ text: "undefined" }] } })
    })

    it("defaults a closed record to a resolved stop", () => {
      const [event] = normalizeRecord({ type: "closed" }, "digest-1", 0)
      expect(event).toMatchObject({ _tag: "turn-closed", stopReason: "stop", outcome: "resolved" })
    })

    it("carries the response id and usage onto a settled message", () => {
      const [event] = normalizeRecord(
        { type: "settled", assistantText: "final", responseId: "resp-1", usage: { total_tokens: 12 } },
        "digest-1",
        0
      )
      expect(event).toMatchObject({ _tag: "model-settled", usage: { totalTokens: 12 } })
      expect((event as { message: { responseId?: string } }).message.responseId).toBe("resp-1")
      // Absent usage normalizes to an empty record, not undefined.
      const [bare] = normalizeRecord({ type: "settled", assistantText: "final" }, "digest-1", 0)
      expect((bare as { usage: unknown }).usage).toEqual({})
    })

    it("emits a bare tool result when the record names no tool", () => {
      const events = normalizeRecord({ type: "toolResult", status: "completed" }, "digest-1", 2)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        delta: { type: "tool-result", id: "digest-1:2:record:tool", output: "" }
      })
      expect((events[0] as { delta: { isError?: boolean } }).delta.isError).toBeUndefined()
    })
  })

  describe("normalizeUsage", () => {
    it("prefers camelCase, then snake_case, then the provider-specific spelling", () => {
      expect(normalizeUsage({ inputTokens: 1, input_tokens: 2, prompt_tokens: 3 })).toMatchObject({ inputTokens: 1 })
      expect(normalizeUsage({ input_tokens: 2, prompt_tokens: 3 })).toMatchObject({ inputTokens: 2 })
      expect(normalizeUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4 })
      expect(normalizeUsage({ cached_input_tokens: 5 })).toEqual({ cachedInputTokens: 5 })
      expect(normalizeUsage({ cacheReadTokens: 6 })).toEqual({ cachedInputTokens: 6 })
      expect(normalizeUsage({ cache_write_tokens: 7, totalTokens: 8 })).toEqual({
        cacheWriteTokens: 7,
        totalTokens: 8
      })
    })

    it("drops non-finite and non-numeric fields instead of coercing them", () => {
      expect(normalizeUsage({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY })).toEqual({})
      expect(normalizeUsage({ inputTokens: "12" })).toEqual({})
      expect(normalizeUsage({})).toEqual({})
      // A zero is a real measurement and must survive.
      expect(normalizeUsage({ inputTokens: 0 })).toEqual({ inputTokens: 0 })
    })
  })

  describe("resolveAnswer", () => {
    it("treats an empty assistant answer as absent and falls through to the tail", () => {
      expect(resolveAnswer([{ type: "settled", assistantText: "" }], "tail")).toEqual({
        source: "stdout-tail",
        text: "tail"
      })
      expect(resolveAnswer([])).toEqual({ source: "empty", text: "" })
      expect(resolveAnswer([{ type: "settled", assistantText: "" }])).toEqual({ source: "empty", text: "" })
    })

    it("lets a later resolved assistantText override an earlier settled answer", () => {
      expect(resolveAnswer([
        { type: "settled", assistantText: "first" },
        { type: "resolved", assistantText: "corrected" }
      ])).toEqual({ source: "assistant", text: "corrected" })
      expect(resolveAnswerText([{ type: "settled", assistantText: "plain" }])).toBe("plain")
      expect(resolveAnswerText([], "tail")).toBe("tail")
    })

    it("keeps a falsy structured payload as the structured answer", () => {
      expect(resolveAnswer([{ type: "resolved", structured: null }], "tail")).toMatchObject({
        source: "structured",
        text: "null"
      })
    })
  })

  describe("truncateTailKeep", () => {
    it("returns text unchanged when it already fits and empties on a non-positive budget", () => {
      expect(truncateTailKeep("short", 100)).toBe("short")
      expect(truncateTailKeep("exact", 5)).toBe("exact")
      expect(truncateTailKeep("anything", 0)).toBe("")
      expect(truncateTailKeep("anything", -1)).toBe("")
    })

    it("degrades to a truncated notice when the budget cannot even hold the notice", () => {
      const result = truncateTailKeep("a much longer body than the budget", 10)
      expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(10)
      // Too small for "[...truncated...]\n" (18 bytes), so only the notice tail survives.
      expect("[...truncated...]\n").toContain(result)
    })
  })
})
