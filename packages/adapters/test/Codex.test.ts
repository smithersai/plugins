import * as Shell from "@smithers/kernel/Shell"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CliClassifier from "../src/CliClassifier.ts"
import * as CliOutput from "../src/CliOutput.ts"
import { spec } from "../src/Codex.ts"
import { flagDiff } from "../src/CommandSpec.ts"

const fixture = (name: string): ReadonlyArray<unknown> =>
  readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as unknown)

describe("Codex", () => {
  it("uses the valid exec resume form while retaining every compatible exec option", () => {
    const options = {
      model: "gpt-5.4",
      cwd: "/workspace",
      addDirs: ["/workspace/shared", "/workspace/generated"],
      sandbox: "workspace-write",
      outputSchemaPath: "/workspace/schema.json",
      jsonMode: true,
      extraArgs: ["-c", "features.web_search=true", "--skip-git-repo-check"]
    } as const
    const fresh = spec.buildCommand(options)
    const resumed = spec.buildCommand(options, { sessionId: "0198a9cf-246c-76a2-8f32-1af472c04bee" })
    const resumeIndex = resumed.args.indexOf("resume")

    expect(flagDiff(fresh, resumed)).toEqual([])
    expect(resumeIndex).toBe(1)
    expect(resumed.args.slice(2, -2)).toEqual(fresh.args.slice(1, -1))
    expect(resumed.args.slice(-2)).toEqual([
      "0198a9cf-246c-76a2-8f32-1af472c04bee",
      "-"
    ])
    expect(resumed.args.slice(0, 2)).toEqual([
      "exec",
      "resume"
    ])
    expect(resumed.args).toContain("sandbox_mode=\"workspace-write\"")
    expect(resumed.args).toContain(
      "sandbox_workspace_write.writable_roots=[\"/workspace/shared\",\"/workspace/generated\"]"
    )
    expect(fresh.outputFile).toBe("/workspace/.flows/codex-output-last-message.txt")
    expect(resumed.outputFile).toBe(fresh.outputFile)
    expect(resumed.cleanup).toEqual(fresh.cleanup)
    expect(resumed.env).toEqual(fresh.env)
    expect(fresh.env).toEqual({
      CODEX_HOME: "/workspace/.flows/codex",
      OPENAI_API_KEY: ""
    })
  })

  it("rejects profile-based resume instead of silently dropping the profile", () => {
    expect(() =>
      spec.buildCommand(
        { model: "gpt-5.4", profile: "subscription-seat" },
        { sessionId: "0198a9cf-246c-76a2-8f32-1af472c04bee" }
      )
    ).toThrow("profiles cannot be retained")
  })

  /**
   * Fixture values lifted from real local rollouts under ~/.codex/sessions
   * (exec_command input from rollout-2026-08-04T00-04-06, update_plan steps
   * from rollout-2026-08-03T20-15-29, patch paths from
   * rollout-2026-08-03T13-37-57), reshaped into the exec `--json` wire schema
   * derived from reference/codex/codex-rs/exec/src/exec_events.rs.
   */
  it("maps exec item variants into tool calls, results, and usage", () => {
    const records = fixture("exec-items.jsonl")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)

    expect(records.map((record) => record.type)).toEqual([
      "resumeToken",
      "turnOpened",
      "delta",
      "toolResult",
      "delta",
      "delta",
      "toolResult",
      "settled",
      "usage"
    ])
    expect(records[2]).toEqual({
      type: "delta",
      toolCall: {
        name: "shell_command",
        id: "item_0",
        arguments: JSON.stringify({ command: "sed -n '1,240p' skills/smithers/SKILL.md" })
      }
    })
    expect(records[3]).toMatchObject({
      type: "toolResult",
      name: "shell_command",
      id: "item_0",
      status: "completed"
    })
    expect(JSON.parse((records[3] as { output: string }).output)).toEqual({
      output: "# Smithers\nDrive Smithers, a durable control plane for long-running coding agents.",
      exitCode: 0,
      status: "completed"
    })
    expect(records[5]).toEqual({
      type: "delta",
      toolCall: {
        name: "update_plan",
        id: "item_1",
        arguments: JSON.stringify({
          items: [
            { text: "Inspect main and lane state; merge smf/full-run-view", status: "completed" },
            { text: "Resolve conflicts and wire cross-lane integrations", status: "pending" }
          ]
        })
      }
    })
    expect(records[6]).toMatchObject({
      type: "toolResult",
      name: "apply_patch",
      id: "item_2",
      status: "completed"
    })
    expect(JSON.parse((records[6] as { output: string }).output)).toEqual({
      changes: [
        { path: "package.json", kind: "add" },
        { path: "tsconfig.json", kind: "add" },
        { path: "packages/resolver/package.json", kind: "update" }
      ],
      status: "completed"
    })
    expect(records[8]).toEqual({
      type: "usage",
      input_tokens: 1204,
      output_tokens: 86,
      cachedInputTokens: 512,
      cacheWriteTokens: 128,
      reasoning_tokens: 40
    })
  })

  it("maps recorded success JSONL into resumable semantic records", () => {
    const records = fixture("success.jsonl")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)

    expect(records.map((record) => record.type)).toEqual([
      "resumeToken",
      "turnOpened",
      "delta",
      "settled",
      "usage"
    ])
    expect(records[0]).toEqual({
      type: "resumeToken",
      sessionId: "0198a9cf-246c-76a2-8f32-1af472c04bee"
    })
    expect(records[2]).toEqual({ type: "delta", thinking: "Inspecting the adapter contract." })
    expect(records[3]).toEqual({
      type: "settled",
      assistantText: "The Codex adapter retained every exec option.",
      responseId: "item_1"
    })
    expect(records[4]).toEqual({
      type: "usage",
      input_tokens: 387,
      output_tokens: 42,
      cachedInputTokens: 256
    })
    expect(CliOutput.resolveAnswer(records)).toEqual({
      source: "assistant",
      text: "The Codex adapter retained every exec option."
    })
  })

  it("classifies recorded quota and lost-session output", () => {
    const quotaRecords = fixture("quota.jsonl")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)
    const sessionRecords = fixture("session-lost.jsonl")
      .map(spec.interpret)
      .filter((record): record is CliOutput.CliRecord => record !== null)
    const quota = CliClassifier.classify({
      exitCode: 1,
      records: quotaRecords,
      patterns: spec.patterns,
      now: Date.UTC(2026, 6, 28, 12)
    })
    const sessionLost = CliClassifier.classify({
      exitCode: 1,
      records: sessionRecords,
      patterns: spec.patterns
    })

    expect(quota?._tag).toBe("flows/adapters/QuotaExhausted")
    expect(sessionLost).toMatchObject({
      _tag: "flows/adapters/SessionLost",
      discardResumeSession: true
    })
  })

  it("classifies Codex authentication wording", () => {
    const error = CliClassifier.classify({
      exitCode: 1,
      stderr: "401 Unauthorized: Incorrect API key provided",
      patterns: spec.patterns
    })
    expect(error?._tag).toBe("flows/adapters/AuthFailed")
  })

  it("declares the Codex harness capabilities", () => {
    expect(spec.capabilities).toMatchObject({
      name: "codex",
      resume: "subcommand",
      mcpBootstrap: "inline-config",
      skillsInstall: "home-dir",
      configDirIsolation: true,
      nativeStructuredOutput: false,
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

  describe("buildCommand", () => {
    it("isolates CODEX_HOME and the last-message file under the cwd", () => {
      const rootless = spec.buildCommand({})
      expect(rootless.env?.CODEX_HOME).toBe(".flows/codex")
      expect(rootless.outputFile).toBe(".flows/codex-output-last-message.txt")
      expect(rootless.cleanup).toEqual([".flows/codex-output-last-message.txt"])
      expect(spec.buildCommand({ cwd: "" }).env?.CODEX_HOME).toBe(".flows/codex")
      expect(spec.buildCommand({ cwd: "/" }).env?.CODEX_HOME).toBe("/.flows/codex")
      expect(spec.buildCommand({ cwd: "/" }).outputFile).toBe("/.flows/codex-output-last-message.txt")
      const trimmed = spec.buildCommand({ cwd: "/workspace//" })
      expect(trimmed.env?.CODEX_HOME).toBe("/workspace/.flows/codex")
      expect(trimmed.outputFile).toBe("/workspace/.flows/codex-output-last-message.txt")
      // The API key is always blanked so a stale ambient export cannot leak in.
      expect(rootless.env?.OPENAI_API_KEY).toBe("")
    })

    it("projects sandbox and writable roots through -c and honours jsonMode", () => {
      const built = spec.buildCommand({
        sandbox: "workspace-write",
        addDirs: ["/a", "/b"],
        outputSchemaPath: "/schema.json"
      })
      expect(built.args).toEqual(expect.arrayContaining(["-c", "sandbox_mode=\"workspace-write\""]))
      expect(built.args).toEqual(
        expect.arrayContaining(["-c", "sandbox_workspace_write.writable_roots=[\"/a\",\"/b\"]"])
      )
      expect(built.args).toEqual(expect.arrayContaining(["--output-schema", "/schema.json"]))
      expect(built.args).toContain("--json")
      // An empty addDirs list must not emit an empty writable_roots override.
      expect(spec.buildCommand({ addDirs: [] }).args.join(" ")).not.toContain("writable_roots")
      // jsonMode defaults on; only an explicit false suppresses --json.
      expect(spec.buildCommand({ jsonMode: false }).args).not.toContain("--json")
      expect(spec.buildCommand({ jsonMode: true }).args).toContain("--json")
    })

    it("passes a profile on a fresh run and always terminates the argv with the stdin marker", () => {
      const fresh = spec.buildCommand({ profile: "seat-a" })
      expect(fresh.args.slice(0, 1)).toEqual(["exec"])
      expect(fresh.args).toEqual(expect.arrayContaining(["--profile", "seat-a"]))
      expect(fresh.args.at(-1)).toBe("-")
      const resumed = spec.buildCommand({}, { sessionId: "thread-1" })
      expect(resumed.args.slice(0, 2)).toEqual(["exec", "resume"])
      expect(resumed.args.at(-1)).toBe("-")
      expect(resumed.args.at(-2)).toBe("thread-1")
    })

    it("rejects resume-incompatible extra args instead of silently dropping them", () => {
      for (const flag of ["--profile", "-p", "--sandbox", "-s", "--cd", "-C", "--add-dir", "--color"]) {
        expect(() => spec.buildCommand({ extraArgs: [flag, "value"] }, { sessionId: "t-1" }))
          .toThrow(`Codex resume does not accept ${flag}`)
        expect(() => spec.buildCommand({ extraArgs: [`${flag}=value`] }, { sessionId: "t-1" }))
          .toThrow(`Codex resume does not accept ${flag}=value`)
      }
      // The same flags are fine on a fresh run, and unrelated flags survive resume.
      expect(spec.buildCommand({ extraArgs: ["--sandbox", "value"] }).args).toContain("--sandbox")
      expect(spec.buildCommand({ extraArgs: ["--unrelated"] }, { sessionId: "t-1" }).args).toContain("--unrelated")
    })
  })

  describe("interpret", () => {
    it("accepts a JSON string line and rejects non-object, malformed, or unknown input", () => {
      expect(spec.interpret("{\"type\":\"thread.started\",\"thread_id\":\"t-1\"}")).toEqual({
        type: "resumeToken",
        sessionId: "t-1"
      })
      expect(spec.interpret("nope")).toBeNull()
      expect(spec.interpret([1])).toBeNull()
      expect(spec.interpret(undefined)).toBeNull()
      expect(spec.interpret({ type: "thread.started" })).toBeNull()
      expect(spec.interpret({ type: "some.other.event" })).toBeNull()
      // A recognized item envelope with no item payload is dropped.
      expect(spec.interpret({ type: "item.completed" })).toBeNull()
      expect(spec.interpret({ type: "item.started", item: { type: "unknown_item" } })).toBeNull()
    })

    it("prefers a top-level failure message over the nested error message", () => {
      expect(spec.interpret({ type: "turn.failed", message: "top", error: { message: "nested" } })).toEqual({
        type: "closed",
        stopReason: "error",
        outcome: "aborted",
        message: "top"
      })
      expect(spec.interpret({ type: "error", error: { message: "nested" } })).toMatchObject({ message: "nested" })
      expect(spec.interpret({ type: "turn.failed" })).toMatchObject({ message: "Codex run failed" })
    })

    it("emits usage only for a well-formed turn.completed payload", () => {
      expect(spec.interpret({ type: "turn.completed", usage: { total_tokens: 90 } })).toEqual({
        type: "usage",
        total_tokens: 90
      })
      // reasoning_output_tokens is the later spelling and overrides the earlier one.
      expect(
        spec.interpret({ type: "turn.completed", usage: { reasoning_tokens: 1, reasoning_output_tokens: 5 } })
      ).toEqual({ type: "usage", reasoning_tokens: 5 })
      // Non-numeric fields are dropped rather than coerced.
      expect(spec.interpret({ type: "turn.completed", usage: { input_tokens: "12" } })).toEqual({ type: "usage" })
      expect(spec.interpret({ type: "turn.completed", usage: "nope" })).toBeNull()
      expect(spec.interpret({ type: "turn.completed" })).toBeNull()
    })

    it("streams an in-flight agent message as a delta and only settles on completion", () => {
      expect(spec.interpret({ type: "item.updated", item: { type: "agent_message", id: "i-1", text: "partial" } }))
        .toEqual({ type: "delta", text: "partial" })
      expect(spec.interpret({ type: "item.completed", item: { type: "agent_message", id: "i-1", text: "final" } }))
        .toEqual({ type: "settled", assistantText: "final", responseId: "i-1" })
      expect(spec.interpret({ type: "item.completed", item: { type: "agent_message", text: "" } })).toBeNull()
      expect(spec.interpret({ type: "item.completed", item: { type: "agent_message" } })).toBeNull()
    })

    it("drops empty reasoning and keeps non-empty reasoning as a thinking delta", () => {
      expect(spec.interpret({ type: "item.updated", item: { type: "reasoning", text: "considering" } }))
        .toEqual({ type: "delta", thinking: "considering" })
      expect(spec.interpret({ type: "item.updated", item: { type: "reasoning", text: "" } })).toBeNull()
      expect(spec.interpret({ type: "item.updated", item: { type: "reasoning" } })).toBeNull()
    })

    it("qualifies an MCP tool call with its server and falls back to the bare tool name", () => {
      expect(
        spec.interpret({
          type: "item.started",
          item: { type: "mcp_tool_call", id: "i-2", server: "github", tool: "list_prs", arguments: { limit: 5 } }
        })
      ).toEqual({
        type: "delta",
        toolCall: { name: "github.list_prs", id: "i-2", arguments: JSON.stringify({ limit: 5 }) }
      })
      expect(spec.interpret({ type: "item.started", item: { type: "mcp_tool_call", tool: "solo" } })).toEqual({
        type: "delta",
        toolCall: { name: "solo", arguments: "{}" }
      })
      expect(spec.interpret({ type: "item.started", item: { type: "mcp_tool_call", server: "github" } })).toBeNull()
    })

    it("renders a web search as a tool call carrying the raw query", () => {
      expect(spec.interpret({ type: "item.completed", item: { type: "web_search", query: "effect v4 layers" } }))
        .toEqual({ type: "delta", toolCall: { name: "web_search", arguments: "effect v4 layers" } })
      expect(spec.interpret({ type: "item.completed", item: { type: "web_search" } })).toBeNull()
    })

    it("keeps an in-progress command a call and marks failed or declined results errors", () => {
      // Completed envelope but in_progress status is still only a call.
      expect(
        spec.interpret({
          type: "item.completed",
          item: { type: "command_execution", id: "c-1", command: "ls", status: "in_progress" }
        })
      ).toEqual({ type: "delta", toolCall: { name: "shell_command", id: "c-1", arguments: "{\"command\":\"ls\"}" } })
      expect(spec.interpret({ type: "item.started", item: { type: "command_execution", command: "ls" } }))
        .toEqual({ type: "delta", toolCall: { name: "shell_command", arguments: "{\"command\":\"ls\"}" } })

      for (const status of ["failed", "declined"]) {
        const record = spec.interpret({
          type: "item.completed",
          item: { type: "command_execution", id: "c-2", command: "ls", status, exit_code: 2 }
        })
        expect(record).toMatchObject({ type: "toolResult", name: "shell_command", status: "error" })
        expect(JSON.parse((record as { output: string }).output)).toEqual({ output: "", exitCode: 2, status })
      }

      // No status at all completes and reports a null exit code.
      const bare = spec.interpret({ type: "item.completed", item: { type: "command_execution", command: "ls" } })
      expect(bare).toMatchObject({ status: "completed" })
      expect(JSON.parse((bare as { output: string }).output)).toEqual({
        output: "",
        exitCode: null,
        status: "completed"
      })
      expect(spec.interpret({ type: "item.completed", item: { type: "command_execution" } })).toBeNull()
    })

    it("reports a failed file change as an errored apply_patch and tolerates absent changes", () => {
      const failed = spec.interpret({
        type: "item.completed",
        item: { type: "file_change", id: "f-1", status: "failed", changes: [{ path: "a.ts", kind: "update" }] }
      })
      expect(failed).toMatchObject({ type: "toolResult", name: "apply_patch", id: "f-1", status: "error" })
      expect(JSON.parse((failed as { output: string }).output)).toEqual({
        changes: [{ path: "a.ts", kind: "update" }],
        status: "failed"
      })
      // A non-array changes field degrades to an empty change set, not a crash.
      const bare = spec.interpret({ type: "item.completed", item: { type: "file_change", changes: "nope" } })
      expect(bare).toMatchObject({ status: "completed", arguments: "{\"changes\":[]}" })
    })

    it("projects a todo list into update_plan, skipping malformed entries", () => {
      expect(
        spec.interpret({
          type: "item.updated",
          item: {
            type: "todo_list",
            id: "t-1",
            items: [
              { text: "done step", completed: true },
              { text: "open step" },
              { text: "explicitly open", completed: false },
              { completed: true },
              "not-an-object"
            ]
          }
        })
      ).toEqual({
        type: "delta",
        toolCall: {
          name: "update_plan",
          id: "t-1",
          arguments: JSON.stringify({
            items: [
              { text: "done step", status: "completed" },
              { text: "open step", status: "pending" },
              { text: "explicitly open", status: "pending" }
            ]
          })
        }
      })
      expect(spec.interpret({ type: "item.updated", item: { type: "todo_list", items: "nope" } }))
        .toEqual({ type: "delta", toolCall: { name: "update_plan", arguments: "{\"items\":[]}" } })
    })

    it("namespaces a collab tool call and requires a tool name", () => {
      expect(
        spec.interpret({
          type: "item.started",
          item: { type: "collab_tool_call", id: "x-1", tool: "ask", prompt: "hi" }
        })
      ).toEqual({
        type: "delta",
        toolCall: { name: "collab.ask", id: "x-1", arguments: JSON.stringify({ prompt: "hi" }) }
      })
      // A missing prompt still encodes an object rather than the string "undefined".
      expect(spec.interpret({ type: "item.started", item: { type: "collab_tool_call", tool: "ask" } }))
        .toEqual({ type: "delta", toolCall: { name: "collab.ask", arguments: "{}" } })
      expect(spec.interpret({ type: "item.started", item: { type: "collab_tool_call" } })).toBeNull()
    })
  })

  describe("preflight", () => {
    const failureOf = (exec: Parameters<typeof Shell.makeNoop>[0]["exec"]) =>
      Effect.runSync(Effect.flip(spec.preflight!(Shell.makeNoop({ exec }), { CODEX_HOME: "/tmp/codex" })))

    it("passes on exit 0 and distinguishes not-executable, config, and spawn failures", () => {
      expect(
        Effect.runSync(
          spec.preflight!(Shell.makeNoop({ exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }) }), {})
        )
      ).toBeUndefined()
      expect(failureOf(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 126 }))).toMatchObject({
        _tag: "flows/adapters/BinaryMissing"
      })
      expect(failureOf(() => Effect.succeed({ stdout: "", stderr: "bad", exitCode: 3 }))).toMatchObject({
        _tag: "flows/adapters/ConfigInvalid"
      })
      expect(failureOf(() => Effect.fail(new Error("no host")) as never)).toMatchObject({
        _tag: "flows/adapters/SpawnFailed"
      })
    })
  })
})
