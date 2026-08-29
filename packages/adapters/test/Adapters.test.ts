/**
 * The adapters this package ships, their registry, and the doctor over them.
 */
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AdapterRuntime from "../src/AdapterRuntime.ts"
import * as Antigravity from "../src/Antigravity.ts"
import * as CommandSpec from "../src/CommandSpec.ts"
import * as Doctor from "../src/Doctor.ts"
import * as Kimi from "../src/Kimi.ts"
import { exits, probeOf } from "./probeStub.ts"

describe("AdapterRuntime", () => {
  it("ships exactly the four adapters the migration keeps", () => {
    expect(AdapterRuntime.names()).toEqual(["claude-code", "codex", "kimi", "antigravity"])
  })

  it("resolves a registered adapter with its plan-card material", () => {
    const resolved = AdapterRuntime.lookup("kimi")

    expect(resolved._tag).toBe("Success")
    expect(resolved._tag === "Success" ? resolved.success.planCard.harness : "").toBe("kimi")
    expect(resolved._tag === "Success" ? resolved.success.planCard.fingerprint.length : 0).toBeGreaterThan(0)
  })

  it("refuses an adapter the ledger deleted", () => {
    for (const name of ["hermes", "openclaw", "herdr", "opencode"]) {
      expect(AdapterRuntime.lookup(name)._tag).toBe("Failure")
    }
  })

  it("admits only configuration-isolated adapters to a multi-seat pool", () => {
    for (const name of AdapterRuntime.names()) {
      const pooled = AdapterRuntime.lookup(name, { multiSeat: true })
      const isolated = Option.getOrUndefined(
        // eslint-disable-next-line
        AdapterRuntime.lookup(name)._tag === "Success" ? Option.some(true) : Option.none()
      )
      expect(pooled._tag === "Success").toBe(isolated === true)
    }
  })
})

describe("Kimi", () => {
  it("isolates the account through KIMI_SHARE_DIR", () => {
    expect(Kimi.spec.buildCommand({}).env).toHaveProperty("KIMI_SHARE_DIR")
  })

  it("keeps every fresh flag when a session is resumed", () => {
    const options = { model: "kimi-k3", cwd: "/repo", addDirs: ["/lib"] }
    const fresh = Kimi.spec.buildCommand(options)
    const resumed = Kimi.spec.buildCommand(options, { sessionId: "s-1" })

    expect(CommandSpec.flagDiff(fresh, resumed)).toEqual([])
    expect(resumed.args).toContain("--session")
    expect(resumed.args).toContain("s-1")
  })

  it("reads a session id, a text delta, and a settled answer", () => {
    expect(Kimi.spec.interpret({ type: "session", session_id: "s-1" })).toEqual({
      type: "resumeToken",
      sessionId: "s-1"
    })
    expect(Kimi.spec.interpret({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))
      .toEqual({ type: "delta", text: "hi" })
    expect(Kimi.spec.interpret({ type: "result", result: "done", session_id: "s-1" })).toMatchObject({
      type: "settled",
      assistantText: "done",
      responseId: "s-1"
    })
  })

  it("ignores a line it does not recognize", () => {
    expect(Kimi.spec.interpret({ type: "heartbeat" })).toBeNull()
    expect(Kimi.spec.interpret("not json")).toBeNull()
  })

  it("classifies an insufficient balance as quota, not breakage", () => {
    const quota = Kimi.spec.patterns.quota.some((pattern) => {
      pattern.lastIndex = 0
      return pattern.test("your account balance is insufficient")
    })

    expect(quota).toBe(true)
  })
})

describe("Antigravity", () => {
  it("isolates the account through GEMINI_DIR and resumes by conversation", () => {
    const resumed = Antigravity.spec.buildCommand({ cwd: "/repo" }, { sessionId: "c-1" })

    expect(resumed.env).toHaveProperty("GEMINI_DIR")
    expect(resumed.args).toEqual(expect.arrayContaining(["--conversation", "c-1"]))
  })

  it("names the options it cannot express rather than dropping them", () => {
    expect(Antigravity.unsupportedOptions).toContain("outputFormat")
    expect(Antigravity.unsupportedOptions).toContain("listSessions")
  })

  it("reads its prose output as text, since it streams no JSON", () => {
    expect(Antigravity.spec.interpret("thinking about it")).toEqual({ type: "delta", text: "thinking about it" })
    expect(Antigravity.spec.interpret({ type: "result" })).toBeNull()
  })

  it("declares no native structured output, so the schema rides in the prompt", () => {
    expect(Antigravity.spec.capabilities.nativeStructuredOutput).toBe(false)
  })
})

describe("Doctor", () => {
  it("reports every shipped adapter as ready when each probe answers", async () => {
    const report = await Effect.runPromise(Doctor.report(exits(0)))

    expect(report.anyAvailable).toBe(true)
    expect(report.entries.map((entry) => entry.name)).toEqual(AdapterRuntime.names())
    expect(report.entries.every((entry) => entry.available)).toBe(true)
  })

  it("names why an adapter is unavailable", async () => {
    const report = await Effect.runPromise(Doctor.report(exits(127)))

    expect(report.anyAvailable).toBe(false)
    expect(report.entries[0]?.reason).toContain("not available")
    expect(Doctor.format(report)).toContain("unavailable")
  })

  it("marks the poolable adapters", async () => {
    const report = await Effect.runPromise(Doctor.report(exits(0)))

    expect(report.entries.filter((entry) => entry.multiSeat).map((entry) => entry.name)).toEqual(
      AdapterRuntime.names()
    )
  })

  it("passes the environment through to each probe", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = []
    await Effect.runPromise(
      Doctor.report(
        {
          exec: (_command, options) => {
            seen.push(options?.env)
            return Effect.succeed({ exitCode: 0, stdout: "" })
          }
        },
        { CLAUDE_CONFIG_DIR: "/tmp/cfg" }
      )
    )

    expect(seen).toHaveLength(AdapterRuntime.names().length)
    expect(seen[0]).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/cfg" })
  })

  it("reports an adapter with no preflight as available rather than inventing a failure", async () => {
    const entry = await Effect.runPromise(
      Doctor.check(
        { ...Kimi.spec, preflight: undefined },
        probeOf(() => ({ exitCode: 1 }))
      )
    )

    expect(entry.available).toBe(true)
  })
})
