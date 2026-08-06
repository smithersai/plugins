import * as Shell from "@smithers/kernel/Shell"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CliOutput from "../src/CliOutput.ts"
import { spec } from "../src/OpenCode.ts"

const fixture = (name: string): ReadonlyArray<unknown> =>
  readFileSync(new URL(`./fixtures/opencode/${name}`, import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as unknown)

describe("OpenCode", () => {
  it("runs json-formatted output and resumes with --session", () => {
    const options = { model: "anthropic/claude-sonnet-4-5", cwd: "/workspace" } as const
    const fresh = spec.buildCommand(options)
    const resumed = spec.buildCommand(options, { sessionId: "ses_0000000000000000000000000000" })

    expect(fresh.command).toBe("opencode")
    expect(fresh.args).toEqual(["run", "--format", "json", "--model", "anthropic/claude-sonnet-4-5"])
    expect(resumed.args).toEqual([...fresh.args, "--session", "ses_0000000000000000000000000000"])
  })

  /**
   * The NDJSON envelope (`{ type, timestamp, sessionID, part }`) is derived
   * from reference/opencode/packages/opencode/src/cli/cmd/run.ts; the part
   * shapes (ToolPart/ToolState, ReasoningPart, TextPart, StepFinishPart token
   * buckets) from reference/opencode/packages/schema/src/v1/session.ts. The
   * embedded part values are real, captured from the local OpenCode database
   * (~/.local/share/opencode/opencode.db `part` table) and trimmed/scrubbed.
   */
  it("maps recorded run output into turns, tool results, text, and usage", () => {
    const records = fixture("run.ndjson")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)

    expect(records.map((record) => record.type)).toEqual([
      "turnOpened",
      "delta",
      "toolResult",
      "settled",
      "usage"
    ])
    expect(records[0]).toEqual({
      type: "turnOpened",
      seat: "opencode",
      sessionId: "ses_0000000000000000000000000000"
    })
    expect(records[1]).toEqual({
      type: "delta",
      thinking: "The user is asking if the latest opencode is installed. I should run a command to check the version."
    })
    expect(records[2]).toMatchObject({
      type: "toolResult",
      name: "edit",
      id: "call_yPy61iaZYGaNYmUNb9CJ4Hyq",
      status: "completed"
    })
    const result = JSON.parse((records[2] as { output: string }).output) as {
      title: string
      output: string
      metadata: { diff: string }
    }
    expect(result.title).toBe("src/evm/evm/interpret.zig")
    expect(result.metadata.diff).toContain("--- src/evm/evm/interpret.zig")
    expect(result.metadata.diff).toContain("+++ src/evm/evm/interpret.zig")
    expect(records[3]).toEqual({
      type: "settled",
      assistantText:
        "## Summary\nReviewed 4 recent commits to opencode: the intelligent compaction feature lands first."
    })
    expect(records[4]).toEqual({
      type: "usage",
      input_tokens: 2,
      output_tokens: 79,
      reasoning_tokens: 0,
      cachedInputTokens: 40106,
      cacheWriteTokens: 166
    })
    expect(CliOutput.resolveAnswer(records)).toEqual({
      source: "assistant",
      text: "## Summary\nReviewed 4 recent commits to opencode: the intelligent compaction feature lands first."
    })
  })

  it("maps run errors to an aborted close", () => {
    const record = spec.interpret({
      type: "error",
      timestamp: 1768944766000,
      sessionID: "ses_0000000000000000000000000000",
      error: { name: "UnknownError", data: { message: "model exploded" } }
    })
    expect(record).toMatchObject({
      type: "closed",
      stopReason: "error",
      outcome: "aborted"
    })
  })

  it("declares the OpenCode harness capabilities", () => {
    expect(spec.capabilities).toMatchObject({
      name: "opencode",
      resume: "flag",
      mcpBootstrap: "project-config",
      configDirIsolation: false,
      usage: true
    })
  })

  it("classifies a missing binary during preflight", () => {
    const shell = Shell.makeNoop({
      exec: () => Effect.succeed({ stdout: "", stderr: "not found", exitCode: 127 })
    })
    const failure = Effect.runSync(Effect.flip(spec.preflight!(shell, {})))
    expect(failure).toMatchObject({
      _tag: "flows/adapters/BinaryMissing"
    })
  })

  describe("buildCommand", () => {
    it("keeps the json run form minimal and appends extra args before the session flag", () => {
      expect(spec.buildCommand({}).args).toEqual(["run", "--format", "json"])
      expect(spec.buildCommand({}).env).toEqual({})
      expect(spec.buildCommand({}).cleanup).toEqual([])
      expect(spec.buildCommand({ extraArgs: ["--agent", "build"] }, { sessionId: "ses_1" }).args).toEqual([
        "run",
        "--format",
        "json",
        "--agent",
        "build",
        "--session",
        "ses_1"
      ])
    })
  })

  describe("interpret", () => {
    it("accepts a JSON string line and rejects non-object, malformed, or unknown input", () => {
      expect(spec.interpret("{\"type\":\"step_start\",\"sessionID\":\"ses_1\"}")).toEqual({
        type: "turnOpened",
        seat: "opencode",
        sessionId: "ses_1"
      })
      expect(spec.interpret("not json")).toBeNull()
      expect(spec.interpret([1])).toBeNull()
      expect(spec.interpret(7)).toBeNull()
      expect(spec.interpret({ type: "unrecognized" })).toBeNull()
      expect(spec.interpret({})).toBeNull()
    })

    it("opens a turn even when the envelope carries no session id", () => {
      expect(spec.interpret({ type: "step_start" })).toEqual({ type: "turnOpened", seat: "opencode" })
    })

    it("settles on a complete text part and drops empty or absent text", () => {
      expect(spec.interpret({ type: "text", part: { id: "prt_1", text: "answer" } })).toEqual({
        type: "settled",
        assistantText: "answer",
        responseId: "prt_1"
      })
      expect(spec.interpret({ type: "text", part: { text: "answer" } })).toEqual({
        type: "settled",
        assistantText: "answer"
      })
      expect(spec.interpret({ type: "text", part: { text: "" } })).toBeNull()
      expect(spec.interpret({ type: "text", part: {} })).toBeNull()
      expect(spec.interpret({ type: "text" })).toBeNull()
    })

    it("drops empty reasoning parts", () => {
      expect(spec.interpret({ type: "reasoning", part: { text: "thinking" } })).toEqual({
        type: "delta",
        thinking: "thinking"
      })
      expect(spec.interpret({ type: "reasoning", part: { text: "" } })).toBeNull()
      expect(spec.interpret({ type: "reasoning" })).toBeNull()
    })

    it("maps tool states: pending is a call, completed and error are results", () => {
      const toolUse = (state: unknown, extra: Readonly<Record<string, unknown>> = {}) =>
        spec.interpret({ type: "tool_use", part: { tool: "bash", callID: "call_1", state, ...extra } })

      // A running/pending state is only an invocation, never a result.
      expect(toolUse({ status: "running", input: { command: "ls" } })).toEqual({
        type: "delta",
        toolCall: { name: "bash", id: "call_1", arguments: JSON.stringify({ command: "ls" }) }
      })
      // An unknown status must not be misread as a completion.
      expect(toolUse({ status: "queued" })).toEqual({
        type: "delta",
        toolCall: { name: "bash", id: "call_1", arguments: "{}" }
      })

      const completed = toolUse({ status: "completed", input: { command: "ls" }, title: "ls", output: "a.ts" })
      expect(completed).toMatchObject({ type: "toolResult", name: "bash", id: "call_1", status: "completed" })
      expect(JSON.parse((completed as { output: string }).output)).toEqual({
        title: "ls",
        output: "a.ts",
        metadata: {}
      })
      // Missing title/output degrade to empty strings rather than "undefined".
      const sparse = toolUse({ status: "completed" })
      expect(JSON.parse((sparse as { output: string }).output)).toEqual({ title: "", output: "", metadata: {} })

      expect(toolUse({ status: "error", error: "tool exploded" })).toMatchObject({
        type: "toolResult",
        status: "error",
        output: "tool exploded"
      })
      expect(toolUse({ status: "error" })).toMatchObject({ output: "OpenCode tool call failed" })
    })

    it("drops tool parts with no state, no tool name, or no part at all", () => {
      expect(spec.interpret({ type: "tool_use", part: { tool: "bash" } })).toBeNull()
      expect(spec.interpret({ type: "tool_use", part: { state: { status: "completed" } } })).toBeNull()
      expect(spec.interpret({ type: "tool_use" })).toBeNull()
    })

    it("omits the call id when the part carries none", () => {
      expect(spec.interpret({ type: "tool_use", part: { tool: "bash", state: { status: "running" } } })).toEqual({
        type: "delta",
        toolCall: { name: "bash", arguments: "{}" }
      })
    })

    it("reports step_finish token buckets and tolerates a missing cache bucket", () => {
      expect(
        spec.interpret({ type: "step_finish", part: { tokens: { input: 5, output: 6, reasoning: 1 } } })
      ).toEqual({ type: "usage", input_tokens: 5, output_tokens: 6, reasoning_tokens: 1 })
      expect(
        spec.interpret({ type: "step_finish", part: { tokens: { input: 5, cache: { read: 9 } } } })
      ).toEqual({ type: "usage", input_tokens: 5, cachedInputTokens: 9 })
      // Non-numeric buckets are dropped rather than coerced.
      expect(spec.interpret({ type: "step_finish", part: { tokens: { input: "5" } } })).toEqual({ type: "usage" })
      expect(spec.interpret({ type: "step_finish", part: {} })).toBeNull()
      expect(spec.interpret({ type: "step_finish" })).toBeNull()
    })

    it("prefers the error message over the nested data message and falls back last", () => {
      expect(spec.interpret({ type: "error", error: { message: "top", data: { message: "nested" } } }))
        .toMatchObject({ type: "closed", stopReason: "error", outcome: "aborted", message: "top" })
      expect(spec.interpret({ type: "error", error: { data: { message: "nested" } } }))
        .toMatchObject({ message: "nested" })
      expect(spec.interpret({ type: "error" })).toMatchObject({ message: "OpenCode run failed" })
    })
  })

  describe("preflight", () => {
    const failureOf = (exec: Parameters<typeof Shell.makeNoop>[0]["exec"]) =>
      Effect.runSync(Effect.flip(spec.preflight!(Shell.makeNoop({ exec }), {})))

    it("passes on exit 0 and distinguishes not-executable, config, and spawn failures", () => {
      expect(
        Effect.runSync(
          spec.preflight!(Shell.makeNoop({ exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }) }), {})
        )
      ).toBeUndefined()
      expect(failureOf(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 126 }))).toMatchObject({
        _tag: "flows/adapters/BinaryMissing"
      })
      expect(failureOf(() => Effect.succeed({ stdout: "", stderr: "bad", exitCode: 1 }))).toMatchObject({
        _tag: "flows/adapters/ConfigInvalid"
      })
      expect(failureOf(() => Effect.fail(new Error("no host")) as never)).toMatchObject({
        _tag: "flows/adapters/SpawnFailed"
      })
    })
  })
})
