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
})
