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
      "resume",
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
})
