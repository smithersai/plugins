import * as Shell from "@smithers/kernel/Shell"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { spec } from "../src/ClaudeCode.ts"
import * as CliClassifier from "../src/CliClassifier.ts"
import * as CliOutput from "../src/CliOutput.ts"

const fixture = (name: string): ReadonlyArray<unknown> =>
  readFileSync(new URL(`./fixtures/claude-code/${name}`, import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as unknown)

describe("ClaudeCode", () => {
  it("builds one system channel and resumes without dropping semantic flags", () => {
    const options = {
      model: "claude-sonnet-4-5",
      cwd: "/workspace",
      addDirs: ["/workspace/shared"],
      sandbox: "danger-full-access",
      outputSchemaPath: "/workspace/schema.json",
      extraArgs: [
        "--mcp-config",
        "/workspace/.mcp.json",
        "--allowed-tools",
        "Read,Edit,Bash",
        "--system-prompt",
        "Use the projected flows.",
        "--append-system-prompt",
        "This second channel must be removed."
      ]
    } as const
    const fresh = spec.buildCommand(options)
    const resumed = spec.buildCommand(options, { sessionId: "8f167e9f-15c7-4cb0-9bb7-6d8e29a72572" })

    expect(fresh.command).toBe("claude")
    expect(fresh.args.slice(0, 4)).toEqual(["--print", "--output-format", "stream-json", "--verbose"])
    expect(fresh.args.filter((argument) => argument === "--system-prompt")).toHaveLength(1)
    expect(fresh.args).not.toContain("--append-system-prompt")
    expect(fresh.args).toContain("--mcp-config")
    expect(fresh.args).toContain("--allowed-tools")
    expect(fresh.env).toMatchObject({
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: "/workspace/.flows/claude-code"
    })
    expect(resumed.args).toEqual([
      ...fresh.args,
      "--resume",
      "8f167e9f-15c7-4cb0-9bb7-6d8e29a72572"
    ])
  })

  it("maps recorded success output into resume, delta, and settled records", () => {
    const records = fixture("success.ndjson")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)

    expect(records.map((record) => record.type)).toEqual(["resumeToken", "delta", "toolResult", "settled"])
    expect(records[0]).toEqual({
      type: "resumeToken",
      sessionId: "8f167e9f-15c7-4cb0-9bb7-6d8e29a72572"
    })
    expect(records[1]).toEqual({ type: "delta", text: "I checked the adapter seam." })
    expect(records[2]).toEqual({
      type: "toolResult",
      id: "toolu_01JZ6QQB3NX7E52S09G3HGX8N8",
      status: "completed",
      output: "All checks passed."
    })
    expect(records[3]).toMatchObject({
      type: "settled",
      assistantText: "The adapter seam is valid.",
      usage: {
        input_tokens: 14,
        cache_read_input_tokens: 120,
        output_tokens: 8
      }
    })
    expect(CliOutput.resolveAnswer(records)).toEqual({
      source: "assistant",
      text: "The adapter seam is valid."
    })
  })

  /**
   * Fixture trimmed and scrubbed from a real captured session transcript
   * (~/.claude/projects/-Users-williamcory-flows/<session>.jsonl); the
   * thinking/tool_use/tool_result content-block shapes are what
   * `--output-format stream-json` emits inside assistant/user envelopes.
   */
  it("maps real transcript thinking, tool_use, and tool_result blocks", () => {
    const records = fixture("transcript.ndjson")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)

    expect(records.map((record) => record.type)).toEqual(["delta", "delta", "toolResult", "delta"])
    expect(records[0]).toEqual({
      type: "delta",
      thinking:
        "The user is asking me to provide a status line about the current activity of a coding agent. This is a brief, real-time status update."
    })
    expect(records[1]).toEqual({
      type: "delta",
      toolCall: {
        name: "Bash",
        id: "toolu_01UPG3DkUJfUGZLkB32iTE34",
        arguments: JSON.stringify({ command: "git status --short", description: "Show working copy status" })
      }
    })
    expect(records[2]).toEqual({
      type: "toolResult",
      id: "toolu_01UPG3DkUJfUGZLkB32iTE34",
      status: "completed",
      output: "M plugins/packages/adapters/src/Codex.ts"
    })
    expect(records[3]).toEqual({
      type: "delta",
      text: "One modified file is staged for the adapter change."
    })
  })

  it("classifies recorded configuration failures and Claude quota wording", () => {
    const interpreted = fixture("config-error.ndjson")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)
    const config = CliClassifier.classify({
      exitCode: 1,
      records: interpreted,
      patterns: spec.patterns
    })
    const quota = CliClassifier.classify({
      exitCode: 0,
      stderr: "You've hit your session limit · resets 3pm (America/Los_Angeles).",
      patterns: spec.patterns
    })

    expect(config?._tag).toBe("flows/adapters/ConfigInvalid")
    expect(quota?._tag).toBe("flows/adapters/QuotaExhausted")
  })

  it("maps rejected machine rate-limit events to a suspended quota result", () => {
    const record = spec.interpret({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1_785_345_600
      }
    })
    const error = CliClassifier.classify({
      exitCode: 0,
      records: record === null ? [] : [record],
      patterns: spec.patterns
    })

    expect(record).toMatchObject({
      type: "closed",
      stopReason: "error",
      outcome: "suspended"
    })
    expect(error?._tag).toBe("flows/adapters/QuotaExhausted")
  })

  it("declares the Claude Code harness capabilities", () => {
    expect(spec.capabilities).toMatchObject({
      name: "claude-code",
      resume: "flag",
      mcpBootstrap: "project-config",
      skillsInstall: "plugin-dir",
      configDirIsolation: true,
      nativeStructuredOutput: true,
      steer: false,
      images: true,
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
