import { exits, probeOf, unreachable } from "./probeStub.ts"
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

    expect(config?._tag).toBe("@smthrs-plugins/adapters/ConfigInvalid")
    expect(quota?._tag).toBe("@smthrs-plugins/adapters/QuotaExhausted")
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
    expect(error?._tag).toBe("@smthrs-plugins/adapters/QuotaExhausted")
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
    const shell = exits(127)
    const failure = Effect.runSync(Effect.flip(spec.preflight!(shell, {})))
    expect(failure).toMatchObject({
      _tag: "@smthrs-plugins/adapters/BinaryMissing"
    })
  })

  describe("buildCommand", () => {
    it("isolates CLAUDE_CONFIG_DIR under the cwd, normalizing root and trailing slashes", () => {
      expect(spec.buildCommand({}).env?.CLAUDE_CONFIG_DIR).toBe(".flows/claude-code")
      expect(spec.buildCommand({ cwd: "" }).env?.CLAUDE_CONFIG_DIR).toBe(".flows/claude-code")
      expect(spec.buildCommand({ cwd: "/" }).env?.CLAUDE_CONFIG_DIR).toBe("/.flows/claude-code")
      expect(spec.buildCommand({ cwd: "/workspace//" }).env?.CLAUDE_CONFIG_DIR).toBe("/workspace/.flows/claude-code")
    })

    it("maps each sandbox level onto Claude's permission flags", () => {
      const args = (sandbox?: string) => spec.buildCommand(sandbox === undefined ? {} : { sandbox }).args
      expect(args("danger-full-access")).toEqual(expect.arrayContaining([
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions"
      ]))
      expect(args("read-only")).toEqual(expect.arrayContaining(["--permission-mode", "plan"]))
      expect(args("workspace-write")).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]))
      // An unrecognized value is forwarded verbatim rather than silently dropped.
      expect(args("custom-mode")).toEqual(expect.arrayContaining(["--permission-mode", "custom-mode"]))
      expect(args()).not.toContain("--permission-mode")
    })

    it("collapses every system-prompt spelling into exactly one channel", () => {
      // `--system-prompt=` inline form wins when it arrives first, and the
      // later space-separated flag must not append a second channel.
      const inline = spec.buildCommand({
        extraArgs: ["--system-prompt=first channel", "--system-prompt", "second channel", "--keep-me"]
      })
      expect(inline.args.filter((argument) => argument === "--system-prompt")).toHaveLength(1)
      expect(inline.args.at(-1)).toBe("first channel")
      expect(inline.args).toContain("--keep-me")
      expect(inline.args).not.toContain("--system-prompt=first channel")
      expect(inline.args).not.toContain("second channel")

      // Both append spellings are dropped along with the space-separated value.
      const appended = spec.buildCommand({
        extraArgs: ["--append-system-prompt", "dropped value", "--append-system-prompt=also dropped", "--kept"]
      })
      expect(appended.args).not.toContain("dropped value")
      expect(appended.args).not.toContain("--append-system-prompt=also dropped")
      expect(appended.args).toContain("--kept")
      // No --system-prompt supplied at all still projects one empty channel.
      expect(appended.args.at(-2)).toBe("--system-prompt")
      expect(appended.args.at(-1)).toBe("")
    })

    it("emits one --add-dir per directory and threads model and schema flags", () => {
      const built = spec.buildCommand({
        addDirs: ["/a", "/b"],
        model: "claude-opus-4",
        outputSchemaPath: "/schema.json"
      })
      expect(built.args.filter((argument) => argument === "--add-dir")).toHaveLength(2)
      expect(built.args).toEqual(expect.arrayContaining(["--add-dir", "/a", "--add-dir", "/b"]))
      expect(built.args).toEqual(expect.arrayContaining(["--model", "claude-opus-4"]))
      expect(built.args).toEqual(expect.arrayContaining(["--json-schema", "/schema.json"]))
    })
  })

  describe("interpret", () => {
    it("accepts a JSON string line and rejects non-object or malformed input", () => {
      expect(spec.interpret("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-1\"}")).toEqual({
        type: "resumeToken",
        sessionId: "s-1"
      })
      expect(spec.interpret("not json at all")).toBeNull()
      expect(spec.interpret("[1,2,3]")).toBeNull()
      expect(spec.interpret(42)).toBeNull()
      expect(spec.interpret(null)).toBeNull()
      expect(spec.interpret({ type: "unrecognized" })).toBeNull()
    })

    it("drops an init frame that carries no session id", () => {
      expect(spec.interpret({ type: "system", subtype: "init" })).toBeNull()
      // A non-init system frame is not a resume token either.
      expect(spec.interpret({ type: "system", subtype: "other", session_id: "s-1" })).toBeNull()
    })

    it("drops assistant frames with no message or no renderable content", () => {
      expect(spec.interpret({ type: "assistant" })).toBeNull()
      expect(spec.interpret({ type: "assistant", message: { content: [] } })).toBeNull()
      expect(spec.interpret({ type: "assistant", message: { content: 7 } })).toBeNull()
      // Blocks of an unknown type contribute nothing.
      expect(spec.interpret({ type: "assistant", message: { content: [{ type: "image" }] } })).toBeNull()
      // An empty text block joins to "" and must not fabricate a delta.
      expect(spec.interpret({ type: "assistant", message: { content: [{ type: "text", text: "" }] } })).toBeNull()
      // A tool_use block with no name is not a usable tool call.
      expect(spec.interpret({ type: "assistant", message: { content: [{ type: "tool_use", input: {} }] } })).toBeNull()
    })

    it("reads string message content and combines text, thinking, and a tool call", () => {
      expect(spec.interpret({ type: "assistant", message: { content: "plain string body" } })).toEqual({
        type: "delta",
        text: "plain string body"
      })
      expect(
        spec.interpret({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
              { type: "thinking", thinking: "reasoning" },
              { type: "tool_use", name: "Read", input: { file: "a.ts" } }
            ]
          }
        })
      ).toEqual({
        type: "delta",
        text: "part one part two",
        thinking: "reasoning",
        toolCall: { name: "Read", arguments: JSON.stringify({ file: "a.ts" }) }
      })
    })

    it("defaults a tool call with no input to an empty argument object", () => {
      expect(
        spec.interpret({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "t-1" }] } })
      ).toEqual({ type: "delta", toolCall: { name: "Read", id: "t-1", arguments: "{}" } })
    })

    it("marks an errored tool_result and falls back to string content", () => {
      expect(
        spec.interpret({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t-1", is_error: true, content: "boom" }] }
        })
      ).toEqual({ type: "toolResult", id: "t-1", status: "error", output: "boom" })
      // A tool_result with no id and no content still reports its status.
      expect(spec.interpret({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual({
        type: "toolResult",
        status: "completed"
      })
    })

    it("maps content_block_delta stream events and ignores other event shapes", () => {
      expect(
        spec.interpret({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "tok" } } })
      ).toEqual({ type: "delta", text: "tok" })
      expect(
        spec.interpret({ type: "stream_event", event: { type: "content_block_delta", delta: { thinking: "think" } } })
      ).toEqual({ type: "delta", thinking: "think" })
      expect(
        spec.interpret({ type: "stream_event", event: { type: "content_block_delta", delta: {} } })
      ).toBeNull()
      expect(spec.interpret({ type: "stream_event", event: { type: "message_start", delta: {} } })).toBeNull()
      expect(spec.interpret({ type: "stream_event", event: { type: "content_block_delta" } })).toBeNull()
      expect(spec.interpret({ type: "stream_event" })).toBeNull()
    })

    it("suspends on a rejected overage status but ignores an allowed rate-limit event", () => {
      expect(spec.interpret({ type: "rate_limit_event", rate_limit_info: { overageStatus: "rejected" } }))
        .toMatchObject({ type: "closed", stopReason: "error", outcome: "suspended" })
      // An explicit non-rejected status wins over the overage field.
      expect(
        spec.interpret({ type: "rate_limit_event", rate_limit_info: { status: "allowed", overageStatus: "rejected" } })
      ).toBeNull()
      expect(spec.interpret({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toBeNull()
      expect(spec.interpret({ type: "rate_limit_event" })).toBeNull()
    })

    it("aborts on an errored result and prefers the error field over the result text", () => {
      expect(spec.interpret({ type: "result", is_error: true, error: "explicit error", result: "ignored" })).toEqual({
        type: "closed",
        stopReason: "error",
        outcome: "aborted",
        message: "explicit error"
      })
      expect(spec.interpret({ type: "result", subtype: "error_during_execution", result: "fallback" })).toMatchObject({
        outcome: "aborted",
        message: "fallback"
      })
      expect(spec.interpret({ type: "result", is_error: true })).toMatchObject({ message: "Claude run failed" })
    })

    it("settles with usage and the session id, and drops a result with no text", () => {
      expect(
        spec.interpret({ type: "result", result: "final", usage: { input_tokens: 3 }, session_id: "s-9" })
      ).toEqual({
        type: "settled",
        assistantText: "final",
        usage: { input_tokens: 3 },
        responseId: "s-9"
      })
      expect(spec.interpret({ type: "result", result: "final" })).toEqual({ type: "settled", assistantText: "final" })
      // Non-string usage is not projected as a usage record.
      expect(spec.interpret({ type: "result", result: "final", usage: "not-a-record" })).toEqual({
        type: "settled",
        assistantText: "final"
      })
      expect(spec.interpret({ type: "result", subtype: "success" })).toBeNull()
    })
  })

  describe("preflight", () => {
    const failureOf = (exec: Parameters<typeof probeOf>[0]) =>
      Effect.runSync(Effect.flip(spec.preflight!(probeOf(exec), { CLAUDE_CONFIG_DIR: "/tmp/cfg" })))

    it("passes on exit 0 and distinguishes not-executable, config, and spawn failures", () => {
      expect(
        Effect.runSync(
          spec.preflight!(
            exits(0),
            {}
          )
        )
      ).toBeUndefined()
      expect(failureOf(() => ({ exitCode: 126 }))).toMatchObject({
        _tag: "@smthrs-plugins/adapters/BinaryMissing"
      })
      expect(failureOf(() => ({ exitCode: 1 }))).toMatchObject({
        _tag: "@smthrs-plugins/adapters/ConfigInvalid"
      })
      expect(Effect.runSync(Effect.flip(spec.preflight!(unreachable(), {})))).toMatchObject({
        _tag: "@smthrs-plugins/adapters/SpawnFailed"
      })
    })

    it("forwards the merged environment to the version probe", () => {
      const seen: Array<Readonly<Record<string, string>> | undefined> = []
      Effect.runSync(
        spec.preflight!(
          {
            exec: (_command, options) => {
              seen.push(options?.env as Readonly<Record<string, string>> | undefined)
              return Effect.succeed({ exitCode: 0, stdout: "" })
            }
          },
          { CLAUDE_CONFIG_DIR: "/tmp/cfg" }
        )
      )
      expect(seen).toEqual([{ CLAUDE_CONFIG_DIR: "/tmp/cfg" }])
    })
  })
})
