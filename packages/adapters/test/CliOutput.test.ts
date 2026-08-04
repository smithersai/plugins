import { describe, expect, it } from "vitest"
import {
  decodeNdjsonChunks,
  makeLineDecoder,
  normalizeRecords,
  normalizeUsage,
  resolveAnswer,
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
})
